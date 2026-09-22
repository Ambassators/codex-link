"""Optional real Chromium UI/OAuth integration test. No model or Tailscale simulation is represented as a live service.
Install developer-only dependency: python -m pip install playwright; python -m playwright install chromium
Run: python test/ui_browser.py. A system Chromium is used when found.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time
from urllib.parse import urlencode, urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
process = subprocess.Popen([shutil.which("node") or "node", str(ROOT / "test/fixtures/ui-server.mjs")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    info = json.loads(process.stdout.readline())
    admin_token = parse_qs(urlparse(info["adminUrl"]).fragment)["token"][0]
    errors = []
    with sync_playwright() as playwright:
        executable = os.environ.get("CHROMIUM_PATH")
        if not executable and not Path(playwright.chromium.executable_path).exists():
            executable = shutil.which("chromium") or shutil.which("google-chrome")
        browser = playwright.chromium.launch(headless=True, **({"executable_path": executable} if executable else {}))
        context = browser.new_context(viewport={"width": 1440, "height": 1100})
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(info["adminUrl"])
        page.get_by_text("Waiting for connection", exact=True).wait_for()
        assert "token=" not in page.url, "Private bootstrap token must leave browser address bar"
        assert page.get_by_role("button", name="Sign in to Codex").count() == 0
        assert page.locator("#step-client").get_attribute("open") is not None
        out = Path(os.environ.get("UI_SCREENSHOT_DIR", str(ROOT / "docs/screenshots")))
        out.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(out / "setup-first-run.png"), full_page=True)
        page.screenshot(path=str(out / "setup.png"), full_page=True)
        # The owner UI has no local tool runner. Requests originate at authenticated MCP.
        # Exercise the browser's actual pairing cookie, consent form and redirect CSP.
        admin_base = info["adminUrl"].split("/#")[0]
        ticket = context.request.post(admin_base + "/api/pair", headers={"X-Codex-Link-Admin": admin_token}, data={}).json()
        auth_page = context.new_page()
        auth_page.goto(ticket["url"])
        auth_page.get_by_role("heading", name="Browser paired").wait_for()
        callback = "https://chatgpt.com/connector_platform_oauth_redirect"
        client = context.request.post(info["publicUrl"] + "/oauth/register", data={"client_name": "Browser integration test", "redirect_uris": [callback], "token_endpoint_auth_method": "none"}).json()
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        resource = info["publicUrl"] + "/mcp"
        query = urlencode({"client_id": client["client_id"], "redirect_uri": callback, "response_type": "code", "scope": "bridge:read files:read files:write", "resource": resource, "state": "browser-state", "code_challenge_method": "S256", "code_challenge": challenge})
        # Only the final ChatGPT callback is intercepted: this is NOT a live ChatGPT connector test.
        auth_page.route(callback + "*", lambda route: route.fulfill(status=200, body="Browser-test callback received"))
        auth_page.goto(info["publicUrl"] + "/oauth/authorize?" + query)
        auth_page.get_by_role("button", name="Authorize", exact=True).click()
        try:
            auth_page.wait_for_url(callback + "*", timeout=5000)
        except Exception:
            print("Consent failure:", auth_page.locator("body").inner_text())
            raise
        returned = parse_qs(urlparse(auth_page.url).query)
        assert returned["state"] == ["browser-state"]
        result = context.request.post(info["publicUrl"] + "/oauth/token", form={"grant_type": "authorization_code", "client_id": client["client_id"], "redirect_uri": callback, "resource": resource, "code": returned["code"][0], "code_verifier": verifier})
        assert result.status == 200, result.text()
        bearer = result.json()["access_token"]
        ping = context.request.post(resource, headers={"Authorization": "Bearer " + bearer, "Accept": "application/json, text/event-stream"}, data={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        assert ping.status == 200 and "result" in ping.json()
        expect(page.locator("#step-projects")).to_have_attribute("open", "")
        page.get_by_role("button", name="Choose project folders...", exact=True).click()
        page.locator("#workspace-root").fill(info["root"])
        page.locator("#workspace-form button").click()
        page.locator("#workspaces strong").filter(has_text="ui-test-project").wait_for(state="attached")
        page.get_by_role("button", name="Done adding projects", exact=True).click()
        page.get_by_role("heading", name="Your client is authorized", exact=True).wait_for()
        page.reload()
        expect(page.locator('.tab[data-tab="activity"]')).to_have_attribute("aria-current", "page")
        page.locator('.tab[data-tab="setup"]').click()
        page.wait_for_timeout(1700)
        expect(page.locator('.tab[data-tab="setup"]')).to_have_attribute("aria-current", "page")
        args = {"workspace": "ui-test-project", "path": "approved-from-ui.txt", "text": "Real MCP write approved through the browser UI.\n", "expectedHash": None, "idempotencyKey": "browser-write"}
        result = context.request.post(resource, headers={"Authorization": "Bearer " + bearer, "Accept": "application/json, text/event-stream"}, data={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "file_write", "arguments": args}})
        assert result.json()["result"]["structuredContent"]["status"] == "awaiting_approval"
        assert not (Path(info["root"]) / args["path"]).exists()
        page.locator('.tab[data-tab="activity"]').click()
        page.get_by_role("button", name="Inspect", exact=True).click()
        page.get_by_role("button", name="Approve once", exact=True).click()
        expect(page.locator("#job-state")).to_have_text("completed")
        assert (Path(info["root"]) / args["path"]).read_text() == args["text"]
        page.locator('#update-compose > summary').click()
        page.locator('#update-text').fill('Focus on login first')
        page.get_by_role('button', name='Queue update', exact=True).click()
        expect(page.locator('#updates')).to_contain_text('queued')
        update_result = context.request.post(resource, headers={"Authorization": "Bearer " + bearer, "Accept": "application/json, text/event-stream"}, data={"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "bridge_status"}}).json()['result']
        assert 'Focus on login first' in update_result['content'][-1]['text']
        expect(page.locator('#updates')).to_contain_text('returned')
        page.locator('#update-text').fill('Cancel this update')
        page.get_by_role('button', name='Queue update', exact=True).click()
        page.get_by_role('button', name='Cancel update', exact=True).click()
        expect(page.locator('#updates')).to_contain_text('cancelled')
        page.screenshot(path=str(out / "activity.png"), full_page=True)
        for width in [375, 430, 768, 1100]:
            page.set_viewport_size({"width": width, "height": 932})
            for tab in ["setup", "activity", "permissions"]:
                page.locator('.tab[data-tab="' + tab + '"]').click()
                assert page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"), f"{tab} overflows at {width}px"
                if width == 430:
                    page.screenshot(path=str(out / (tab + "-mobile.png")), full_page=True)
        page.get_by_role("button", name="Pause access", exact=True).click()
        page.get_by_role("button", name="Resume access", exact=True).wait_for()
        paused = context.request.post(resource, headers={"Authorization": "Bearer " + bearer, "Accept": "application/json, text/event-stream"}, data={"jsonrpc": "2.0", "id": 3, "method": "ping"})
        assert paused.status == 503
        page.get_by_role("button", name="Resume access", exact=True).click()
        page.get_by_role("button", name="Pause access", exact=True).wait_for()
        browser.close()
        assert not errors, errors
        print("PASS: browser workspace creation, approval-gated real file write, activity rendering, responsive layout, token address-bar clearing, OAuth pairing/cookie/consent/redirect/PKCE/bearer.")
        print("No real ChatGPT account, native desktop capture, or Tailscale tunnel was exercised.")
finally:
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
