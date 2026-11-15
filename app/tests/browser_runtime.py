"""Portable browser launcher for GitCity offline visual acceptance tests.

Uses Google Chrome when available on GitHub runners; otherwise Playwright's
bundled Chromium. Set GITCITY_BROWSER_CHANNEL=chromium to force bundled.
"""
from __future__ import annotations
import os
import shutil

async def launch_test_browser(pw):
    requested=os.environ.get("GITCITY_BROWSER_CHANNEL","").strip()
    if requested.lower() in {"chromium","bundled"}:
        channel=None
    elif requested:
        channel=requested
    elif shutil.which("google-chrome") or shutil.which("google-chrome-stable"):
        channel="chrome"
    else:
        channel=None
    args={"headless":True,"args":["--no-sandbox"]}
    if channel:
        args["channel"]=channel
    return await pw.chromium.launch(**args)
