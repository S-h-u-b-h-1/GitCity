"""Public demo budgets must be persistent, transactional, and privacy-bounded."""
from concurrent.futures import ThreadPoolExecutor
import asyncio
import httpx
import pytest
from app import auth, main
from app.demo import build_demo
from app.quotas import Budget, BudgetExceeded, consume, reserve_ai, reserve_import


def env_setup(monkeypatch, tmp_path):
    monkeypatch.setenv('REPOWORLD_DB_PATH',str(tmp_path/'database.sqlite3'))
    monkeypatch.setenv('APP_ENV','production')
    monkeypatch.setenv('APP_BASE_URL','https://repo.example')
    monkeypatch.setenv('REPOWORLD_AI_GLOBAL_DAILY','2')
    monkeypatch.setenv('REPOWORLD_AI_GUEST_DAILY','10')
    monkeypatch.setenv('REPOWORLD_AI_GUEST_10MIN','10')
    monkeypatch.setenv('REPOWORLD_AI_IP_DAILY','10')


def test_transactional_quota_and_no_partial_debit(monkeypatch,tmp_path):
    env_setup(monkeypatch,tmp_path)
    specs=[Budget('small','visitor1',60,1),Budget('global','global',60,4)]
    consume(specs,now=100)
    with pytest.raises(BudgetExceeded) as err:consume(specs,now=101)
    assert err.value.retry_after==19
    # Denied request did not consume the global budget.
    consume([specs[1]],now=101)
    consume(specs,now=161)  # new fixed window


def test_concurrent_visitors_cannot_exceed_global_daily(monkeypatch,tmp_path):
    env_setup(monkeypatch,tmp_path)
    def attempt(i):
        try:reserve_ai('visitor-'+str(i), 'network-'+str(i));return True
        except BudgetExceeded:return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(attempt,range(14)))
    assert sum(results)==2
    with auth._database() as db:
        assert db.execute("SELECT count FROM request_quotas WHERE quota_key LIKE 'AI global daily:%'").fetchone()['count']==2


@pytest.mark.asyncio
async def test_production_import_limit_returns_retry_after(monkeypatch,tmp_path):
    env_setup(monkeypatch,tmp_path)
    monkeypatch.setenv('REPOWORLD_IMPORT_GUEST_HOURLY','1')
    async def fake_import(url):
        graph=build_demo()
        graph.update(owner='testorg',name='testrepo',url='https://github.com/testorg/testrepo',source='github')
        return graph
    monkeypatch.setattr(main,'get_repository_graph',fake_import)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='https://repo.example') as client:
        session=(await client.get('/api/session')).json()
        headers={'X-RepoWorld-CSRF':session['csrf']}
        first=await client.post('/api/my-repos',json={'url':'testorg/testrepo'},headers=headers)
        assert first.status_code==200
        second=await client.post('/api/my-repos',json={'url':'testorg/testrepo'},headers=headers)
        assert second.status_code==429
        assert int(second.headers['retry-after'])>0
        # A rejected import doesn't destroy the existing saved city.
        assert len((await client.get('/api/session')).json()['repositories'])==1


def test_dev_mode_does_not_exhaust_public_key_budget(monkeypatch,tmp_path):
    monkeypatch.setenv('REPOWORLD_DB_PATH',str(tmp_path/'dev.sqlite3'))
    monkeypatch.setenv('APP_ENV','development')
    monkeypatch.delenv('REPOWORLD_ENFORCE_BUDGETS',raising=False)
    for _ in range(100):reserve_ai('local','localhost')
    with auth._database() as db:
        assert db.execute("SELECT name FROM sqlite_master WHERE name='request_quotas'").fetchone() is None

@pytest.mark.asyncio
async def test_recent_public_city_reused_across_browsers_without_consuming_more_import_budget(monkeypatch,tmp_path):
    from app import github
    env_setup(monkeypatch,tmp_path)
    monkeypatch.setenv('REPOWORLD_IMPORT_GLOBAL_HOURLY','1')
    monkeypatch.setenv('REPOWORLD_IMPORT_GUEST_HOURLY','1')
    monkeypatch.setenv('REPOWORLD_EPHEMERAL_DEMO','1')
    monkeypatch.delenv('GITHUB_TOKEN',raising=False)
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()
    calls=[]
    async def fake_archive(owner,repo,client=None):
        calls.append((owner,repo))
        graph=build_demo()
        graph.update(owner=owner,name=repo,url=f'https://github.com/{owner}/{repo}',source='github')
        return graph
    monkeypatch.setattr('app.archive_import.get_public_archive_graph',fake_archive)
    transport=httpx.ASGITransport(app=main.app)
    async with (httpx.AsyncClient(transport=transport,base_url='https://repo.example') as first,
                httpx.AsyncClient(transport=transport,base_url='https://repo.example') as second):
        csrf1=(await first.get('/api/session')).json()['csrf']
        csrf2=(await second.get('/api/session')).json()['csrf']
        headers1={'X-RepoWorld-CSRF':csrf1}
        headers2={'X-RepoWorld-CSRF':csrf2}
        a=await first.post('/api/my-repos',json={'url':'public/demo'},headers=headers1)
        b=await second.post('/api/my-repos',json={'url':'public/demo'},headers=headers2)
        assert a.status_code==b.status_code==200,(a.text,b.text)
        assert a.json().get('cacheStatus') is None
        assert b.json().get('cacheStatus')=='recent-public-snapshot'
        assert len(calls)==1
        assert a.json()['id']!=b.json()['id']
        # Reusing the graph doesn't give another guest access to saved IDs.
        assert (await second.get('/api/my-repos/'+a.json()['id'])).status_code==404
        # A new uncached repo still hits the original global limit.
        denied=await second.post('/api/my-repos',json={'url':'public/another'},headers=headers2)
        assert denied.status_code==429
        assert 'global' in denied.text
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()

@pytest.mark.asyncio
async def test_force_refresh_remains_budgeted_even_for_cached_public_city(monkeypatch,tmp_path):
    from app import github
    env_setup(monkeypatch,tmp_path)
    monkeypatch.setenv('REPOWORLD_IMPORT_GUEST_HOURLY','1')
    monkeypatch.setenv('REPOWORLD_IMPORT_GLOBAL_HOURLY','1')
    monkeypatch.setenv('REPOWORLD_EPHEMERAL_DEMO','1')
    monkeypatch.delenv('GITHUB_TOKEN',raising=False)
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()
    async def fake_archive(owner,repo,client=None):
        graph=build_demo()
        graph.update(owner=owner,name=repo,url=f'https://github.com/{owner}/{repo}',source='github')
        return graph
    monkeypatch.setattr('app.archive_import.get_public_archive_graph',fake_archive)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='https://repo.example') as client:
        csrf=(await client.get('/api/session')).json()['csrf']
        headers={'X-RepoWorld-CSRF':csrf}
        assert (await client.post('/api/my-repos',json={'url':'public/demo'},headers=headers)).status_code==200
        refresh=await client.post('/api/my-repos',json={'url':'public/demo','refresh':True},headers=headers)
        assert refresh.status_code==429
        assert (await client.get('/api/session')).json()['repositories'][0]['fullName']=='public/demo'
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()

@pytest.mark.asyncio
async def test_expired_cache_no_longer_bypasses_import_budget(monkeypatch,tmp_path):
    from app import github
    env_setup(monkeypatch,tmp_path)
    monkeypatch.setenv('REPOWORLD_IMPORT_GUEST_HOURLY','1')
    monkeypatch.setenv('REPOWORLD_IMPORT_GLOBAL_HOURLY','1')
    monkeypatch.setenv('REPOWORLD_EPHEMERAL_DEMO','1')
    monkeypatch.delenv('GITHUB_TOKEN',raising=False)
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()
    async def fake_archive(owner,repo,client=None):
        graph=build_demo()
        graph.update(owner=owner,name=repo,url=f'https://github.com/{owner}/{repo}',source='github')
        return graph
    monkeypatch.setattr('app.archive_import.get_public_archive_graph',fake_archive)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='https://repo.example') as client:
        csrf=(await client.get('/api/session')).json()['csrf']
        headers={'X-RepoWorld-CSRF':csrf}
        assert (await client.post('/api/my-repos',json={'url':'public/demo'},headers=headers)).status_code==200
        key='public/demo'
        timestamp,graph=github._GRAPH_CACHE[key]
        github._GRAPH_CACHE[key]=(timestamp-github.GRAPH_TTL_SECONDS-1,graph)
        blocked=await client.post('/api/my-repos',json={'url':'public/demo'},headers=headers)
        assert blocked.status_code==429
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()


def test_balanced_import_burst_limit_is_transactional_and_separate_per_browser(monkeypatch,tmp_path):
    env_setup(monkeypatch,tmp_path)
    monkeypatch.setenv('REPOWORLD_IMPORT_GLOBAL_HOURLY','100')
    monkeypatch.setenv('REPOWORLD_IMPORT_GUEST_HOURLY','30')
    monkeypatch.setenv('REPOWORLD_IMPORT_GLOBAL_5MIN','12')
    monkeypatch.setenv('REPOWORLD_IMPORT_GUEST_5MIN','8')
    for _ in range(8):
        reserve_import('guest-a','proxy-shared-by-everyone')
    with pytest.raises(BudgetExceeded) as exc:
        reserve_import('guest-a','proxy-shared-by-everyone')
    assert 'browser 5-minute' in exc.value.detail
    for _ in range(4):
        reserve_import('guest-b','proxy-shared-by-everyone')
    with pytest.raises(BudgetExceeded) as exc:
        reserve_import('guest-c','proxy-shared-by-everyone')
    assert 'global 5-minute' in exc.value.detail
    with auth._database() as db:
        browser = db.execute("SELECT count FROM request_quotas WHERE quota_key LIKE 'Import browser 5-minute:%'").fetchall()
        assert sorted(row['count'] for row in browser)==[4,8]


@pytest.mark.asyncio
async def test_import_concurrency_cap_rejects_new_work_without_spending_quota(monkeypatch,tmp_path):
    env_setup(monkeypatch,tmp_path)
    monkeypatch.setattr(main,'_import_slots',asyncio.Semaphore(1))
    monkeypatch.setattr(main,'_import_jobs',0)
    started=asyncio.Event()
    release=asyncio.Event()
    async def hold():
        async with main._expensive_import_slot():
            started.set()
            await release.wait()
    async def queued():
        async with main._expensive_import_slot():
            return True
    owner=asyncio.create_task(hold())
    await started.wait()
    waiters=[asyncio.create_task(queued()) for _ in range(5)]
    for _ in range(10):
        if main._import_jobs==6:
            break
        await asyncio.sleep(0)
    assert main._import_jobs==6
    with pytest.raises(main.RepoError) as exc:
        async with main._expensive_import_slot():
            pytest.fail('Extra import should not enter the server')
    assert exc.value.status==503
    assert exc.value.retry_after==15
    release.set()
    assert all(await asyncio.gather(*waiters))
    await owner
    assert main._import_jobs==0


@pytest.mark.asyncio
async def test_cache_reuse_bypasses_burst_and_work_queue(monkeypatch,tmp_path):
    from app import github
    env_setup(monkeypatch,tmp_path)
    monkeypatch.setenv('REPOWORLD_EPHEMERAL_DEMO','1')
    monkeypatch.delenv('GITHUB_TOKEN',raising=False)
    monkeypatch.setenv('REPOWORLD_IMPORT_GLOBAL_HOURLY','1')
    monkeypatch.setenv('REPOWORLD_IMPORT_GLOBAL_5MIN','1')
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()
    monkeypatch.setattr(main,'_import_slots',asyncio.Semaphore(1))
    monkeypatch.setattr(main,'_import_jobs',0)
    async def fake_archive(owner,repo,client=None):
        graph=build_demo()
        graph.update(owner=owner,name=repo,url=f'https://github.com/{owner}/{repo}',source='github')
        return graph
    monkeypatch.setattr('app.archive_import.get_public_archive_graph',fake_archive)
    async with (httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='https://repo.example') as a,
                httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='https://repo.example') as b):
        csrf_a=(await a.get('/api/session')).json()['csrf']
        csrf_b=(await b.get('/api/session')).json()['csrf']
        h_a={'X-RepoWorld-CSRF':csrf_a}
        h_b={'X-RepoWorld-CSRF':csrf_b}
        first=await a.post('/api/my-repos',json={'url':'public/repo'},headers=h_a)
        assert first.status_code==200
        # A cache hit cannot spend more quotas, even if all work slots are busy.
        async with main._expensive_import_slot():
            cached=await b.post('/api/my-repos',json={'url':'public/repo'},headers=h_b)
        assert cached.status_code==200
        assert cached.json().get('cacheStatus')=='recent-public-snapshot'
        assert main._import_jobs==0
    github._GRAPH_CACHE.clear()
    main._import_locks.clear()
