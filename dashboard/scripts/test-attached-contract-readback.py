#!/usr/bin/env python3
"""attached-agent.py's contract read-back (design 4.6, T33) in an owned,
disposable, privileged root Linux container.

Root reads the attached agent's AGENTS.md on the host and again through the
unit's own mount namespace (/proc/<pid>/root). Only the same inode with the
same digest, in a root-owned 0444 file, is "checked"; Hivra shows "checked by
Hivra" only for that. A file the unit's namespace sees differently (a bind
mount over the path, a copy with the same text, a missing file) or a host file
anyone else could have written is never checked.

Run: docker run --rm --privileged -v "$PWD":/src:ro python:3.12-slim \
       python3 /src/scripts/test-attached-contract-readback.py
Never run it on a real computer.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time

SRC = Path(os.environ.get("HIVRA_SRC", "/src"))
INSTALLATION = "33333333-3333-4333-8333-333333333333"
VIEW = Path("/var/lib/hivra/agent-views") / INSTALLATION
TEXT = b"# Attached base prompt\n\n<!-- hivra:computer-contract:begin -->\nrev 1\n<!-- hivra:computer-contract:end -->\n"

spec = importlib.util.spec_from_file_location("attached_agent", str(SRC / "provisioner" / "attached-agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


def write_view(data=TEXT, mode=0o444, uid=0):
    for directory in ("/var", "/var/lib", "/var/lib/hivra", "/var/lib/hivra/agent-views", str(VIEW)):
        Path(directory).mkdir(mode=0o755, exist_ok=True)
        os.chown(directory, 0, 0)
        os.chmod(directory, 0o755)
    target = VIEW / "AGENTS.md"
    if target.exists() or target.is_symlink():
        target.unlink()
    target.write_bytes(data)
    os.chown(target, uid, 0)
    os.chmod(target, mode)
    return hashlib.sha256(data).hexdigest()


def namespace_process(setup):
    """A process in its own mount namespace, after `setup` ran there (as the unit would be)."""
    process = subprocess.Popen(["unshare", "--mount", "--propagation", "private", "sh", "-c", setup + "\nexec sleep 60"])
    for _ in range(50):
        time.sleep(0.1)
        try:
            if os.readlink("/proc/%d/ns/mnt" % process.pid) != os.readlink("/proc/self/ns/mnt"):
                # The setup has run once the sleep replaced the shell.
                if Path("/proc/%d/cmdline" % process.pid).read_bytes().startswith(b"sleep"):
                    return process
        except OSError:
            pass
    process.kill()
    raise SystemExit("namespace process did not start")


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (" " + detail if detail else ""))
    if not condition:
        global failed
        failed = True


failed = False


def main():
    if os.geteuid() != 0:
        raise SystemExit("run as root in a disposable container")
    digest = write_view()

    same = subprocess.Popen(["sleep", "60"])
    try:
        result = agent.contract_readback(INSTALLATION, same.pid)
        check("same_inode_same_digest_is_checked", result == {"sha256": digest, "checked": True}, str(result))
    finally:
        same.kill()

    check("no_unit_process_is_never_checked", agent.contract_readback(INSTALLATION, None) == {"sha256": digest, "checked": False})

    # The unit's namespace sees another file with the same text at the same path.
    copy = namespace_process("cp /var/lib/hivra/agent-views/%s/AGENTS.md /tmp/copy && mount --bind /tmp/copy "
                             "/var/lib/hivra/agent-views/%s/AGENTS.md" % (INSTALLATION, INSTALLATION))
    try:
        result = agent.contract_readback(INSTALLATION, copy.pid)
        check("same_text_other_inode_in_unit_is_not_checked", result == {"sha256": digest, "checked": False}, str(result))
    finally:
        copy.kill()

    # The unit's namespace sees different text.
    other = namespace_process("printf 'other' > /tmp/other && mount --bind /tmp/other /var/lib/hivra/agent-views/%s/AGENTS.md"
                              % INSTALLATION)
    try:
        check("other_text_in_unit_is_not_checked", agent.contract_readback(INSTALLATION, other.pid)["checked"] is False)
    finally:
        other.kill()

    # The unit's namespace has no such file (its view was replaced by an empty folder).
    missing = namespace_process("mkdir -p /tmp/empty && mount --bind /tmp/empty /var/lib/hivra/agent-views/%s" % INSTALLATION)
    try:
        check("missing_in_unit_is_not_checked", agent.contract_readback(INSTALLATION, missing.pid)["checked"] is False)
    finally:
        missing.kill()

    # A host file someone other than root could have written is never checked.
    for label, mode, uid in (("writable_file", 0o644, 0), ("not_root_owned", 0o444, 1000)):
        write_view(mode=mode, uid=uid)
        same = subprocess.Popen(["sleep", "60"])
        try:
            check(label + "_is_not_checked", agent.contract_readback(INSTALLATION, same.pid)["checked"] is False)
        finally:
            same.kill()

    # A link in place of the file is refused, never followed.
    write_view()
    (VIEW / "AGENTS.md").unlink()
    Path("/tmp/elsewhere").write_bytes(TEXT)
    os.symlink("/tmp/elsewhere", VIEW / "AGENTS.md")
    try:
        agent.contract_readback(INSTALLATION, None)
        check("link_is_refused", False)
    except OSError:
        check("link_is_refused", True)

    print("verdict", "FAIL" if failed else "PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
