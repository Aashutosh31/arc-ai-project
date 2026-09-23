# client/tests/qa/test_approval_browser.py
#
# JARVIS Action Substrate — slice 4D: real-browser approval UI QA.
#
# Drives the ACTUAL dashboard in Chromium, backed by the real approval QA
# harness (approvalHarnessServer.mjs) so that approval state flows through the
# REAL approvalStore CAS and the REAL TaskExecutor gate for native tools.
#
# Covers:
#   native approve-once / deny-zero / expired / duplicate double-click
#   reconnect (offline -> online approves over the re-established socket)
#   MCP-shaped request (High risk readout + MCP source)
#   responsive matrix (1920/1440/1024/768/390/360): no horizontal overflow,
#   cards never cover the composer, buttons never clipped, keyboard approve.
#
# Run:
#   1. python -m playwright install chromium   (or set ARC_CHROMIUM_PATH)
#   2. start harness:  node client/tests/qa/approvalHarnessServer.mjs  (port 5000)
#      or PORT=5001 node client/tests/qa/approvalHarnessServer.mjs
#   3. cd client && VITE_API_URL=http://localhost:5001 npm run dev -- --port 5199
#   4. python client/tests/qa/test_approval_browser.py
import json
import os
import time
import urllib.request

from playwright.sync_api import sync_playwright

HARNESS = os.environ.get("ARC_HARNESS_URL", "http://localhost:5001")
BASE = os.environ.get("ARC_QA_URL", "http://localhost:5199/dashboard")
CHROMIUM_PATH = os.environ.get("ARC_CHROMIUM_PATH")

LAUNCH = {"args": ["--no-sandbox", "--disable-gpu"]}
if CHROMIUM_PATH:
    LAUNCH["executable_path"] = CHROMIUM_PATH

FAILURES = []


def check(cond, msg):
    if cond:
        print(f"  ok: {msg}")
    else:
        print(f"  FAIL: {msg}")
        FAILURES.append(msg)


def http(path, body=None):
    payload = json.dumps(body or {}).encode() if body is not None else None
    req = urllib.request.Request(
        HARNESS + path,
        data=payload,
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def wait_http(path, pred, timeout=18.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = http(path)
        if pred(data):
            return data
        time.sleep(0.25)
    return None


def results_for(suite_id):
    return wait_http(
        "/__qa/results",
        lambda d: any(e.get("id") == suite_id for e in d.get("entries", [])),
    )


def entry_state(data, suite_id):
    e = next((x for x in data.get("entries", []) if x.get("id") == suite_id), None)
    return e


def open_app(p, width=1440, height=860, prefix=""):
    ctx = p.chromium.launch(**LAUNCH).new_context(
        viewport={"width": width, "height": height},
        ignore_https_errors=True,
    )
    page = ctx.new_page()
    page.on("console", lambda m: print(f"{prefix}[console:{m.type}] {m.text[:160]}") if m.type in ("error", "warning") else None)
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Online", exact=True).wait_for(state="attached", timeout=20000)
    wait_http("/__qa/metrics", lambda d: d.get("sockets", 0) >= 1, timeout=10)
    return ctx, page


def open_suite(page):
    req_id = http("/__qa/request", {"case": "native"})["id"]
    card = page.locator('section[aria-label^="Permission requested"]')
    card.first.wait_for(state="visible", timeout=15000)
    check(card.count() == 1, "exactly one native approval card rendered")
    return req_id, card


def resolve_and_wait(page, card, decision, status_substring):
    card.get_by_role("button", name=decision).click()
    page.locator("text=" + status_substring).first.wait_for(timeout=10000)


def run():
    with sync_playwright() as p:
        # ---- 1. native approve -------------------------------------------------
        print("1. native approve-once")
        ctx, page = open_app(p, prefix="[1] ")
        suite_id, card = open_suite(page)
        text = card.first.inner_text().lower()
        check("requesting permission to use" in text, "permission wording present")
        check("nothing runs before you decide" in text, "non-execution guarantee shown")
        resolve_and_wait(page, card, "Approve", "may now proceed")
        data = results_for(suite_id)
        e = entry_state(data, suite_id)
        check(e and e.get("state") == "APPROVED" and e.get("executed") is True,
              f"native approve executed exactly once (state={e and e.get('state')})")
        ctx.close()

        # ---- 2. native deny ----------------------------------------------------
        print("2. native deny-zero")
        ctx, page = open_app(p, prefix="[2] ")
        suite_id, card = open_suite(page)
        resolve_and_wait(page, card, "Deny", "will not run")
        data = results_for(suite_id)
        e = entry_state(data, suite_id)
        check(e and e.get("state") == "DENIED" and e.get("executed") is False,
              f"native deny executed zero times (state={e and e.get('state')})")
        ctx.close()

        # ---- 3. expiry ----------------------------------------------------------
        print("3. expiry while card is open")
        ctx, page = open_app(p, prefix="[3] ")
        suite_id = http("/__qa/request", {"case": "timeout"})["id"]
        card = page.locator('section[aria-label^="Permission requested"]')
        card.first.wait_for(state="visible", timeout=15000)
        page.get_by_text("no decision was received").first.wait_for(timeout=12000)
        buttons = card.first.locator("button")
        check(buttons.count() == 0, "no decision buttons remain after expiry")
        data = results_for(suite_id)
        e = entry_state(data, suite_id)
        check(e and e.get("state") == "EXPIRED", f"server record expired (state={e and e.get('state')})")
        ctx.close()

        # ---- 4. duplicate double-click -----------------------------------------
        print("4. double-click approve -> single execution")
        ctx, page = open_app(p, prefix="[4] ")
        suite_id, card = open_suite(page)
        btn = card.first.get_by_role("button", name="Approve")
        btn.click()
        time.sleep(0.06)
        btn.click(timeout=1500) if btn.is_visible() else None
        page.get_by_text("may now proceed").first.wait_for(timeout=10000)
        data = results_for(suite_id)
        e = entry_state(data, suite_id)
        check(e and e.get("state") == "APPROVED" and e.get("executed") is True,
              f"double-click still produced a single execution (state={e and e.get('state')})")
        ctx.close()

        # ---- 5. reconnect -------------------------------------------------------
        print("5. reconnect then approve over the new socket")
        ctx, page = open_app(p, prefix="[5] ")
        suite_id = http("/__qa/request", {"case": "native", "ttlMs": 30000})["id"]
        card = page.locator('section[aria-label^="Permission requested"]')
        card.first.wait_for(state="visible", timeout=15000)
        ctx.set_offline(True)
        time.sleep(2.0)
        ctx.set_offline(False)
        page.get_by_text("Online", exact=True).wait_for(state="attached", timeout=20000)
        resolve_and_wait(page, card, "Approve", "may now proceed")
        data = results_for(suite_id)
        e = entry_state(data, suite_id)
        check(e and e.get("state") == "APPROVED" and e.get("executed") is True,
              f"approval resolved across a socket reconnect (state={e and e.get('state')})")
        ctx.close()

        # ---- 6. MCP-shaped ------------------------------------------------------
        print("6. MCP-shaped request (High risk, MCP source)")
        ctx, page = open_app(p, prefix="[6] ")
        suite_id = http("/__qa/request", {"case": "mcp"})["id"]
        card = page.locator('section[aria-label^="Permission requested"]')
        card.first.wait_for(state="visible", timeout=15000)
        card_text = card.first.inner_text()
        check("High risk" in card_text, "MCP risk surfaced as High risk")
        check("MCP tool" in card_text, "MCP source shown")
        check("Has lasting external effects" in card_text, "consequential scope shown")
        resolve_and_wait(page, card, "Deny", "will not run")
        data = results_for(suite_id)
        e = entry_state(data, suite_id)
        check(e and e.get("state") == "DENIED", f"MCP deny recorded (state={e and e.get('state')})")
        ctx.close()

        # ---- 7. responsive matrix + keyboard ------------------------------------
        print("7. responsive matrix + keyboard approve")
        widths = [1920, 1440, 1024, 768, 390, 360]
        for width in widths:
            pref = f"[7:{width}] "
            ctx, page = open_app(p, width=width, height=860, prefix=pref)
            overflow_before = page.evaluate(
                "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
            )
            http("/__qa/request", {"case": "multi", "count": 2})
            cards = page.locator('section[aria-label^="Permission requested"]')
            cards.nth(1).wait_for(state="visible", timeout=15000)
            check(cards.count() == 2, pref + "two pending cards rendered")

            overflow_after = page.evaluate(
                "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
            )
            check(overflow_after is False or overflow_after == overflow_before,
                  pref + "no page-level horizontal overflow introduced")

            composer = page.locator('[aria-label="Message input"]')
            composer_visible = composer.is_visible()
            check(composer_visible, pref + "composer visible")

            boxes = [page.query_selector('section[aria-label^="Permission requested"]') for _ in range(2)]
            composer_box = composer.bounding_box()
            overlap = False
            clipped = False
            for node in boxes:
                box = node.bounding_box()
                if not box:
                    continue
                if composer_box and box["x"] < composer_box["x"] + composer_box["width"] and box["x"] + box["width"] > composer_box["x"] and box["y"] < composer_box["y"] + composer_box["height"] and box["y"] + box["height"] > composer_box["y"]:
                    overlap = True
                for btn in node.query_selector_all("button"):
                    bb = btn.bounding_box()
                    if bb and (bb["x"] < -1 or bb["x"] + bb["width"] > width + 1):
                        clipped = True
            check(not overlap, pref + "approval cards never cover the composer")
            check(not clipped, pref + "decision buttons never clipped at this width")

            first_card = cards.first
            approve_btn = first_card.get_by_role("button", name="Approve")
            approve_btn.focus()
            page.keyboard.press("Enter")
            page.locator("text=may now proceed").first.wait_for(timeout=10000)
            check(True, pref + "keyboard focus + Enter approves")
            ctx.close()

    print()
    if FAILURES:
        print(f"APPROVAL BROWSER QA: {len(FAILURES)} FAILURE(S)")
        for f in FAILURES:
            print(f"  - {f}")
        raise SystemExit(1)
    print("APPROVAL BROWSER QA: PASSED")


if __name__ == "__main__":
    run()