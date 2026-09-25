#!/usr/bin/env python3
"""attached-workspace.py in an owned, disposable, privileged root Linux container (T4, T10, T23, T31).

Run: docker run --rm --privileged --tmpfs /home --tmpfs /var/lib/hivra -v "$PWD":/src:ro python:3.12-slim \
       python3 /src/scripts/test-attached-workspace-helper.py
Needs a kernel with idmapped mounts on tmpfs (6.3 or later). Never run it on a real computer.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import shutil
import stat
import subprocess
import sys

SRC = Path(os.environ.get("HIVRA_SRC", "/src"))
HELPER = SRC / "provisioner" / "attached-workspace.py"
INSTALLATION = "33333333-3333-4333-8333-333333333333"
ACCOUNT = "hva_" + INSTALLATION.replace("-", "")[:24]
VIEW = Path("/var/lib/hivra/agent-views") / INSTALLATION
HOME = Path("/var/lib/hivra/agent-homes") / INSTALLATION
REGISTRY = Path("/etc/hivra/attachments") / INSTALLATION
OWNER_FOLDER = Path("/home/bux/Hivra")


def sh(*args, check=True, user=None, env=None):
    command = list(args)
    if user is not None:
        info = pwd.getpwnam(user)
        command = ["setpriv", "--reuid", str(info.pw_uid), "--regid", str(info.pw_gid), "--clear-groups", "--", *command]
    return subprocess.run(command, check=check, capture_output=True, text=True, env=env)


def helper(command, user=None, check=True, env=None):
    environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", **(env or {})}
    result = sh(sys.executable, "-IBS", str(HELPER), command, INSTALLATION, user=user, check=False, env=environment)
    if check and result.returncode != 0:
        raise AssertionError(command + " failed: " + result.stderr + result.stdout)
    return result


def tree_digest(root):
    items = []
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        entry = [str(path.relative_to(root)), stat.S_IFMT(info.st_mode), info.st_uid, info.st_gid]
        if stat.S_ISREG(info.st_mode):
            entry.append(hashlib.sha256(path.read_bytes()).hexdigest())
        items.append(entry)
    return hashlib.sha256(json.dumps(items).encode()).hexdigest()


def setup():
    assert os.geteuid() == 0 and Path("/.dockerenv").exists(), "owned root Docker fixture required"
    subprocess.run(["useradd", "--create-home", "--home-dir", "/home/bux", "--shell", "/bin/bash", "bux"], check=True)
    OWNER_FOLDER.mkdir(mode=0o700)
    os.chown(OWNER_FOLDER, pwd.getpwnam("bux").pw_uid, pwd.getpwnam("bux").pw_gid)
    (OWNER_FOLDER / "notes.txt").write_text("owner bytes\n")
    os.chown(OWNER_FOLDER / "notes.txt", pwd.getpwnam("bux").pw_uid, pwd.getpwnam("bux").pw_gid)
    Path("/home/bux/.hivra").mkdir(mode=0o700)
    (Path("/home/bux/.hivra") / "api-token").write_text("a" * 64)
    subprocess.run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", str(HOME),
                    "--shell", "/usr/sbin/nologin", ACCOUNT], check=True)
    user = pwd.getpwnam(ACCOUNT)
    for parent, mode in (("/var/lib/hivra", 0o711), ("/var/lib/hivra/agent-views", 0o711), ("/var/lib/hivra/agent-homes", 0o711),
                         ("/etc/hivra", 0o755), ("/etc/hivra/attachments", 0o755)):
        Path(parent).mkdir(exist_ok=True)
        os.chmod(parent, mode)
    VIEW.mkdir()
    os.chown(VIEW, 0, user.pw_gid)
    os.chmod(VIEW, 0o750)
    (VIEW / "Hivra").mkdir()
    os.chmod(VIEW / "Hivra", 0)
    HOME.mkdir(mode=0o700)
    os.chown(HOME, user.pw_uid, user.pw_gid)
    REGISTRY.mkdir()
    os.chmod(REGISTRY, 0o755)
    write_binding(True)
    return user


def write_binding(workspace):
    user = pwd.getpwnam(ACCOUNT)
    path = REGISTRY / "binding.json"
    path.write_text(json.dumps({"version": 1, "installationId": INSTALLATION, "account": ACCOUNT,
                                "uid": user.pw_uid, "gid": user.pw_gid, "workspace": workspace}))
    os.chmod(path, 0o644)


def main():
    user = setup()
    before = tree_digest(OWNER_FOLDER)
    bux = pwd.getpwnam("bux")

    # Grant on: an idmapped, nosuid,nodev, non-recursive view on the root-owned mount point.
    state = json.loads(helper("mount").stdout)
    assert state["mounted"] and state["idmapped"] and state["nosuid"] and state["nodev"], state
    assert state["viewOwnedByAgent"] and state["sourceOwnerOk"], state
    assert json.loads(helper("mount").stdout) == state, "mount is idempotent"
    view = VIEW / "Hivra"
    assert (view / "notes.txt").stat().st_uid == user.pw_uid, "the owner's files appear as the agent's through the view"
    sh("sh", "-c", f"printf agent > {view}/hello.txt", user=ACCOUNT)
    assert (OWNER_FOLDER / "hello.txt").stat().st_uid == bux.pw_uid, "files the agent writes are stored as the owner"
    assert OWNER_FOLDER.stat().st_mode & 0o7777 == 0o700 and OWNER_FOLDER.stat().st_uid == bux.pw_uid, "nothing changes on disk"
    # T4: the owner's personal home stays closed to the agent.
    assert sh("cat", "/home/bux/.hivra/api-token", user=ACCOUNT, check=False).returncode != 0
    assert sh("ls", "/home/bux", user=ACCOUNT, check=False).returncode != 0
    # Non-recursive: a mount the owner has inside ~/Hivra is not exposed.
    (OWNER_FOLDER / "inner").mkdir()
    sh("mount", "-t", "tmpfs", "-o", "size=1m", "tmpfs", str(OWNER_FOLDER / "inner"))
    (OWNER_FOLDER / "inner" / "secret").write_text("inner mount")
    assert not (view / "inner" / "secret").exists(), "submounts are not in the view"
    sh("umount", str(OWNER_FOLDER / "inner"))

    # verify runs as the agent: accepts the view, creates ~/Hivra, refuses root.
    env = {"HOME": str(HOME)}
    assert json.loads(helper("verify", user=ACCOUNT, env=env).stdout)["verified"] is True
    assert os.readlink(HOME / "Hivra") == str(view)
    assert helper("verify", check=False).returncode != 0, "verify refuses to run as root"

    # The agent chmods the view root; reassert brings the owner's folder back to 0700.
    sh("chmod", "0777", str(view), user=ACCOUNT)
    assert OWNER_FOLDER.stat().st_mode & 0o777 == 0o777
    assert json.loads(helper("reassert").stdout)["reasserted"] is True
    assert OWNER_FOLDER.stat().st_mode & 0o7777 == 0o700

    # Grant off: unmount leaves the root-owned 0000 mount point, and verify refuses a stale grant.
    write_binding(False)
    assert helper("verify", user=ACCOUNT, env=env, check=False).returncode != 0, "a mounted view with the grant off is refused"
    state = json.loads(helper("mount").stdout)
    assert not state["mounted"] and state["mountPointEmpty"], state
    assert (view.stat().st_mode & 0o7777, view.stat().st_uid) == (0, 0)
    assert json.loads(helper("verify", user=ACCOUNT, env=env).stdout)["workspace"] is False
    # With access off the agent cannot create, replace or re-point anything in its view folder (T31).
    for attempt in (["touch", str(VIEW / "planted")], ["rm", "-rf", str(view)], ["ln", "-sfn", "/usr/local/bin", str(view)],
                    ["mv", str(VIEW / "Hivra"), str(VIEW / "moved")]):
        assert sh(*attempt, user=ACCOUNT, check=False).returncode != 0, attempt

    # T31: a link at /home/bux/Hivra, or at the mount point, is refused with no mount and no owner change.
    write_binding(True)
    shutil.move(str(OWNER_FOLDER), "/home/bux/Hivra.real")
    os.symlink("/usr/local/bin", str(OWNER_FOLDER))
    refused = helper("mount", check=False)
    assert refused.returncode != 0 and "workspace_path_not_plain" in refused.stderr, refused.stderr
    assert not json.loads(helper("state").stdout)["mounted"]
    assert Path("/usr/local/bin").stat().st_uid == 0
    os.unlink(OWNER_FOLDER)
    shutil.move("/home/bux/Hivra.real", str(OWNER_FOLDER))
    os.rmdir(view)
    os.symlink("/usr/local/bin", str(view))
    refused = helper("mount", check=False)
    assert refused.returncode != 0 and "workspace_path_not_plain" in refused.stderr, refused.stderr
    os.unlink(view)
    view.mkdir()
    os.chmod(view, 0)
    # A link at /home/bux itself is refused too.
    shutil.move("/home/bux", "/home/bux.real")
    os.symlink("/home/bux.real", "/home/bux")
    refused = helper("mount", check=False)
    assert refused.returncode != 0, "a linked /home/bux is refused"
    os.unlink("/home/bux")
    shutil.move("/home/bux.real", "/home/bux")
    assert json.loads(helper("mount").stdout)["mounted"], "once the link is gone, mounting succeeds"
    helper("unmount")
    mounts = [line for line in Path("/proc/self/mountinfo").read_text().splitlines() if "/agent-views/" in line]
    assert mounts == [], mounts

    # T23/T31: the Remove walker deletes names inside the home only, stops at a mount, and never follows links.
    (HOME / "nested" / "deeper").mkdir(parents=True)
    (HOME / "nested" / "deeper" / "file").write_text("agent")
    os.symlink("/etc", str(HOME / "etc-link"))
    os.symlink(str(OWNER_FOLDER), str(HOME / "hivra-link"))
    keep = Path("/var/lib/hivra/root-owned-keep")
    keep.write_text("keep")
    os.link(str(keep), str(HOME / "hardlink-to-root-file"))
    os.mkfifo(str(HOME / "fifo"))
    (HOME / "mnt").mkdir()
    sh("mount", "-t", "tmpfs", "-o", "size=1m", "tmpfs", str(HOME / "mnt"))
    (HOME / "mnt" / "other-fs").write_text("x")
    refused = helper("remove-home", check=False)
    assert refused.returncode != 0 and "detach_mount_found" in refused.stderr, refused.stderr
    sh("umount", str(HOME / "mnt"))
    etc_before = tree_digest(Path("/etc/hivra"))
    removed = json.loads(helper("remove-home").stdout)
    assert removed["home"] == "removed" and not HOME.exists(), removed
    assert tree_digest(Path("/etc/hivra")) == etc_before, "links were removed as links"
    assert keep.read_text() == "keep" and keep.stat().st_nlink == 1, "a hardlink only loses its name"
    assert json.loads(helper("remove-home").stdout)["home"] == "absent"
    (OWNER_FOLDER / "inner").rmdir()
    (OWNER_FOLDER / "hello.txt").unlink()
    assert tree_digest(OWNER_FOLDER) == before, "~/Hivra holds exactly the owner's bytes again"

    # Source check (T31): the new root code never calls path-based mount, chown, chmod or recursive delete.
    source = HELPER.read_text()
    # It starts no program at all, so no path-based mount(8), mountpoint(1), chown(1) or rm -r can hide in argv.
    for forbidden in ("import subprocess", "os.system(", "os.popen(", "os.exec", "os.spawn", "shell=True",
                      "os.chown(", "os.chmod(", "os.lchown(", "os.lchmod(", "shutil.", "rmtree", "removedirs",
                      "mountpoint", "--bind", "rm -r", "libc().mount(", "libc().chown(", "libc().chmod("):
        assert forbidden not in source, forbidden
    print(json.dumps({"result": "PASS", "helper": hashlib.sha256(HELPER.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
