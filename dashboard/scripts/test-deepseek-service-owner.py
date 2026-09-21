"""Owned Linux fixtures for the staged service contract; never calls systemd."""
import errno
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "provisioner/deepseek-harness"
spec = importlib.util.spec_from_file_location("native_service", SOURCE / "service-owner.py")
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires disposable Linux root fixture")
class ServiceOwnership(unittest.TestCase):
    def setUp(self):
        owner.files.ancestors(Path("/root"))
        self.temp = tempfile.TemporaryDirectory(prefix="hivra-service-test-", dir="/root")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.unit = self.root / "systemd" / owner.SERVICE
        self.unit.parent.mkdir()
        self.unit.write_bytes(owner.TEMPLATE.read_bytes())
        self.unit.chmod(0o644)
        self.cgroup = self.root / "cgroup/system.slice" / owner.SERVICE
        self.cgroup.mkdir(parents=True)
        (self.cgroup.parent.parent / "cgroup.controllers").write_text("cpu memory pids\n")
        (self.cgroup / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        self.proc = self.root / "proc"
        (self.proc / "123").mkdir(parents=True)
        (self.proc / "123/cgroup").write_text("0::" + owner.CGROUP_NAME + "\n")
        (self.proc / "123/status").write_text("Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n")
        static = {**owner.STATIC, "FragmentPath": str(self.unit)}
        self.observed = {**static, "ExecStart": "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/hivra/deepseek-gateway/server.js ; ignore_errors=no ; pid=123 ; code=(null) ; status=0/0 }",
            "ActiveState": "active", "SubState": "running", "MainPID": "123", "ControlPID": "0",
            "ControlGroup": owner.CGROUP_NAME, "InvocationID": "a" * 32, "Job": ""}
        self.calls = []
        self.stop_effect = self.stopped
        for target, name, value in ((owner, "UNIT_FILE", self.unit), (owner, "CGROUP", self.cgroup),
                (owner, "PROC", self.proc), (owner, "STATIC", static), (owner, "service", self.service),
                (owner, "listeners_closed", lambda: True), (owner.pwd, "getpwnam", lambda _: SimpleNamespace(pw_uid=1000))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def stopped(self):
        self.observed.update(ActiveState="inactive", SubState="dead", MainPID="0", ControlGroup="")
        (self.cgroup / "cgroup.events").write_text("populated 0\nfrozen 0\n")

    def service(self, *arguments, **kwargs):
        self.calls.append((arguments, kwargs))
        if arguments[0] == "show":
            return "".join(f"{name}={value}\n" for name, value in self.observed.items()).encode()
        if arguments == ("stop", owner.SERVICE):
            self.stop_effect()
            return b""
        raise AssertionError("unexpected service mutation")

    def test_owned_running_generation_is_nonroot_and_in_the_service_cgroup(self):
        self.assertEqual(owner.state()["Job"], "0")  # Real systemctl Job= output.
        value = owner.verify_running()
        self.assertEqual(value["invocationId"], "a" * 32)
        self.assertEqual(value["supervisorPid"], 123)
        self.assertTrue(value["supervisorInOwnedCgroup"])
        self.assertFalse(value["wholeComputerCleanupVerified"])

    def test_stop_waits_for_unit_pids_cgroup_and_listener_absence(self):
        value = owner.stop_owned()
        self.assertTrue(value["serviceCgroupEmpty"])
        self.assertTrue(value["listenersClosed"])
        self.assertFalse(value["wholeComputerCleanupVerified"])
        stops = [call for call in self.calls if call[0][0] == "stop"]
        self.assertEqual(stops, [(("stop", owner.SERVICE), {"timeout": 30})])

    def test_real_missing_unit_shape_has_no_execstart_line_or_stop_mutation(self):
        self.unit.unlink()
        self.stopped()
        self.observed.update(LoadState="not-found", FragmentPath="", DropInPaths="", InvocationID="")
        self.observed.pop("ExecStart")
        value = owner.stop_owned()
        self.assertTrue(value["serviceCgroupEmpty"])
        self.assertEqual(value["previousInvocationId"], "")
        self.assertFalse(any(call[0][0] == "stop" for call in self.calls))
        self.observed["Job"] = "42"
        with self.assertRaises(owner.files.InstallError):
            owner.stop_owned()

    def test_loaded_unit_cannot_omit_execstart(self):
        self.observed.pop("ExecStart")
        with self.assertRaisesRegex(owner.files.InstallError, "invalid service state"):
            owner.stop_owned()
        self.assertFalse(any(call[0][0] == "stop" for call in self.calls))

    def test_custom_effective_definition_or_argv_rejects_before_stop(self):
        original = dict(self.observed)
        for key, value in (("DropInPaths", "/run/custom.conf"), ("User", "root"), ("KillMode", "process"),
                ("TimeoutStopUSec", "infinity"), ("Delegate", "yes"), ("LimitCORE", "infinity"),
                ("ExecStart", original["ExecStart"].replace("/usr/bin/node ; argv", "/tmp/node ; argv")),
                ("ExecStart", original["ExecStart"] + original["ExecStart"])):
            with self.subTest(key=key):
                self.observed = {**original, key: value}
                self.calls.clear()
                with self.assertRaises(owner.files.InstallError):
                    owner.stop_owned()
                self.assertFalse(any(call[0][0] == "stop" for call in self.calls))

    def test_matching_disk_template_does_not_authorize_stale_loaded_custom_behavior(self):
        # The manager can still hold old ExecStop/Environment after somebody
        # replaced the file with our template but before daemon-reload.
        self.observed["NeedDaemonReload"] = "yes"
        self.assertEqual(self.unit.read_bytes(), owner.TEMPLATE.read_bytes())
        with self.assertRaisesRegex(owner.files.InstallError, "effective service definition differs"):
            owner.stop_owned()
        self.assertFalse(any(call[0][0] == "stop" for call in self.calls))

    def test_custom_unit_file_is_preserved(self):
        self.unit.write_text("custom unit: preserve")
        with self.assertRaises(owner.files.InstallError):
            owner.stop_owned()
        self.assertEqual(self.unit.read_text(), "custom unit: preserve")
        self.assertFalse(any(call[0][0] == "stop" for call in self.calls))

    def test_stopped_leader_is_not_descendant_absence(self):
        def survivor():
            self.stopped()
            (self.cgroup / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        self.stop_effect = survivor
        with self.assertRaisesRegex(owner.files.InstallError, "remains unresolved"):
            owner.stop_owned()

    def test_queued_job_or_open_listener_keeps_outcome_unresolved(self):
        def queued():
            self.stopped()
            self.observed["Job"] = "42"
        self.stop_effect = queued
        with self.assertRaises(owner.files.InstallError):
            owner.stop_owned()
        self.observed["Job"] = ""
        self.stop_effect = self.stopped
        with patch.object(owner, "listeners_closed", return_value=False), self.assertRaises(owner.files.InstallError):
            owner.stop_owned()

    def test_missing_cgroup_hierarchy_is_not_a_cleanup_proof(self):
        (self.cgroup.parent.parent / "cgroup.controllers").unlink()
        with self.assertRaisesRegex(owner.files.InstallError, "hierarchy unavailable"):
            owner.stop_owned()

    def test_same_pid_from_different_generation_is_rejected(self):
        real = self.service
        count = 0
        def changing(*args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                self.observed["InvocationID"] = "b" * 32
            return real(*args, **kwargs)
        with patch.object(owner, "service", side_effect=changing), self.assertRaisesRegex(owner.files.InstallError, "generation changed"):
            owner.verify_running()

    def test_wrong_process_user_or_cgroup_is_not_running_acceptance(self):
        (self.proc / "123/status").write_text("Uid:\t0\t0\t0\t0\n")
        with self.assertRaisesRegex(owner.files.InstallError, "user differs"):
            owner.verify_running()
        (self.proc / "123/cgroup").write_text("0::/other.slice/service\n")
        with self.assertRaisesRegex(owner.files.InstallError, "outside owned cgroup"):
            owner.verify_running()

    def test_empty_invocation_identity_is_not_a_running_generation(self):
        self.observed["InvocationID"] = "0" * 32
        with self.assertRaisesRegex(owner.files.InstallError, "not a stable running generation"):
            owner.verify_running()

    def test_malformed_properties_and_cgroup_events_fail_closed(self):
        self.observed["MainPID"] = "123; arbitrary"
        with self.assertRaises(owner.files.InstallError):
            owner.state()
        (self.cgroup / "cgroup.events").write_text("populated 0\npopulated 1\n")
        with self.assertRaises(owner.files.InstallError):
            owner.cgroup_empty()


class ListenerChecks(unittest.TestCase):
    def test_only_refused_connections_count_as_absent(self):
        for result, expected in ((errno.ECONNREFUSED, True), (0, False), (errno.ETIMEDOUT, None)):
            probe = Mock()
            probe.connect_ex.return_value = result
            with patch.object(owner.socket, "socket") as factory:
                factory.return_value.__enter__.return_value = probe
                if expected is None:
                    with self.assertRaisesRegex(owner.files.InstallError, "inconclusive"):
                        owner.listeners_closed()
                else:
                    self.assertIs(owner.listeners_closed(), expected)


if __name__ == "__main__":
    unittest.main()
