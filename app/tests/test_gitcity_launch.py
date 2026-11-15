"""GitCity Vercel static launch and safe browser origin regression contracts."""
from __future__ import annotations
import json
from pathlib import Path
from app import auth

ROOT = Path(__file__).resolve().parents[2]

def test_vercel_static_root_and_proxy():
    cfg = json.loads((ROOT / "app/static/vercel.json").read_text())
    assert cfg["framework"] is None
    assert cfg["outputDirectory"] == "."
    rules = {rule["source"]: rule["destination"] for rule in cfg["rewrites"]}
    assert rules["/api/:path*"] == "https://repoworld-3b9e.onrender.com/api/:path*"
    assert rules["/static/:path*"] == "/:path*"
    assert (ROOT / "app/static/index.html").is_file()
    assert (ROOT / "app/static/world.js").is_file()

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
