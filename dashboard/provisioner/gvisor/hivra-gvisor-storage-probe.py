#!/usr/bin/python3
"""Read-only storage evidence for a provisioner-attested fixed XFS store."""

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

POLICY = Path("/opt/hivra/gvisor-adapter/storage-admission.json")
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "HOME": "/nonexistent"}


def read_policy():
    fd = os.open(POLICY, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as document:
        info = os.fstat(document.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 16384:
            raise ValueError("Storage policy is not a private root-owned file")
        return json.load(document)


def read(*argv):
    return subprocess.run(argv, text=True, check=True, capture_output=True, timeout=3, env=ENV).stdout


def mount_at(path):
    [mount] = json.loads(read("/usr/bin/findmnt", "--json", "--target", str(path),
                             "--output", "TARGET,SOURCE,FSTYPE,UUID,OPTIONS"))["filesystems"]
    return mount


def containerd_root():
    pid = read("/usr/bin/systemctl", "show", "--property=MainPID", "--value", "containerd.service").strip()
    if not re.fullmatch(r"[1-9][0-9]{0,9}", pid):
        raise ValueError("No supported standalone containerd service")
    args = Path(f"/proc/{pid}/cmdline").read_bytes().rstrip(b"\0").split(b"\0")
    if Path(os.readlink(f"/proc/{pid}/exe")).name != "containerd":
        raise ValueError("Unsupported containerd executable")
    if len(args) == 1:
        opts = ()
    elif args[1:] == [b"--config", b"/etc/containerd/config.toml"]:
        opts = ("--config", "/etc/containerd/config.toml")
    elif args[1:] == [b"--config=/etc/containerd/config.toml"]:
        opts = ("--config=/etc/containerd/config.toml",)
    else:
        raise ValueError("Unsupported containerd arguments")
    dump = read("/usr/bin/containerd", *opts, "config", "dump")
    [root] = re.findall(r"""^root\s*=\s*['"](/[A-Za-z0-9/._-]+)['"]\s*$""", dump, re.M)
    root = Path(root)
    database = root / "io.containerd.metadata.v1.bolt" / "meta.db"
    expected = database.stat()
    for fd in Path(f"/proc/{pid}/fd").iterdir():
        try:
            if os.path.samestat(fd.stat(), expected):
                return root
        except FileNotFoundError:
            continue
    raise ValueError("Running containerd metadata store does not match its configured root")


def evidence(policy):
    if policy["version"] != 1 or policy["backing"] != "reserved-fixed":
        raise ValueError("No provisioner-attested fixed backing")
    quota = policy["xfsWorkspace"]
    root, mount = Path(quota["docker_root"]), Path(quota["xfs_mount"])
    options = mount_at(mount)
    if (options["target"] != str(mount) or options["fstype"] != "xfs"
            or not options["uuid"] or options["uuid"] != policy["mountUuid"]
            or options["source"] != policy["mountSource"] or "rw" not in options["options"].split(",")):
        raise ValueError("Attested XFS mount changed")
    info = json.loads(read("/usr/bin/docker", "--host=unix://" + quota["docker_socket"], "info", "--format", "{{json .}}"))
    if info["DockerRootDir"] != str(root) or info["Driver"] not in {"overlay2", "overlayfs"} or info["LoggingDriver"] != "local":
        raise ValueError("Unsupported Docker storage or logging")
    persistent = (root, root / "volumes", containerd_root())
    if any(not p.is_relative_to(mount) or not p.is_dir() or p.resolve() != p or mount_at(p)["target"] != str(mount)
           for p in persistent):
        raise ValueError("Docker or containerd persists outside the attested mount")
    run = Path("/run")
    if mount_at(run)["fstype"] != "tmpfs":
        raise ValueError("Runtime state is not on tmpfs")
    runtime = (run / "docker", run / "containerd")
    if any(not p.is_dir() or mount_at(p)["target"] != str(run) for p in runtime):
        raise ValueError("Runtime state does not share the verified tmpfs")
    domains = []
    for category, path, workspace in (("persistent", mount, (quota["hard_bytes"], quota["hard_inodes"])),
                                      ("volatile", run, (0, 0))):
        row = {dimension: dict(policy[category][dimension]) for dimension in ("bytes", "inodes")}
        for dimension, limit in zip(("bytes", "inodes"), workspace):
            row[dimension].update(workspace=limit, outstanding=0)
        domains.append({"path": str(path), **row})
    return {"version": 1, "backing": "fixed", "filesystems": domains, "pools": [], "xfsWorkspace": quota}


if __name__ == "__main__":
    if os.geteuid() != 0 or len(sys.argv) != 5 or sys.argv[1] not in {"create", "start"}:
        sys.exit(1)
    try:
        print(json.dumps(evidence(read_policy()), separators=(",", ":")))
    except (KeyError, ValueError, TypeError, OSError, subprocess.SubprocessError):
        sys.exit(1)
