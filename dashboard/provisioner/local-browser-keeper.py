#!/usr/bin/env python3
"""Local browser-keeper for bux (HermesOS one-click-agent dogfood).

Replaces bux's Browser-Use-Cloud keeper with a real Google Chrome running on
THIS box. Launches headless Chrome with remote debugging on 127.0.0.1, writes
the same /home/bux/.claude/browser.env contract the rest of bux already reads
(BU_CDP_WS=ws://127.0.0.1:9222/devtools/browser/<uuid>), and supervises it.

One browser per box. Profile persists on disk so logins/cookies stick.
"""

import json
import os
import pwd
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PORT = int(os.environ.get("BUX_LOCAL_CDP_PORT", "9222"))
PROFILE_DIR = os.environ.get("BUX_LOCAL_PROFILE_DIR", "/home/bux/.browser-profile")
STATE_DIR = Path("/home/bux/.claude")
ENV_FILE = STATE_DIR / "browser.env"

CHROME = None
for _name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
    _found = shutil.which(_name)
    if _found:
        CHROME = _found
        break

# HIVRA_BROWSER_VIEW=1 (set by the bux-local-browser drop-in on Claude boxes)
# runs Chrome HEADFUL on the Xvfb display (DISPLAY=:99) so it can be streamed
# over noVNC, while keeping CDP on :9222 for the harness. Default stays headless.
CHROME_ARGS = ([] if os.environ.get("HIVRA_BROWSER_VIEW") == "1" else ["--headless=new"]) + [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=%d" % PORT,
    "--remote-allow-origins=*",
    "--user-data-dir=%s" % PROFILE_DIR,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--window-size=1280,720",
    "about:blank",
]

proc = None


def log(msg):
    print("[local-keeper] %s" % msg, flush=True)


def devtools_ws():
    url = "http://127.0.0.1:%d/json/version" % PORT
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read()).get("webSocketDebuggerUrl", "")


def write_env(ws):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ENV_FILE.with_suffix(".tmp")
    payload = (
        "BU_PROFILE_ID=local\n"
        "BU_BROWSER_ID=local\n"
        "BU_CDP_WS=%s\n"
        "BU_BROWSER_LIVE_URL=\n"
        "BU_BROWSER_EXPIRES_AT=%d\n"
    ) % (ws, int(time.time()) + 10 * 365 * 24 * 3600)
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(str(tmp), os.O_CREAT | os.O_WRONLY | os.O_EXCL | os.O_CLOEXEC, 0o640)
    try:
        os.write(fd, payload.encode())
    finally:
        os.close(fd)
    tmp.replace(ENV_FILE)
    try:
        u = pwd.getpwnam("bux")
        os.chown(str(ENV_FILE), u.pw_uid, u.pw_gid)
    except Exception:
        pass


def write_devtools_active_port(ws):
    # ws == ws://127.0.0.1:9222/devtools/browser/<uuid>. Chrome in --headless=new
    # does NOT write this file into a custom --user-data-dir, but the harness's
    # { profileDir } connect form reads it. So we write it ourselves in the exact
    # 2-line format Chrome uses: line1=port, line2=/devtools/browser/<uuid>.
    after = ws.split("://", 1)[-1]
    authority, _, path = after.partition("/")
    port = authority.rsplit(":", 1)[-1] if ":" in authority else str(PORT)
    f = Path(PROFILE_DIR) / "DevToolsActivePort"
    f.write_text("%s\n/%s\n" % (port, path))


def shutdown(*_):
    if proc and proc.poll() is None:
        proc.terminate()
    sys.exit(0)


def main():
    global proc
    if not CHROME:
        sys.exit("no chrome/chromium binary found on PATH")
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    os.makedirs(PROFILE_DIR, exist_ok=True)
    log("launching %s on 127.0.0.1:%d" % (CHROME, PORT))
    proc = subprocess.Popen(
        [CHROME] + CHROME_ARGS,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    ws = ""
    for _ in range(60):
        if proc.poll() is not None:
            sys.exit("chrome exited early rc=%s" % proc.returncode)
        try:
            ws = devtools_ws()
        except Exception:
            ws = ""
        if ws:
            break
        time.sleep(1)
    if not ws:
        proc.terminate()
        sys.exit("devtools endpoint not ready after 60s")
    write_env(ws)
    write_devtools_active_port(ws)
    log("wrote %s (BU_CDP_WS=%s)" % (ENV_FILE, ws))
    proc.wait()
    log("chrome exited rc=%s; exiting so systemd restarts us" % proc.returncode)
    sys.exit(1)


if __name__ == "__main__":
    main()
