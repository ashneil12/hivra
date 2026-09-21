#!/usr/bin/env python3
"""Execute the staged stop controller with simulated systemd/Docker observations.

No guest commands or live resource mutations. Filesystem rejection cases use
owned temporary files; this is not Linux/systemd or provider acceptance.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent / "provisioner/remote-desktop/provider-service-owner.py"
spec = importlib.util.spec_from_file_location("desktop_owner", SOURCE)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
CID = "a" * 64
COMPUTER = "11111111-1111-4111-8111-111111111111"
OPERATION = "22222222-2222-4222-8222-222222222222"
OTHER = "33333333-3333-4333-8333-333333333333"
FILES = {unit: ("reviewed-template:" + unit + ":" + CID).encode() for unit in owner.UNITS}
PLAN = {"version": 1, "computerId": COMPUTER, "operationId": OPERATION,
        "units": {unit: hashlib.sha256(data).hexdigest() for unit, data in FILES.items()},
        "container": {"id": CID, "imageId": "sha256:" + "b" * 64}}


def running(unit):
    return dict(LoadState="loaded", FragmentPath=str(owner.UNIT_ROOT / unit), DropInPaths="", NeedDaemonReload="no",
                Transient="no", ActiveState="active", SubState="running", MainPID="42", ControlPID="0",
                ControlGroup="/system.slice/" + unit, Job="", UnitFileState="enabled")


class DesktopOwnerTest(unittest.TestCase):
    def setUp(self):
        self.services = {unit: running(unit) for unit in owner.UNITS}
        self.container = [CID, "/" + owner.CONTAINER_NAME, PLAN["container"]["imageId"],
                          {"io.hivra.computer-id": COMPUTER, "io.hivra.operation-id": OPERATION}, "no", "system.slice", False,
                          {"Running": True, "Paused": False, "Restarting": False, "Dead": False, "Pid": 99, "Status": "running"}]
        self.named_id = CID
        self.present = True
        self.files = dict(FILES)
        self.commands = []
        self.mutations = []
        self.keep_running = False
        self.patches = [patch.object(owner.sys, "platform", "linux"), patch.object(owner.os, "geteuid", return_value=0),
                        patch.object(owner, "command", side_effect=self.command),
                        patch.object(owner, "read_regular", side_effect=lambda path, *_: self.files[path.name]),
                        patch.object(owner, "process_cgroup", return_value=("0::/system.slice/docker-" + CID + ".scope\n").encode()),
                        patch.object(owner, "cgroup_empty", return_value=True), patch.object(owner, "listeners_closed", return_value=True)]
        for item in self.patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    def command(self, argv, timeout=10):
        self.commands.append(argv)
        if argv[:2] == ["/usr/bin/docker", "info"]:
            return b"systemd/2\n"
        if argv[:2] == ["/usr/bin/systemctl", "show"]:
            return ("\n".join(key + "=" + value for key, value in self.services[argv[-1]].items()) + "\n").encode()
        if argv[:2] == ["/usr/bin/systemctl", "disable"]:
            self.mutations.append(argv)
            self.services[argv[-1]]["UnitFileState"] = "disabled"
            return b""
        if argv[:2] == ["/usr/bin/systemctl", "stop"]:
            self.mutations.append(argv)
            self.assertEqual(timeout, 30)
            self.services[argv[-1]].update(ActiveState="inactive", SubState="dead", MainPID="0", ControlGroup="")
            return b""
        if argv[:3] == ["/usr/bin/docker", "container", "ls"]:
            identity = self.named_id if argv[6].startswith("name=") else CID if self.present else ""
            return (identity + "\n").encode() if identity else b""
        if argv[:3] == ["/usr/bin/docker", "container", "inspect"]:
            self.assertEqual(argv[-1], CID)
            return json.dumps(self.container).encode()
        if argv[:3] == ["/usr/bin/docker", "container", "stop"]:
            self.mutations.append(argv)
            self.assertEqual(argv, ["/usr/bin/docker", "container", "stop", "--time", "10", CID])
            self.assertEqual(timeout, 20)
            if not self.keep_running:
                self.container[-1].update(Running=False, Pid=0, Status="exited")
            return (CID + "\n").encode()
        self.fail("Unexpected command: " + repr(argv))

    def test_stops_only_bound_services_and_exact_container_without_deletion(self):
        result = owner.stop_owned(PLAN)
        self.assertEqual(result["computerId"], COMPUTER)
        self.assertEqual(result["operationId"], OPERATION)
        self.assertFalse(result["wholeComputerCleanupVerified"])
        self.assertTrue(result["bootStartDisabled"])
        self.assertEqual(len(self.mutations), 7)
        self.assertFalse(any(part in ("rm", "prune", "docker.service", "restart", "start") for argv in self.mutations for part in argv))

    def test_fresh_observation_does_not_stop_or_reuse_cached_success(self):
        self.assertFalse(owner.observe_stopped(PLAN))
        self.assertEqual(self.mutations, [])
        owner.stop_owned(PLAN)
        self.mutations.clear()
        self.assertTrue(owner.observe_stopped(PLAN))
        self.services[owner.UNITS[0]] = running(owner.UNITS[0])
        self.assertFalse(owner.observe_stopped(PLAN))
        self.assertEqual(self.mutations, [])

    def test_absent_services_require_exact_absence_not_an_unloaded_file(self):
        self.present = False
        self.named_id = ""
        for state in self.services.values():
            state.update(LoadState="not-found", FragmentPath="", ControlGroup="", UnitFileState="",
                         ActiveState="inactive", SubState="dead", MainPID="0")
        with patch.object(owner.os.path, "lexists", return_value=False):
            self.assertTrue(owner.stop_owned(PLAN)["servicesStopped"])
        self.assertEqual(self.mutations, [])
        with patch.object(owner.os.path, "lexists", return_value=True):
            with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
        self.assertEqual(self.mutations, [])

    def test_both_entrypoints_require_linux_root(self):
        for function in (owner.stop_owned, owner.observe_stopped):
            with patch.object(owner.os, "geteuid", return_value=1000):
                with self.assertRaises(RuntimeError): function(PLAN)
            with patch.object(owner.sys, "platform", "darwin"):
                with self.assertRaises(RuntimeError): function(PLAN)
        self.assertEqual(self.commands, [])

    def test_foreign_unit_refused_before_any_mutation(self):
        self.files[owner.UNITS[-1]] = b"foreign service"
        with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
        self.assertEqual(self.mutations, [])

    def test_foreign_effective_service_refused_before_mutation(self):
        for field, value in (("DropInPaths", "/foreign.conf"), ("FragmentPath", "/foreign.service"),
                             ("NeedDaemonReload", "yes"), ("Transient", "yes"), ("Job", "57"),
                             ("ControlGroup", "/foreign"), ("UnitFileState", "linked")):
            with self.subTest(field=field):
                self.services[owner.UNITS[-1]] = {**running(owner.UNITS[-1]), field: value}
                with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
                self.assertEqual(self.mutations, [])

    def test_foreign_container_refused_before_mutation(self):
        for index, value in ((0, "c" * 64), (1, "/foreign"), (2, "sha256:" + "c" * 64),
                             (3, {"io.hivra.computer-id": OTHER, "io.hivra.operation-id": OPERATION}),
                             (3, {"io.hivra.computer-id": COMPUTER, "io.hivra.operation-id": OTHER}), (4, "always"),
                             (5, "custom.slice"), (5, ""), (6, True)):
            with self.subTest(index=index, value=value):
                previous = self.container[index]
                self.container[index] = value
                with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
                self.assertEqual(self.mutations, [])
                self.container[index] = previous

    def test_wrong_actual_container_process_cgroup_refused_before_mutation(self):
        with patch.object(owner, "process_cgroup", return_value=("0::/foreign.slice/docker-" + CID + ".scope\n").encode()):
            with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
        self.assertEqual(self.mutations, [])

    def test_replacement_name_refused_even_if_owned_container_absent(self):
        self.present = False
        self.named_id = "c" * 64
        with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
        self.assertEqual(self.mutations, [])

    def test_absent_container_requires_successful_empty_id_and_name_observations(self):
        self.present = False
        self.named_id = ""
        self.assertTrue(owner.stop_owned(PLAN)["containerStopped"])
        self.assertFalse(any(argv[0] == "/usr/bin/docker" for argv in self.mutations))

    def test_docker_observation_failure_is_not_absence(self):
        with patch.object(owner, "container_state", side_effect=RuntimeError("unreachable")):
            with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
        self.assertEqual(self.mutations, [])

    def test_unresolved_container_cgroup_or_listener_never_proves_cleanup(self):
        self.keep_running = True
        with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
        self.keep_running = False
        with patch.object(owner, "cgroup_empty", return_value=False):
            with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
        with patch.object(owner, "listeners_closed", return_value=False):
            with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)

    def test_docker_cgroup_population_prevents_cleanup_even_when_daemon_reports_stopped(self):
        with patch.object(owner, "cgroup_empty", side_effect=lambda name: not name.startswith("docker-")):
            with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)

    def test_unknown_docker_cgroup_driver_refused_before_mutation(self):
        def command(argv, timeout=10):
            return b"cgroupfs/1\n" if argv[:2] == ["/usr/bin/docker", "info"] else self.command(argv, timeout)
        with patch.object(owner, "command", side_effect=command):
            with self.assertRaises(RuntimeError): owner.stop_owned(PLAN)
        self.assertEqual(self.mutations, [])

    def test_plan_cannot_select_arbitrary_service_or_container_name(self):
        for change in ({"units": {"docker.service": "a" * 64}}, {"version": True}, {"computerId": "invalid"},
                       {"container": {"id": "short", "imageId": PLAN["container"]["imageId"]}}, {"extra": "authority"}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                owner.stop_owned({**copy.deepcopy(PLAN), **change})
        self.assertEqual(self.mutations, [])

    def test_timeout_has_fixed_diagnostic_and_no_success(self):
        with patch.object(owner, "command", side_effect=subprocess.TimeoutExpired("credential-like-content", 10)):
            with self.assertRaisesRegex(RuntimeError, "^Provider desktop cleanup ownership could not be verified$"):
                owner.stop_owned(PLAN)


class FileBoundaryTest(unittest.TestCase):
    def test_real_open_rejects_links_and_modes(self):
        with tempfile.TemporaryDirectory(prefix="hivra-desktop-owner-") as folder:
            root = Path(folder)
            target = root / "unit"
            target.write_bytes(b"owned test")
            target.chmod(0o644)
            original_fstat = os.fstat

            def fstat(fd):
                info = original_fstat(fd)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_nlink=info.st_nlink, st_size=info.st_size)
            with patch.object(owner, "directory"), patch.object(owner.os, "fstat", side_effect=fstat):
                self.assertEqual(owner.read_regular(target, 100, 0o644), b"owned test")
                symlink = root / "symlink"
                symlink.symlink_to(target)
                with self.assertRaises(OSError): owner.read_regular(symlink, 100, 0o644)
                os.link(target, root / "hardlink")
                with self.assertRaises(RuntimeError): owner.read_regular(target, 100, 0o644)
                (root / "hardlink").unlink()
                target.chmod(0o666)
                with self.assertRaises(RuntimeError): owner.read_regular(target, 100, 0o644)


if __name__ == "__main__":
    unittest.main()
