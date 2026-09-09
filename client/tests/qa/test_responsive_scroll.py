"""
Responsive scroll regression tests for the ARC-AI dashboard.

Covers two confirmed production bugs:
  1. Narrow-viewport wheel trap: `overscroll-behavior: contain` on the
     content-sized MessageArea stopped wheel/touch chaining, so the page
     never scrolled on mobile widths (ChatInterface.jsx).
  2. Tools panel ignored Escape (ToolsPanel.jsx had no key handler).

Plus guards: no page-level horizontal overflow, bottom reachable,
composer visible, drawer open/close.

Run:
  1. pip install playwright && python -m playwright install chromium
  2. npm run dev -- --port 5199   (from client/)
  3. python client/tests/qa/test_responsive_scroll.py
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("ARC_QA_URL", "http://localhost:5199/dashboard")
# Optional: point at a system Chromium instead of playwright's build, e.g.
# ARC_CHROMIUM_PATH=/usr/bin/chromium
CHROMIUM_PATH = os.environ.get("ARC_CHROMIUM_PATH")
LAUNCH_ARGS = {"args": ['--no-sandbox', '--disable-gpu']}
if CHROMIUM_PATH:
    LAUNCH_ARGS["executable_path"] = CHROMIUM_PATH
FAILURES = []

GUEST = {"token": "qa-token", "_id": "qa-user", "authType": "guest",
         "authProvider": "guest", "username": "Guest",
         "creditsRemaining": 12, "googleLinked": False}
WS = {"_id": "ws1", "name": "Main", "description": ""}
CONVS = [{"_id": "conv-long", "title": "QA thread",
          "updatedAt": "2026-09-09T12:00:00.000Z"}]
MSGS = None  # built below


def ai_block(i):
    return (
        f"## Section {i}\n\n" + ("Paragraph with **bold** and `code`.\n\n" * 6) +
        "```javascript\nconst value = await compute({\n  iterations: 42,\n  label: 'qa',\n});\nconsole.log(value);\n```\n\n" +
        "| Feature | A | B |\n|---|---|---|\n| Speed | Fast | Faster |\n| Tools | Yes | Yes |\n\n" +
        "- bullet one\n- bullet two\n  - nested item\n\n1. step one\n2. step two\n\n"
        "> A wise quote about caching.\n\n"
    )


def build_messages():
    msgs, mid = [], 0
    for i in range(6):
        mid += 1
        msgs.append({"_id": f"m{mid}", "role": "user",
                     "content": f"Question number {i + 1} about caching?", "metadata": {}})
        mid += 1
        msgs.append({"_id": f"m{mid}", "role": "ai", "content": ai_block(i + 1),
                     "metadata": {"streaming": False}})
    return {"messages": msgs}


MSGS = build_messages()
TAIL = "step two"


def mocks(page):
    page.route(lambda u: u.split('?')[0].endswith('/api/auth/guest'),
               lambda r: r.fulfill(status=200, content_type='application/json',
                                   body=json.dumps(GUEST)))
    page.route(lambda u: '/api/workspaces' in u,
               lambda r: r.fulfill(status=200, content_type='application/json',
                                   body=json.dumps({"workspace": WS} if '/active' in r.request.url
                                                   else {"workspaces": [WS]})))
    page.route(lambda u: '/api/conversations' in u and '/messages' not in u,
               lambda r: r.fulfill(status=200, content_type='application/json',
                                   body=json.dumps(CONVS)))
    page.route(lambda u: '/messages' in u,
               lambda r: r.fulfill(status=200, content_type='application/json',
                                   body=json.dumps(MSGS)))


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def doc_scroll(page):
    return page.evaluate("() => { const d = document.scrollingElement; "
                         "return {top: d.scrollTop, max: d.scrollHeight - d.clientHeight}; }")


with sync_playwright() as p:
    browser = p.chromium.launch(**LAUNCH_ARGS)

    # --- narrow: wheel must scroll the page (bug #1) ---
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.on("pageerror", lambda e: check("no pageerrors (narrow)", False, str(e)[:120]))
    mocks(page)
    page.goto(BASE, wait_until="networkidle", timeout=30000)
    page.get_by_text(TAIL).first.wait_for(timeout=20000)
    page.wait_for_timeout(800)
    de = doc_scroll(page)
    check("narrow page is scrollable", de["max"] > 1000, str(de))
    page.mouse.move(195, 400)
    page.mouse.wheel(0, 900)
    page.wait_for_timeout(500)
    moved = doc_scroll(page)["top"]
    check("narrow wheel scrolls page", moved > 100, f"top={moved}")
    ox = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check("no page horizontal overflow (390px)", ox <= 1, f"ox={ox}")
    # bottom reachable via End, composer visible
    page.keyboard.press("End")
    page.wait_for_timeout(500)
    vis = page.evaluate("() => { const t = document.querySelector('textarea[aria-label=\"Message input\"]');"
                        " const r = t.getBoundingClientRect(); return r.bottom <= innerHeight + 2; }")
    check("composer visible at bottom", vis)
    # drawer open + Escape/outside close (Escape closes overlay; drawer closes via outside tap)
    page.get_by_role("button", name="Toggle sidebar").click()
    page.wait_for_timeout(500)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    page.mouse.click(350, 400)
    page.wait_for_timeout(400)
    dx = page.evaluate("() => { const sb = [...document.querySelectorAll('div')].find(d => "
                       "d.textContent.includes('QA thread') && getComputedStyle(d).position==='fixed');"
                       " return sb ? Math.round(sb.getBoundingClientRect().x) : 'gone'; }")
    check("drawer closes", dx != 0, f"x={dx}")
    page.close()

    # --- desktop: internal area scrolls, tools Escape works (bug #2) ---
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("pageerror", lambda e: check("no pageerrors (desktop)", False, str(e)[:120]))
    mocks(page)
    page.goto(BASE, wait_until="networkidle", timeout=30000)
    page.get_by_text(TAIL).first.wait_for(timeout=20000)
    page.wait_for_timeout(800)
    top0 = page.evaluate("() => { const de = document.scrollingElement; de.scrollTop = 0; return 0; }")
    page.mouse.move(720, 400)
    page.mouse.wheel(0, 900)
    page.wait_for_timeout(500)
    check("desktop wheel does not move page", doc_scroll(page)["top"] == 0)
    page.keyboard.press("Control+k")
    page.wait_for_timeout(400)
    page.get_by_text("Open tools").click()
    page.wait_for_timeout(500)
    check("tools opens", page.get_by_role("dialog").count() > 0)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    check("tools closes on Escape", page.get_by_role("dialog").count() == 0)
    # --- voice dock: opens compact, conversation stays visible, Escape closes ---
    page.keyboard.press("Control+k")
    page.wait_for_timeout(400)
    page.get_by_text("Open voice mode").click()
    page.wait_for_timeout(600)
    check("voice dock opens", page.get_by_role("region", name="Voice control").count() > 0)
    check("voice dock is compact", page.evaluate(
        "() => { const d = document.querySelector('[aria-label=\"Voice control\"]');"
        " return d ? d.getBoundingClientRect().height < 400 : false; }"))
    check("conversation visible with dock", page.get_by_text(TAIL).count() > 0)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    check("voice dock closes on Escape",
          page.get_by_role("region", name="Voice control").count() == 0)
    # --- vision card: opens with composer, conversation stays visible ---
    page.keyboard.press("Control+k")
    page.wait_for_timeout(400)
    page.get_by_text("Open vision camera").click()
    page.wait_for_timeout(600)
    check("vision card opens", page.get_by_role("region", name="Live vision").count() > 0)
    check("vision question composer present",
          page.get_by_label("Ask about the camera view").count() > 0)
    check("conversation visible with card", page.get_by_text(TAIL).count() > 0)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    check("vision card closes on Escape",
          page.get_by_role("region", name="Live vision").count() == 0)
    page.close()
    browser.close()

print(f"\n{len(FAILURES)} failures: {FAILURES}" if FAILURES else "\nALL QA CHECKS PASS")
sys.exit(1 if FAILURES else 0)
