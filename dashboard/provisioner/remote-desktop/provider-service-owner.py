#!/usr/bin/env python3
"""Private stop-only provider desktop controller; not installed or dispatched yet.

The v3 worker must hold its manager/install locks and durable cancellation latch,
and supply the exact ownership plan captured BEFORE service activation. Never
manufacture that plan by hashing whatever units/containers happen to exist at
cleanup time. Unit templates must address the recorded container ID, not remove
or stop an arbitrary container by name. Existing managed desktop units are NOT
admitted by this controller. Provider container creation must explicitly use
cgroup parent system.slice and AutoRemove=false; stopping retains writable data.
The worker must retain this reviewed source before
dispatch, and bind its result to the fresh guest clock and SQL cleanup grant.

This module does not release leases, delete workspace bytes, remove images or
networks, stop Docker, install services, or provide a privileged CLI.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys

UNITS = ("hivra-remote-desktop-broker.service", "bux-hivra-chat.service", "hivra-selkies-desktop.service")
CONTAINER_NAME = "hivra-selkies-desktop"
UNIT_ROOT = Path("/etc/systemd/system")
CGROUP_ROOT = Path("/sys/fs/cgroup")
PROC = Path("/proc")
ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
PROPERTIES = ("LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload", "Transient",
              "ActiveState", "SubState", "MainPID", "ControlPID", "ControlGroup", "Job", "UnitFileState")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
DIGEST = re.compile(r"[0-9a-f]{64}")


def reject():
    raise RuntimeError("Provider desktop cleanup ownership could not be verified") from None


def ownership(value):
    try:
        if (not isinstance(value, dict) or set(value) != {"version", "computerId", "operationId", "units", "container"}
                or type(value["version"]) is not int or value["version"] != 1):
            reject()
        if any(not isinstance(value[k], str) or not UUID.fullmatch(value[k]) for k in ("computerId", "operationId")):
            reject()
        if (not isinstance(value["units"], dict) or set(value["units"]) != set(UNITS)
                or any(not isinstance(v, str) or not DIGEST.fullmatch(v) for v in value["units"].values())):
            reject()
        container = value["container"]
        if (not isinstance(container, dict) or set(container) != {"id", "imageId"}
                or not isinstance(container["id"], str) or not DIGEST.fullmatch(container["id"])
                or not isinstance(container["imageId"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", container["imageId"])):
            reject()
        return json.loads(json.dumps(value))
    except (TypeError, ValueError, KeyError):
        reject()


def directory(path):
    for parent in reversed((path, *path.parents)):
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            reject()


def read_regular(path, limit, mode=None):
    directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022
                or (mode is not None and stat.S_IMODE(info.st_mode) != mode) or info.st_size > limit):
            reject()
        raw = os.read(fd, limit + 1)
        if len(raw) > limit:
            reject()
        return raw
    finally:
        os.close(fd)


def command(argv, timeout=10):
    result = subprocess.run(argv, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=False, timeout=timeout)
    if result.returncode != 0 or len(result.stdout) > 32768:
        reject()  # A failed Docker lookup is not absence evidence.
    return result.stdout


def service_state(unit, expected):
    raw = command(["/usr/bin/systemctl", "show", *["--property=" + key for key in PROPERTIES], unit])
    pairs = [line.split("=", 1) for line in raw.decode("ascii").splitlines()]
    if any(len(p) != 2 for p in pairs) or len({p[0] for p in pairs}) != len(pairs):
        reject()
    state = dict(pairs)
    if set(state) != set(PROPERTIES) or any(not re.fullmatch(r"0|[1-9][0-9]*", state[k]) for k in ("MainPID", "ControlPID")):
        reject()
    path = UNIT_ROOT / unit
    if state["DropInPaths"] or state["NeedDaemonReload"] != "no" or state["Transient"] != "no" or state["Job"] not in ("", "0"):
        reject()
    if state["LoadState"] == "not-found":
        if (os.path.lexists(path) or state["FragmentPath"] or state["ControlGroup"] or state["UnitFileState"]
                or not idle(state)):
            reject()
    elif (state["LoadState"] != "loaded" or state["FragmentPath"] != str(path)
          or state["ControlGroup"] not in ("", "/system.slice/" + unit)
          or state["UnitFileState"] not in ("enabled", "disabled")
          or hashlib.sha256(read_regular(path, 16384, 0o644)).hexdigest() != expected["units"][unit]):
        reject()
    return state


def idle(state):
    return (state["MainPID"] == "0" and state["ControlPID"] == "0"
            and state["ActiveState"] in ("inactive", "failed") and state["SubState"] in ("dead", "failed"))


def container_state(expected):
    identity = expected["container"]["id"]
    # Check both the exact ID and the fixed desktop name. A replacement at the
    # old name is foreign even when the recorded container has already exited.
    ids = command(["/usr/bin/docker", "container", "ls", "--all", "--no-trunc", "--filter",
                   "name=^/" + CONTAINER_NAME + "$", "--format", "{{.ID}}"])
    if ids not in (b"", (identity + "\n").encode("ascii")):
        reject()
    found = command(["/usr/bin/docker", "container", "ls", "--all", "--no-trunc", "--filter", "id=" + identity, "--format", "{{.ID}}"])
    if found == b"":
        if ids:
            reject()
        return None
    if found != (identity + "\n").encode("ascii") or not ids:
        reject()
    # Deliberately omit environment variables and other credential-bearing data.
    fields = '[{{json .Id}},{{json .Name}},{{json .Image}},{{json .Config.Labels}},{{json .HostConfig.RestartPolicy.Name}},{{json .HostConfig.CgroupParent}},{{json .HostConfig.AutoRemove}},{{json .State}}]'
    value = json.loads(command(["/usr/bin/docker", "container", "inspect", "--format", fields, identity]))
    if not isinstance(value, list) or len(value) != 8:
        reject()
    actual_id, name, image, labels, restart, parent, auto_remove, state = value
    if (actual_id != identity or name != "/" + CONTAINER_NAME or image != expected["container"]["imageId"]
            or not isinstance(labels, dict) or labels.get("io.hivra.computer-id") != expected["computerId"]
            or labels.get("io.hivra.operation-id") != expected["operationId"] or restart != "no"
            or parent != "system.slice" or auto_remove is not False
            or not isinstance(state, dict) or any(type(state.get(k)) is not bool for k in ("Running", "Paused", "Restarting", "Dead"))
            or type(state.get("Pid")) is not int or state["Pid"] < 0):
        reject()
    if state["Running"]:
        if state["Pid"] == 0 or process_cgroup(state["Pid"]) != ("0::/system.slice/docker-" + identity + ".scope\n").encode("ascii"):
            reject()
    return state


def process_cgroup(pid):
    directory(PROC)
    parent = PROC / str(pid)
    info = os.lstat(parent)
    # A non-root container init legitimately owns its /proc entry. Require a
    # real non-writable directory, but not uid0. Never read process argv/env.
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
        reject()
    fd = os.open(parent / "cgroup", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o022:
            reject()
        raw = os.read(fd, 4097)
        if len(raw) > 4096:
            reject()
        return raw
    finally:
        os.close(fd)


def cgroup_empty(unit):
    directory(CGROUP_ROOT / "system.slice")
    read_regular(CGROUP_ROOT / "cgroup.controllers", 4096)
    path = CGROUP_ROOT / "system.slice" / unit
    if not os.path.lexists(path):
        return True
    pairs = [line.split() for line in read_regular(path / "cgroup.events", 4096).decode("ascii").splitlines()]
    if any(len(p) != 2 for p in pairs) or len({p[0] for p in pairs}) != len(pairs):
        reject()
    events = dict(pairs)
    if events.get("populated") not in ("0", "1"):
        reject()
    return events["populated"] == "0"


def listeners_closed():
    for port in (8080, 8088, 8090):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            result = probe.connect_ex(("127.0.0.1", port))
            if result == 0:
                return False
            if result != errno.ECONNREFUSED:
                reject()
    return True


def observed(expected):
    driver = command(["/usr/bin/docker", "info", "--format", "{{.CgroupDriver}}/{{.CgroupVersion}}"])
    if driver != b"systemd/2\n":
        reject()
    services = {unit: service_state(unit, expected) for unit in UNITS}
    return services, container_state(expected)


def _verified_stopped(expected):
    services, container = observed(expected)
    if any(not idle(state) or (state["LoadState"] != "not-found" and state["UnitFileState"] != "disabled")
           or not cgroup_empty(unit) for unit, state in services.items()):
        return False
    if container is not None and (any(container[k] for k in ("Running", "Paused", "Restarting", "Dead"))
                                  or container["Pid"] != 0 or container.get("Status") not in ("created", "exited")):
        return False
    return cgroup_empty("docker-" + expected["container"]["id"] + ".scope") and listeners_closed()


def observe_stopped(plan):
    try:
        if not sys.platform.startswith("linux") or os.geteuid() != 0:
            reject()
        return _verified_stopped(ownership(plan))
    except Exception:
        reject()


def stop_owned(plan):
    try:
        if not sys.platform.startswith("linux") or os.geteuid() != 0:
            reject()
        expected = ownership(plan)
        before, _ = observed(expected)  # Validate ALL resources before mutation.
        for unit in UNITS:
            if before[unit]["LoadState"] != "not-found":
                service_state(unit, expected)
                command(["/usr/bin/systemctl", "disable", unit])
                command(["/usr/bin/systemctl", "stop", unit], timeout=30)
        container = container_state(expected)
        if container is not None and container["Running"]:
            command(["/usr/bin/docker", "container", "stop", "--time", "10", expected["container"]["id"]], timeout=20)
        if not _verified_stopped(expected):
            reject()
        return {"computerId": expected["computerId"], "operationId": expected["operationId"],
                "servicesStopped": True, "serviceCgroupsEmpty": True, "containerStopped": True,
                "listenersClosed": True, "bootStartDisabled": True, "wholeComputerCleanupVerified": False}
    except Exception:
        reject()  # Never expose command output, customer paths or credentials.
