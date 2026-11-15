"""Public GitCity release identity and readiness consistency."""
import httpx
import pytest

from app import main


@pytest.mark.asyncio
async def test_release_identity_matches_between_health_and_ready(monkeypatch):
    monkeypatch.setenv("APP_ENV","development")
    monkeypatch.setenv("RENDER_GIT_COMMIT","A"*40)
    monkeypatch.delenv("GITCITY_BUILD_SHA",raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url="http://testserver") as c:
        h=(await c.get("/api/health")).json()
        r=(await c.get("/api/ready")).json()
    assert h["ok"] is True and h["product"]=="GitCity"
    assert r["ready"] is True
    assert h["version"]==r["version"]==main.app.version
    assert h["revision"]==r["revision"]=="a"*12


@pytest.mark.asyncio
async def test_release_identity_suppresses_invalid_git_sha(monkeypatch):
    monkeypatch.setenv("APP_ENV","development")
    monkeypatch.setenv("RENDER_GIT_COMMIT","<script>bad env</script>")
    monkeypatch.setenv("GITCITY_BUILD_SHA","b"*40)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url="http://testserver") as c:
        h=await c.get("/api/health")
        r=await c.get("/api/ready")
    assert "revision" not in h.json() and "revision" not in r.json()
    assert h.json()["version"]==r.json()["version"]
    assert "script" not in h.text
    monkeypatch.setenv("RENDER_GIT_COMMIT","")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url="http://testserver") as c:
        h=(await c.get("/api/health")).json()
        r=(await c.get("/api/ready")).json()
    assert h["revision"]==r["revision"]=="b"*12
