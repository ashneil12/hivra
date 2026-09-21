#!/usr/bin/env python3
"""Private DeepSeek guest composition, called under the shared installer lock.

No CLI, allocation, lease release, key delivery or public-readiness claim. Only
a fresh base may run the shared bootstrap. Replays verify and reuse immutable
assets without re-running a root installer from the agent-writable bux tree.
"""
import importlib.util
import grp
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import tempfile
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("deepseek_service_owner", Path(__file__).with_name("service-owner.py"))
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
files = owner.files
GATEWAY = Path("/opt/hivra/deepseek-gateway")
CONFIG = Path("/etc/hivra/deepseek-native.json")
INTENT = Path("/etc/hivra/deepseek-install.json")
BASE = Path("/opt/bux")
HOME = Path("/home/bux")
BASE_UNITS = ("bux-ttyd.service", "bux-box-ttyd.service", "bux-local-browser.service", "bux-browser-keeper.service",
              "bux-agent.service", "bux-tg.service", "bux-miniapp.service", "bux-miniapp-tunnel.service",
              "hivra-xvfb.service", "hivra-x11vnc.service", "hivra-novnc.service")
BASE_PATHS = tuple(Path(path) for path in ("/etc/bux", "/etc/sudoers.d/bux", "/etc/sudoers.d/hivra-tg",
    "/etc/sudoers.d/hivra-browser", "/usr/local/bin/hivra-agent-shell", "/usr/local/bin/hivra-tg-apply",
    "/usr/local/bin/hivra-browser-apply", "/usr/local/bin/ttyd", "/var/log/bux",
    "/usr/local/bin/tg-send", "/usr/local/bin/bux-restart", "/usr/local/bin/tg-approve",
    "/etc/at.allow", "/etc/ssh/sshd_config.d/00-bux.conf", "/etc/sudoers.d/bux-dev",
    "/usr/local/bin/browser-harness-js", "/usr/local/bin/bux-agent-shell", "/usr/local/bin/tg-schedule",
    "/usr/local/bin/tg-schedule-fire", "/usr/local/bin/tg-run-task", "/usr/local/bin/new-topic", "/usr/local/bin/schedule"))
ASSETS = {
    **{name: "hivra-chat/" + name for name in ("server.js", "llm-application.js", "guarded-files.cjs", "agent-zero-editor.cjs", "index.html", "app.js")},
    **{"deepseek-harness/" + name: "deepseek-harness/" + name
       for name in ("native-broker.cjs", "gateway-policy.cjs", "runtime-process.cjs")},
}


def reject(code):
    raise files.InstallError("DeepSeek guest installation: " + code)


def source_assets(source):
    # Provider bundles arrive root-owned through the verified bundle protocol.
    # Do not execute/copy an agent-writable checkout under root authority.
    files.ancestors(source)
    # Imports and shell bootstrap also consume files beyond the gateway. The
    # authenticated controller already pinned the bundle; enforce its root-only
    # filesystem handoff before executing any part of it.
    for current, directories, names in os.walk(source, followlinks=False):
        for name in directories:
            files.directory(Path(current) / name)
        for name in names:
            files.read_regular(Path(current) / name, 2 * 1024 * 1024)
    result = {}
    for target, relative in ASSETS.items():
        path = source / relative
        files.ancestors(path.parent)
        result[target] = files.read_regular(path, 2 * 1024 * 1024)
    return result


def root_directory(path, provider_parent=False):
    files.ancestors(path.parent)
    if not path.parent.stat().st_mode & 0o001:
        reject("native ancestor is not traversable; explicit repair required")
    if not os.path.lexists(path):
        path.mkdir(mode=0o755)
        path.chmod(0o755)
    files.ancestors(path)
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode in (0o711, 0o755):
        return
    if provider_parent and mode == 0o700 and {entry.name for entry in path.iterdir()} == {"provider-bundle"}:
        # The verified delivery protocol intentionally creates /opt/hivra as
        # 0700. Permit traversal to the new public runtime without exposing its
        # directory listing or the still-private source/launch material below
        # provider-bundle. Never relax a custom tree or any child permissions.
        private = path / "provider-bundle"
        files.ancestors(private)
        if stat.S_IMODE(private.stat().st_mode) == 0o700:
            path.chmod(0o711)
            return
    reject("native directory mode requires explicit repair")


def exact_file(path, expected):
    files.ancestors(path.parent)
    if not os.path.lexists(path):
        return False
    if files.read_regular(path, len(expected) + 1) != expected or stat.S_IMODE(path.lstat().st_mode) != 0o644:
        reject("custom configuration; explicit repair required")
    return True


def publish_file(path, expected):
    if exact_file(path, expected):
        return
    stage = Path(tempfile.mkdtemp(prefix=".deepseek-config-", dir=path.parent))
    try:
        pending = stage / "value"
        files.exclusive_file(pending, expected)
        files.publish(pending, path)
    finally:
        shutil.rmtree(stage)  # Only this invocation's root-owned temporary dir.


def verify_gateway(assets):
    files.ancestors(GATEWAY)
    expected_paths = set(assets) | {"deepseek-harness"}
    actual_paths = set()
    for current, directories, names in os.walk(GATEWAY, followlinks=False):
        for name in directories + names:
            path = Path(current) / name
            relative = path.relative_to(GATEWAY).as_posix()
            actual_paths.add(relative)
            if relative == "deepseek-harness":
                files.directory(path)
                if stat.S_IMODE(path.stat().st_mode) != 0o755:
                    reject("custom gateway directory mode; explicit repair required")
            elif relative not in assets or not exact_file(path, assets[relative]):
                reject("custom gateway; explicit repair required")
    if actual_paths != expected_paths or stat.S_IMODE(GATEWAY.stat().st_mode) != 0o755:
        reject("incomplete gateway; explicit repair required")


def publish_gateway(assets):
    if os.path.lexists(GATEWAY):
        verify_gateway(assets)
        return
    stage = Path(tempfile.mkdtemp(prefix=".deepseek-gateway-", dir=GATEWAY.parent))
    try:
        pending = stage / "gateway"
        pending.mkdir(mode=0o755)
        pending.chmod(0o755)
        (pending / "deepseek-harness").mkdir(mode=0o755)
        (pending / "deepseek-harness").chmod(0o755)
        for relative, raw in assets.items():
            files.exclusive_file(pending / relative, raw)
        files.publish(pending, GATEWAY)
    finally:
        shutil.rmtree(stage)
    verify_gateway(assets)


def base_exists():
    try:
        pwd.getpwnam("bux")
        return True
    except KeyError:
        pass
    try:
        grp.getgrnam("bux")
        return True
    except KeyError:
        pass
    if any(os.path.lexists(path) for path in (BASE, HOME, *BASE_PATHS)):
        return True
    for unit in BASE_UNITS:
        # Even a runtime/vendor unit with no /etc fragment is a custom base.
        raw = owner.service("show", "--property=LoadState", "--property=FragmentPath", "--property=DropInPaths", unit)
        if set(raw.splitlines()) != {b"LoadState=not-found", b"FragmentPath=", b"DropInPaths="}:
            return True
        if any(os.path.lexists(Path("/etc/systemd/system") / suffix) for suffix in (unit, unit + ".d")):
            return True
    return False


def wait_ready(timeout=95):
    # Internal readiness only. Public native rendering and real model replies
    # are separate acceptance checks. Disable proxies from operator settings.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        before = owner.definition()
        try:
            with client.open("http://127.0.0.1:8080/healthz", timeout=2) as response:
                if response.status == 200:
                    with client.open("http://127.0.0.1:8080/api/meta", timeout=2) as metadata:
                        value = json.loads(metadata.read(4097))
                        if metadata.status == 200 and value.get("agentKind") == "deepseek-harness" and value.get("nativeSurface") == "/" and value.get("nativeReady") is True:
                            running = owner.verify_running()
                            if before["InvocationID"] != running["invocationId"] or before["MainPID"] != str(running["supervisorPid"]):
                                reject("service generation changed across readiness observation")
                            return running
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(0.5)
    reject("native readiness deadline exceeded")


def install(launch, source, bootstrap):
    owner.require_root()
    assets = source_assets(source)
    # parse_launch is the authority for the exact v2 shape. This module is not
    # another external launch parser and must never be exposed as a CLI.
    config = (json.dumps({"version": 1, "publicOrigin": launch["publicOrigin"]}, separators=(",", ":")) + "\n").encode()
    intent = files.canonical({"version": 1, "computerSubstrate": launch["computerSubstrate"], "browserEnabled": launch["wantBrowser"] is True})
    files.ancestors(Path(__file__).parent)
    template = files.read_regular(owner.TEMPLATE, 8192)
    state = owner.definition(allow_missing=True)
    reused = state["LoadState"] != "not-found"
    if not reused and base_exists():
        reject("existing base requires explicit adoption or repair")
    root_directory(CONFIG.parent)
    root_directory(GATEWAY.parent, provider_parent=True)
    # Inspect every retained asset before stopping anything or bootstrapping.
    exact_file(CONFIG, config)
    exact_file(INTENT, intent)
    if os.path.lexists(GATEWAY):
        verify_gateway(assets)
    if os.path.lexists(files.RUNTIME):
        files.verified_existing()
    if reused and (not os.path.lexists(CONFIG) or not os.path.lexists(INTENT) or not os.path.lexists(GATEWAY) or not os.path.lexists(files.RUNTIME)):
        reject("incomplete retained runtime; explicit repair required")
    owner.stop_owned()
    if not reused:
        bootstrap()
    # The shared base must not have started or installed a different gateway.
    owner.stop_owned()
    package = files.install_package(source / "deepseek-harness")
    publish_gateway(assets)
    publish_file(CONFIG, config)
    publish_file(INTENT, intent)
    publish_file(owner.UNIT_FILE, template)
    owner.service("daemon-reload")
    owner.definition()
    try:
        owner.service("enable", owner.SERVICE)
        owner.service("start", owner.SERVICE, timeout=30)
        running = wait_ready()
    except Exception:
        # A failed launch must not leave Restart=always churning. Unknown stop
        # outcomes remain failures and the enclosing computer operation owns
        # cleanup; this module never releases its authority or deletes a VM.
        owner.stop_owned()
        raise
    return {"package": package, "service": running, "baseReused": reused, "publicAccessVerified": False}
