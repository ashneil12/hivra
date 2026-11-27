import ctypes
import errno
import importlib.util
import json
import os
import stat
import struct
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "hivra_gvisor_xfs_workspace", Path(__file__).with_name("hivra-gvisor-xfs-workspace.py"),
)
xfs = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = xfs
SPEC.loader.exec_module(xfs)


class FakeKernel:
    def __init__(self):
        self.enforced = True
        self.directories = {}
        self.records = {}
        self.writes = []
        self.wrong_readback = False
        self.assignment_visible = True

    def require_enforced(self, fd):
        if not self.enforced:
            raise xfs.QuotaError("enforcement off")

    def attrs(self, fd):
        return self.directories.get(os.fstat(fd).st_ino, (0, 0, 0, 0, 0, b"\0" * 8))

    def usage(self, fd, project):
        return self.records.get(project)

    def set_limits(self, fd, project, policy):
        self.writes.append(("limit", project))
        self.records[project] = xfs.Usage(
            policy.hard_bytes, policy.hard_inodes + self.wrong_readback, 0, 0,
        )

    def assign(self, fd, attrs, project):
        self.writes.append(("assign", project))
        if self.assignment_visible:
            self.directories[os.fstat(fd).st_ino] = (0x200, 0, 0, project, 0, b"\0" * 8)
            self.records[project] = replace(self.records[project], used_inodes=1)


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        mount = Path(temporary.name).resolve()
        self.root = mount / "docker"
        self.policy = xfs.Policy("/run/docker.sock", str(self.root), str(mount), ("adapter",),
                                 2000, 3000, 16384, 10)
        self.workspace = xfs.Workspace("11111111-1111-4111-8111-111111111111",
                                       "22222222-2222-4222-8222-222222222222", "a" * 64)
        self.directory, self.item = self.create_volume(self.workspace)
        self.project = self.workspace.project_id(self.policy)
        self.kernel = FakeKernel()
        self.quotas = xfs.XFSWorkspaceQuotas(self.policy, kernel=self.kernel)
        device = mount.stat().st_dev
        self.mounts = [(7, f"{os.major(device)}:{os.minor(device)}",
                        PurePosixPath("/"), PurePosixPath(mount), "xfs", True)]
        self.reported_root = str(self.root)
        self.volume_names = [self.workspace.name]
        self.volumes = {self.workspace.name: self.item}
        self.replace("_docker", side_effect=self.docker)
        self.namespace = self.replace("_require_docker_namespace")
        self.replace("_mounts", side_effect=lambda: iter(self.mounts))
        self.mount_id = self.replace("_mount_id", return_value=7)

    def replace(self, name, **kwargs):
        patcher = patch.object(xfs, name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def create_volume(self, workspace):
        directory = self.root / "volumes" / workspace.name / "_data"
        directory.mkdir(parents=True)
        item = {
            "Name": workspace.name, "Driver": "local", "Scope": "local",
            "Options": None, "Mountpoint": str(directory),
            "Labels": {
                "cloud.hivra.adapter": "adapter",
                "cloud.hivra.owner": workspace.owner_hash,
                "cloud.hivra.computer": workspace.computer_id,
                "cloud.hivra.sandbox": workspace.sandbox_id,
            },
        }
        return directory, item

    def docker(self, policy, *args):
        if args == ("info", "--format", "{{json .DockerRootDir}}"):
            return json.dumps(self.reported_root)
        if args[:2] == ("volume", "inspect"):
            return json.dumps([self.volumes[args[2]]])
        if args == ("volume", "ls", "--format", "{{.Name}}"):
            return "\n".join(self.volume_names)
        self.fail(f"unexpected Docker invocation: {args}")

    def assert_refused_without_writes(self):
        with self.assertRaises((xfs.QuotaError, OSError)):
            self.quotas.acquire(self.workspace)
        self.assertEqual(self.kernel.writes, [])

    def test_dry_acquire_is_read_only_and_apply_proves_exact_limits(self):
        self.assertEqual(self.quotas.dry_acquire(self.workspace), self.project)
        self.assertEqual(self.kernel.writes, [])
        proof = self.quotas.acquire(self.workspace)
        self.assertEqual(self.kernel.writes, [("limit", self.project), ("assign", self.project)])
        self.assertEqual(proof, self.quotas.verify(self.workspace))
        self.assertEqual(proof.path, str(self.directory))
        self.assertEqual(proof.usage, xfs.Usage(16384, 10, 0, 1))

    def test_create_preflight_is_read_only_before_volume_exists(self):
        with self.assertRaisesRegex(xfs.QuotaError, "Docker workspace still exists"):
            self.quotas.probe_create(self.workspace)
        self.volume_names.clear()
        with self.assertRaisesRegex(xfs.QuotaError, "workspace path still exists"):
            self.quotas.probe_create(self.workspace)
        self.directory.rmdir()
        self.directory.parent.rmdir()
        self.assertEqual(self.quotas.probe_create(self.workspace), self.project)
        self.kernel.records[self.project] = xfs.Usage(16384, 10, 0, 0)
        with self.assertRaisesRegex(xfs.QuotaError, "already allocated"):
            self.quotas.probe_create(self.workspace)
        self.assertEqual(self.kernel.writes, [])

    def test_foreign_volume_metadata_is_refused(self):
        original = dict(self.item)
        for key, value in (
            ("Name", "other"), ("Driver", "custom"), ("Scope", "global"),
            ("Options", {"type": "none", "o": "bind", "device": "/foreign"}),
            ("Mountpoint", str(self.directory) + "/."), ("Labels", {}),
            ("Labels", {**original["Labels"], "cloud.hivra.owner": "b" * 64}),
            ("Labels", {**original["Labels"], "cloud.hivra.adapter": "unknown"}),
        ):
            with self.subTest(key=key, value=value):
                self.item.update(original, **{key: value})
                self.assert_refused_without_writes()

    def test_current_docker_root_must_match_policy(self):
        self.reported_root += "/elsewhere"
        self.assert_refused_without_writes()

    def test_unverified_docker_mount_namespace_refuses_acquisition(self):
        self.namespace.side_effect = xfs.QuotaError("different namespace")
        self.assert_refused_without_writes()

    def test_symlink_is_refused_even_with_exact_inspection_path(self):
        foreign = self.directory.with_name("foreign")
        self.directory.rename(foreign)
        self.directory.symlink_to(foreign, target_is_directory=True)
        self.assert_refused_without_writes()

    def test_mount_must_be_whole_writable_xfs(self):
        record = self.mounts[0]
        for bad_record in (
            (*record[:4], "ext4", True),
            (*record[:5], False),
            (*record[:2], PurePosixPath("/bind"), *record[3:]),
        ):
            with self.subTest(record=bad_record):
                self.mounts[0] = bad_record
                self.assert_refused_without_writes()

    def test_nested_mount_is_refused_even_on_the_same_device(self):
        self.mounts.append((9, self.mounts[0][1], PurePosixPath("/somewhere"),
                            PurePosixPath(self.directory / "nested"), "xfs", True))
        self.assert_refused_without_writes()

    def test_mount_identity_is_checked_on_the_open_directory(self):
        self.mount_id.side_effect = [7, 7, 7, 19]
        self.assert_refused_without_writes()

    def test_disabled_enforcement_refused_without_mutation(self):
        self.kernel.enforced = False
        self.assert_refused_without_writes()

    def test_nonempty_or_tagged_volume_cannot_be_adopted(self):
        data = self.directory / "existing"
        data.touch()
        self.assert_refused_without_writes()
        data.unlink()
        self.kernel.directories[self.directory.stat().st_ino] = (0x200, 0, 0, 0, 0, b"\0" * 8)
        self.assert_refused_without_writes()

    def test_policy_rejects_byte_limit_not_aligned_to_xfs_blocks(self):
        self.quotas = xfs.XFSWorkspaceQuotas(
            replace(self.policy, hard_bytes=512), kernel=self.kernel,
        )
        with patch.object(xfs.os, "fstatvfs", return_value=SimpleNamespace(f_frsize=4096)):
            self.assert_refused_without_writes()

    def test_deterministic_collision_fails_even_for_zero_usage(self):
        fixed = replace(self.policy, first_project=4000, last_project=4000)
        other = replace(self.workspace, owner_hash="b" * 64)
        self.assertEqual(other.project_id(fixed), self.workspace.project_id(fixed))
        self.kernel.records[4000] = xfs.Usage(1, 1, 0, 0)
        q = xfs.XFSWorkspaceQuotas(fixed, kernel=self.kernel)
        for operation in (q.dry_acquire, q.acquire):
            with self.assertRaisesRegex(xfs.QuotaError, "already allocated"):
                operation(self.workspace)
        self.assertEqual(self.kernel.writes, [])

    def test_inexact_limit_readback_never_tags_directory(self):
        self.kernel.wrong_readback = True
        with self.assertRaisesRegex(xfs.QuotaError, "unused project"):
            self.quotas.acquire(self.workspace)
        self.assertEqual(self.kernel.writes, [("limit", self.project)])
        self.assertEqual(self.kernel.directories, {})
        with self.assertRaisesRegex(xfs.QuotaError, "already allocated"):
            self.quotas.acquire(self.workspace)

    def test_missing_assignment_readback_fails_closed(self):
        self.kernel.assignment_visible = False
        with self.assertRaisesRegex(xfs.QuotaError, "did not read back"):
            self.quotas.acquire(self.workspace)

    def test_wake_rejects_limit_or_root_drift_without_repair(self):
        original = self.quotas.acquire(self.workspace).usage
        self.kernel.writes.clear()
        self.kernel.records[self.project] = replace(original, hard_bytes=original.hard_bytes * 2)
        with self.assertRaises(xfs.QuotaError):
            self.quotas.verify(self.workspace)
        self.kernel.records[self.project] = original
        self.kernel.directories.clear()
        with self.assertRaises(xfs.QuotaError):
            self.quotas.verify(self.workspace)
        self.assertEqual(self.kernel.writes, [])

    def test_commitments_use_live_usage_and_include_retained_volume(self):
        stopped = replace(self.workspace, sandbox_id="44444444-4444-4444-8444-444444444444")
        _, self.volumes[stopped.name] = self.create_volume(stopped)
        self.volume_names.extend([stopped.name, "unrelated-docker-volume"])
        self.quotas.acquire(self.workspace)
        second = self.quotas.acquire(stopped)
        self.kernel.records[self.project] = xfs.Usage(16384, 10, 8192, 4)
        self.kernel.writes.clear()
        running, retained = self.quotas.commitments([self.workspace, stopped])
        self.assertEqual((running.outstanding_bytes, running.outstanding_inodes), (8192, 6))
        self.assertEqual(retained, second)
        self.assertEqual((retained.outstanding_bytes, retained.outstanding_inodes), (16384, 9))
        with self.assertRaisesRegex(xfs.QuotaError, "inventory does not match"):
            self.quotas.commitments([self.workspace])
        with self.assertRaisesRegex(xfs.QuotaError, "duplicate project"):
            self.quotas.commitments([self.workspace, self.workspace, stopped])
        self.assertEqual(self.kernel.writes, [])

    def test_delete_confirms_docker_path_and_usage_absence_without_recycling_id(self):
        proof = self.quotas.acquire(self.workspace)
        self.kernel.writes.clear()
        with self.assertRaisesRegex(xfs.QuotaError, "Docker workspace still exists"):
            self.quotas.confirm_deleted(proof)
        self.volume_names.clear()
        with self.assertRaisesRegex(xfs.QuotaError, "workspace path still exists"):
            self.quotas.confirm_deleted(proof)
        self.directory.rmdir()
        self.kernel.directories.pop(proof.inode)
        self.directory.parent.rmdir()
        with self.assertRaisesRegex(xfs.QuotaError, "still has usage"):
            self.quotas.confirm_deleted(proof)
        self.kernel.records[self.project] = replace(proof.usage, used_inodes=0)
        self.quotas.confirm_deleted(proof)
        self.directory.mkdir(parents=True)
        with self.assertRaisesRegex(xfs.QuotaError, "already allocated"):
            self.quotas.acquire(self.workspace)
        self.assertEqual(self.kernel.writes, [])


class LinuxABITests(unittest.TestCase):
    def setUp(self):
        self.kernel = object.__new__(xfs.LinuxXFS)

    def test_quota_state_checks_both_project_flags(self):
        for flags in (0x30, 0x10, 0x20, 0x03):
            with self.subTest(flags=flags):
                def call(fd, command, project, data):
                    self.assertEqual((fd, command, project), (8, 8, 0))
                    self.assertEqual(data[0], b"\x01")
                    struct.pack_into("=BBH", data, 0, 1, 0, flags)
                self.kernel._quota_call = call
                if flags == 0x30:
                    self.kernel.require_enforced(8)
                else:
                    with self.assertRaises(xfs.QuotaError):
                        self.kernel.require_enforced(8)

    def test_quotactl_fd_uses_project_quota_command_encoding(self):
        def syscall(number, fd, command, project, pointer):
            self.assertEqual((number.value, fd.value, command.value, project.value),
                             (443, 8, 0x580302, 0xf0000000))
            return 0
        self.kernel._syscall = syscall
        self.kernel._quota_call(8, 3, 0xf0000000, ctypes.create_string_buffer(112))

    def test_quota_usage_checks_record_and_converts_basic_blocks(self):
        def call(fd, command, project, data):
            self.assertEqual((fd, command, ctypes.sizeof(data)), (8, 3, 112))
            struct.pack_into("=bBHI6Q", data, 0, 1, 2, 0, 234, 32, 0, 10, 0, 16, 5)
        self.kernel._quota_call = call
        self.assertEqual(self.kernel.usage(8, 234), xfs.Usage(16384, 10, 8192, 5))
        with self.assertRaisesRegex(xfs.QuotaError, "identity"):
            self.kernel.usage(8, 235)

    def test_only_definitive_missing_quota_is_available(self):
        with patch.object(self.kernel, "_quota_call", side_effect=OSError(errno.ENOENT, "")):
            self.assertIsNone(self.kernel.usage(8, 234))
        with patch.object(self.kernel, "_quota_call", side_effect=OSError(errno.EPERM, "")):
            with self.assertRaises(OSError):
                self.kernel.usage(8, 234)

    def test_sets_hard_limits_only_in_basic_blocks_and_inodes(self):
        policy = xfs.Policy("/run/docker.sock", "/xfs/docker", "/xfs", ("adapter",),
                            1, 1000, 16384, 10)

        def call(fd, command, project, data):
            self.assertEqual((fd, command, project), (8, 4, 234))
            self.assertEqual(struct.unpack_from("=bBHI6Q", data), (1, 2, 10, 234, 32, 0, 10, 0, 0, 0))
        self.kernel._quota_call = call
        self.kernel.set_limits(8, 234, policy)


class DockerNamespaceTests(unittest.TestCase):
    def test_daemon_root_and_mount_namespace_must_match(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory).resolve() / "docker.pid"
            pid_file.write_text("715\n", encoding="ascii")
            policy = SimpleNamespace(docker_pid_file=str(pid_file))
            identity = SimpleNamespace(st_dev=2, st_ino=9)
            own_root = SimpleNamespace(st_dev=2, st_ino=1)
            paths = {
                "/proc/715/ns/mnt": identity,
                "/proc/self/ns/mnt": identity,
                "/proc/715/root": own_root,
                "/": own_root,
            }
            metadata = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_size=4)
            with (patch.object(xfs.os, "fstat", return_value=metadata),
                  patch.object(xfs.os, "readlink", return_value="/usr/bin/dockerd"),
                  patch.object(xfs.os, "stat", side_effect=paths.__getitem__)):
                xfs._require_docker_namespace(policy)
                paths["/proc/715/ns/mnt"] = SimpleNamespace(st_dev=2, st_ino=10)
                with self.assertRaisesRegex(xfs.QuotaError, "does not share"):
                    xfs._require_docker_namespace(policy)
                paths["/proc/715/ns/mnt"] = identity
                paths["/proc/715/root"] = SimpleNamespace(st_dev=2, st_ino=3)
                with self.assertRaisesRegex(xfs.QuotaError, "does not share"):
                    xfs._require_docker_namespace(policy)


if __name__ == "__main__":
    unittest.main()
