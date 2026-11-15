"""Real offline Chromium smoke for GitCity pull-request impact UI.

The intercepted HTTPS page and public-GitHub fetch are fixture-only: no GitHub
provider quota, token, AI, production data, or external network access is used.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

from app.demo import build_demo
from app.tests.browser_runtime import launch_test_browser
from app.tests.share_links_browser_smoke import verify

ROOT=Path(__file__).resolve().parents[2]


async def main():
    graph=build_demo()
    graph.update(name="demo-city",owner="testowner",source="github",
                 url="https://github.com/testowner/demo-city",branch="main")
    path=graph["nodes"][0]["files"][0]
    async with async_playwright() as p:
        browser=await launch_test_browser(p)
        for width,height in [(1440,900),(390,844)]:
            page=await browser.new_page(viewport={"width":width,"height":height})
            session={"authenticated":True,"guest":True,"csrf":"fixture",
                     "repositories":[{"id":"demo","owner":"testowner","name":"demo-city",
                                       "fullName":"testowner/demo-city"}],
                     "activeRepo":"demo","aiConfigured":False}
            errors=await verify(page,session,graph,"/testowner/demo-city")
            await page.add_script_tag(content=(ROOT/"app/static/pr-impact.js").read_text())
            await page.evaluate("""({path})=>{
                window.__PR_HTTP_CALLS__=[];
                const existing=window.fetch;
                window.fetch=async(url,opts={})=>{
                    if(String(url).includes('/pulls/31/files?')){
                        window.__PR_HTTP_CALLS__.push({url:String(url),method:opts.method||'GET'});
                        return new Response(JSON.stringify([
                            {filename:path,status:'modified',additions:3,deletions:1},
                            {filename:'unknown/never-indexed.ts',status:'added',additions:9,deletions:0}
                        ]),{status:200,headers:{'Content-Type':'application/json'}});
                    }
                    return existing(url,opts);
                };
            }""",{"path":path})
            await page.locator("#canvasStage").wait_for(state="visible",timeout=10000)
            await page.locator("#mapCommandTrigger").click()
            await page.locator('[data-compass-tab="pr"]').click()
            await page.locator("#prInput").fill("31")
            await page.locator("#prLoad").click()
            await page.locator("#prResults .pr-file-row").first.wait_for(state="visible",timeout=9000)
            assert await page.locator("#prResults .pr-file-row").count()==2
            assert "1 UNMAPPED" in (await page.locator("#prStatus").inner_text())
            assert await page.locator("#prOpenGithub").get_attribute("href")==(
                "https://github.com/testowner/demo-city/pull/31")
            assert page.url=="https://gitcity.test/testowner/demo-city/pull/31",page.url
            assert len(await page.evaluate("window.__PR_HTTP_CALLS__"))==1
            assert await page.locator("#prResults .pr-file-row").first.get_attribute(
                "data-evidence")=="indexed-file"
            # Clearing the review removes only the map highlights and PR route.
            await page.locator("#prClear").click()
            assert page.url=="https://gitcity.test/testowner/demo-city"
            await page.evaluate("""({path})=>{
                window.__MORE_PAGE_CALLS__=[];
                const oldFetch=window.fetch;
                window.fetch=async(url,opts={})=>{
                    if(String(url).includes('/pulls/31/files?')){
                        const n=Number(new URL(String(url)).searchParams.get('page'));
                        window.__MORE_PAGE_CALLS__.push(n);
                        const rows=n===1?Array.from({length:100},(_,i)=>({
                            filename:'outside/file-'+i+'.py',status:'modified',additions:1,deletions:0
                        })):[{filename:path,status:'modified',additions:3,deletions:1}];
                        const headers={'Content-Type':'application/json'};
                        if(n===1)headers.Link='<https://api.github.com/repos/testowner/demo-city/pulls/31/files?per_page=100&page=2>; rel="next"';
                        return new Response(JSON.stringify(rows),{status:200,headers});
                    }
                    return oldFetch(url,opts);
                };
            }""",{"path":path})
            await page.locator("#prInput").fill("31")
            await page.locator("#prLoad").click()
            await page.locator("#prResults .pr-file-row").nth(99).wait_for(state="visible",timeout=12000)
            assert await page.locator("#prResults .pr-file-row").count()==100
            assert await page.locator("#prMore").is_visible()
            assert await page.evaluate("window.__MORE_PAGE_CALLS__")==[1]
            await page.locator("#prMore").click()
            await page.locator("#prResults .pr-file-row").nth(100).wait_for(state="visible",timeout=12000)
            assert await page.locator("#prResults .pr-file-row").count()==101
            assert await page.evaluate("window.__MORE_PAGE_CALLS__")==[1,2]
            assert await page.locator("#prMore").is_hidden()
            assert "1 FILE MATCH" in (await page.locator("#prStatus").inner_text())
            await page.locator("#prResults button.pr-file-row").click()
            await page.locator("#inspector").wait_for(state="visible",timeout=9000)
            assert not await page.evaluate("document.documentElement.scrollWidth>innerWidth")
            assert not errors,errors
            print(f"{width}x{height}: PR route sharing, 100+1 on-demand pages, city inspector OK")
            await page.close()
        await browser.close()


if __name__=="__main__":
    asyncio.run(main())
