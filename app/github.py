"""Public-only GitHub importer: bounded, recoverable, rate-limit aware.

The initial city uses GitHub's metadata and Git tree plus a *small* source sample.
Source-specific questions fetch evidence separately when needed; an import must
not exhaust the unauthenticated hourly REST API allowance merely to draw a map.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import os
import sqlite3
import re
import time
from urllib.parse import quote, urlsplit

import httpx

from .auth import _database
from .graph import (MAX_ANALYZED_SOURCES, MAX_SOURCE_BYTES, build_graph,
                    group_for_file, source_priority)

GH_API = "https://api.github.com"
_GRAPH_CACHE: dict[str, tuple[float, dict]] = {}
GRAPH_TTL_SECONDS = 480
GRAPH_CACHE_MAX_ENTRIES = 24
PUBLIC_CITY_CACHE_TTL_SECONDS = 12 * 3600
PUBLIC_CITY_CACHE_MAX_ENTRIES = 128
PUBLIC_CITY_CACHE_MAX_GRAPH_BYTES = 500_000
OWNER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
# Github's unauthenticated API allowance is 60 calls / hour per origin IP.
# Two calls are needed for metadata and tree, before source inspection.
DEFAULT_PUBLIC_SOURCE_LIMIT = 6
DEFAULT_AUTHENTICATED_SOURCE_LIMIT = 16
SOURCE_FETCH_CONCURRENCY = 3
SOURCE_FETCH_BUDGET_SECONDS = 21


def _verified_public_graph(graph: object, key: str) -> bool:
    """Only serve the public GitHub graph for its exact canonical owner/repo."""
    if not isinstance(graph, dict) or graph.get('source') != 'github':
        return False
    if not isinstance(graph.get('nodes'), list) or not graph['nodes']:
        return False
    try:
        actual_owner, actual_repo = parse_repository(graph['url'])
    except (RepoError, KeyError, TypeError):
        return False
    return (actual_owner + '/' + actual_repo).lower() == key


def _remember_public_graph(key: str, graph: dict) -> None:
    if key not in _GRAPH_CACHE and len(_GRAPH_CACHE) >= GRAPH_CACHE_MAX_ENTRIES:
        oldest = min(_GRAPH_CACHE, key=lambda entry: _GRAPH_CACHE[entry][0])
        _GRAPH_CACHE.pop(oldest, None)
    _GRAPH_CACHE[key] = (time.monotonic(), copy.deepcopy(graph))


def _shared_public_graph(owner: str, repo: str) -> dict | None:
    """Best-effort 12-hour cache in the existing ephemeral SQLite volume."""
    key = (owner + '/' + repo).lower()
    try:
        with _database() as db:
            row = db.execute(
                'SELECT graph_json, cached_at FROM public_city_cache WHERE repo_key=?',
                (key,),
            ).fetchone()
            if row is None:
                return None
            age = int(time.time()) - int(row['cached_at'])
            if age < 0 or age >= PUBLIC_CITY_CACHE_TTL_SECONDS:
                db.execute('DELETE FROM public_city_cache WHERE repo_key=?', (key,))
                return None
            graph = json.loads(row['graph_json'])
    except (sqlite3.Error, ValueError, TypeError, KeyError):
        return None
    if not _verified_public_graph(graph, key):
        return None
    # Avoid suggesting stale code is a live, commit-pinned GitHub observation.
    if age >= GRAPH_TTL_SECONDS:
        warnings = graph.setdefault('warnings', [])
        if isinstance(warnings, list):
            warnings.append('Shared public city snapshot may be up to 12 hours old. Refresh to check updated GitHub code.')
    return graph


def _persist_public_graph(key: str, graph: dict) -> None:
    """Store at most 128 public-only graphs, each <=500 KB, without guest data."""
    try:
        payload = json.dumps(graph, separators=(',', ':'), ensure_ascii=False)
        if len(payload.encode('utf-8')) > PUBLIC_CITY_CACHE_MAX_GRAPH_BYTES:
            return
        now = int(time.time())
        with _database() as db:
            db.execute('DELETE FROM public_city_cache WHERE cached_at<?',
                       (now - PUBLIC_CITY_CACHE_TTL_SECONDS,))
            db.execute('''INSERT INTO public_city_cache (repo_key,graph_json,cached_at)
                          VALUES (?,?,?) ON CONFLICT(repo_key) DO UPDATE SET
                          graph_json=excluded.graph_json,cached_at=excluded.cached_at''',
                       (key, payload, now))
            db.execute('''DELETE FROM public_city_cache WHERE repo_key NOT IN
                          (SELECT repo_key FROM public_city_cache
                           ORDER BY cached_at DESC,repo_key DESC LIMIT ?)''',
                       (PUBLIC_CITY_CACHE_MAX_ENTRIES,))
    except (sqlite3.Error, ValueError, TypeError):
        # A cache failure must not prevent an otherwise successful public import.
        return


def cached_public_graph(owner: str, repo: str) -> dict | None:
    """Use private in-memory copies first, then shared public-only SQLite."""
    key = (owner + '/' + repo).lower()
    entry = _GRAPH_CACHE.get(key)
    if entry is not None:
        age = time.monotonic() - entry[0]
        if 0 <= age < GRAPH_TTL_SECONDS and _verified_public_graph(entry[1], key):
            return copy.deepcopy(entry[1])
        _GRAPH_CACHE.pop(key, None)
    persisted = _shared_public_graph(owner, repo)
    if persisted is not None:
        _remember_public_graph(key, persisted)
        return copy.deepcopy(persisted)
    return None


def invalidate_shared_graph(owner: str, repo: str) -> None:
    """Remove recently public snapshots after the source archive returns 404."""
    key = (owner + '/' + repo).lower()
    _GRAPH_CACHE.pop(key, None)
    try:
        with _database() as db:
            db.execute('DELETE FROM public_city_cache WHERE repo_key=?', (key,))
    except sqlite3.Error:
        # The request stays denied even if temporary SQLite is unavailable.
        pass


def _cache_public_graph(owner: str, repo: str, graph: dict) -> None:
    """Only verified public GitHub imports enter the shared city cache."""
    key = (owner + '/' + repo).lower()
    if not _verified_public_graph(graph, key):
        return
    _remember_public_graph(key, graph)
    _persist_public_graph(key, graph)


class RepoError(Exception):
    def __init__(self, detail: str, status: int = 400, retry_after: int | None = None):
        self.detail = detail
        self.status = status
        if retry_after is not None:
            self.retry_after = max(1, int(retry_after))
        super().__init__(detail)


def parse_repository(value: str) -> tuple[str, str]:
    if not isinstance(value, str) or len(value) > 240:
        raise RepoError("Use a public GitHub repository URL or owner/repo.")
    raw = value.strip()
    if raw.startswith("https://"):
        parsed = urlsplit(raw)
        if parsed.netloc.lower() not in ("github.com", "www.github.com") or parsed.username or parsed.password or parsed.port:
            raise RepoError("Only public github.com repositories are supported.")
        if parsed.query or parsed.fragment:
            raise RepoError("Use the main repository URL without query parameters.")
        path = parsed.path.strip("/")
    elif "://" not in raw and not raw.startswith("/"):
        path = raw.strip("/")
    else:
        raise RepoError("Only HTTPS GitHub URLs or owner/repo are supported.")
    pieces = path.split("/")
    if len(pieces) != 2:
        raise RepoError("Enter a repository, e.g. https://github.com/pallets/flask.")
    owner, repo = pieces
    repo = repo[:-4] if repo.endswith(".git") else repo
    if not OWNER_RE.fullmatch(owner) or not REPO_RE.fullmatch(repo) or repo in {".", ".."}:
        raise RepoError("The GitHub owner or repository name is invalid.")
    return owner, repo


def _retry_seconds(response: httpx.Response) -> int | None:
    raw = response.headers.get("Retry-After", "").strip()
    if raw.isdigit():
        return max(1, min(int(raw), 86400))
    reset = response.headers.get("X-RateLimit-Reset", "").strip()
    remaining = response.headers.get("X-RateLimit-Remaining", "").strip()
    if remaining == "0" and reset.isdigit():
        return max(1, min(int(reset) - int(time.time()), 86400))
    return None


def _github_failure(response: httpx.Response, *, token_present: bool) -> RepoError:
    status = response.status_code
    if status == 404:
        return RepoError("Public GitHub repository not found. Check owner/repository and visibility.", 404)
    if status == 401:
        return RepoError("GitHub rejected the server's GITHUB_TOKEN. Remove or replace that token and retry.", 502)
    if status in {403, 429}:
        # A 403 can also be a permissions denial, not a rate limit.
        retry = _retry_seconds(response)
        limited = status == 429 or retry is not None
        if not limited:
            try:
                text = str(response.json().get("message", "")).lower()
            except (ValueError, AttributeError):
                text = ""
            limited = "rate limit" in text or "abuse detection" in text
        if limited:
            return RepoError(
                "GitHub API rate limit reached. Please retry after the cooldown; "
                "a server-side GITHUB_TOKEN can raise the allowance for public repositories.",
                429, retry_after=retry or 60,
            )
        return RepoError("GitHub denied access to this repository. Only public repositories are supported.", 403)
    if status in {408, 502, 503, 504}:
        return RepoError("GitHub is temporarily unavailable. The import was not saved; try again.", 503, retry_after=15)
    if status == 409:
        return RepoError("This GitHub repository is empty or its Git tree is unavailable.", 422)
    return RepoError(f"GitHub returned HTTP {status} during import.", 502)


async def _json(client: httpx.AsyncClient, url: str, headers: dict) -> dict:
    try:
        response = await client.get(url, headers=headers)
    except httpx.TimeoutException as exc:
        raise RepoError("GitHub took too long to respond. Retry, or try a smaller public repository.", 504) from exc
    except httpx.RequestError as exc:
        raise RepoError("GitHub could not be reached from this server. Check its network connection.", 502) from exc
    if response.status_code >= 400:
        raise _github_failure(response, token_present=bool(headers.get("Authorization")))
    try:
        data = response.json()
    except ValueError as exc:
        raise RepoError("GitHub returned an unreadable response. Please retry.", 502) from exc
    if not isinstance(data, dict):
        raise RepoError("Unexpected GitHub response format.", 502)
    return data


def _source_limit(token_present: bool) -> int:
    # The free Render demo shares a small unauthenticated GitHub IP budget.
    # Sample fewer optional blobs there; leave token-backed and local imports
    # unchanged, and allow an explicit config override when needed.
    default = (DEFAULT_AUTHENTICATED_SOURCE_LIMIT if token_present else
               2 if os.getenv("REPOWORLD_EPHEMERAL_DEMO") == "1" else
               DEFAULT_PUBLIC_SOURCE_LIMIT)
    raw = os.getenv("REPOWORLD_IMPORT_SOURCE_LIMIT", "").strip()
    try:
        requested = int(raw) if raw else default
    except ValueError:
        requested = default
    return max(0, min(MAX_ANALYZED_SOURCES, requested))


def _source_sample(entries: list[dict], count: int) -> list[dict]:
    # Round-robin across modules so the first handful of files isn't dominated
    # by the alphabetically earliest directory. No filenames are invented.
    grouped: dict[str, list[dict]] = {}
    for item in entries:
        if not isinstance(item, dict) or item.get("type") != "blob":
            continue
        path = item.get("path")
        size = item.get("size", 0)
        if (not isinstance(path, str) or not isinstance(size, int)
                or not 0 < size <= MAX_SOURCE_BYTES or source_priority(path)[0] >= 99):
            continue
        grouped.setdefault(group_for_file(path), []).append(item)
    for files in grouped.values():
        files.sort(key=lambda e: source_priority(e["path"]))
    districts = sorted(grouped, key=lambda group: (source_priority(grouped[group][0]["path"]), group))
    result: list[dict] = []
    for round_number in range(4):
        for group in districts:
            if len(result) >= count:
                return result
            if len(grouped[group]) > round_number:
                result.append(grouped[group][round_number])
    return result


async def _sample_sources(client: httpx.AsyncClient, base: str, headers: dict,
                          chosen: list[dict]) -> tuple[dict[str, str], int]:
    """Gather a small source sample with a hard overall budget and safe partial results."""
    if not chosen:
        return {}, 0
    semaphore = asyncio.Semaphore(SOURCE_FETCH_CONCURRENCY)
    source_texts: dict[str, str] = {}

    async def fetch(item: dict) -> None:
        sha = item.get("sha", "")
        path = item.get("path", "")
        if not isinstance(path, str) or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
            return
        async with semaphore:
            try:
                # This is a fixed api.github.com URL built only from validated SHA.
                response = await client.get(f"{base}/git/blobs/{sha}", headers=headers,
                                            timeout=httpx.Timeout(8.0, connect=5.0))
                if response.status_code != 200:
                    return
                blob = response.json()
                encoded = blob.get("content", "") if isinstance(blob, dict) else ""
                if blob.get("encoding") != "base64" or not isinstance(encoded, str):
                    return
                if len(encoded) > (MAX_SOURCE_BYTES * 4 // 3) + 200:
                    return
                decoded = base64.b64decode(encoded, validate=False)
                if len(decoded) <= MAX_SOURCE_BYTES:
                    source_texts[path] = decoded.decode("utf-8", errors="replace")
            except (httpx.RequestError, ValueError, KeyError, TypeError, AttributeError, UnicodeError):
                # A missing source sample must not destroy a successfully
                # obtained repository tree. Report partial inspection below.
                return

    tasks = [asyncio.create_task(fetch(item)) for item in chosen]
    try:
        completed, pending = await asyncio.wait(tasks, timeout=SOURCE_FETCH_BUDGET_SECONDS)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        # Completed tasks already placed safely decoded text into source_texts.
        _ = completed
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
    return source_texts, len(chosen) - len(source_texts)


async def get_repository_graph(raw: str, client: httpx.AsyncClient | None = None,
                               *, refresh: bool = False) -> dict:
    owner, repo = parse_repository(raw)
    cache_key = (owner + "/" + repo).lower()
    cached = cached_public_graph(owner, repo) if client is None and not refresh else None
    if cached is None and client is None and not refresh:
        # Optional durable public-only cache after local RAM/SQLite miss.
        from .public_snapshot_pg import read_public_graph
        cached = await read_public_graph(owner, repo)
        if cached is not None:
            _remember_public_graph(cache_key, cached)
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token and os.getenv("REPOWORLD_EPHEMERAL_DEMO") == "1":
        # Explicit free public preview: use the bounded source ZIP endpoint,
        # not the shared-IP GitHub REST allowance. Token-backed imports keep
        # the normal metadata/visibility checks and expanded source sampling.
        from .archive_import import get_public_archive_graph
        if cached is not None:
            return cached
        graph = await get_public_archive_graph(owner, repo, client=client)
        if client is None:
            _cache_public_graph(owner, repo, graph)
            from .public_visibility import mark_fresh_public
            mark_fresh_public(owner, repo)
            from .public_snapshot_pg import write_public_graph
            await write_public_graph(owner, repo, graph)
        return graph
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "RepoWorld/0.9.7",
               "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=httpx.Timeout(16.0, connect=6.0), follow_redirects=False)
    assert client is not None
    try:
        safe_owner, safe_repo = quote(owner, safe=""), quote(repo, safe="")
        base = f"{GH_API}/repos/{safe_owner}/{safe_repo}"
        meta = await _json(client, base, headers)
        if meta.get("private") is not False:
            raise RepoError("Private or unverified repositories are not supported. Only public code is analyzed.", 403)
        if cached is not None:
            return cached
        branch = str(meta.get("default_branch") or "main")
        if len(branch) > 150 or any(c in branch for c in "?#\\\x00"):
            raise RepoError("Repository branch could not be safely parsed.", 502)
        tree = await _json(client, f"{base}/git/trees/{quote(branch, safe='')}?recursive=1", headers)
        entries = tree.get("tree", [])
        if not isinstance(entries, list):
            raise RepoError("GitHub returned an invalid repository tree.", 502)
        if not any(isinstance(e, dict) and e.get("type") == "blob" for e in entries):
            raise RepoError("No files were found in the public repository. It may be empty or unsupported.", 422)

        chosen = _source_sample(entries, _source_limit(bool(token)))
        source_texts, missed = await _sample_sources(client, base, headers, chosen)
        graph = build_graph(
            entries, source_texts, name=str(meta.get("name") or repo)[:100],
            owner=str(meta.get("owner", {}).get("login") or owner)[:80],
            description=str(meta.get("description") or "")[:400],
            url=f"https://github.com/{owner}/{repo}", branch=branch,
            stars=int(meta.get("stargazers_count") or 0), language=str(meta.get("language") or ""),
            truncated=bool(tree.get("truncated")),
        )
        if not graph.get("nodes"):
            raise RepoError("The repository has no displayable code or document files. Try another public repository.", 422)
        if missed:
            graph.setdefault("warnings", []).append(
                f"Only {len(source_texts)} of {len(chosen)} selected source files could be inspected. "
                "The city remains usable, but import relationships are incomplete."
            )
        if not token:
            graph.setdefault("warnings", []).append(
                "Public GitHub import uses a small source sample to conserve API requests. "
                "Issue investigations can retrieve additional relevant files later."
            )
        if own_client:
            _cache_public_graph(owner, repo, graph)
            from .public_visibility import mark_fresh_public
            mark_fresh_public(owner, repo)
            from .public_snapshot_pg import write_public_graph
            await write_public_graph(owner, repo, graph)
        return graph
    finally:
        if own_client:
            await client.aclose()
