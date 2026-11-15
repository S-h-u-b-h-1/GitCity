"""Offline Chromium visual check for share-link entry points.

This fixture uses a synthetic HTTPS origin intercepted entirely by Playwright.
It exercises real browser pathname/query routing with mocked API responses.
No GitHub, Render or AI provider network calls occur.
"""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

from playwright.async_api import async_playwright
from app.tests.browser_runtime import launch_test_browser

from app.demo import build_demo

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'evidence'


def offline_assets():
    html = (ROOT / 'app/static/index.html').read_text()
    for tag in ('<link rel="stylesheet" href="/static/styles.css">',
                '<script defer src="/static/world.js"></script>',
                '<script defer src="/static/app.js"></script>'):
        html = html.replace(tag, '')
    css = (ROOT / 'app/static/styles.css').read_text()
    image = base64.b64encode((ROOT / 'app/static/city-concept.png').read_bytes()).decode()
    css = css.replace("url('/static/city-concept.png')", "url('data:image/png;base64," + image + "')")
    return html, css


async def verify(page, session, graph, fake_search):
    errors=[]
    page.on('pageerror', lambda exception: errors.append(str(exception)))
    html,css=offline_assets()
    async def serve_local_fixture(route):
        await route.fulfill(status=200,content_type='text/html',body=html)
    await page.route('https://gitcity.test/**',serve_local_fixture)
    address=('https://gitcity.test'+fake_search if fake_search.startswith('/')
             else 'https://gitcity.test/'+fake_search)
    await page.goto(address,wait_until='domcontentloaded')
    await page.add_style_tag(content=css)
    await page.evaluate('''({session,graph,search})=>{
      window.__FETCH_LOG__=[];
      // Use native URLSearchParams and the actual synthetic browser location.
      window.fetch=async(input,opts={})=>{
        const url=String(input);
        window.__FETCH_LOG__.push({url,method:opts.method||'GET'});
        let json=url==='/api/session'?session:
          url==='/api/my-repos/demo'?{id:'demo',graph}:
          url==='/api/my-repos/demo/issues'?{total:0,placed:0,unplaced:0,issues:[],byNode:{},partial:false}:
          url==='/api/tour'?{mode:'guided',steps:[]}:{error:'Unexpected URL'};
        if(url==='/api/my-repos'&&opts.method==='POST'){
          const requested=JSON.parse(opts.body||'{}').url;
          if(requested==='testowner/demo-city'){
            session.repositories=[{id:'demo',owner:'testowner',name:'demo-city',fullName:'testowner/demo-city'}];
            session.activeRepo='demo';
            json={id:'demo',graph};
          }
        }
        return new Response(JSON.stringify(json),{status:json.error?404:200,headers:{'Content-Type':'application/json'}});
      };
    }''',{'session':session,'graph':graph,'search':fake_search})
    await page.add_script_tag(content=(ROOT / 'app/static/world.js').read_text())
    await page.add_script_tag(content=(ROOT / 'app/static/app.js').read_text())
    await page.evaluate('document.dispatchEvent(new Event("DOMContentLoaded"))')
    return errors


async def main():
    OUT.mkdir(parents=True,exist_ok=True)
    demo=build_demo()
    demo.update({'name':'demo-city','owner':'testowner','source':'github',
                 'url':'https://github.com/testowner/demo-city','branch':'main'})
    async with async_playwright() as pw:
        browser=await launch_test_browser(pw)
        for width,height in [(1440,900),(390,844)]:
            page=await browser.new_page(viewport={'width':width,'height':height})
            session={'authenticated':True,'guest':True,'csrf':'fixture', 'repositories':[],
                     'activeRepo':None,'aiConfigured':False}
            errors=await verify(page,session,demo,'?repo=openwisp%2Fopenwisp-utils')
            await page.locator('#addRepoDialog').wait_for(state='visible',timeout=10000)
            assert await page.locator('#importInput').input_value()=='openwisp/openwisp-utils'
            calls=await page.evaluate('window.__FETCH_LOG__')
            assert not any(item['method']=='POST' for item in calls),calls
            assert not await page.evaluate('document.documentElement.scrollWidth>innerWidth')
            assert not errors,errors
            await page.screenshot(path=str(OUT/f'shared-link-invite-{width}.png'))
            print(f'{width}x{height}: share-link import prompt prefilled, no automatic import, no JS errors/overflow')
            await page.close()
            # Canonical /owner/repo links now import automatically on first visit.
            page=await browser.new_page(viewport={'width':width,'height':height})
            session={'authenticated':True,'guest':True,'csrf':'fixture', 'repositories':[],
                     'activeRepo':None,'aiConfigured':False}
            errors=await verify(page,session,demo,'/testowner/demo-city')
            await page.locator('#canvasStage').wait_for(state='visible',timeout=10000)
            assert await page.locator('#addRepoDialog').is_hidden()
            calls=await page.evaluate('window.__FETCH_LOG__')
            assert len([r for r in calls if r['url']=='/api/my-repos' and r['method']=='POST'])==1,calls
            assert page.url=='https://gitcity.test/testowner/demo-city',page.url
            assert not errors,errors
            await page.close()
            print(f'{width}x{height}: canonical path auto-opens without confirm or browser errors')
        page=await browser.new_page(viewport={'width':1440,'height':900})
        session={'authenticated':True,'guest':True,'csrf':'fixture',
                 'repositories':[{'id':'demo','owner':'testowner','name':'demo-city','fullName':'testowner/demo-city'}],
                 'activeRepo':'demo','aiConfigured':False}
        errors=await verify(page,session,demo,'/testowner/demo-city')
        await page.locator('#canvasStage').wait_for(state='visible',timeout=10000)
        assert await page.locator('#addRepoDialog').is_hidden()
        await page.locator('#repoMenuButton').click()
        assert await page.locator('#copyCityLink').is_visible()
        assert not errors,errors
        await page.screenshot(path=str(OUT/'shared-link-city-1440.png'))
        print('1440x900: existing city opens from same-repo link; copy-link menu action visible')
        await page.close()
        await browser.close()


if __name__=='__main__':asyncio.run(main())
