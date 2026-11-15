"""Opt-in integration against a disposable TLS PostgreSQL test database.

ONLY run when GITCITY_TEST_POSTGRES_DSN points to an isolated test database
with scripts/gitcity_public_cache.sql applied. Tests never create a real Neon
project or handle the production database connection.
"""
from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from app import archive_import, github, main, public_snapshot_pg
from app.demo import build_demo


@pytest.mark.asyncio
async def test_real_postgres_survives_ephemeral_restart_without_sharing_sessions(monkeypatch,tmp_path):
    dsn=os.getenv('GITCITY_TEST_POSTGRES_DSN','').strip()
    if not dsn:
        pytest.skip('Explicit disposable PostgreSQL TLS test URL not supplied')
    monkeypatch.setenv('GITCITY_PUBLIC_CACHE_DATABASE_URL',dsn)
    monkeypatch.setenv('APP_ENV','production')
    monkeypatch.setenv('APP_BASE_URL','https://repo.example')
    monkeypatch.setenv('REPOWORLD_EPHEMERAL_DEMO','1')
    monkeypatch.delenv('GITHUB_TOKEN',raising=False)
    monkeypatch.setattr(public_snapshot_pg,'_database_unavailable_until',0.0)
    name='qa-'+uuid4().hex[:12]
    key='testowner/'+name
    source_reads=[]
    async def source(owner,repo,client=None):
        source_reads.append((owner,repo))
        graph=build_demo()
        graph.update(owner=owner,name=repo,source='github',
                     url=f'https://github.com/{owner}/{repo}')
        return graph
    monkeypatch.setattr(archive_import,'get_public_archive_graph',source)
    ids=[]
    try:
        for i in range(2):
            # Simulate Render wiping its entire anonymous SQLite and RAM caches.
            github._GRAPH_CACHE.clear()
            main._import_locks.clear()
            monkeypatch.setenv('REPOWORLD_DB_PATH',str(Path(tmp_path)/f'guest-{i}.sqlite3'))
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app),
                base_url='https://repo.example',
            ) as visitor:
                csrf=(await visitor.get('/api/session')).json()['csrf']
                response=await visitor.post('/api/my-repos',json={'url':key},
                                            headers={'X-RepoWorld-CSRF':csrf})
                assert response.status_code==200,response.text
                data=response.json()
                assert data['graph']['url']==f'https://github.com/{key}'
                if i==1:
                    assert data['cacheStatus']=='recent-public-snapshot'
                ids.append(data['id'])
        assert ids[0]!=ids[1]
        assert source_reads==[('testowner',name)]
        verified=await public_snapshot_pg.read_public_graph('testowner',name)
        assert verified is not None and verified['source']=='github'
        assert not any(field in verified for field in ('csrf','session','api_key'))
    finally:
        # Remove only the unique test record from the disposable test database.
        import asyncpg
        connection=await asyncpg.connect(dsn=dsn,ssl='require',timeout=4)
        try:
            await connection.execute(
                'DELETE FROM gitcity_public_city_snapshots WHERE repo_key=$1',key
            )
        finally:
            await connection.close()
        github._GRAPH_CACHE.clear()
        main._import_locks.clear()
