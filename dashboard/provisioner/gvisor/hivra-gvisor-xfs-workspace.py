"""Host-local XFS workspace quotas. Import this module; it has no CLI.

The caller holds the adapter's exclusive host flock throughout each operation
and serializes Docker lifecycle changes with this helper. The explicitly
configured, dedicated XFS mount and local Docker daemon are operator-controlled;
only this helper may assign project IDs in the configured range. Never share
that range with another allocator or change its bounds for existing volumes.
Call acquire only for a freshly created named volume before any container or
initializer can touch it. On any failure, do not use the volume. Never retag
an existing tree: verify (including on wake), or delete through Docker.
"""

import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import stat
import struct
import subprocess
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import PurePosixPath


class QuotaError(RuntimeError):
    """The workspace could not be safely acquired or proven."""


def _absolute(path):
    if (not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
            or str(PurePosixPath(path)) != path or ".." in PurePosixPath(path).parts
            or any(ord(ch) < 32 for ch in path)):
        raise QuotaError("noncanonical host path")
    return PurePosixPath(path)


@dataclass(frozen=True)
class Policy:
    docker_socket: str
    docker_root: str
    xfs_mount: str
    adapter_versions: tuple[str, ...]
    first_project: int
    last_project: int
    hard_bytes: int
    hard_inodes: int
    docker_pid_file: str = "/run/docker.pid"

    def __post_init__(self):
        root, mount = _absolute(self.docker_root), _absolute(self.xfs_mount)
        socket = _absolute(self.docker_socket)
        pid_file = _absolute(self.docker_pid_file)
        if (mount == PurePosixPath("/") or not root.is_relative_to(mount)
                or socket == PurePosixPath("/") or pid_file == PurePosixPath("/")
                or not isinstance(self.adapter_versions, tuple)
                or not self.adapter_versions
                or not all(isinstance(v, str) and v for v in self.adapter_versions)):
            raise QuotaError("invalid workspace topology policy")
        limits = (self.first_project, self.last_project, self.hard_bytes, self.hard_inodes)
        if (any(type(value) is not int for value in limits)
                or not 1 <= self.first_project <= self.last_project <= 0xffffffff
                or not 0 < self.hard_bytes <= 0xffffffffffffffff
                or not 0 < self.hard_inodes <= 0x7fffffffffffffff
                or self.hard_bytes % 512):
            raise QuotaError("invalid workspace quota policy")


_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_HASH = re.compile(r"[0-9a-f]{64}")
_WORKSPACE_PREFIX = "hivra-gvisor-workspace-"


@dataclass(frozen=True)
class Workspace:
    sandbox_id: str
    computer_id: str
    owner_hash: str

    def __post_init__(self):
        for value, pattern in ((self.sandbox_id, _UUID), (self.computer_id, _UUID),
                               (self.owner_hash, _HASH)):
            if not isinstance(value, str) or not pattern.fullmatch(value):
                raise QuotaError("invalid workspace identity")

    @property
    def name(self):
        return _WORKSPACE_PREFIX + self.sandbox_id

    def project_id(self, policy):
        identity = f"hivra-gvisor-xfs-v1:{self.sandbox_id}:{self.computer_id}:{self.owner_hash}"
        value = int.from_bytes(hashlib.sha256(identity.encode("ascii")).digest(), "big")
        return policy.first_project + value % (policy.last_project - policy.first_project + 1)


@dataclass(frozen=True)
class Usage:
    hard_bytes: int
    hard_inodes: int
    used_bytes: int
    used_inodes: int


@dataclass(frozen=True)
class Proof:
    workspace: Workspace
    path: str
    project_id: int
    mount_id: int
    device: int
    inode: int
    usage: Usage

    @property
    def outstanding_bytes(self):
        return max(0, self.usage.hard_bytes - self.usage.used_bytes)

    @property
    def outstanding_inodes(self):
        return max(0, self.usage.hard_inodes - self.usage.used_inodes)


_PROJINHERIT = 0x200
_FSGETXATTR = 0x801c581f
_FSSETXATTR = 0x401c5820
_XATTR = struct.Struct("=IIIII8s")
_DQ_HEADER = struct.Struct("=bBHI6Q")
_DQ_VERSION = 1
_DQ_PROJECT = 1 << 1
_DQ_HARD = (1 << 1) | (1 << 3)
_PROJECT_ACTIVE = (1 << 4) | (1 << 5)
_SYS_QUOTACTL_FD = 443
_Q_XGETQUOTA = 3
_Q_XSETQLIM = 4
_Q_XGETQSTATV = 8
_FS_QSTATV_VERSION1 = 1


class LinuxXFS:
    """Linux UAPI: linux/fs.h, linux/dqblk_xfs.h and quotactl_fd(2)."""

    def __init__(self):
        host = os.uname()
        if host.sysname != "Linux" or host.machine != "x86_64":
            raise QuotaError("workspace quotas require Linux x86_64")
        self._syscall = ctypes.CDLL(None, use_errno=True).syscall
        self._syscall.restype = ctypes.c_long

    def _quota_call(self, fd, command, project, data):
        code = (((ord("X") << 8) | command) << 8) | 2
        rc = self._syscall(ctypes.c_long(_SYS_QUOTACTL_FD), ctypes.c_uint(fd), ctypes.c_uint(code),
                           ctypes.c_uint(project), ctypes.byref(data))
        if rc != 0:
            number = ctypes.get_errno()
            raise OSError(number, os.strerror(number))

    def require_enforced(self, fd):
        data = ctypes.create_string_buffer(256)
        data[0] = bytes([_FS_QSTATV_VERSION1])
        self._quota_call(fd, _Q_XGETQSTATV, 0, data)
        version, _, flags = struct.unpack_from("=BBH", data)
        if version != _FS_QSTATV_VERSION1 or flags & _PROJECT_ACTIVE != _PROJECT_ACTIVE:
            raise QuotaError("XFS project quota accounting and enforcement must both be active")

    def usage(self, fd, project):
        data = ctypes.create_string_buffer(112)
        try:
            self._quota_call(fd, _Q_XGETQUOTA, project, data)
        except OSError as error:
            if error.errno == errno.ENOENT:
                return None
            raise
        version, flags, _, actual, b_hard, _, i_hard, _, blocks, inodes = _DQ_HEADER.unpack_from(data)
        if version != _DQ_VERSION or flags != _DQ_PROJECT or actual != project:
            raise QuotaError("XFS quota record identity did not match")
        return Usage(b_hard * 512, i_hard, blocks * 512, inodes)

    def set_limits(self, fd, project, policy):
        data = ctypes.create_string_buffer(112)
        _DQ_HEADER.pack_into(data, 0, _DQ_VERSION, _DQ_PROJECT, _DQ_HARD, project,
                             policy.hard_bytes // 512, 0, policy.hard_inodes, 0, 0, 0)
        self._quota_call(fd, _Q_XSETQLIM, project, data)

    def attrs(self, fd):
        data = bytearray(_XATTR.size)
        fcntl.ioctl(fd, _FSGETXATTR, data)
        return _XATTR.unpack(data)

    def assign(self, fd, attrs, project):
        flags, extent, nextents, _, cowext, padding = attrs
        data = _XATTR.pack(flags | _PROJINHERIT, extent, nextents, project, cowext, padding)
        fcntl.ioctl(fd, _FSSETXATTR, data)


def _docker(policy, *args):
    try:
        result = subprocess.run(
            ["/usr/bin/docker", "--host=unix://" + policy.docker_socket, *args],
            env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"}, cwd="/",
            stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=30, check=True,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        raise QuotaError("could not read local Docker evidence") from error
    return result.stdout


def _docker_json(policy, *args):
    try:
        return json.loads(_docker(policy, *args))
    except json.JSONDecodeError as error:
        raise QuotaError("invalid local Docker evidence") from error


def _mount_id(fd):
    with open(f"/proc/self/fdinfo/{fd}", encoding="ascii") as info:
        matches = re.findall(r"^mnt_id:\s+(\d+)$", info.read(), re.MULTILINE)
    if len(matches) != 1:
        raise QuotaError("missing file descriptor mount identity")
    return int(matches[0])


def _mount_path(value):
    return PurePosixPath(re.sub(r"\\(040|011|012|134)", lambda m: chr(int(m[1], 8)), value))


def _mounts():
    with open("/proc/self/mountinfo", encoding="utf-8", errors="surrogateescape") as file:
        for line in file:
            before, after = line.rstrip("\n").split(" - ", 1)
            fields, fs = before.split(), after.split()
            yield (int(fields[0]), fields[2], _mount_path(fields[3]), _mount_path(fields[4]),
                   fs[0], "rw" in fields[5].split(",") and "rw" in fs[2].split(","))


def _open_dir(stack, path, parent=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=parent)
    stack.callback(os.close, fd)
    return fd


def _require_docker_namespace(policy):
    """The configured PID file must belong to the daemon behind the local socket."""
    pid_file = PurePosixPath(policy.docker_pid_file)
    with ExitStack() as stack:
        parent = _open_dir(stack, "/")
        for component in pid_file.parts[1:-1]:
            parent = _open_dir(stack, component, parent)
        fd = os.open(pid_file.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=parent)
        stack.callback(os.close, fd)
        metadata = os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH) or metadata.st_size > 32):
            raise QuotaError("Docker PID file is not trusted")
        pid = os.read(fd, 33).strip()
    if not re.fullmatch(rb"[1-9][0-9]{0,9}", pid):
        raise QuotaError("invalid Docker PID")
    process = "/proc/" + pid.decode("ascii")
    if (PurePosixPath(os.readlink(process + "/exe")).name != "dockerd"
            or not os.path.samestat(os.stat(process + "/ns/mnt"), os.stat("/proc/self/ns/mnt"))
            or not os.path.samestat(os.stat(process + "/root"), os.stat("/"))):
        raise QuotaError("Docker daemon does not share the adapter's mount namespace and root")


class XFSWorkspaceQuotas:
    def __init__(self, policy, *, kernel=None):
        self.policy = policy
        self.kernel = LinuxXFS() if kernel is None else kernel

    @contextmanager
    def _scope(self, workspace):
        policy = self.policy
        root = _docker_json(policy, "info", "--format", "{{json .DockerRootDir}}")
        if root != policy.docker_root:
            raise QuotaError("current Docker root does not match workspace policy")
        _require_docker_namespace(policy)
        mount_path = PurePosixPath(policy.xfs_mount)
        volumes = PurePosixPath(root) / "volumes"
        volume = volumes / workspace.name
        with ExitStack() as stack:
            current = _open_dir(stack, "/")
            mfd = None
            walked = PurePosixPath("/")
            for component in volumes.parts[1:]:
                current = _open_dir(stack, component, current)
                walked /= component
                if walked == mount_path:
                    mfd = current
            if mfd is None:
                raise QuotaError("dedicated XFS mount is not an ancestor of Docker volumes")
            mid = _mount_id(mfd)
            volume_dev = os.fstat(mfd).st_dev
            major_minor = f"{os.major(volume_dev)}:{os.minor(volume_dev)}"
            record = (mid, major_minor, PurePosixPath("/"), mount_path, "xfs", True)
            mounts = list(_mounts())
            if (record not in mounts or _mount_id(current) != mid
                    or any(m[0] != mid and m[3].is_relative_to(mount_path)
                           and (volume.is_relative_to(m[3]) or m[3].is_relative_to(volume))
                           for m in mounts)):
                raise QuotaError("workspace is not on the dedicated writable XFS mount")
            granularity = os.fstatvfs(mfd).f_frsize
            if granularity <= 0 or policy.hard_bytes % granularity:
                raise QuotaError("workspace hard byte limit must align with XFS blocks")
            self.kernel.require_enforced(mfd)
            yield stack, mfd, current, mid, volume_dev

    @contextmanager
    def _target(self, workspace):
        policy = self.policy
        path = f"{policy.docker_root}/volumes/{workspace.name}/_data"
        with self._scope(workspace) as (stack, mfd, volumes_fd, mid, dev):
            items = _docker_json(policy, "volume", "inspect", workspace.name)
            if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
                raise QuotaError("invalid Docker volume inspection")
            item = items[0]
            labels = item.get("Labels")
            if (item.get("Name") != workspace.name or item.get("Driver") != "local"
                    or item.get("Scope") != "local" or "Options" not in item
                    or item["Options"] not in (None, {}) or item.get("Mountpoint") != path
                    or not isinstance(labels, dict)
                    or labels.get("cloud.hivra.adapter") not in policy.adapter_versions
                    or labels.get("cloud.hivra.owner") != workspace.owner_hash
                    or labels.get("cloud.hivra.computer") != workspace.computer_id
                    or labels.get("cloud.hivra.sandbox") != workspace.sandbox_id):
                raise QuotaError("Docker volume is not the expected owned local workspace")
            vfd = _open_dir(stack, workspace.name, volumes_fd)
            fd = _open_dir(stack, "_data", vfd)
            inode = os.fstat(fd)
            if _mount_id(vfd) != mid or _mount_id(fd) != mid or inode.st_dev != dev:
                raise QuotaError("workspace directory mount identity changed")
            yield mfd, fd, path, mid, inode

    def _volume_names(self):
        names = _docker(self.policy, "volume", "ls", "--format", "{{.Name}}").splitlines()
        if len(set(names)) != len(names) or any(not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", n)
                                               for n in names):
            raise QuotaError("invalid Docker volume inventory")
        return set(names)

    def _require_absent(self, volumes_fd, name):
        if name in self._volume_names():
            raise QuotaError("Docker workspace still exists")
        try:
            os.stat(name, dir_fd=volumes_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise QuotaError("workspace path still exists")

    def _require_available(self, mfd, project):
        """Any readable record is occupied, including a zero-usage tombstone."""
        if self.kernel.usage(mfd, project) is not None:
            raise QuotaError("workspace project ID is already allocated")

    def probe_create(self, workspace):
        """Read-only preflight before creating a Docker volume."""
        project = workspace.project_id(self.policy)
        with self._scope(workspace) as (_, mfd, volumes_fd, _, _):
            self._require_absent(volumes_fd, workspace.name)
            self._require_available(mfd, project)
        return project

    def _preflight(self, mfd, fd, project):
        attrs = self.kernel.attrs(fd)
        if attrs[3] != 0 or attrs[0] & _PROJINHERIT or os.listdir(fd):
            raise QuotaError("new workspace is already tagged or not empty")
        self._require_available(mfd, project)
        return attrs

    def dry_acquire(self, workspace):
        """Read-only eligibility and collision check on an empty Docker volume."""
        project = workspace.project_id(self.policy)
        with self._target(workspace) as (mfd, fd, _, _, _):
            self._preflight(mfd, fd, project)
        return project

    def _verified_usage(self, mfd, fd, project):
        self.kernel.require_enforced(mfd)
        attrs = self.kernel.attrs(fd)
        usage = self.kernel.usage(mfd, project)
        if (attrs[3] != project or not attrs[0] & _PROJINHERIT or usage is None
                or usage.hard_bytes != self.policy.hard_bytes
                or usage.hard_inodes != self.policy.hard_inodes or usage.used_inodes < 1):
            raise QuotaError("XFS project identity, inheritance or hard limits did not read back")
        return usage

    def acquire(self, workspace):
        """Set and prove the hard limits before use. Never roll back a reserved ID."""
        project = workspace.project_id(self.policy)
        with self._target(workspace) as (mfd, fd, path, mid, inode):
            attrs = self._preflight(mfd, fd, project)
            self.kernel.set_limits(mfd, project, self.policy)
            reserved = self.kernel.usage(mfd, project)
            if reserved != Usage(self.policy.hard_bytes, self.policy.hard_inodes, 0, 0):
                raise QuotaError("XFS hard limits did not read back on an unused project")
            if self.kernel.attrs(fd) != attrs or os.listdir(fd):
                raise QuotaError("workspace changed during acquisition")
            self.kernel.assign(fd, attrs, project)
            usage = self._verified_usage(mfd, fd, project)
            return Proof(workspace, path, project, mid, inode.st_dev, inode.st_ino, usage)

    def verify(self, workspace):
        """Read-only proof for a retained workspace; never fixes quota drift."""
        project = workspace.project_id(self.policy)
        with self._target(workspace) as (mfd, fd, path, mid, inode):
            usage = self._verified_usage(mfd, fd, project)
            return Proof(workspace, path, project, mid, inode.st_dev, inode.st_ino, usage)

    def commitments(self, workspaces):
        """Prove every supplied owned volume, including stopped ones.

        Supply the complete inventory of retained owned volumes, not running
        containers. The helper cross-checks Docker's entire Hivra workspace
        namespace; an unexpected volume or duplicate project denies the batch.
        """
        workspaces = tuple(workspaces)
        expected = {workspace.name for workspace in workspaces}
        discovered = {name for name in self._volume_names() if name.startswith(_WORKSPACE_PREFIX)}
        if expected != discovered:
            raise QuotaError("owned workspace inventory does not match Docker")
        proofs = {}
        for workspace in workspaces:
            proof = self.verify(workspace)
            if proof.project_id in proofs:
                raise QuotaError("duplicate project in workspace inventory")
            proofs[proof.project_id] = proof
        return tuple(proofs.values())

    def confirm_deleted(self, proof):
        """After Docker removes the proven volume, verify absence and retain its ID."""
        workspace = proof.workspace
        with self._scope(workspace) as (_, mfd, volumes_fd, mid, device):
            if (mid != proof.mount_id or device != proof.device
                    or workspace.project_id(self.policy) != proof.project_id):
                raise QuotaError("deleted workspace backing identity changed")
            self._require_absent(volumes_fd, workspace.name)
            retained = self.kernel.usage(mfd, proof.project_id)
            if retained != Usage(proof.usage.hard_bytes, proof.usage.hard_inodes, 0, 0):
                raise QuotaError("deleted workspace still has usage or lost its quota tombstone")
