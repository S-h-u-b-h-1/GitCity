"""Offline Chromium acceptance for opt-in public-city recovery after Render reset.

One actual browser context is used across two page visits. HTTP responses for
the GitCity backend are locally mocked; no network, GitHub API, AI, billing or
production database access is used. LocalStorage persists across visits.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

from app.demo import build_demo
from app.tests.browser_runtime import launch_test_browser
from app.tests.share_links_browser_smoke import offline_assets

ROOT=Path(__file__).resolve().parents[2]


async def serve(page,graph,*,outage=False):
    html,css=offline_assets()
    async def fixture(route):
        await route.fulfill(status=200,content_type="text/html",body=html)
    await page.route("https://gitcity.test/**",fixture)
    await page.goto("https://gitcity.test/testowner/demo-city",wait_until="domcontentloaded")
    await page.add_style_tag(content=css)
    await page.evaluate("""({graph,outage})=>{
        window.__VAULT_HTTP_CALLS__=[];
        window.fetch=async(input,opts={})=>{
            const url=String(input),method=opts.method||'GET';
            window.__VAULT_HTTP_CALLS__.push({url,method});
            if(url==='/api/session'&&outage){
              return new Response(JSON.stringify({error:'Backend temporarily unavailable'}),{
                status:503,headers:{'Content-Type':'application/json'}});
            }
            const session={authenticated:true,guest:true,csrf:'test-secret-csrf',
              repositories:[{id:'demo',owner:'testowner',name:'demo-city',
                            fullName:'testowner/demo-city'}],
              activeRepo:'demo',aiConfigured:false};
            const result=url==='/api/session'?session:
              url==='/api/my-repos/demo'?{id:'demo',graph}:
              url==='/api/my-repos/demo/issues'?{
                total:0,placed:0,unplaced:0,issues:[],byNode:{},partial:false}:
              url==='/api/tour'?{mode:'guided',steps:[]}:
              {error:'Unexpected API request '+url};
            return new Response(JSON.stringify(result),{
              status:result.error?404:200,
              headers:{'Content-Type':'application/json'}});
        };
    }""",{"graph":graph,"outage":outage})
    for script in ("world.js","offline-city.js","city-vault.js","app.js"):
        await page.add_script_tag(content=(ROOT/"app"/"static"/script).read_text())
    await page.evaluate('document.dispatchEvent(new Event("DOMContentLoaded"))')


async def exercise(browser,width,height):
    ctx=await browser.new_context(viewport={"width":width,"height":height})
    errors=[]
    graph=build_demo()
    graph.update(name="demo-city",owner="testowner",source="github",
                 url="https://github.com/testowner/demo-city",branch="main")
    try:
        live=await ctx.new_page()
        live.on("pageerror",lambda error:errors.append(str(error)))
        dialogs=[]
        live.on("dialog",lambda dialog:dialogs.append(dialog.message))
        await serve(live,graph)
        await live.locator("#canvasStage").wait_for(state="visible",timeout=12000)
        assert await live.evaluate(
          "window.localStorage.getItem('gitcity:public-recovery-vault:v1')") is None
        await live.locator("#repoMenuButton").click()
        await live.locator("#vaultToggle").click()
        await live.wait_for_function(
          "window.localStorage.getItem('gitcity:public-recovery-opt-in:v1')==='1'")
        saved=await live.evaluate(
          "window.localStorage.getItem('gitcity:public-recovery-vault:v1')")
        assert saved and "testowner/demo-city" in saved
        assert "test-secret-csrf" not in saved
        assert "token_hash" not in saved
        assert await live.locator("#vaultMenuCities .vault-city-button").count()==1
        assert not dialogs,"Opt-in must work without native confirmation popups"
        await live.close()

        # Simulate a cold backend with missing temporary SQLite and no session.
        lost=await ctx.new_page()
        lost.on("pageerror",lambda error:errors.append(str(error)))
        await serve(lost,graph,outage=True)
        await lost.locator("#vaultRecovery").wait_for(state="visible",timeout=10000)
        assert await lost.locator("#vaultEmptyCities .vault-city-button").count()==1
        initial=await lost.evaluate("window.__VAULT_HTTP_CALLS__.length")
        await lost.locator("#vaultEmptyCities .vault-city-button").click()
        await lost.locator("#canvasStage").wait_for(state="visible",timeout=10000)
        assert await lost.locator("#mapCoverageLabel").inner_text()=="Offline map"
        await lost.locator("#mapCoverageLabel").click()
        label=await lost.locator("#cityStatusText").inner_text()
        assert "LOCAL OFFLINE PREVIEW" in label,label
        await lost.locator("#mapCoverageLabel").click()
        assert await lost.evaluate("window.__VAULT_HTTP_CALLS__.length")==initial
        assert not await lost.evaluate("document.documentElement.scrollWidth>innerWidth")
        await lost.locator("#repoMenuButton").click()
        assert await lost.locator("#reconnectOfflineCity").is_visible()
        await lost.locator("#reconnectOfflineCity").click()
        assert await lost.locator("#addRepoDialog").is_visible()
        assert await lost.locator("#importInput").input_value()=="testowner/demo-city"
        assert await lost.evaluate("window.__VAULT_HTTP_CALLS__.length")==initial
        assert not errors,errors
        print(f"{width}x{height}: opt-in public city saved; backend 503; recovered offline; reimport awaits confirmation")
        await lost.close()
    finally:
        await ctx.close()


async def main():
    async with async_playwright() as pw:
        browser=await launch_test_browser(pw)
        try:
            await exercise(browser,1440,900)
            await exercise(browser,390,844)
        finally:
            await browser.close()


if __name__=="__main__":
    asyncio.run(main())
