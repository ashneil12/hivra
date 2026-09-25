#!/usr/bin/env python3
"""Remove of an attached agent that was staged but never activated, as root in
an owned, disposable container (design 5.5 Remove, T3, T31).

Live on Canary an attach staged on an Ubuntu Desktop computer, its activation
never ran, and every cleanup Remove was refused: the gateway drop-in folder
(bux-hivra-chat.service.d) exists only on agent computers or after an
activation, and Remove opened it unconditionally. Staging also leaves the
agent's home, which Remove only deleted through the activation's registry.

This runs the real attached-agent.py remove() against exactly what staging
leaves (stage-attached-codex.py): the account, its home (with what the pinned
`codex --version` may write), the installation and the staging journal. No
activation registry, units, helpers, view or drop-in folder. It runs twice:
without ip and nft (python:3.12-slim has neither), and with stand-ins that
report no namespace and no table, as a computer that has them. systemctl is a
recording stand-in and the gateway answers its meta; nothing else is faked.

Run from dashboard/:
  docker run --rm --network none -v "$PWD":/src:ro python:3.12-slim python3 -I -B /src/scripts/test-attached-agent-remove.py
Never run it on a real computer: it creates and deletes accounts and writes
/usr/bin/systemctl.
"""
import grp
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys

if os.geteuid() != 0 or not Path("/.dockerenv").exists():
    raise SystemExit("owned root Docker fixture required")

SRC = Path(os.environ.get("HIVRA_SRC", "/src"))
PROGRAM = Path(os.environ.get("HIVRA_ATTACHED_AGENT", SRC / "provisioner" / "attached-agent.py"))
INSTALLATION = "44444444-4444-4444-8444-444444444444"
OPERATION = "55555555-5555-4555-8555-555555555555"
HEX = INSTALLATION.replace("-", "")
ACCOUNT = "hva_" + HEX[:24]
HOME = Path("/var/lib/hivra/agent-homes") / INSTALLATION
INSTALL = Path("/opt/hivra/agent-installations") / INSTALLATION
STAGING = Path("/var/lib/hivra/attachment-staging")
DROPINS = Path("/etc/systemd/system/bux-hivra-chat.service.d")
SYSTEMCTL = Path("/usr/bin/systemctl")
NET_TOOLS = {Path("/usr/sbin/ip"): "#!/bin/sh\nexit 0\n", Path("/usr/sbin/nft"): "#!/bin/sh\nexit 1\n"}
SYSTEMCTL_LOG = Path("/run/fake-systemctl.log")
KEEP = Path("/opt/keep/owner-file")

assert not SYSTEMCTL.exists(), "a real systemctl is installed here"
for tool in ("ip", "nft"):
    assert not any((Path(d) / tool).exists() for d in ("/usr/sbin", "/usr/bin", "/sbin", "/bin")), tool


def private_parent(path):
    """As stage-attached-codex.py makes the installation and home parents."""
    current = Path("/")
    for part in Path(path).parts[1:]:
        current /= part
        if not current.exists():
            current.mkdir(mode=0o711)
            current.chmod(0o711)


def stage():
    """Exactly what staging leaves behind, and nothing an activation makes."""
    private_parent(INSTALL.parent)
    private_parent(HOME.parent)
    INSTALL.mkdir(mode=0o700)
    HOME.mkdir(mode=0o700)
    subprocess.run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", str(HOME),
                    "--shell", "/usr/sbin/nologin", ACCOUNT], check=True, capture_output=True)
    user = pwd.getpwnam(ACCOUNT)
    os.chown(HOME, user.pw_uid, user.pw_gid)
    os.chown(INSTALL, 0, user.pw_gid)
    os.chmod(INSTALL, 0o750)
    # What the pinned `codex --version` may write as the account.
    (HOME / ".codex" / "log").mkdir(parents=True)
    (HOME / ".codex" / "version.json").write_text("{}")
    (HOME / ".codex" / "log" / "codex-tui.log").write_text("x")
    # A link in the home must be removed, never followed.
    KEEP.parent.mkdir(parents=True, exist_ok=True)
    KEEP.write_text("the owner's")
    (HOME / ".codex" / "owner-link").symlink_to(KEEP)
    for path in HOME.rglob("*"):
        os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
    (INSTALL / "codex").write_bytes(b"\x7fELF")
    os.chown(INSTALL / "codex", 0, user.pw_gid)
    os.chmod(INSTALL / "codex", 0o550)
    (INSTALL / "installation.json").write_text("{}")
    STAGING.mkdir(mode=0o700, parents=True, exist_ok=True)
    (STAGING / "staging.json").write_text(json.dumps({"identity": {"installationId": INSTALLATION}}))
    Path("/etc/systemd/system").mkdir(parents=True, exist_ok=True)
    assert not DROPINS.exists()
    return user


def remove():
    namespace = {"__name__": "hivra_attached_agent"}
    exec(compile(PROGRAM.read_bytes(), "<pinned-attached-agent>", "exec"), namespace)
    # The computer's gateway answers after its restart.
    namespace["gateway_meta"] = lambda: {"resourceKind": "computer", "attachedAgents": namespace["PROTOCOL"]}
    return namespace["main"]({"version": 1, "action": "remove", "operationId": OPERATION, "installationId": INSTALLATION}, {})


def check(with_net_tools):
    user = stage()
    receipt = remove()
    assert receipt == {"version": 1, "operationId": OPERATION, "installationId": INSTALLATION, "workspaceTouched": False,
                       "viewUnmounted": True, "networkRemoved": True, "unitsRemoved": True, "homeRemoved": True,
                       "accountRemoved": True, "stagingCleared": True, "leftoverFiles": 0, "state": "removed"}, receipt
    for gone in (HOME, INSTALL, STAGING / "staging.json", DROPINS):
        assert not os.path.lexists(gone), gone
    for lookup in (pwd.getpwnam, grp.getgrnam):
        try:
            lookup(ACCOUNT)
            raise AssertionError("the account is still there")
        except KeyError:
            pass
    assert KEEP.read_text() == "the owner's", "a link in the home was followed"
    assert HOME.parent.is_dir() and stat.S_IMODE(HOME.parent.stat().st_mode) == 0o711
    calls = SYSTEMCTL_LOG.read_text().splitlines()
    assert "daemon-reload" in calls and "restart bux-hivra-chat.service" in calls, calls
    tools = "with ip and nft" if with_net_tools else "without ip or nft"
    print(f"PASS {tools}: a staged, never activated agent is removed (account, home, installation, journal); no folder is created")

    # Remove again (a lost answer): nothing is left and it says removed.
    again = remove()
    assert again["state"] == "removed" and again["leftoverFiles"] == 0, again
    print(f"PASS {tools}: Remove again after it finished answers removed")


SYSTEMCTL.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> /run/fake-systemctl.log\nexit 0\n')
SYSTEMCTL.chmod(0o755)
try:
    check(False)
    for path, script in NET_TOOLS.items():
        path.write_text(script)
        path.chmod(0o755)
    SYSTEMCTL_LOG.unlink(missing_ok=True)
    check(True)
finally:
    SYSTEMCTL.unlink()
    for path in NET_TOOLS:
        path.unlink(missing_ok=True)
print("PASS attached agent Remove before activation")
sys.exit(0)
