#!/usr/bin/python3 -I
"""Root helper for the optional Claude app on a Hivra Ubuntu Desktop computer.

The Claude desktop app for Linux is Anthropic's proprietary software. Hivra does
not bundle it: ``install`` downloads the single pinned package from Anthropic's
own repository, checks its size and SHA-256 against ``claude-desktop-pin.json``
(a file of this bundle), and unpacks it without root inside the existing
contained desktop. The computer's owner signs in to the unmodified app
themselves; no Hivra service receives or reads that sign-in, and this program
never handles a Claude credential itself.

Hivra's isolation proof for the desktop container is unchanged: this program
adds no mount, no port and no privilege to it. Everything it does to the desktop
is ``docker exec`` as the container's unprivileged desktop user, from root on the
VM, with fixed argv.

The container is created with ``--rm`` and one mount, so its home disappears on
every desktop restart. To keep the app's own profile (its sign-in, its settings)
across restarts, this program takes a size-capped tar snapshot of that profile
into one root-only file on the same VM and puts it back before the app starts.
That file is a backup of the app's own data on the owner's own computer, so it
holds whatever the app keeps there, a sign-in session included. It is never read
by any Hivra service, never leaves the VM, and is deleted by ``remove``.

Verbs (the gateway reaches them through one scoped sudoers rule):
  status            print one JSON document
  install           start adding/updating the pinned app as its own systemd job
  install-run       the job itself (internal; not in the sudoers grant)
  mode app|desktop  full-screen app view, or the app in a window on the desktop
  remove            stop, disable and delete the app and its saved profile
  supervise         the systemd service: restore, launch, keep it running
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

CONTAINER = "hivra-selkies-desktop"
DESKTOP_USER = "ubuntu"
HOME = "/home/ubuntu"
DISPLAY = ":20"
DOCKER = "/usr/bin/docker"
STATE = Path("/var/lib/hivra/claude-app")
CACHE = Path("/var/cache/hivra/claude-desktop")
PIN_FILE = Path("/usr/local/share/hivra/claude-desktop-pin.json")
ENABLED = STATE / "enabled"
MODE_FILE = STATE / "mode"
SNAPSHOT = STATE / "profile.tar.gz"
INSTALL_LOCK = STATE / "install.lock"
LAST_ERROR = STATE / "last-error"
APP_ROOT = f"{HOME}/.local/opt/claude-desktop"
LAUNCHER = f"{HOME}/.local/bin/hivra-claude-app-launch"
DESKTOP_ENTRY = f"{HOME}/.local/share/applications/claude-desktop.desktop"
# Chromium caches are large and rebuilt on demand; everything else under the
# app's config directory is the profile (sign-in, settings, local sessions).
SNAPSHOT_EXCLUDES = (
    ".config/Claude/Cache", ".config/Claude/Code Cache", ".config/Claude/GPUCache",
    ".config/Claude/DawnGraphiteCache", ".config/Claude/DawnWebGPUCache",
    ".config/Claude/Crashpad", ".config/Claude/logs", ".config/Claude/blob_storage",
    ".config/Claude/Service Worker/CacheStorage", ".config/Claude/SingletonLock",
    ".config/Claude/SingletonCookie", ".config/Claude/SingletonSocket",
    ".config/Claude/claude-code", ".config/Claude/vm_bundles",
)
SNAPSHOT_INTERVAL_SECONDS = 120
# A profile larger than this is not backed up (the previous backup is kept) rather
# than filling the VM's memory or disk.
SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
INSTALL_UNIT = "hivra-claude-app-install.service"
STREAM_CHUNK = 1 << 20
MODES = ("app", "desktop")
VERSION_RE = re.compile(r"^[0-9]{1,4}\.[0-9]{1,6}\.[0-9]{1,6}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
URL_RE = re.compile(r"^https://downloads\.claude\.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_[0-9.]+_amd64\.deb$")

LAUNCHER_SCRIPT = """#!/bin/bash
# Written by hivra-claude-app. The app runs with no session bus on purpose: on
# the pinned desktop image an app that reaches the secret service makes the KDE
# wallet wizard appear and block the window until someone answers it, and the
# app keeps its own settings in its profile either way.
export DISPLAY={display}
export XDG_RUNTIME_DIR=/tmp/runtime-{user}
export XDG_CURRENT_DESKTOP=KDE
export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
exec {root}/current/usr/lib/claude-desktop/claude-desktop --no-sandbox --password-store=basic "$@"
"""


def log(message: str) -> None:
    print(f"hivra-claude-app: {message}", file=sys.stderr, flush=True)


def run(argv, *, check=True, input_bytes=None, capture=True, timeout=120):
    result = subprocess.run(
        argv, input=input_bytes, stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None, timeout=timeout, check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"{argv[0]} failed ({result.returncode}): "
                           f"{(result.stderr or b'').decode('utf-8', 'replace')[:300]}")
    return result


def in_container(argv, *, check=True, input_bytes=None, timeout=120, detach=False, env=None):
    command = [DOCKER, "exec"]
    if detach:
        command.append("-d")
    if input_bytes is not None:
        command.append("-i")
    command += ["-u", DESKTOP_USER, "-e", f"DISPLAY={DISPLAY}"]
    for key, value in (env or {}).items():
        command += ["-e", f"{key}={value}"]
    command += [CONTAINER] + list(argv)
    return run(command, check=check, input_bytes=input_bytes, timeout=timeout)


def container_running() -> bool:
    result = run([DOCKER, "inspect", "--format", "{{.State.Running}}", CONTAINER], check=False)
    return result.returncode == 0 and result.stdout.strip() == b"true"


def stream_from_file(argv, path: Path, timeout=600) -> None:
    """Run argv with the file as stdin, streamed (never held in memory)."""
    with path.open("rb") as handle:
        result = subprocess.run(argv, stdin=handle, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"{argv[0]} failed ({result.returncode}): {result.stderr.decode('utf-8', 'replace')[:300]}")


def stream_to_file(argv, path: Path, limit: int, timeout=300):
    """Run argv writing its stdout to path, stopping at ``limit`` bytes. Returns
    (exit code, bytes written, exceeded)."""
    written = 0
    exceeded = False
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + timeout
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        assert process.stdout is not None
        while True:
            chunk = process.stdout.read(STREAM_CHUNK)
            if not chunk:
                break
            written += len(chunk)
            if written > limit or time.monotonic() > deadline:
                exceeded = True
                process.kill()
                break
            handle.write(chunk)
    process.wait()
    return process.returncode, written, exceeded


@contextlib.contextmanager
def install_lock(blocking: bool):
    """One writer of the app's installed files at a time: an install job, the
    supervisor's own repair and ``remove``."""
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE, 0o700)
    fd = os.open(INSTALL_LOCK, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except OSError:
            yield False
            return
        yield True
    finally:
        os.close(fd)


def read_pin() -> dict:
    document = json.loads(PIN_FILE.read_text(encoding="utf-8"))
    version, sha, size, url = (document.get(k) for k in ("version", "sha256", "bytes", "url"))
    if (set(document) != {"version", "sha256", "bytes", "url"} or not isinstance(version, str)
            or not VERSION_RE.fullmatch(version) or not isinstance(sha, str) or not SHA256_RE.fullmatch(sha)
            or not isinstance(size, int) or not 1_000_000 < size < 1_000_000_000
            or not isinstance(url, str) or not URL_RE.fullmatch(url)
            or not url.endswith(f"claude-desktop_{version}_amd64.deb")):
        raise RuntimeError("claude-desktop-pin.json is not a valid pin")
    return document


def read_mode() -> str:
    try:
        value = MODE_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return "app"
    return value if value in MODES else "app"


def write_state(path: Path, text: str) -> None:
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE, 0o700)
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(temporary, path)


def installed_version() -> str | None:
    if not container_running():
        return None
    result = in_container(["/bin/bash", "-c", f"readlink {APP_ROOT}/current 2>/dev/null"], check=False)
    value = result.stdout.decode("utf-8", "replace").strip()
    return value if VERSION_RE.fullmatch(value) else None


def download(pin: dict) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = CACHE / f"{pin['version']}.deb"

    def verified(path: Path) -> bool:
        if not path.is_file() or path.stat().st_size != pin["bytes"]:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest() == pin["sha256"]

    if verified(target):
        return target
    partial = target.with_name(target.name + ".part")
    log(f"downloading claude-desktop {pin['version']}")
    request = urllib.request.Request(pin["url"], headers={"User-Agent": "hivra-claude-app"})
    received = 0
    with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as handle:
        while True:
            chunk = response.read(STREAM_CHUNK)
            if not chunk:
                break
            received += len(chunk)
            if received > pin["bytes"]:
                partial.unlink(missing_ok=True)
                raise RuntimeError("downloaded package is larger than the pinned size")
            handle.write(chunk)
    if not verified(partial):
        partial.unlink(missing_ok=True)
        raise RuntimeError("downloaded package does not match the pinned size and SHA-256")
    os.replace(partial, target)
    return target


def unpack(pin: dict) -> None:
    """Unpack the pinned package inside the container as the desktop user."""
    version = pin["version"]
    package = download(pin)
    destination = f"{APP_ROOT}/{version}"
    ready = in_container(["/bin/bash", "-c", f"test -x {destination}/usr/lib/claude-desktop/claude-desktop"], check=False)
    if ready.returncode != 0:
        scratch = f"{HOME}/.cache/hivra-claude-app"
        in_container(["/bin/bash", "-c", f"mkdir -p {APP_ROOT} {scratch} && rm -rf {destination}.tmp"])
        # Streamed in as the desktop user: root never writes to a path that user controls.
        stream_from_file([DOCKER, "exec", "-i", "-u", DESKTOP_USER, CONTAINER, "/bin/bash", "-c", f"cat > {scratch}/claude-desktop.deb"], package)
        try:
            in_container(["/bin/bash", "-c",
                          f"set -e; mkdir -p {destination}.tmp; dpkg-deb -x {scratch}/claude-desktop.deb {destination}.tmp; "
                          f"test -x {destination}.tmp/usr/lib/claude-desktop/claude-desktop; "
                          f"rm -rf {destination}; mv {destination}.tmp {destination}"], timeout=600)
        finally:
            in_container(["/bin/rm", "-rf", scratch], check=False)
    entry = (f"[Desktop Entry]\nName=Claude\nComment=Claude app\nExec={LAUNCHER} %U\nIcon=utilities-terminal\n"
             "Type=Application\nStartupNotify=true\nCategories=Utility;Development;\n"
             "MimeType=x-scheme-handler/claude;application/vnd.anthropic.mcpb;application/vnd.anthropic.skill;\n")
    launcher = LAUNCHER_SCRIPT.format(display=DISPLAY, user=DESKTOP_USER, root=APP_ROOT)
    in_container(["/bin/bash", "-c",
                  f"set -e; mkdir -p {HOME}/.local/bin {HOME}/.local/share/applications; "
                  f"cat > {LAUNCHER}; chmod 0755 {LAUNCHER}"], input_bytes=launcher.encode())
    in_container(["/bin/bash", "-c", f"cat > {DESKTOP_ENTRY}"], input_bytes=entry.encode())
    in_container(["/bin/bash", "-c",
                  f"set -e; ln -sfn {version} {APP_ROOT}/current.next; mv -T {APP_ROOT}/current.next {APP_ROOT}/current; "
                  f"update-desktop-database {HOME}/.local/share/applications 2>/dev/null || true; "
                  f"xdg-mime default claude-desktop.desktop x-scheme-handler/claude 2>/dev/null || true; "
                  # The app's sign-in opens the owner's browser. Firefox starts clean, while
                  # the image's Chrome first asks the owner to accept Google's terms. Set it
                  # only when the owner has not chosen a browser themselves.
                  f"if [ -e /usr/share/applications/firefox.desktop ] && ! grep -qs 'x-scheme-handler/https' {HOME}/.config/mimeapps.list; then "
                  f"xdg-mime default firefox.desktop x-scheme-handler/http x-scheme-handler/https text/html 2>/dev/null || true; fi"])
    # A running app keeps reading its own files, so an older version's folder is
    # removed only while no app is running.
    if not app_running():
        in_container(["/bin/bash", "-c",
                      f"ls {APP_ROOT} | grep -vx -e current -e '{version}' | while read old; do rm -rf {APP_ROOT}/$old; done"],
                     check=False)


def snapshot_profile() -> bool:
    if not container_running():
        return False
    exists = in_container(["/bin/bash", "-c", f"test -d {HOME}/.config/Claude"], check=False)
    if exists.returncode != 0:
        return False
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = SNAPSHOT.with_name(SNAPSHOT.name + ".tmp")
    command = [DOCKER, "exec", "-u", DESKTOP_USER, CONTAINER, "tar", "-C", HOME, "-czf", "-"] \
        + [f"--exclude={item}" for item in SNAPSHOT_EXCLUDES] + [".config/Claude"]
    code, written, exceeded = stream_to_file(command, temporary, SNAPSHOT_MAX_BYTES)
    # tar exits 1 when a file changed while it was read (a live profile): the
    # archive is still the best available copy, never a reason to drop state.
    if exceeded or code not in (0, 1) or written == 0:
        temporary.unlink(missing_ok=True)
        log("profile snapshot skipped: " + ("larger than the cap" if exceeded else "tar failed"))
        return False
    os.replace(temporary, SNAPSHOT)
    return True


def restore_profile() -> bool:
    if not SNAPSHOT.is_file():
        return False
    present = in_container(["/bin/bash", "-c", f"test -e {HOME}/.config/Claude/Local\\ Storage"], check=False)
    if present.returncode == 0:
        return False
    stream_from_file([DOCKER, "exec", "-i", "-u", DESKTOP_USER, CONTAINER, "/bin/tar", "-C", HOME, "-xzf", "-",
                      "--no-same-owner", "--no-same-permissions"], SNAPSHOT, timeout=300)
    return True


# --- window mode -----------------------------------------------------------------

def app_windows() -> list[tuple[str, int, int]]:
    """Top-level windows the window manager shows for the app: (id, width, height)."""
    result = in_container(["wmctrl", "-lGx"], check=False, timeout=10)
    windows = []
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        fields = line.split(None, 8)
        window_class = fields[6].lower() if len(fields) >= 7 else ""
        if window_class.startswith("claude-desktop.") or window_class.startswith("com.anthropic.claude."):
            try:
                windows.append((fields[0], int(fields[4]), int(fields[5])))
            except ValueError:
                continue
    return windows


def display_size() -> tuple[int, int]:
    result = in_container(["xdotool", "getdisplaygeometry"], check=False, timeout=10)
    parts = result.stdout.decode().split()
    if len(parts) == 2 and all(part.isdigit() for part in parts):
        return int(parts[0]), int(parts[1])
    return 1760, 1168


def apply_mode(mode: str) -> bool:
    windows = app_windows()
    if not windows:
        return False
    # The app can own tiny helper windows. The main window is the largest.
    hexid = max(windows, key=lambda window: window[1] * window[2])[0]
    if mode == "app":
        in_container(["wmctrl", "-i", "-r", hexid, "-b", "add,fullscreen"], check=False, timeout=10)
        in_container(["wmctrl", "-i", "-a", hexid], check=False, timeout=10)
    else:
        width, height = display_size()
        in_container(["wmctrl", "-i", "-r", hexid, "-b", "remove,fullscreen"], check=False, timeout=10)
        in_container(["wmctrl", "-i", "-r", hexid, "-e",
                      f"0,{int(width * 0.14)},{int(height * 0.1)},{int(width * 0.72)},{int(height * 0.72)}"],
                     check=False, timeout=10)
        in_container(["wmctrl", "-i", "-a", hexid], check=False, timeout=10)
    return True


def app_running() -> bool:
    if not container_running():
        return False
    return in_container(["/usr/bin/pgrep", "-u", DESKTOP_USER, "-f", f"{APP_ROOT}/.*/claude-desktop"], check=False, timeout=10).returncode == 0


# --- verbs ---------------------------------------------------------------------

def status() -> dict:
    pin = None
    try:
        pin = read_pin()
    except (OSError, ValueError, RuntimeError):
        pass
    running = container_running()
    enabled = ENABLED.exists()
    version = installed_version() if running else None
    try:
        last_error = LAST_ERROR.read_text(encoding="utf-8").strip()[:200] or None
    except OSError:
        last_error = None
    return {
        "protocol": "hivra-claude-app-v1",
        "enabled": enabled,
        "desktopRunning": running,
        "installedVersion": version,
        "pinnedVersion": pin["version"] if pin else None,
        "updateAvailable": bool(enabled and version and pin and version != pin["version"]),
        "appRunning": app_running() if running and enabled else False,
        "mode": read_mode(),
        "profileSaved": SNAPSHOT.is_file(),
        "installing": install_in_progress(),
        "lastError": last_error,
    }


def unit_active(unit: str) -> bool:
    return run(["/usr/bin/systemctl", "is-active", "--quiet", unit], check=False).returncode == 0


def install_in_progress() -> bool:
    return unit_active(INSTALL_UNIT)


def verb_install() -> int:
    """Start adding or updating the app as its own systemd job and return at once.

    The gateway runs this detached, and a gateway restart (Update & restart does
    one) must not end a half-finished download, so the work runs in a transient
    unit that belongs to neither the gateway nor this call. The owner's screen
    polls ``status`` for ``installing`` and ``lastError``."""
    if not container_running():
        log("the desktop is not running")
        write_state(LAST_ERROR, "The desktop is not running. Start the computer, then try again.\n")
        print(json.dumps({"ok": False, "error": "desktop_not_running"}))
        return 3
    if install_in_progress():
        print(json.dumps({"ok": True, "installing": True}))
        return 0
    run(["/usr/bin/systemctl", "reset-failed", INSTALL_UNIT], check=False)
    started = run(["/usr/bin/systemd-run", f"--unit={INSTALL_UNIT.removesuffix('.service')}", "--collect", "--no-block", "--quiet",
                   "-p", "Nice=10", "-p", "KillMode=process",
                   "/usr/bin/python3", "-I", "-B", "/usr/local/bin/hivra-claude-app", "install-run"], check=False)
    if started.returncode != 0 and not install_in_progress():
        write_state(LAST_ERROR, "The install could not be started.\n")
        print(json.dumps({"ok": False, "error": "install_not_started"}))
        return 1
    print(json.dumps({"ok": True, "installing": True}))
    return 0


def verb_install_run() -> int:
    """The install job. Takes the install lock so the supervisor's own repair and
    ``remove`` never write the same files at the same time."""
    if not container_running():
        write_state(LAST_ERROR, "The desktop is not running. Start the computer, then try again.\n")
        return 3
    with install_lock(blocking=False) as held:
        if not held:
            return 0
        try:
            LAST_ERROR.unlink(missing_ok=True)
            pin = read_pin()
            # Adding the app for the first time, or moving it to a new pinned
            # version, restarts it. Asking again when it is already current and
            # running changes nothing, so an open session is never interrupted.
            needs_restart = not ENABLED.exists() or installed_version() != pin["version"] or not app_running()
            unpack(pin)
            write_state(ENABLED, pin["version"] + "\n")
            if not MODE_FILE.exists():
                write_state(MODE_FILE, "app\n")
            run(["/usr/bin/systemctl", "enable", "hivra-claude-app.service"], check=False)
            if needs_restart:
                run(["/usr/bin/systemctl", "restart", "hivra-claude-app.service"], check=False)
        except Exception as error:  # noqa: BLE001 - recorded for the owner's screen
            reason = re.sub(r"\s+", " ", str(error))[:180]
            write_state(LAST_ERROR, reason + "\n")
            log(f"install failed: {reason}")
            return 1
    return 0


def verb_mode(mode: str) -> int:
    if mode not in MODES:
        print("usage: hivra-claude-app mode app|desktop", file=sys.stderr)
        return 2
    if not ENABLED.exists():
        print(json.dumps({"ok": False, "error": "not_installed"}))
        return 3
    write_state(MODE_FILE, mode + "\n")
    applied = container_running() and apply_mode(mode)
    print(json.dumps({"ok": True, "mode": mode, "applied": applied}))
    return 0


def verb_remove() -> int:
    run(["/usr/bin/systemctl", "stop", INSTALL_UNIT], check=False)
    with install_lock(blocking=True):
        run(["/usr/bin/systemctl", "disable", "--now", "hivra-claude-app.service"], check=False)
        if container_running():
            in_container(["/usr/bin/pkill", "-u", DESKTOP_USER, "-f", f"{APP_ROOT}/.*/claude-desktop"], check=False, timeout=10)
            in_container(["/bin/bash", "-c",
                          f"rm -rf {APP_ROOT} {HOME}/.config/Claude {HOME}/.cache/hivra-claude-app {LAUNCHER} {DESKTOP_ENTRY}"],
                         check=False, timeout=120)
        shutil.rmtree(STATE, ignore_errors=True)
    print(json.dumps({"ok": True, "removed": True}))
    return 0


def supervise() -> int:
    """Keep the app up on the desktop. Runs as the hivra-claude-app.service unit."""
    stopping = {"flag": False}

    def stop(_signal, _frame):
        stopping["flag"] = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    last_snapshot = 0.0
    applied_for = None
    while not stopping["flag"]:
        if not ENABLED.exists():
            time.sleep(5)
            continue
        if not container_running():
            applied_for = None
            time.sleep(3)
            continue
        try:
            if not app_running():
                # The pinned version is applied only while the app is stopped, so
                # a release never pulls the app out from under an open session.
                # An install job in progress owns the files: wait for the next pass.
                with install_lock(blocking=False) as held:
                    if not held:
                        time.sleep(3)
                        continue
                    pin = read_pin()
                    if installed_version() != pin["version"]:
                        unpack(pin)
                        write_state(ENABLED, pin["version"] + "\n")
                    restore_profile()
                log("starting the Claude app")
                in_container([LAUNCHER], detach=True, check=False, timeout=20)
                applied_for = None
                for _ in range(60):
                    if stopping["flag"] or app_windows():
                        break
                    time.sleep(1)
            if app_running() and applied_for != "set":
                time.sleep(2)
                if apply_mode(read_mode()):
                    applied_for = "set"
            if app_running() and time.monotonic() - last_snapshot > SNAPSHOT_INTERVAL_SECONDS:
                snapshot_profile()
                last_snapshot = time.monotonic()
        except Exception as error:  # noqa: BLE001 - the loop must survive any single failure
            log(f"supervisor pass failed: {error}")
            time.sleep(5)
        time.sleep(3)
    # Graceful stop: let the app flush its profile, then save it.
    try:
        if container_running() and app_running():
            in_container(["/usr/bin/pkill", "-TERM", "-u", DESKTOP_USER, "-f", f"{APP_ROOT}/.*/claude-desktop"], check=False, timeout=10)
            for _ in range(10):
                if not app_running():
                    break
                time.sleep(1)
        snapshot_profile()
    except Exception as error:  # noqa: BLE001
        log(f"final snapshot failed: {error}")
    return 0


def main(argv: list[str]) -> int:
    if os.geteuid() != 0:
        print("hivra-claude-app must run as root", file=sys.stderr)
        return 2
    verb = argv[1] if len(argv) > 1 else ""
    if verb == "status" and len(argv) == 2:
        print(json.dumps(status()))
        return 0
    if verb == "install" and len(argv) == 2:
        return verb_install()
    if verb == "install-run" and len(argv) == 2:
        return verb_install_run()
    if verb == "mode" and len(argv) == 3:
        return verb_mode(argv[2])
    if verb == "remove" and len(argv) == 2:
        return verb_remove()
    if verb == "supervise" and len(argv) == 2:
        return supervise()
    print("usage: hivra-claude-app status|install|mode app|desktop|remove|supervise", file=sys.stderr)  # install-run is internal
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
