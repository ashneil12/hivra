#!/usr/bin/env python3
"""Private provider-VM installer worker for one existing Hivra provision op.

No provider API, allocation, credentials lookup, arbitrary command, or readiness
claim. The control plane must retain its existing agent operation until an
identity-bound stopped receipt is observed. Start is once-only, including after
lost acknowledgements. A failed/ambiguous install requires explicit recovery,
not an automatic rerun of a partially installed computer.
"""
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
import grp
import pwd
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import types

BUNDLE = Path("/opt/hivra/provider-bundle/current")
ROOT = Path("/var/lib/hivra/provider-install")
UNIT = "hivra-provider-install.service"
CGROUP = Path("/sys/fs/cgroup/system.slice") / UNIT
INSTALL_LOCK = Path("/run/hivra-agent-install.lock")
NATIVE_VERSION = "2026.09.08.3"
NATIVE_PROFILE = "deepseek-owned-service-v1"
NATIVE_FILES = ("deepseek-harness/bux-hivra-chat.service", "deepseek-harness/install-native.py", "deepseek-harness/service-owner.py")
DESKTOP_PROFILE = "desktop-owned-services-v1"
DESKTOP_FILES = ("remote-desktop/provider-service-owner.py",)
DESKTOP_VERSION = "2026.09.08.3"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
MAX_INPUT = 128 * 1024
MAX_RUN_MS = 480000
# A cold desktop downloads and derives a multi-gigabyte image. Keep its whole
# install bounded, but do not kill it before a single allowed 15-minute command.
# Legacy/native agents retain their existing eight-minute limit.
DESKTOP_MAX_RUN_MS = 1200000
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
DIGEST = re.compile(r"[0-9a-f]{64}")


def reject():
    raise ValueError("provider worker rejected")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject()
        result[key] = value
    return result


def decode(raw):
    if not raw or len(raw) > MAX_INPUT:
        reject()
    return json.loads(raw, object_pairs_hook=unique_object)


def encode(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii") + b"\n"


def identity(value):
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] not in (1, 2, 3):
        reject()
    native = value["version"] == 2
    desktop = value["version"] == 3
    if set(value) != {"version", "agentId", "operationId", "bundle"} | ({"nativeCleanup"} if native else {"desktopCleanup"} if desktop else set()):
        reject()
    if any(not isinstance(value[key], str) or not UUID.fullmatch(value[key]) for key in ("agentId", "operationId")):
        reject()
    bundle = value["bundle"]
    if not isinstance(bundle, dict) or set(bundle) != {"version", "state", "scopeSha256", "bundleSha256", "provisionerVersion"}:
        reject()
    if type(bundle["version"]) is not int or bundle["version"] != 1 or bundle["state"] != "bundle_installed":
        reject()
    if any(not isinstance(bundle[key], str) or not DIGEST.fullmatch(bundle[key]) for key in ("scopeSha256", "bundleSha256")):
        reject()
    if bundle["provisionerVersion"] not in ("2026.08.28.1", "2026.08.28.2", "2026.08.28.3", "2026.08.28.4", "2026.08.29.1", "2026.08.29.2", "2026.08.29.3", "2026.08.29.4", "2026.08.29.5", "2026.08.30.1", "2026.08.30.2", "2026.08.31.1", "2026.08.31.2", NATIVE_VERSION, DESKTOP_VERSION):
        reject()
    if native:
        cleanup = value["nativeCleanup"]
        if (bundle["provisionerVersion"] != NATIVE_VERSION or not isinstance(cleanup, dict)
                or set(cleanup) != {"profile", "closureSha256"} or cleanup["profile"] != NATIVE_PROFILE
                or not isinstance(cleanup["closureSha256"], str) or not DIGEST.fullmatch(cleanup["closureSha256"])):
            reject()
    if desktop:
        cleanup = value["desktopCleanup"]
        if (bundle["provisionerVersion"] != DESKTOP_VERSION or not isinstance(cleanup, dict)
                or set(cleanup) != {"profile", "closureSha256"} or cleanup["profile"] != DESKTOP_PROFILE
                or not isinstance(cleanup["closureSha256"], str) or not DIGEST.fullmatch(cleanup["closureSha256"])):
            reject()
    return value


def guest_clock():
    return {"bootId": Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip(),
            "boottimeMs": time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1000000}


def fresh(clock):
    if not isinstance(clock, dict) or set(clock) != {"bootId", "boottimeMs"} or not isinstance(clock["bootId"], str) or not UUID.fullmatch(clock["bootId"]):
        reject()
    if type(clock["boottimeMs"]) is not int or not 0 <= clock["boottimeMs"] <= 9007199254740991 - MAX_RUN_MS:
        reject()
    now = guest_clock()
    if now["bootId"] != clock["bootId"] or not 0 <= now["boottimeMs"] - clock["boottimeMs"] < 20000:
        reject()


def directory(path):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        reject()


def read_file(path, limit=MAX_INPUT, mode=0o600):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode or info.st_size > limit:
            reject()
        with os.fdopen(fd, "rb", closefd=False) as stream:
            value = stream.read(limit + 1)
        if len(value) > limit:
            reject()
        return value
    finally:
        os.close(fd)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish(path, value):
    """Fixed private directory; caller holds manager/run lock. Never overwrite."""
    publish_bytes(path, encode(value))


def publish_bytes(path, raw):
    if os.path.lexists(path):
        if read_file(path) != raw:
            reject()
        return
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(fd)
        # Exclusive same-directory publication; no existing evidence is replaced.
        libc = ctypes.CDLL(None, use_errno=True)
        rename = getattr(libc, "renameat2", None)
        if rename is None:
            reject()
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(-100, os.fsencode(temporary), -100, os.fsencode(path), 1) != 0:
            reject()
        sync_dir(path.parent)
    finally:
        os.close(fd)
        if os.path.lexists(temporary):
            os.unlink(temporary)  # Only this invocation's mkstemp output.


def installer():
    # The SSH wrapper verifies this worker's bundle before invoking it. During
    # run/start verify_bundle independently rechecks every asset before use.
    spec = importlib.util.spec_from_file_location("hivra_install_agent", BUNDLE / "hivra-install-agent.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def lock(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            reject()
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def manifest_rows(expected, manifest):
    if not isinstance(manifest, list) or not 1 <= len(manifest) <= 64:
        reject()
    rows, paths = [], []
    for file in manifest:
        if not isinstance(file, dict) or set(file) != {"path", "sha256", "size", "mode"}:
            reject()
        name = file["path"]
        if not isinstance(name, str) or not re.fullmatch(r"[.A-Za-z0-9_-]+(?:/[.A-Za-z0-9_-]+)*", name) or any(part in (".", "..") for part in name.split("/")):
            reject()
        if not isinstance(file["sha256"], str) or not DIGEST.fullmatch(file["sha256"]) or type(file["size"]) is not int or not 0 <= file["size"] <= 2 * 1024 * 1024 or type(file["mode"]) is not int or file["mode"] not in (0o600, 0o700):
            reject()
        paths.append(name)
        rows.append([name, file["sha256"], file["size"], file["mode"]])
    if paths != sorted(set(paths)) or sum(row[2] for row in rows) > 2 * 1024 * 1024:
        reject()
    if hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode("ascii")).hexdigest() != expected["bundleSha256"]:
        reject()
    return rows


def verify_bundle(expected, manifest):
    for parent in (BUNDLE.parent.parent, BUNDLE.parent, BUNDLE):
        directory(parent)
    if decode(read_file(BUNDLE / ".hivra-receipt.json")) != expected:
        reject()
    rows = manifest_rows(expected, manifest)
    paths = [row[0] for row in rows]
    actual = []
    for parent, directories, files in os.walk(BUNDLE, followlinks=False):
        directory(parent)
        for child in directories:
            directory(Path(parent) / child)
        actual.extend(str((Path(parent) / file).relative_to(BUNDLE)) for file in files)
    if sorted(actual) != sorted(paths + [".hivra-receipt.json"]):
        reject()
    for name, digest, size, mode in rows:
        raw = read_file(BUNDLE / name, size, mode)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            reject()
    if read_file(BUNDLE / "VERSION").decode("ascii").strip() != expected["provisionerVersion"]:
        reject()


def check_launch(expected, launch):
    if launch["computerSubstrate"] != "provider-vm":
        reject()
    # Match explicit contracts, not the complement of the native contract.
    # In particular a future desktop parser must not make v3 admissible under
    # an older identity that cannot retain/observe desktop cleanup obligations.
    legacy = (expected["version"] == 1 and launch["version"] == 1
              and launch["agentKind"] in {"claude", "codex", "aeon", "openclaw", "agent-zero"})
    native = expected["version"] == 2 and launch["version"] == 2 and launch["agentKind"] == "deepseek-harness"
    desktop = (expected["version"] == 3 and launch["version"] == 3 and launch["agentKind"] == "linux-desktop"
               and launch.get("computerId") == expected.get("agentId") and isinstance(expected.get("agentId"), str))
    if not (legacy or native or desktop):
        reject()


def parse_worker_launch(expected, raw):
    module = installer()
    launch = module.parse_launch(raw, provider_desktop=True) if expected["version"] == 3 else module.parse_launch(raw)
    check_launch(expected, launch)
    return launch


def native_rows(expected, manifest):
    rows = manifest_rows(expected["bundle"], manifest)
    closure = [row for row in rows if row[0] in NATIVE_FILES]
    if (tuple(row[0] for row in closure) != NATIVE_FILES
            or hashlib.sha256(encode(closure)).hexdigest() != expected["nativeCleanup"]["closureSha256"]):
        reject()
    controllers = [row for row in rows if row[0] == "hivra-provider-worker.py"]
    if len(controllers) != 1:
        reject()
    return closure, controllers[0]


def retain_native(expected, manifest):
    """Under manager.lock, BEFORE dispatch. Retain the complete stop-only code
    closure; recovery never imports a newer/current preparation bundle."""
    closure, controller = native_rows(expected, manifest)
    folder = ROOT / "native-cleanup"
    if not os.path.lexists(folder):
        os.mkdir(folder, 0o700)
        sync_dir(ROOT)
    directory(folder)
    for name, digest, size, mode in [*closure, controller]:
        raw = read_file(BUNDLE / name, size, mode)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            reject()
        target = ROOT / "controller.py" if name == controller[0] else folder / Path(name).name
        publish_bytes(target, raw)


def retained_native(expected):
    folder = ROOT / "native-cleanup"
    directory(ROOT)
    directory(folder)
    closure, controller = native_rows(expected, decode(read_file(ROOT / "manifest.json")))
    if sorted(path.name for path in folder.iterdir()) != sorted(Path(row[0]).name for row in closure):
        reject()
    for name, digest, size, _ in [*closure, controller]:
        target = ROOT / "controller.py" if name == controller[0] else folder / Path(name).name
        raw = read_file(target, size)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            reject()
    return folder


def desktop_rows(expected, manifest):
    """Private v3 closure mechanics; server admission requires the additive seal."""
    if not isinstance(expected, dict) or type(expected.get("version")) is not int or expected["version"] != 3:
        reject()
    cleanup = expected.get("desktopCleanup")
    if (not isinstance(cleanup, dict) or set(cleanup) != {"profile", "closureSha256"}
            or cleanup["profile"] != DESKTOP_PROFILE
            or not isinstance(cleanup["closureSha256"], str) or not DIGEST.fullmatch(cleanup["closureSha256"])):
        reject()
    rows = manifest_rows(expected["bundle"], manifest)
    closure = [row for row in rows if row[0] in DESKTOP_FILES]
    controllers = [row for row in rows if row[0] == "hivra-provider-worker.py"]
    if (tuple(row[0] for row in closure) != DESKTOP_FILES or len(controllers) != 1
            or hashlib.sha256(encode(closure)).hexdigest() != cleanup["closureSha256"]):
        reject()
    return closure, controllers[0]


def retain_desktop(expected, manifest):
    # Original manager lock, after full bundle verification, BEFORE dispatch.
    closure, controller = desktop_rows(expected, manifest)
    folder = ROOT / "desktop-cleanup"
    if not os.path.lexists(folder):
        os.mkdir(folder, 0o700)
        sync_dir(ROOT)
    directory(folder)
    names = {Path(row[0]).name for row in closure}
    if not {path.name for path in folder.iterdir()}.issubset(names):
        reject()  # Interrupted publication residue is not a usable closure.
    for name, digest, size, mode in [*closure, controller]:
        raw = read_file(BUNDLE / name, size, mode)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            reject()
        publish_bytes(ROOT / "controller.py" if name == controller[0] else folder / Path(name).name, raw)
    if {path.name for path in folder.iterdir()} != names:
        reject()


def retained_desktop_owner(expected):
    # Never resolve recovery code through current BUNDLE. The retained original
    # controller and complete stop-only closure must still match its manifest.
    folder = ROOT / "desktop-cleanup"
    directory(ROOT)
    directory(folder)
    closure, controller = desktop_rows(expected, decode(read_file(ROOT / "manifest.json")))
    if sorted(path.name for path in folder.iterdir()) != sorted(Path(row[0]).name for row in closure):
        reject()
    owner_raw = None
    for name, digest, size, _ in [*closure, controller]:
        target = ROOT / "controller.py" if name == controller[0] else folder / Path(name).name
        raw = read_file(target, size)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            reject()
        if name in DESKTOP_FILES:
            owner_raw = raw
    # Execute exactly the verified bytes, avoiding a second import-path read.
    owner = types.ModuleType("hivra_retained_desktop_owner")
    owner.__file__ = str(folder / "provider-service-owner.py")
    exec(compile(owner_raw, owner.__file__, "exec"), owner.__dict__)
    return owner


def desktop_owned_plan(expected, owner):
    plan = owner.ownership(decode(read_file(ROOT / "desktop-ownership.json")))
    if plan["computerId"] != expected["agentId"] or plan["operationId"] != expected["operationId"]:
        reject()
    return plan


def desktop_proof_path():
    boot_id = guest_clock()["bootId"]
    if not isinstance(boot_id, str) or not UUID.fullmatch(boot_id):
        reject()
    return ROOT / ("desktop-cleanup-" + boot_id + ".json"), boot_id


def desktop_observation(expected):
    path, boot_id = desktop_proof_path()
    if not os.path.lexists(path):
        return {"state": "pending"}
    proof = decode(read_file(path))
    if (not isinstance(proof, dict) or set(proof) != {"identity", "state", "bootId", "ownershipSha256"}
            or proof["identity"] != expected or proof["bootId"] != boot_id
            or proof["state"] not in ("not_started", "verified_stopped")
            or decode(read_file(ROOT / "cancel.json")) != expected):
        reject()
    if proof["state"] == "not_started":
        if proof["ownershipSha256"] is not None or any(os.path.lexists(ROOT / name) for name in
                ("dispatch.json", "started.json", "desktop-preparation-intent.json", "desktop-ownership.json")):
            reject()
    else:
        execution = lock(INSTALL_LOCK)
        try:
            owner = retained_desktop_owner(expected)
            plan = desktop_owned_plan(expected, owner)
            if hashlib.sha256(encode(plan)).hexdigest() != proof["ownershipSha256"]:
                reject()
            if not owner.observe_stopped(plan):
                return {"state": "pending"}
        finally:
            os.close(execution)
    return {"state": proof["state"], "bootId": boot_id}


def cleanup_desktop(expected):
    """Under original manager lock and cancellation; never releases a SQL lease.
    Missing ownership after dispatch is ambiguous, not permission to stop by
    name or claim not-started. Provider destruction remains separate authority.
    """
    if decode(read_file(ROOT / "cancel.json")) != expected:
        reject()
    if not empty_worker(unit_state()):
        return {"state": "pending"}
    observed = desktop_observation(expected)
    if observed["state"] != "pending":
        return observed
    path, boot_id = desktop_proof_path()
    if not os.path.lexists(ROOT / "dispatch.json"):
        if any(os.path.lexists(ROOT / name) for name in
               ("started.json", "desktop-preparation-intent.json", "desktop-ownership.json")):
            reject()
        publish(path, {"identity": expected, "state": "not_started", "bootId": boot_id, "ownershipSha256": None})
    elif not os.path.lexists(ROOT / "desktop-ownership.json"):
        return {"state": "pending"}
    else:
        execution = lock(INSTALL_LOCK)
        try:
            owner = retained_desktop_owner(expected)
            plan = desktop_owned_plan(expected, owner)
            proof = owner.stop_owned(plan)
            if (not isinstance(proof, dict) or proof.get("computerId") != expected["agentId"]
                    or proof.get("operationId") != expected["operationId"]
                    or any(proof.get(key) is not True for key in ("servicesStopped", "serviceCgroupsEmpty",
                           "containerStopped", "listenersClosed", "bootStartDisabled"))
                    or proof.get("wholeComputerCleanupVerified") is not False
                    or not owner.observe_stopped(plan) or desktop_proof_path() != (path, boot_id)):
                reject()
            publish(path, {"identity": expected, "state": "verified_stopped", "bootId": boot_id,
                           "ownershipSha256": hashlib.sha256(encode(plan)).hexdigest()})
        finally:
            os.close(execution)
    return desktop_observation(expected)


def native_proof_path(boot_id=None):
    boot_id = guest_clock()["bootId"] if boot_id is None else boot_id
    if not isinstance(boot_id, str) or not UUID.fullmatch(boot_id):
        reject()
    return ROOT / ("native-cleanup-" + boot_id + ".json")


def native_observation(expected):
    path = native_proof_path()
    if not os.path.lexists(path):
        return {"state": "pending"}
    proof = decode(read_file(path))
    if (not isinstance(proof, dict) or set(proof) != {"identity", "state", "bootId"} or proof["identity"] != expected
            or path.name != "native-cleanup-" + str(proof["bootId"]) + ".json"
            or proof["state"] not in ("not_started", "verified_stopped")
            or not os.path.lexists(ROOT / "cancel.json") or decode(read_file(ROOT / "cancel.json")) != expected):
        reject()
    if proof["state"] == "not_started":
        if os.path.lexists(ROOT / "dispatch.json") or os.path.lexists(ROOT / "started.json"):
            reject()
    else:
        folder = retained_native(expected)
        # A stored proof is historical. Recheck current unit/enablement/cgroup/
        # listeners before using it as fresh authority; never stop on status.
        execution = lock(INSTALL_LOCK)
        try:
            if not observe_retained_native(folder):
                return {"state": "pending"}
        finally:
            os.close(execution)
    return {"state": proof["state"], "bootId": proof["bootId"]}


def cleanup_native(expected):
    if decode(read_file(ROOT / "cancel.json")) != expected:
        reject()
    if native_observation(expected)["state"] != "pending":
        return
    boot_id = guest_clock()["bootId"]
    path = native_proof_path(boot_id)
    if not os.path.lexists(ROOT / "dispatch.json"):
        if os.path.lexists(ROOT / "started.json"):
            reject()
        outcome = "not_started"  # Tombstone fences all future dispatch first.
    else:
        folder = retained_native(expected)
        execution = lock(INSTALL_LOCK)
        try:
            proof = stop_retained_native(folder)
            if (proof.get("service") != "bux-hivra-chat.service" or proof.get("serviceCgroupEmpty") is not True
                    or proof.get("listenersClosed") is not True or proof.get("wholeComputerCleanupVerified") is not False
                    or proof.get("bootStartDisabled") is not True):
                reject()
            outcome = "verified_stopped"
            if native_proof_path() != path:
                reject()
            publish(path, {"identity": expected, "state": outcome, "bootId": boot_id})
        finally:
            os.close(execution)
        return
    publish(path, {"identity": expected, "state": outcome, "bootId": boot_id})


def retained_native_owner(folder):
    # The caller has verified all three root-owned retained assets immediately
    # before import, and holds both manager and guest lifecycle locks.
    spec = importlib.util.spec_from_file_location("hivra_retained_native_owner", folder / "service-owner.py")
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    return owner


def native_disabled(owner, observed):
    return (observed["LoadState"] == "not-found"
            or owner.service("show", "--property=UnitFileState", "--value", owner.SERVICE) == b"disabled\n")


def observe_retained_native(folder):
    owner = retained_native_owner(folder)
    observed = owner.definition(allow_missing=True)
    return native_disabled(owner, observed) and owner.empty(observed)


def stop_retained_native(folder):
    owner = retained_native_owner(folder)
    observed = owner.definition(allow_missing=True)
    if observed["LoadState"] != "not-found":
        owner.service("disable", owner.SERVICE)
    proof = owner.stop_owned()
    after = owner.definition(allow_missing=True)
    if not native_disabled(owner, after) or not owner.empty(after):
        reject()
    return {**proof, "bootStartDisabled": True}


def systemctl(*arguments):
    result = subprocess.run(["/usr/bin/systemctl", *arguments], env=ENV, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=False)
    if result.returncode != 0 or len(result.stdout) > 16384:
        reject()
    return result.stdout.decode("ascii")


def unit_state():
    names = ("LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "ControlGroup", "Transient")
    raw = systemctl("show", *["--property=" + name for name in names], UNIT)
    pairs = [line.split("=", 1) for line in raw.splitlines()]
    if len(pairs) != len(names) or any(len(pair) != 2 for pair in pairs) or {pair[0] for pair in pairs} != set(names):
        reject()
    value = dict(pairs)
    if value["LoadState"] != "not-found" and value["Transient"] != "yes":
        reject()  # Never shadow/stop a custom same-name unit.
    return value


def empty_worker(state):
    if state["MainPID"] != "0" or state["ControlPID"] != "0" or state["ActiveState"] not in ("inactive", "failed", "active"):
        return False
    if state["ActiveState"] == "active" and state["SubState"] != "exited":
        return False
    if state["ControlGroup"] not in ("", "/system.slice/" + UNIT):
        reject()
    if CGROUP.exists():
        events = dict(line.split() for line in (CGROUP / "cgroup.events").read_text(encoding="ascii").splitlines())
        if events.get("populated") != "0":
            return False
    try:
        fd = lock(ROOT / "run.lock")
    except BlockingIOError:
        return False
    os.close(fd)
    return True


def observe(expected):
    state = unit_state()
    cancelled = os.path.lexists(ROOT / "cancel.json")
    if cancelled and decode(read_file(ROOT / "cancel.json")) != expected:
        reject()
    # A dispatch with no unit may still be queued. A durable started/cancel
    # marker prevents a future queued run; the run lock and cgroup above also
    # exclude a worker currently between its marker and installer execution.
    started = os.path.lexists(ROOT / "started.json")
    if started and decode(read_file(ROOT / "started.json")) != expected:
        reject()
    # Read the one-way fences BEFORE sampling process/lock absence. Otherwise
    # a newly starting worker could publish its marker after an empty sample,
    # making that stale sample appear terminal while installation begins.
    stopped = empty_worker(state)
    # A loaded but inactive unit may also have a queued start job. Without a
    # durable fence, no nominally empty systemd state proves a future run cannot
    # begin. Never release authority from that observation alone.
    if not cancelled and not started and (stopped or state["LoadState"] == "not-found"):
        return {"state": "unknown", "stopped": False}
    if expected["version"] in (2, 3) and stopped:
        # Installer outcome is immutable and distinct from a later native stop.
        # In particular a cancel after cached success must not erase success,
        # and a previous failure without result.json must remain a failure.
        recorded = ROOT / "stopped-outcome.json"
        if os.path.lexists(recorded):
            value = decode(read_file(recorded))
            if (not isinstance(value, dict) or set(value) != {"identity", "state"}
                    or value["identity"] != expected or value["state"] not in ("failed", "succeeded", "cancelled")):
                reject()
            outcome = value["state"]
        else:
            outcome = "cancelled" if cancelled else "failed"
            if os.path.lexists(ROOT / "result.json"):
                value = decode(read_file(ROOT / "result.json"))
                if (not isinstance(value, dict) or set(value) != {"identity", "exitCode"}
                        or value["identity"] != expected or type(value["exitCode"]) is not int):
                    reject()
                outcome = "succeeded" if value["exitCode"] == 0 else "failed"
            publish(recorded, {"identity": expected, "state": outcome})
        if cancelled and os.path.lexists(ROOT / "launch.json"):
            read_file(ROOT / "launch.json")
            os.unlink(ROOT / "launch.json")
            sync_dir(ROOT)
        return {"state": outcome, "stopped": True}
    if cancelled:
        if stopped and os.path.lexists(ROOT / "launch.json"):
            read_file(ROOT / "launch.json")
            os.unlink(ROOT / "launch.json")
            sync_dir(ROOT)
        return {"state": "cancelled" if stopped else "stopping", "stopped": stopped}
    if not stopped:
        return {"state": "running", "stopped": False}
    if not os.path.lexists(ROOT / "result.json"):
        return {"state": "failed", "stopped": True}
    result = decode(read_file(ROOT / "result.json"))
    if not isinstance(result, dict) or set(result) != {"identity", "exitCode"} or result["identity"] != expected or type(result["exitCode"]) is not int:
        reject()
    return {"state": "succeeded" if result["exitCode"] == 0 else "failed", "stopped": True}


def ensure_root():
    for parent in (Path("/"), Path("/var"), Path("/var/lib"), ROOT.parent, ROOT):
        if parent in (ROOT.parent, ROOT) and not os.path.lexists(parent):
            os.mkdir(parent, 0o700)
            sync_dir(parent.parent)
        directory(parent)


def control(request):
    action = request.get("action") if isinstance(request, dict) else None
    fields = {"action", "identity", "clock"} | ({"manifest", "launch"} if action == "start" else set())
    if action not in ("start", "status", "cancel") or set(request) != fields:
        reject()
    expected = identity(request["identity"])
    fresh(request["clock"])
    if action == "status" and not os.path.lexists(ROOT):
        return {"version": expected["version"], "identity": expected, "state": "unknown", "stopped": False,
                **({"nativeCleanup": {"state": "pending"}} if expected["version"] == 2 else
                   {"desktopCleanup": {"state": "pending"}} if expected["version"] == 3 else {})}
    if action == "start":
        verify_bundle(expected["bundle"], request["manifest"])
        launch = parse_worker_launch(expected, encode(request["launch"]))
        if expected["version"] == 2:
            native_rows(expected, request["manifest"])
        elif expected["version"] == 3:
            desktop_rows(expected, request["manifest"])
    ensure_root()
    manager = lock(ROOT / "manager.lock")
    try:
        fresh(request["clock"])
        if os.path.lexists(ROOT / "identity.json"):
            if decode(read_file(ROOT / "identity.json")) != expected:
                reject()
        elif action == "status":
            reject()
        else:
            if unit_state()["LoadState"] != "not-found":
                reject()
            publish(ROOT / "identity.json", expected)
        if action == "cancel":
            fresh(request["clock"])
            publish(ROOT / "cancel.json", expected)
            if unit_state()["LoadState"] != "not-found":
                fresh(request["clock"])
                systemctl("stop", "--no-block", UNIT)
        elif action == "start" and not os.path.lexists(ROOT / "cancel.json"):
            marker = ROOT / "dispatch.json"
            digest = hashlib.sha256(encode(launch)).hexdigest()
            if os.path.lexists(ROOT / "launch-sha256.json"):
                if decode(read_file(ROOT / "launch-sha256.json")) != digest:
                    reject()
            if not os.path.lexists(marker):
                fresh(request["clock"])
                if expected["version"] == 2:
                    retain_native(expected, request["manifest"])
                publish(ROOT / "manifest.json", request["manifest"])
                if expected["version"] == 3:
                    retain_desktop(expected, request["manifest"])
                    retained_desktop_owner(expected)  # Usable original cleanup BEFORE dispatch.
                publish(ROOT / "launch.json", launch)
                publish(ROOT / "launch-sha256.json", digest)
                # Once this journal is written, retries only observe. No new
                # command is emitted if systemd's acknowledgement is lost.
                publish(marker, {"identity": expected, "clock": request["clock"]})
                fresh(request["clock"])
                subprocess.run(["/usr/bin/systemd-run", "--quiet", "--no-ask-password", "--unit=" + UNIT,
                    "--service-type=exec", "--property=Restart=no", "--property=RemainAfterExit=no",
                    "--property=RuntimeMaxSec=" + str((DESKTOP_MAX_RUN_MS if expected["version"] == 3 else MAX_RUN_MS) // 1000) + "s",
                    "--property=TimeoutStartSec=5s", "--property=TimeoutStopSec=5s",
                    "--property=KillMode=control-group", "--property=SendSIGKILL=yes", "--property=UMask=0077",
                    "--property=StandardOutput=null", "--property=StandardError=null", "--property=LimitCORE=0",
                    "/usr/bin/python3", "-I", "-B", str(ROOT / "controller.py" if expected["version"] in (2, 3) else BUNDLE / "hivra-provider-worker.py"), "run"],
                    env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=2, check=True)
        result = observe(expected)
        if expected["version"] == 2:
            if action == "cancel" and result["stopped"]:
                cleanup_native(expected)
            result["nativeCleanup"] = native_observation(expected)
        elif expected["version"] == 3:
            if action == "cancel" and result["stopped"]:
                cleanup_desktop(expected)
            result["desktopCleanup"] = desktop_observation(expected)
        fresh(request["clock"])
        return {"version": expected["version"], "identity": expected, **result}
    finally:
        os.close(manager)


def run_installer(raw, deadline):
    log_fd = os.open(ROOT / "installer.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with subprocess.Popen(["/usr/bin/python3", "-I", "-B", str(BUNDLE / "hivra-install-agent.py")],
                              env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
            child.stdin.write(raw)
            child.stdin.close()
            captured = 0
            with selectors.DefaultSelector() as reader:
                reader.register(child.stdout, selectors.EVENT_READ)
                while reader.get_map():
                    if guest_clock()["boottimeMs"] >= deadline:
                        # The service manager terminates the entire cgroup,
                        # including the installer descendants, on worker exit.
                        os._exit(124)
                    for key, _ in reader.select(0.2):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            reader.unregister(key.fileobj)
                        elif captured < 1024 * 1024:
                            chunk = chunk[:1024 * 1024 - captured]
                            os.write(log_fd, chunk)
                            captured += len(chunk)
            return child.wait(timeout=2)
    finally:
        os.close(log_fd)


class DesktopJournal:
    NAMES = {"cancel.json", "desktop-preparation-intent.json", "desktop-network-intent.json",
             "desktop-network.json", "desktop-create-intent.json", "desktop-ownership.json",
             "desktop-unit-intent.json", "desktop-units.json", "desktop-activation.json", "desktop-ready.json"}

    def __init__(self, expected, dispatch_clock):
        self.expected = expected
        self.clock = dispatch_clock

    def fence(self):
        now = guest_clock()
        if now["bootId"] != self.clock["bootId"] or not 0 <= now["boottimeMs"] - self.clock["boottimeMs"] < DESKTOP_MAX_RUN_MS:
            reject()
        if os.path.lexists(ROOT / "cancel.json"):
            reject()

    def read(self, name):
        if name not in self.NAMES:
            reject()
        if not os.path.lexists(ROOT / name):
            return None
        value = decode(read_file(ROOT / name))
        if name == "cancel.json" and value != self.expected:
            reject()
        return value

    def publish(self, name, value):
        if name not in self.NAMES - {"cancel.json"}:
            reject()
        # Short publication lock only: control must remain able to journal
        # cancellation while installation holds the separate install/run locks.
        while True:
            self.fence()
            try:
                manager = lock(ROOT / "manager.lock")
                break
            except BlockingIOError:
                # Normal status also owns this short lock. Wait only for the
                # lock, never redispatch a mutation; cancellation/deadline end
                # the wait even if its holder is stalled.
                time.sleep(0.05)
        try:
            self.fence()
            publish(ROOT / name, value)
        finally:
            os.close(manager)


def desktop_preflight(command):
    # Fresh provider VM only, never automatic adoption of an existing computer.
    for name in ("bux", "hivra-desktop-broker"):
        for lookup in (pwd.getpwnam, grp.getgrnam):
            try:
                lookup(name)
            except KeyError:
                continue
            reject()
    for path in ("/home/bux", "/opt/bux", "/etc/bux", "/opt/hivra/remote-desktop", "/var/lib/docker",
                 "/etc/docker", "/run/docker.sock", "/run/docker", "/etc/containerd", "/var/lib/containerd",
                 "/var/lib/hivra/remote-desktop", "/etc/sudoers.d/bux", "/etc/sudoers.d/hivra-tg",
                 "/etc/sudoers.d/hivra-browser", "/usr/local/bin/hivra-agent-shell", "/usr/local/bin/hivra-tg-apply",
                 "/usr/local/bin/hivra-browser-apply", "/usr/local/bin/ttyd", "/var/log/bux",
                 "/usr/local/bin/tg-send", "/usr/local/bin/bux-restart", "/usr/local/bin/tg-approve",
                 "/etc/ssh/sshd_config.d/00-bux.conf", "/etc/sudoers.d/bux-dev", "/usr/local/bin/browser-harness-js",
                 "/usr/local/bin/bux-agent-shell", "/usr/local/bin/tg-schedule", "/usr/local/bin/tg-schedule-fire",
                 "/usr/local/bin/tg-run-task", "/usr/local/bin/new-topic", "/usr/local/bin/schedule"):
        if os.path.lexists(path):
            reject()
    units = ("hivra-selkies-desktop.service", "hivra-remote-desktop-broker.service", "bux-hivra-chat.service",
             "bux-ttyd.service", "bux-box-ttyd.service", "bux-local-browser.service", "bux-browser-keeper.service",
             "bux-agent.service", "bux-tg.service", "bux-miniapp.service", "bux-miniapp-tunnel.service",
             "hivra-xvfb.service", "hivra-x11vnc.service", "hivra-novnc.service",
             "docker.service", "docker.socket", "containerd.service")
    for unit in units:
        raw = command(["/usr/bin/systemctl", "show", "--property=LoadState", "--property=FragmentPath", "--property=DropInPaths", unit])
        if set(raw.splitlines()) != {b"LoadState=not-found", b"FragmentPath=", b"DropInPaths="}:
            reject()
        if any(os.path.lexists(Path("/etc/systemd/system") / name) for name in (unit, unit + ".d")):
            reject()
    # Four GiB is the container ceiling, not the total host requirement. Reserve
    # two additional GiB for Docker/base services; normal provider sizing is 8GB.
    memory = re.search(r"^MemTotal:\s+([0-9]+) kB$", Path("/proc/meminfo").read_text(), re.MULTILINE)
    if not memory or int(memory[1]) < 6 * 1024**2 or (os.cpu_count() or 0) < 2:
        reject()


def desktop_module(name):
    if name not in ("install-guest.py", "provider-service-plan.py"):
        reject()
    relative = "remote-desktop/" + name
    rows = decode(read_file(ROOT / "manifest.json"))
    row = next((item for item in rows if item["path"] == relative), None)
    if row is None:
        reject()
    raw = read_file(BUNDLE / relative, row["size"], row["mode"])
    if len(raw) != row["size"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
        reject()
    module = types.ModuleType("hivra_owned_" + name.replace("-", "_").replace(".", "_"))
    module.__file__ = str(BUNDLE / relative)
    exec(compile(raw, module.__file__, "exec"), module.__dict__)
    return module


def prepare_desktop_runtime_parent():
    # Bundle delivery creates /opt/hivra as private0700. The non-root broker
    # needs traversal to its new runtime sibling, not access to source secrets.
    parent = BUNDLE.parent.parent
    directory(parent)
    mode = stat.S_IMODE(os.lstat(parent).st_mode)
    if mode in (0o711, 0o755):
        return
    private = parent / "provider-bundle"
    if mode != 0o700 or BUNDLE.parent != private or {item.name for item in parent.iterdir()} != {"provider-bundle"}:
        reject()
    directory(private)
    if stat.S_IMODE(os.lstat(private).st_mode) != 0o700:
        reject()
    os.chmod(parent, 0o711)
    sync_dir(parent)


def prepare_desktop_state_parent():
    parent = ROOT.parent
    directory(parent)
    mode = stat.S_IMODE(os.lstat(parent).st_mode)
    if mode in (0o711, 0o755):
        return
    if mode != 0o700 or ROOT.name != "provider-install" or {item.name for item in parent.iterdir()} != {"provider-install"}:
        reject()
    directory(ROOT)
    if stat.S_IMODE(os.lstat(ROOT).st_mode) != 0o700:
        reject()
    os.chmod(parent, 0o711)
    sync_dir(parent)


def run_provider_desktop(expected, launch, dispatch_clock):
    execution = lock(INSTALL_LOCK)
    try:
        journal = DesktopJournal(expected, dispatch_clock)
        def command(argv):
            journal.fence()
            result = subprocess.run(argv, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, timeout=30, check=True)
            if len(result.stdout) > 1024 * 1024:
                reject()
            journal.fence()
            return result.stdout  # Never log Docker's private Config.Env.
        journal.fence()
        owner = retained_desktop_owner(expected)
        plan, guest = desktop_module("provider-service-plan.py"), desktop_module("install-guest.py")
        desktop_preflight(command)
        journal.fence()
        prepare_desktop_runtime_parent()
        prepare_desktop_state_parent()
        args = types.SimpleNamespace(computer_kind="hivra-agent", computer_id=expected["agentId"],
            control_origin=launch["controlOrigin"], public_origin=launch["publicOrigin"], control_bypass_file=None,
            source_dir=str(BUNDLE / "remote-desktop"))
        def compose():
            journal.fence()
            return plan.install_prepared_base(args, expected["operationId"], journal, command, owner, guest)
        installer().install_agent(launch, BUNDLE, provider_desktop=compose)
        journal.fence()
        if journal.read("desktop-ready.json") is None:
            reject()
        return 0
    finally:
        os.close(execution)


def run():
    directory(ROOT)
    execution = lock(ROOT / "run.lock")
    try:
        expected = identity(decode(read_file(ROOT / "identity.json")))
        dispatch = decode(read_file(ROOT / "dispatch.json"))
        if set(dispatch) != {"identity", "clock"} or dispatch["identity"] != expected:
            reject()
        fresh(dispatch["clock"])
        if os.path.lexists(ROOT / "cancel.json") or os.path.lexists(ROOT / "started.json"):
            reject()
        verify_bundle(expected["bundle"], decode(read_file(ROOT / "manifest.json")))
        raw = read_file(ROOT / "launch.json")
        launch = parse_worker_launch(expected, raw)
        if expected["version"] == 2:
            retained_native(expected)
        elif expected["version"] == 3:
            retained_desktop_owner(expected)
        fresh(dispatch["clock"])
        publish(ROOT / "started.json", expected)
        os.unlink(ROOT / "launch.json")
        sync_dir(ROOT)
        # Cancellation after this final check is still covered by systemd's
        # stop of this exact unit/cgroup. Queued starts check the tombstone.
        if os.path.lexists(ROOT / "cancel.json"):
            reject()
        if expected["version"] == 3:
            code = run_provider_desktop(expected, launch, dispatch["clock"])
        else:
            code = run_installer(raw, dispatch["clock"]["boottimeMs"] + MAX_RUN_MS)
        publish(ROOT / "result.json", {"identity": expected, "exitCode": code})
        return 0 if code == 0 else 1
    finally:
        os.close(execution)


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or sys.platform != "linux" or not Path("/run/systemd/system").is_dir() or not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
        reject()
    if sys.argv[1:] == ["run"]:
        return run()
    if sys.argv[1:]:
        reject()
    result = control(decode(sys.stdin.buffer.read(MAX_INPUT + 1)))
    print("HIVRA_PROVIDER_WORKER_V1 " + json.dumps(result, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Provider installer operation could not be verified; inspect its private journal.", file=sys.stderr)
        sys.exit(1)
