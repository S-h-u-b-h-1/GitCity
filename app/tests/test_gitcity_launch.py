"""GitCity native Vercel routing and browser origin regression contracts."""
from __future__ import annotations
import json
from pathlib import Path

import httpx
import pytest

from app import auth, main

ROOT = Path(__file__).resolve().parents[2]

def test_vercel_build_uses_native_fastapi_without_a_proxy():
    cfg = json.loads((ROOT / "vercel.json").read_text())
    assert cfg["framework"] == "fastapi"
    assert not cfg.get("rewrites")
    assert (ROOT / next(iter(cfg["functions"]))).is_file()


@pytest.mark.asyncio
async def test_direct_city_links_serve_the_application_shell():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://localhost") as client:
        home = await client.get("/")
        for path in ("/S-h-u-b-h-1/GitCity", "/S-h-u-b-h-1/GitCity/pull/31"):
            linked = await client.get(path)
            assert linked.status_code == 200 and linked.text == home.text
            assert linked.headers["cache-control"] == "no-cache"
        assert (await client.get("/api/missing")).status_code == 404
        assert (await client.post("/auth/preview")).status_code == 404
        assert (await client.get("/org/repo/pull/invalid")).status_code == 404
        assert (await client.get("/static/app.js")).status_code == 200


@pytest.mark.asyncio
async def test_vercel_without_durable_database_does_not_create_local_sessions(monkeypatch, tmp_path):
    sqlite = tmp_path / "must-not-exist.sqlite3"
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("VERCEL_URL", "gitcity-preview.vercel.app")
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "A" * 40)
    monkeypatch.setenv("REPOWORLD_DB_PATH", str(sqlite))
    monkeypatch.delenv("APP_BASE_URL", raising=False)
    monkeypatch.delenv("GITCITY_TURSO_DATABASE_URL", raising=False)
    monkeypatch.delenv("GITCITY_TURSO_AUTH_TOKEN", raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url=auth.base_url()) as client:
        health = (await client.get("/api/health")).json()
        assert health["runtime"] == "vercel" and health["revision"] == "a" * 12
        assert (await client.get("/api/ready")).status_code == 503
        session = await client.get("/api/session")
        assert session.status_code == 503
        assert "set-cookie" not in session.headers
    assert not sqlite.exists()


def test_vercel_origins_are_limited_to_the_current_environment(monkeypatch):
    monkeypatch.delenv("APP_BASE_URL", raising=False)
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("VERCEL_URL", "gitcity-preview.vercel.app")
    monkeypatch.setenv("VERCEL_BRANCH_URL", "gitcity-workbench.vercel.app")
    monkeypatch.setenv("VERCEL_PROJECT_PRODUCTION_URL", "gitcity-one.vercel.app")
    assert auth.base_url() == "https://gitcity-preview.vercel.app"
    assert auth.cookie_secure()
    assert auth._is_allowed_origin(None, "https://gitcity-workbench.vercel.app")
    assert not auth._is_allowed_origin(None, "https://gitcity-one.vercel.app")
    assert not auth._is_allowed_origin(None, "https://gitcity-preview.vercel.app.example.org")
    monkeypatch.setenv("VERCEL_ENV", "production")
    assert auth.base_url() == "https://gitcity-one.vercel.app"

def test_gitcity_visible_brand_preserves_old_public_backup_format():
    html = (ROOT / "app/static/index.html").read_text()
    script = (ROOT / "app/static/app.js").read_text()
    backup = (ROOT / "app/static/offline-city.js").read_text()
    assert "<title>GitCity" in html
    assert "RepoWorld" not in html and "REPOWORLD" not in html
    assert "— GitCity" in script
    assert "repoworld:offline-city:v1" in backup
    assert "repoworld-public-city-v1" in backup
    assert "gitcity-" in backup

def test_exact_gitcity_production_origin_is_allowed_but_attackers_blocked(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_BASE_URL", "https://repoworld-3b9e.onrender.com")
    monkeypatch.delenv("GITCITY_PUBLIC_ORIGIN", raising=False)
    assert auth._is_allowed_origin(None, "https://repoworld-3b9e.onrender.com")
    assert auth._is_allowed_origin(None, "https://gitcity-one.vercel.app")
    assert not auth._is_allowed_origin(None, "http://gitcity-one.vercel.app")
    assert not auth._is_allowed_origin(None, "https://gitcity-one.vercel.app.attacker.example")
    assert not auth._is_allowed_origin(None, "https://other-project.vercel.app")

def test_optional_custom_gitcity_origin_must_be_https(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_BASE_URL", "https://repoworld-3b9e.onrender.com")
    monkeypatch.setenv("GITCITY_PUBLIC_ORIGIN", "https://city.example.org")
    assert auth._is_allowed_origin(None, "https://city.example.org")
    monkeypatch.setenv("GITCITY_PUBLIC_ORIGIN", "http://unsafe.example.org")
    assert not auth._is_allowed_origin(None, "http://unsafe.example.org")
