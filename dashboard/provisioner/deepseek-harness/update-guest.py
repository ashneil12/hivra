#!/usr/bin/env python3
"""Owned in-place runtime update for one installed DeepSeek guest.

Run as root by the guest half of the runtime updater
(hivra-guest-runtime-update.sh), never as an API or CLI of its own:

    update-guest.py SOURCE INSTALLED

SOURCE is the new reviewed bundle, staged root-only by the updater. INSTALLED
is the bundle this computer was installed from. A computer updated before
carries the bundle of its last update in RECORDED instead, and that one wins.

The update only replaces what Hivra owns, and only when the computer is
exactly the generation that reference bundle installed: the gateway tree, the
pinned native package and the service unit must match it byte for byte, and
the service must be the running owned generation. A customized computer is
refused before anything stops. The new gateway, and a new package when its
pins moved, are staged before the old service stops; the swap is two renames;
the new generation must prove the same readiness a fresh install proves. Any
failure stops the new generation, puts the previous one back and starts it.

The configuration and intent files that launch wrote stay as they are. Model
keys, the agent's files and its private home are never read or touched.
Restarting the service ends work in flight in the native agent: the owner is
told that before they confirm.

Prints one line, ``HIVRA_DEEPSEEK_UPDATE_V1 {json}``, on success.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import time

LOCK = Path("/run/hivra-agent-install.lock")
RECORDED = Path("/var/lib/hivra/deepseek-update-source")
PREVIOUS = Path("/opt/hivra/.deepseek-previous")
GUEST = "deepseek-harness/install-guest.py"
# Worst case from stopping the old generation to a proved new one (or back):
# the stop, the start and the readiness wait, with margin.
SWITCH_SECONDS = 170


class UpdateError(Exception):
    pass


def reject(code):
    raise UpdateError("DeepSeek runtime update: " + code)


def load(source, name):
    """Import one bundle's guest composition (and the owner and package
    modules beside it) under its own name, so two generations never share
    module state."""
    path = source / GUEST
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def lock():
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            reject("unsafe installation lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            reject("another installation or update is running")
        return fd
    except BaseException:
        os.close(fd)
        raise


def reference(installed):
    """The bundle that produced this computer's current generation."""
    return RECORDED if os.path.lexists(RECORDED) else installed


def kept_file(guest, path):
    """A file launch wrote and the update keeps: root-owned, 0644, as is."""
    guest.files.ancestors(path.parent)
    raw = guest.files.read_regular(path, 64 * 1024)
    if stat.S_IMODE(path.lstat().st_mode) != 0o644:
        reject("custom configuration; explicit repair required")
    return raw


def stage_gateway(guest, assets, parent):
    pending = parent / "gateway"
    pending.mkdir(mode=0o755)
    pending.chmod(0o755)
    (pending / "deepseek-harness").mkdir(mode=0o755)
    (pending / "deepseek-harness").chmod(0o755)
    for relative, raw in assets.items():
        guest.files.exclusive_file(pending / relative, raw)
    return pending


def stage_package(guest, source, parent):
    """Install the new pinned package beside the live one, never over it."""
    live = guest.files.RUNTIME
    guest.files.RUNTIME = parent / "runtime"
    try:
        guest.files.install_package(source / "deepseek-harness")
        return guest.files.RUNTIME
    finally:
        guest.files.RUNTIME = live


def stop_any(guest):
    """Stop whichever generation the unit now names and prove it is gone."""
    guest.owner.service("stop", guest.owner.SERVICE, timeout=30)
    if not guest.owner.empty(guest.owner.state()):
        reject("service generation remains unresolved; computer needs repair")


def record_source(source):
    """Keep the new bundle as the reference for this computer's next update."""
    parent = RECORDED.parent
    if not os.path.lexists(parent):
        parent.mkdir(mode=0o711)
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        reject("unsafe update record directory")
    pending = Path(tempfile.mkdtemp(prefix=".deepseek-update-source-", dir=parent))
    try:
        copy = pending / "source"
        shutil.copytree(source, copy, symlinks=True)
        os.chmod(copy, 0o700)
        if os.path.lexists(RECORDED):
            os.rename(RECORDED, pending / "replaced")
        os.rename(copy, RECORDED)
    finally:
        shutil.rmtree(pending)


def budget():
    """Seconds this update may take, when its caller bounds it; else None."""
    raw = os.environ.get("HIVRA_RUNTIME_UPDATE_SECONDS", "")
    if raw == "":
        return None
    if not raw.isdigit() or len(raw) > 6:
        reject("invalid update budget")
    return int(raw)


def update(source, installed, started=None, seconds=None):
    started = time.monotonic() if started is None else started
    retained = reference(installed)
    new, old = load(source, "hivra_deepseek_update_next"), load(retained, "hivra_deepseek_update_current")
    new.owner.require_root()
    new_assets, old_assets = new.source_assets(source), old.source_assets(retained)
    old_template = old.files.read_regular(old.owner.TEMPLATE, 8192, False)
    new_template = new.files.read_regular(new.owner.TEMPLATE, 8192, False)

    # The computer must be exactly the generation its reference bundle made.
    old.verify_gateway(old_assets)
    old.files.verified_existing()
    before = old.owner.verify_running()
    kept_file(new, new.CONFIG)
    kept_file(new, new.INTENT)

    changed = {
        "gateway": new_assets != old_assets,
        "package": new.files.PINS != old.files.PINS or new.files.VERSION != old.files.VERSION,
        "unit": new_template != old_template,
    }
    if not any(changed.values()):
        record_source(source)
        return {"version": 1, "changed": changed, "service": before}

    gateway, runtime, unit = new.GATEWAY, new.files.RUNTIME, new.owner.UNIT_FILE
    work = Path(tempfile.mkdtemp(prefix=".deepseek-update-", dir=gateway.parent))
    swapped = {"gateway": False, "package": False, "unit": False}
    try:
        staged_gateway = stage_gateway(new, new_assets, work) if changed["gateway"] else None
        staged_runtime = stage_package(new, source, work) if changed["package"] else None
        if changed["unit"]:
            new.files.exclusive_file(work / "unit", new_template)
        # Only switch generations when the caller's bound still covers the
        # whole switch; until here the old generation never stopped.
        if seconds is not None and time.monotonic() - started + SWITCH_SECONDS > seconds:
            reject("not enough time left to switch generations; nothing was changed")

        old.owner.stop_owned()
        try:
            if staged_gateway:
                os.rename(gateway, work / "previous-gateway")
                swapped["gateway"] = True
                os.rename(staged_gateway, gateway)
            if staged_runtime:
                os.rename(runtime, work / "previous-runtime")
                swapped["package"] = True
                os.rename(staged_runtime, runtime)
            if changed["unit"]:
                new.files.exclusive_file(work / "previous-unit", old_template)
                swapped["unit"] = True
                os.replace(work / "unit", unit)
            new.owner.service("daemon-reload")
            new.owner.definition()
            new.owner.service("start", new.owner.SERVICE, timeout=30)
            running = new.wait_ready()
            new.verify_gateway(new_assets)
            package = new.files.verified_existing()
        except BaseException:
            rollback(new, old, work, swapped, gateway, runtime, unit)
            raise

        # Committed: the previous generation stays on disk once, for repair.
        if os.path.lexists(PREVIOUS):
            shutil.rmtree(PREVIOUS)
        os.rename(work, PREVIOUS)
        work = None
        record_source(source)
        return {"version": 1, "changed": changed, "service": running, "package": package}
    finally:
        if work is not None and os.path.lexists(work):
            shutil.rmtree(work)


def rollback(new, old, work, swapped, gateway, runtime, unit):
    """Put the previous generation back and start it. A rollback that cannot
    finish leaves the service stopped and says the computer needs repair."""
    stop_any(new)
    if swapped["gateway"]:
        if os.path.lexists(gateway):
            os.rename(gateway, work / "failed-gateway")
        os.rename(work / "previous-gateway", gateway)
    if swapped["package"]:
        if os.path.lexists(runtime):
            os.rename(runtime, work / "failed-runtime")
        os.rename(work / "previous-runtime", runtime)
    if swapped["unit"]:
        os.replace(work / "previous-unit", unit)
    old.owner.service("daemon-reload")
    old.owner.definition()
    old.owner.service("start", old.owner.SERVICE, timeout=30)
    old.wait_ready()


def main(argv):
    if len(argv) != 3:
        reject("usage")
    source, installed = Path(argv[1]), Path(argv[2])
    if not source.is_absolute() or not installed.is_absolute():
        reject("bundle paths must be absolute")
    started, seconds = time.monotonic(), budget()
    fd = lock()
    try:
        result = update(source, installed, started, seconds)
    finally:
        os.close(fd)
    digest = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    print("HIVRA_DEEPSEEK_UPDATE_V1 " + json.dumps({**result, "receiptSha256": digest}, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as error:  # Only fixed rejection text, never a secret.
        message = str(error) if isinstance(error, UpdateError) or type(error).__name__ == "InstallError" else "update failed"
        print(message, file=sys.stderr)
        sys.exit(1)
