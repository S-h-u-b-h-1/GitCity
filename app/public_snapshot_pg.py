"""Optional HTTPS-PostgreSQL cache for public GitCity city graphs only.

This stores NO browser sessions, CSRF values, user IDs, provider credentials,
AI prompts or private repositories. It is disabled when no connection URL is
configured and leaves the existing SQLite/guest-workspace design untouched.

DDL is deliberately not run at request time. Operators provision the dedicated
GitCity cache table with scripts/gitcity_public_cache.sql before enabling it.
Connection failures are best-effort cache misses, never app outages.
"""
from __future__ import annotations

import json
import logging
import os
import time
from urllib.parse import urlsplit

logger = logging.getLogger("gitcity.public-cache")
TTL_SECONDS = 12 * 3600
MAX_ENTRIES = 128
MAX_GRAPH_BYTES = 500_000
_QUERY = ("SELECT graph_json,cached_at FROM gitcity_public_city_snapshots "
          "WHERE repo_key=$1 AND cached_at>$2")
_UPSERT = ("""INSERT INTO gitcity_public_city_snapshots(repo_key,graph_json,cached_at)
              VALUES($1,$2,$3) ON CONFLICT(repo_key) DO UPDATE
              SET graph_json=excluded.graph_json,cached_at=excluded.cached_at""")
_PRUNE = ("""DELETE FROM gitcity_public_city_snapshots WHERE repo_key NOT IN
              (SELECT repo_key FROM gitcity_public_city_snapshots
               ORDER BY cached_at DESC,repo_key DESC LIMIT $1)""")


def _dsn() -> str | None:
    value = os.getenv("GITCITY_PUBLIC_CACHE_DATABASE_URL", "").strip()
    if not value:
        return None
    try:
        parts = urlsplit(value)
        if parts.scheme not in {"postgres", "postgresql"} or not parts.hostname or not parts.path.strip("/") or not parts.username:
            return None
        if parts.password is None:
            return None
    except (ValueError, AttributeError):
        return None
    return value


async def _connect(dsn: str):
    # Imported only in opt-in mode, so development and Free Render continue to
    # work when PostgreSQL and this optional driver are not installed.
    import asyncpg
    return await asyncpg.connect(dsn=dsn, ssl="require", timeout=4, command_timeout=4)


def _valid_graph(graph: object, key: str) -> bool:
    # Exact canonical public GitHub source check is shared with SQLite.
    from .github import _verified_public_graph
    return _verified_public_graph(graph, key)


async def read_public_graph(owner: str, repo: str) -> dict | None:
    """Read a 12-hour public snapshot if configured and verified."""
    url = _dsn()
    if url is None:
        return None
    key = (owner + "/" + repo).lower()
    conn = None
    try:
        conn = await _connect(url)
        now = int(time.time())
        row = await conn.fetchrow(_QUERY, key, now - TTL_SECONDS)
        if row is None:
            return None
        cached_at = int(row["cached_at"])
        age = now - cached_at
        if age < 0 or age >= TTL_SECONDS:
            return None
        raw = row["graph_json"]
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_GRAPH_BYTES:
            return None
        graph = json.loads(raw)
        if not _valid_graph(graph, key):
            return None
        if age >= 480:
            warning = ("Durable public city snapshot may be up to 12 hours old. "
                       "Refresh to check updated GitHub code.")
            if isinstance(graph.get("warnings"), list):
                graph["warnings"].append(warning)
        return graph
    except Exception:
        # Do not log provider URL/password or app session details. Provider
        # unavailability cannot break a successful GitHub import.
        logger.warning("Optional public-city PostgreSQL cache unavailable (read).")
        return None
    finally:
        if conn is not None:
            try:
                await conn.close()
            except Exception:
                pass


async def write_public_graph(owner: str, repo: str, graph: dict) -> bool:
    """Persist a server-confirmed public graph; never write user workspace data."""
    url = _dsn()
    if url is None:
        return False
    key = (owner + "/" + repo).lower()
    if not _valid_graph(graph, key):
        return False
    try:
        payload = json.dumps(graph, separators=(",", ":"), ensure_ascii=False)
        if len(payload.encode("utf-8")) > MAX_GRAPH_BYTES:
            return False
    except (ValueError, TypeError):
        return False
    conn = None
    try:
        conn = await _connect(url)
        now = int(time.time())
        async with conn.transaction():
            await conn.execute(
                "DELETE FROM gitcity_public_city_snapshots WHERE cached_at<$1",
                now - TTL_SECONDS,
            )
            await conn.execute(_UPSERT, key, payload, now)
            await conn.execute(_PRUNE, MAX_ENTRIES)
        return True
    except Exception:
        logger.warning("Optional public-city PostgreSQL cache unavailable (write).")
        return False
    finally:
        if conn is not None:
            try:
                await conn.close()
            except Exception:
                pass
