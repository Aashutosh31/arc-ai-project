"""
Real-browser OAuth QA for MCP Phase 3.

Drives REAL Chromium through the provider authorization leg against the
local OAuth fixture:

  node harness (leg 1: discovery → DCR → authorize URL)
    → Chromium navigates to the authorize URL
    → fixture 302s to the ARC callback origin (local QA recorder)
    → recorder landing page shows code/state/iss (no tokens, ever)
    → driver POSTs code/state/iss back to the harness (/finish)
    → harness validates, exchanges, reconnects MCP, calls a tool

Also asserts the production client bundle ships the OAuth UI strings.

Run:
  1. pip install playwright   (system chromium via ARC_CHROMIUM_PATH)
  2. python client/tests/qa/test_mcp_oauth_browser.py
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

CHROMIUM_PATH = os.environ.get("ARC_CHROMIUM_PATH", "/usr/bin/chromium")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SERVER_DIR = os.path.join(REPO, "server")
CLIENT_DIST = os.path.join(REPO, "client", "dist")
FAILURES = []
LANDED = {}


def check(name, cond, detail=""):
    print(("  ok - " if cond else "  FAIL - ") + name + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


class Recorder(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/mcp/oauth/callback":
            LANDED["code"] = (qs.get("code") or [None])[0]
            LANDED["state"] = (qs.get("state") or [None])[0]
            LANDED["iss"] = (qs.get("iss") or [None])[0]
            LANDED["raw"] = self.path
            body = ("<html><body><h1>ARC OAuth callback received</h1>"
                    "<p>Completing authorization…</p></body></html>").encode()
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


def main():
    recorder = HTTPServer(("127.0.0.1", 0), Recorder)
    recorder_port = recorder.server_address[1]
    threading.Thread(target=recorder.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    callback_base = f"http://127.0.0.1:{recorder_port}"

    env = dict(os.environ)
    env["PUBLIC_BACKEND_URL"] = callback_base
    env["OAUTH_HARNESS_PORT"] = "45991"
    harness = subprocess.Popen(
        ["node", "tests/helpers/oauthBrowserHarness.js"],
        cwd=SERVER_DIR, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        line = harness.stdout.readline()
        handshake = json.loads(line)
    except Exception as exc:
        print("harness failed to start")
        print(harness.stdout.read())
        harness.terminate()
        sys.exit(1)
    check("harness ready with browser authorization URL", bool(handshake.get("authorizationUrl")))
    auth_url = handshake["authorizationUrl"]
    check("authorize URL targets the fixture AS", f":{handshake['fixturePort']}/as/authorize" in auth_url)
    check("authorize URL carries PKCE challenge", "code_challenge=" in auth_url and "code_challenge_method=S256" in auth_url)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROMIUM_PATH, args=["--no-sandbox", "--disable-gpu"])
        page = browser.new_page()
        page.goto(auth_url, wait_until="domcontentloaded", timeout=15000)
        # The fixture 302s straight to the ARC callback; wait for landing.
        deadline = time.time() + 10
        while time.time() < deadline and "code" not in LANDED:
            time.sleep(0.1)
        try:
            page.wait_for_url(f"{callback_base}/**", timeout=5000)
        except Exception:
            pass
        html = page.content()
        final_url = page.url
        browser.close()

    check("browser landed on the ARC OAuth callback", LANDED.get("code") is not None, page.url if not LANDED.get("code") else "")
    check("callback delivered an authorization code", bool(LANDED.get("code")))
    check("callback delivered state", bool(LANDED.get("state")))
    check("callback delivered RFC 9207 iss", LANDED.get("iss") == handshake.get("expectedIssuer"),
          f"iss={LANDED.get('iss')}")
    check("state binds the transaction id", (LANDED.get("state") or "").startswith("mcp_oauth_"))
    for secret in ("access_token", "refresh_token", "at_", "rt_"):
        check(f"no {secret} material in browser landing", secret not in (LANDED.get("raw") or "") and secret not in html)
    check("landing page is same-origin ARC callback", final_url.startswith(callback_base), final_url)

    # Hand the browser-observed values back for validation + exchange.
    payload = json.dumps({"code": LANDED.get("code"), "state": LANDED.get("state"), "iss": LANDED.get("iss")}).encode()
    req = urllib.request.Request("http://127.0.0.1:45991/finish", data=payload,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        result = json.loads(res.read().decode())
    check("browser state validated server-side", result.get("stateValid") is True, json.dumps(result)[:200])
    check("browser issuer validated server-side", result.get("issuerValid") is True, json.dumps(result)[:200])
    check("code exchanged (AUTHORIZED)", result.get("leg2") == "AUTHORIZED", json.dumps(result)[:200])
    check("MCP reconnected after browser authorization", result.get("connected") is True)
    check("tools discovered after browser authorization", (result.get("toolCount") or 0) > 0,
          json.dumps(result)[:200])
    check("tool executed after browser authorization", result.get("toolResultType") == "content",
          json.dumps(result)[:200])
    check("status authorized after browser flow", result.get("statusAuthorized") is True)
    check("full browser flow ok", result.get("ok") is True, json.dumps(result)[:300])

    # Production bundle ships the OAuth UI (build-inclusion proof).
    bundle_hits = {"OAuth / Automatic Authorization": False, "Forget authorization": False, "Reauthorize": False}
    if os.path.isdir(CLIENT_DIST):
        for root, _, files in os.walk(CLIENT_DIST):
            for fn in files:
                if not fn.endswith(".js"):
                    continue
                try:
                    with open(os.path.join(root, fn), encoding="utf-8", errors="ignore") as fh:
                        text = fh.read()
                except OSError:
                    continue
                for key in bundle_hits:
                    if key in text:
                        bundle_hits[key] = True
    for key, hit in bundle_hits.items():
        check(f"client bundle ships OAuth UI string: {key!r}", hit)

    recorder.shutdown()
    harness.terminate()
    print(f"\n{len(FAILURES)} browser QA failures" if FAILURES else "\nBROWSER OAUTH QA: all checks passed")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
