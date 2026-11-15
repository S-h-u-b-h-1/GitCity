"""Fail-closed verification of shared public GitHub city snapshots.

A stale snapshot must not become a new browser's city when GitHub hides or
deletes the source. The visibility probe uses HEAD only; fresh imports continue
to work and cache hits do not spend new-import quota.
"""
from __future__ import annotations

import httpx
import pytest

from app import archive_import, auth, github, main, public_visibility as proof
from app.demo import build_demo


@pytest.fixture(autouse=True)
def reset_visibility_tables(monkeypatch):
    monkeypatch.setattr(proof, "_public_proof_until", {})
    monkeypatch.setattr(proof, "_revoked_until", {})


def public_graph(owner="public", repo="demo"):
    graph=build_demo()
    graph.update(owner=owner,name=repo,source="github",
                 url=f"https://github.com/{owner}/{repo}")
    return graph


def head_client(status=200, *, headers=None, observations=None):
    calls=observations if observations is not None else []
    def handler(req):
        calls.append((req.method,str(req.url),dict(req.headers)))
        assert req.method=="HEAD"
        assert req.url.host=="codeload.github.com"
        assert "authorization" not in req.headers
        assert "cookie" not in req.headers
        return httpx.Response(status,headers=headers or {})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler)),calls


@pytest.mark.asyncio
async def test_recent_positive_visibility_proof_avoids_extra_provider_requests():
    client,calls=head_client(status=200)
    async with client:
        await proof.require_current_public("public","demo",client=client)
        await proof.require_current_public("PUBLIC","demo",client=client)
    assert len(calls)==1
    assert calls[0][1]=="https://codeload.github.com/public/demo/zip/HEAD"
    assert proof._public_proof_until["public/demo"]>0


@pytest.mark.asyncio
async def test_revoked_public_repo_is_denied_and_local_snapshot_purged(monkeypatch,tmp_path):
    monkeypatch.setenv("REPOWORLD_DB_PATH",str(tmp_path/"private-transition.sqlite3"))
    github._GRAPH_CACHE.clear()
    github._cache_public_graph("public","demo",public_graph())
    assert github.cached_public_graph("public","demo") is not None

    client,calls=head_client(status=404)
    async with client:
        with pytest.raises(github.RepoError) as err:
            await proof.require_current_public("public","demo",client=client)
        assert err.value.status==404
        with pytest.raises(github.RepoError):
            await proof.require_current_public("public","demo",client=client)
    assert len(calls)==1,"negative visibility proofs must avoid repeat provider calls"
    assert github._GRAPH_CACHE.get("public/demo") is None
    with auth._database() as db:
        assert db.execute(
            "SELECT COUNT(*) FROM public_city_cache WHERE repo_key=?",
            ("public/demo",)).fetchone()[0]==0
    github._GRAPH_CACHE.clear()


@pytest.mark.parametrize("status,seconds",[
    (403,60), (429,23), (302,15), (500,15),
])
@pytest.mark.asyncio
async def test_unverified_provider_status_fails_closed_with_retry(status,seconds):
    client,calls=head_client(status,headers={"Retry-After":"23"} if status==429 else {})
    async with client:
        with pytest.raises(github.RepoError) as err:
            await proof.require_current_public("public","demo",client=client)
    assert err.value.status==503
    assert err.value.retry_after==seconds
    assert len(calls)==1
    assert "public/demo" not in proof._public_proof_until


@pytest.mark.asyncio
async def test_transport_failure_fails_closed_with_retry():
    def network_error(request):
        raise httpx.ReadTimeout("test timeout", request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(network_error)) as client:
        with pytest.raises(github.RepoError) as err:
            await proof.require_current_public("public","demo",client=client)
    assert err.value.status==503
    assert err.value.retry_after==15


@pytest.mark.asyncio
async def test_fresh_live_import_and_cache_hit_proof_then_private_transition(monkeypatch,tmp_path):
    monkeypatch.setenv("APP_ENV","production")
    monkeypatch.setenv("APP_BASE_URL","https://repo.example")
    monkeypatch.setenv("REPOWORLD_DB_PATH",str(tmp_path/"guests.sqlite3"))
    monkeypatch.setenv("REPOWORLD_EPHEMERAL_DEMO","1")
    monkeypatch.setenv("REPOWORLD_IMPORT_GLOBAL_HOURLY","1")
    monkeypatch.setenv("REPOWORLD_IMPORT_GLOBAL_5MIN","1")
    monkeypatch.delenv("GITHUB_TOKEN",raising=False)
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()
    src=[]
    async def source(owner,repo,client=None):
        src.append((owner,repo))
        return public_graph(owner,repo)
    monkeypatch.setattr(archive_import,"get_public_archive_graph",source)

    heads=[]
    client,calls=head_client(200,observations=heads)
    monkeypatch.setattr(proof,"_new_client",lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda req: httpx.Response(
                200 if len(heads)==0 else 404)
        )
    ))
    # HEAD responses are tested below using a deterministic switch.
    status={"code":200}
    def provider(req):
        heads.append((req.method,str(req.url)))
        return httpx.Response(status["code"])
    monkeypatch.setattr(proof,"_new_client",lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(provider)))

    transport=httpx.ASGITransport(app=main.app)
    async with (httpx.AsyncClient(transport=transport,base_url="https://repo.example") as a,
                httpx.AsyncClient(transport=transport,base_url="https://repo.example") as b,
                httpx.AsyncClient(transport=transport,base_url="https://repo.example") as c,
                httpx.AsyncClient(transport=transport,base_url="https://repo.example") as d):
        async def headers(client):
            return {"X-RepoWorld-CSRF":(await client.get("/api/session")).json()["csrf"]}
        h_a,h_b,h_c,h_d=await headers(a),await headers(b),await headers(c),await headers(d)

        first=await a.post("/api/my-repos",json={"url":"public/demo"},headers=h_a)
        assert first.status_code==200,first.text
        assert src==[("public","demo")]
        assert len(heads)==0,"Fresh source archive is already a public-visibility proof"

        second=await b.post("/api/my-repos",json={"url":"public/demo"},headers=h_b)
        assert second.status_code==200,second.text
        assert second.json()["cacheStatus"]=="recent-public-snapshot"
        assert len(heads)==0,"Recent public proof should avoid extra HEAD calls"
        assert first.json()["id"]!=second.json()["id"]

        proof._public_proof_until["public/demo"]=0
        third=await c.post("/api/my-repos",json={"url":"public/demo"},headers=h_c)
        assert third.status_code==200,third.text
        assert len(heads)==1
        assert src==[("public","demo")]

        proof._public_proof_until["public/demo"]=0
        status["code"]=404
        fourth=await d.post("/api/my-repos",json={"url":"public/demo"},headers=h_d)
        assert fourth.status_code==404,fourth.text
        assert "no longer publicly accessible" in fourth.text
        assert len(heads)==2
        assert src==[("public","demo")],"A private repo must not trigger a new source download"
        with auth._database() as db:
            assert db.execute(
                "SELECT COUNT(*) FROM public_city_cache WHERE repo_key='public/demo'"
            ).fetchone()[0]==0
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()
