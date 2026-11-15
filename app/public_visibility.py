"""Short-lived GitHub public-visibility proofs for shared, previously-public city maps.

A cached GitCity graph may outlive the source repository's public visibility.
Before assigning it to a *new* anonymous browser, verify access through a
lightweight HEAD request to the same public codeload archive endpoint used by
the GitCity Free importer. Never send cookies, tokens, or provider credentials.

This provides a bounded ~90-second verification window, NOT instant revocation
and NOT a verified immutable Git commit. On a provider outage fail CLOSED for
shared-cache reads; fresh imports still use the existing GitHub source route.
"""
from __future__ import annotations

import math
import time
from urllib.parse import quote

import httpx

from .github import RepoError, parse_repository

PUBLIC_PROOF_TTL_SECONDS = 90
REVOKED_RECHECK_SECONDS = 90
MAX_PROOFS = 512

_public_proof_until: dict[str, float] = {}
_revoked_until: dict[str, float] = {}
_provider_cooldown_until: dict[str, float] = {}


def _remember(target: dict[str, float], key: str, expiry: float) -> None:
    target.pop(key, None)
    if len(target) >= MAX_PROOFS:
        target.pop(next(iter(target)), None)
    target[key] = expiry


def mark_fresh_public(owner: str, repo: str) -> None:
    """Only call after a successfully fetched public source archive or API."""
    key = (owner + "/" + repo).lower()
    _revoked_until.pop(key, None)
    _provider_cooldown_until.pop(key, None)
    _remember(_public_proof_until, key, time.monotonic() + PUBLIC_PROOF_TTL_SECONDS)


def _retry_seconds(response: httpx.Response) -> int:
    raw = response.headers.get("retry-after", "").strip()
    if raw.isdigit():
        return max(1, min(int(raw), 3600))
    return 60


def _new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(5, connect=3),
                             follow_redirects=False)


async def require_current_public(owner: str, repo: str, *,
                                 client: httpx.AsyncClient | None = None) -> None:
    """Prevent sharing old cached maps if public source visibility is unverified.

    200: fresh public proof. 404: no longer public/exists, revoke local cache.
    403/429 or transport error: provider unverified; never send stale snapshot.
    Callers holding the per-repo import lock coalesce concurrent verifications.
    """
    safe_owner, safe_repo = parse_repository(f"{owner}/{repo}")
    key = (safe_owner + "/" + safe_repo).lower()
    now = time.monotonic()
    if _revoked_until.get(key, 0) > now:
        raise RepoError(
            "This repository is no longer publicly accessible. Its cached city is unavailable.", 404)
    if _public_proof_until.get(key, 0) > now:
        return
    cooldown = _provider_cooldown_until.get(key, 0)
    if cooldown > now:
        raise RepoError("GitHub public-visibility verification is cooling down. Retry shortly.",
                        503, retry_after=max(1, math.ceil(cooldown-now)))
    _provider_cooldown_until.pop(key, None)

    url = ("https://codeload.github.com/" + quote(safe_owner, safe="") +
           "/" + quote(safe_repo, safe="") + "/zip/HEAD")
    own_client = client is None
    if own_client:
        client = _new_client()
    assert client is not None
    try:
        try:
            response = await client.head(
                url,
                headers={"User-Agent": "GitCity/0.9", "Accept": "application/zip"},
                follow_redirects=False,
                timeout=httpx.Timeout(5, connect=3),
            )
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            _remember(_provider_cooldown_until, key, time.monotonic() + 15)
            raise RepoError(
                "Cannot verify that this cached repository is still public. Retry shortly.",
                503, retry_after=15) from exc

        if response.status_code == 200:
            mark_fresh_public(safe_owner, safe_repo)
            return

        if response.status_code == 404:
            # The same endpoint is used for new source ZIP imports, so a 404
            # means the previously public archive is not accessible now.
            from .github import invalidate_shared_graph
            invalidate_shared_graph(safe_owner, safe_repo)
            _public_proof_until.pop(key, None)
            _provider_cooldown_until.pop(key, None)
            _remember(_revoked_until, key, time.monotonic() + REVOKED_RECHECK_SECONDS)
            raise RepoError(
                "This repository is no longer publicly accessible. Its cached city is unavailable.", 404)

        if response.status_code in (403, 429):
            seconds = _retry_seconds(response)
            _remember(_provider_cooldown_until, key, time.monotonic() + seconds)
            raise RepoError(
                "GitHub is limiting public-visibility checks. Cached city is temporarily unavailable.",
                503, retry_after=seconds)
        # Redirects must not silently grant trust for a different canonical
        # owner/repo, nor should provider errors expose old cached source paths.
        _remember(_provider_cooldown_until, key, time.monotonic() + 15)
        raise RepoError(
            "Cannot confirm public access to this cached city. Retry shortly.",
            503, retry_after=15)
    finally:
        if own_client:
            await client.aclose()
