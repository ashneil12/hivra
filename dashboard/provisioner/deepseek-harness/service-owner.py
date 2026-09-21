#!/usr/bin/env python3
"""Service ownership checks for the existing bux-hivra-chat service.

No CLI, sudoers entry, installation, lease release, or automatic retry. The
shared guest installer calls these under its existing lifecycle lock.
An empty service cgroup is not whole-computer teardown: other guest services
may own work submitted through their IPC. The VM lifecycle retains authority.
"""
import errno
import hashlib
import importlib.util
import os
from pathlib import Path
import pwd
import re
import socket
import subprocess
import sys

spec = importlib.util.spec_from_file_location("deepseek_native_install", Path(__file__).with_name("install-native.py"))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)

SERVICE = "bux-hivra-chat.service"
UNIT_FILE = Path("/etc/systemd/system") / SERVICE
CGROUP_NAME = "/system.slice/" + SERVICE
CGROUP = Path("/sys/fs/cgroup" + CGROUP_NAME)
PROC = Path("/proc")
TEMPLATE = Path(__file__).with_name(SERVICE)
STATIC = {
    "LoadState": "loaded", "FragmentPath": str(UNIT_FILE), "DropInPaths": "", "Transient": "no",
    "NeedDaemonReload": "no",
    "Type": "simple", "User": "bux", "Group": "bux", "DynamicUser": "no",
    "WorkingDirectory": "/opt/hivra/deepseek-gateway", "KillMode": "control-group",
    "TimeoutStopUSec": "15s", "SendSIGKILL": "yes", "FinalKillSignal": "9",
    "Delegate": "no", "ProtectControlGroups": "yes", "LimitCORE": "0", "LimitCORESoft": "0",
    "UMask": "0077", "Restart": "always",
}
VARIABLE = ("ExecStart", "ActiveState", "SubState", "MainPID", "ControlPID", "ControlGroup", "InvocationID", "Job")
ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}


def reject(code):
    raise files.InstallError("DeepSeek service ownership: " + code)


def require_root():
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        reject("Linux root authority required")


def service(*arguments, timeout=10):
    result = subprocess.run(["/usr/bin/systemctl", *arguments], env=ENV, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=timeout)
    if result.returncode != 0 or len(result.stdout) > 32768:
        reject("service command failed; outcome unverified")
    return result.stdout


def state():
    names = (*STATIC, *VARIABLE)
    raw = service("show", *["--property=" + name for name in names], SERVICE)
    try:
        pairs = [line.split("=", 1) for line in raw.decode("ascii").splitlines()]
        if any(len(pair) != 2 for pair in pairs) or len({pair[0] for pair in pairs}) != len(pairs):
            raise ValueError()
        value = dict(pairs)
        # Unlike scalar properties, systemctl omits an empty ExecStart array.
        # Only the exact absent-unit shape may omit it; loaded units stay strict.
        if value.get("LoadState") == "not-found" and set(value) == set(names) - {"ExecStart"}:
            value["ExecStart"] = ""
        if set(value) != set(names):
            raise ValueError()
        # systemctl renders the idle (0, "/") D-Bus Job tuple as an empty
        # property, not the literal string "0". Normalize only that exact case.
        if value["Job"] == "":
            value["Job"] = "0"
        if any(not re.fullmatch(r"0|[1-9][0-9]*", value[key]) for key in ("MainPID", "ControlPID", "Job")):
            raise ValueError()
        return value
    except (ValueError, UnicodeError):
        reject("invalid service state")


def definition(allow_missing=False):
    require_root()
    files.ancestors(UNIT_FILE.parent)
    observed = state()
    if allow_missing and not os.path.lexists(UNIT_FILE) and observed["LoadState"] == "not-found":
        if (observed["FragmentPath"] or observed["DropInPaths"] or observed["MainPID"] != "0"
                or observed["ControlPID"] != "0" or observed["Job"] != "0" or observed["ControlGroup"]
                or observed["ExecStart"] or observed["InvocationID"] or observed["NeedDaemonReload"] != "no"):
            reject("missing service has unresolved work")
        return observed
    expected = files.read_regular(TEMPLATE, 8192, False)
    installed = files.read_regular(UNIT_FILE, 8192)
    if installed != expected or (UNIT_FILE.stat().st_mode & 0o777) != 0o644:
        reject("custom service definition; explicit repair required")
    if any(observed[key] != value for key, value in STATIC.items()):
        reject("effective service definition differs")
    # systemctl appends per-invocation timestamps/PID/status after these fixed
    # fields. Require one exact executable/argv block, not a matching substring.
    command = observed["ExecStart"]
    prefix = "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/hivra/deepseek-gateway/server.js ; ignore_errors=no ; "
    if not command.startswith(prefix) or not command.endswith(" }") or command.count("{") != 1 or command.count("}") != 1:
        reject("effective service command differs")
    if observed["ControlGroup"] not in ("", CGROUP_NAME):
        reject("unexpected service cgroup")
    return observed


def cgroup_empty():
    # Require unified cgroup v2. An absent/unsupported hierarchy is not cleanup
    # evidence; only absence below the verified system.slice can be accepted.
    files.ancestors(CGROUP.parent)
    if not (CGROUP.parent.parent / "cgroup.controllers").is_file():
        reject("unified cgroup hierarchy unavailable")
    if not os.path.lexists(CGROUP):
        return True
    files.directory(CGROUP)
    raw = files.read_regular(CGROUP / "cgroup.events", 4096)
    try:
        pairs = [line.split() for line in raw.decode("ascii").splitlines()]
        if any(len(pair) != 2 for pair in pairs) or len({pair[0] for pair in pairs}) != len(pairs):
            raise ValueError()
        events = dict(pairs)
        if events.get("populated") not in ("0", "1"):
            raise ValueError()
        return events["populated"] == "0"
    except (ValueError, UnicodeError):
        reject("invalid cgroup observation")


def listeners_closed():
    for port in (8080, 3080):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            result = probe.connect_ex(("127.0.0.1", port))
            if result == 0:
                return False
            if result != errno.ECONNREFUSED:
                reject("listener observation inconclusive")
    return True


def empty(observed):
    return (observed["MainPID"] == "0" and observed["ControlPID"] == "0" and observed["Job"] == "0"
            and observed["ActiveState"] in ("inactive", "failed")
            and observed["SubState"] in ("dead", "failed") and cgroup_empty() and listeners_closed())


def stop_owned():
    before = definition(allow_missing=True)
    if before["LoadState"] != "not-found":
        # A synchronous manual stop cancels the owned Restart=always policy.
        # A timeout is unknown; never copy files/release authority after it.
        service("stop", SERVICE, timeout=30)
    after = definition(allow_missing=True)
    if not empty(after):
        reject("old service generation remains unresolved")
    # Bind to the checked definition and observed prior invocation. This narrow
    # observation does not cancel queued control-plane work or release its lock.
    return {"service": SERVICE, "previousInvocationId": before["InvocationID"],
            "serviceCgroupEmpty": True, "listenersClosed": True, "wholeComputerCleanupVerified": False}


def verify_running():
    observed = definition()
    if (observed["ActiveState"] != "active" or observed["SubState"] != "running" or observed["MainPID"] == "0"
            or observed["ControlPID"] != "0" or observed["Job"] != "0" or observed["ControlGroup"] != CGROUP_NAME
            or not re.fullmatch(r"[a-f0-9]{32}", observed["InvocationID"]) or observed["InvocationID"] == "0" * 32 or cgroup_empty()):
        reject("service is not a stable running generation")
    process = PROC / observed["MainPID"]
    if files.read_regular(process / "cgroup", 4096, False) != ("0::" + CGROUP_NAME + "\n").encode():
        reject("supervisor is outside owned cgroup")
    status = files.read_regular(process / "status", 16384, False).decode("ascii")
    uid = str(pwd.getpwnam("bux").pw_uid)
    if not re.search(r"^Uid:\s+" + r"\s+".join([uid] * 4) + r"$", status, re.MULTILINE):
        reject("supervisor user differs")
    again = definition()
    if any(again[key] != observed[key] for key in VARIABLE):
        reject("service generation changed during observation")
    return {"service": SERVICE, "invocationId": observed["InvocationID"], "supervisorPid": int(observed["MainPID"]),
            "unitSha256": hashlib.sha256(files.read_regular(UNIT_FILE, 8192)).hexdigest(),
            "supervisorInOwnedCgroup": True, "wholeComputerCleanupVerified": False}
