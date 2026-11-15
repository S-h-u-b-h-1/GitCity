"""Optional durable PUBLIC-cache acceptance, without external databases or secrets.

The tests mock the asyncpg connection, enforce HTTPS transport, verify that
only canonical GitHub graphs are persisted, and exercise the real FastAPI
anonymous-browser boundary. A live Postgres rollout requires separate QA.
"""
from __future__ import annotations

import json
import time

import httpx
import pytest

from app import auth, github, main, public_snapshot_pg as pg
from app.demo import build_demo


class FakeTransaction:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        self.connection.in_transaction = True

    async def __aexit__(self, exc_type, exc, tb):
        self.connection.in_transaction = False


class FakeConnection:
    def __init__(self, row=None):
        self.row = row
        self.calls = []
        self.closed = False
        self.in_transaction = False

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self.row

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        assert self.in_transaction, "All durable writes must be transactional"

    def transaction(self):
        return FakeTransaction(self)

    async def close(self):
        self.closed = True


def public_graph(owner="public", repo="demo"):
    result = build_demo()
    result.update(owner=owner, name=repo, source="github",
                  url=f"https://github.com/{owner}/{repo}")
    return result


@pytest.mark.asyncio
async def test_pg_off_by_default_never_connects(monkeypatch):
    monkeypatch.delenv("GITCITY_PUBLIC_CACHE_DATABASE_URL", raising=False)
    async def forbidden(_dsn):
        raise AssertionError("A missing environment URL must never connect")
    monkeypatch.setattr(pg, "_connect", forbidden)
    assert await pg.read_public_graph("public", "demo") is None
    assert not await pg.write_public_graph("public", "demo", public_graph())


@pytest.mark.parametrize("bad", [
    "sqlite:///elsewhere.db", "http://db.example/gitcity",
    "postgresql://db.example/gitcity", "postgresql://user@db.example/gitcity",
    "postgresql://user:pass@db.example/", "postgresql://user:pass@",
])
def test_invalid_database_settings_fail_closed(monkeypatch, bad):
    monkeypatch.setenv("GITCITY_PUBLIC_CACHE_DATABASE_URL", bad)
    assert pg._dsn() is None


@pytest.mark.asyncio
async def test_tls_pg_read_rejects_old_or_mismatched_graphs(monkeypatch):
    monkeypatch.setenv("GITCITY_PUBLIC_CACHE_DATABASE_URL",
                       "postgresql://gitcity:secret@test-postgres.example/gitcity")
    now=int(time.time())
    good=public_graph()
    conn=FakeConnection({"graph_json": json.dumps(good), "cached_at": now - 500})
    async def connect(dsn):
        assert dsn.startswith("postgresql://gitcity:")
        return conn
    monkeypatch.setattr(pg, "_connect", connect)
    result=await pg.read_public_graph("public","demo")
    assert result["name"]=="demo"
    assert any("may be up to 12 hours old" in x for x in result["warnings"])
    assert conn.closed
    assert conn.calls[0][0]=="fetchrow"
    assert conn.calls[0][2][0]=="public/demo"

    malicious=public_graph()
    malicious["csrf"] = "never-store-or-return"
    conn2=FakeConnection({"graph_json":json.dumps(malicious), "cached_at":now})
    async def bad_connect(dsn): return conn2
    monkeypatch.setattr(pg,"_connect",bad_connect)
    assert await pg.read_public_graph("public","demo") is None
    assert conn2.closed

    wrong=public_graph("elsewhere","demo")
    conn3=FakeConnection({"graph_json":json.dumps(wrong), "cached_at":now})
    async def wrong_connect(dsn):return conn3
    monkeypatch.setattr(pg,"_connect",wrong_connect)
    assert await pg.read_public_graph("public","demo") is None
    assert conn3.closed


@pytest.mark.asyncio
async def test_pg_writes_are_transactional_bounded_and_public_only(monkeypatch):
    monkeypatch.setenv("GITCITY_PUBLIC_CACHE_DATABASE_URL",
                       "postgresql://gitcity:secret@test-postgres.example/gitcity")
    conn=FakeConnection()
    async def connect(_dsn):return conn
    monkeypatch.setattr(pg,"_connect",connect)
    assert await pg.write_public_graph("public","demo",public_graph())
    assert conn.closed
    writes=[x for x in conn.calls if x[0]=="execute"]
    assert len(writes)==3
    assert any("ON CONFLICT" in x[1] for x in writes)
    assert any(x[2]==(pg.MAX_ENTRIES,) for x in writes)
    upsert=next(x for x in writes if "ON CONFLICT" in x[1])
    assert upsert[2][0]=="public/demo"
    assert "csrf" not in upsert[2][1].lower()
    assert "rw_session" not in upsert[2][1]

    malicious=public_graph()
    malicious["session"]="private-cookie"
    assert not await pg.write_public_graph("public","demo",malicious)
    assert not await pg.write_public_graph("public","demo",public_graph("other","demo"))
    huge=public_graph()
    huge["description"]="A"*(pg.MAX_GRAPH_BYTES+1)
    assert not await pg.write_public_graph("public","demo",huge)
    assert len(conn.calls)==3


@pytest.mark.asyncio
async def test_provider_outage_is_a_safe_cache_miss(monkeypatch):
    monkeypatch.setenv("GITCITY_PUBLIC_CACHE_DATABASE_URL",
                       "postgresql://gitcity:secret@test-postgres.example/gitcity")
    async def outage(_dsn):
        raise ConnectionError("No database available")
    monkeypatch.setattr(pg,"_connect",outage)
    assert await pg.read_public_graph("public","demo") is None
    assert not await pg.write_public_graph("public","demo",public_graph())


@pytest.mark.asyncio
async def test_live_import_uses_remote_public_snapshot_without_spending_new_quota(monkeypatch,tmp_path):
    monkeypatch.setenv("REPOWORLD_DB_PATH",str(tmp_path/"guests.sqlite3"))
    monkeypatch.setenv("APP_ENV","production")
    monkeypatch.setenv("APP_BASE_URL","https://repo.example")
    monkeypatch.setenv("REPOWORLD_IMPORT_GLOBAL_HOURLY","1")
    monkeypatch.setenv("REPOWORLD_IMPORT_GLOBAL_5MIN","1")
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()
    calls=[]
    async def read(owner,repo):
        calls.append((owner,repo))
        return public_graph(owner,repo)
    async def no_import(*_args,**_kwargs):
        raise AssertionError("Fresh GitHub fetch must not happen for remote public cache")
    monkeypatch.setattr(pg,"read_public_graph",read)
    monkeypatch.setattr(main,"get_repository_graph",no_import)
    transport=httpx.ASGITransport(app=main.app)
    async with (httpx.AsyncClient(transport=transport,base_url="https://repo.example") as visitor1,
                httpx.AsyncClient(transport=transport,base_url="https://repo.example") as visitor2):
        h1={"X-RepoWorld-CSRF":(await visitor1.get("/api/session")).json()["csrf"]}
        h2={"X-RepoWorld-CSRF":(await visitor2.get("/api/session")).json()["csrf"]}
        a=await visitor1.post("/api/my-repos",json={"url":"public/demo"},headers=h1)
        b=await visitor2.post("/api/my-repos",json={"url":"public/demo"},headers=h2)
        assert a.status_code==b.status_code==200,(a.text,b.text)
        assert a.json()["cacheStatus"]=="recent-public-snapshot"
        assert b.json()["id"]!=a.json()["id"]
        assert len(calls)==1
        assert (await visitor2.get("/api/my-repos/"+a.json()["id"])).status_code==404
        # Remote cache hits have no new-import quota bucket.
        with auth._database() as db:
            has_quota_table=db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_quotas'"
            ).fetchone()
            if has_quota_table:
                assert db.execute(
                    "SELECT count(*) FROM request_quotas WHERE quota_key LIKE 'Import global hourly:%'"
                ).fetchone()[0]==0
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()


@pytest.mark.asyncio
async def test_real_import_populates_optional_durable_cache_best_effort(monkeypatch,tmp_path):
    monkeypatch.setenv("REPOWORLD_DB_PATH",str(tmp_path/"public.sqlite3"))
    monkeypatch.setenv("REPOWORLD_EPHEMERAL_DEMO","1")
    monkeypatch.delenv("GITHUB_TOKEN",raising=False)
    github._GRAPH_CACHE.clear()
    events=[]
    async def fresh(owner,repo,client=None):
        events.append("source")
        return public_graph(owner,repo)
    async def store(owner,repo,graph):
        assert graph["source"]=="github"
        events.append("durable-store")
        return True
    monkeypatch.setattr("app.archive_import.get_public_archive_graph",fresh)
    monkeypatch.setattr(pg,"write_public_graph",store)
    result=await github.get_repository_graph("public/demo")
    assert result["name"]=="demo"
    assert events==["source","durable-store"]
    github._GRAPH_CACHE.clear()
