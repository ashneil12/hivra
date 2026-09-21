#!/usr/bin/env python3
"""Local executable worker tests; no SSH, systemd or package execution.

The Jest wrapper supplies the actual server-generated bundle manifest. All
filesystem state is test-owned. Only systemd and Darwin's missing renameat2
syscall are substituted; production parsing, fencing, locks and journals run.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from unittest.mock import Mock
from types import SimpleNamespace

sys.dont_write_bytecode = True
FIXTURE = json.loads(sys.stdin.read())
SOURCE = Path(__file__).resolve().parent.parent / "provisioner"
spec = importlib.util.spec_from_file_location("worker", SOURCE / "hivra-provider-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Rename:
    def __call__(self, _from_dir, source, _to_dir, destination, flags):
        assert flags == 1
        if os.path.lexists(destination):
            return -1
        os.rename(source, destination)
        return 0


class Libc:
    renameat2 = Rename()


def absent():
    return {"LoadState": "not-found", "ActiveState": "inactive", "SubState": "dead",
            "MainPID": "0", "ControlPID": "0", "ControlGroup": "", "Transient": "no"}


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hivra-provider-worker-test-")
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle" / "current"
        self.bundle.mkdir(parents=True)
        for file in FIXTURE["manifest"]:
            destination = self.bundle / file["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / file["path"], destination)
            destination.chmod(file["mode"])
        receipt = self.bundle / ".hivra-receipt.json"
        receipt.write_bytes(worker.encode(FIXTURE["identity"]["bundle"]))
        receipt.chmod(0o600)
        self.request = copy.deepcopy(FIXTURE)
        self.state = absent()
        self.commands = []
        self.lost_ack = False
        self.cancel_still_running = False
        self.clock = copy.deepcopy(FIXTURE["clock"])

        def ensure_root():
            worker.ROOT.mkdir(mode=0o700, exist_ok=True)
            worker.directory(worker.ROOT)

        def command(arguments, **options):
            self.commands.append(arguments)
            if arguments[0] == "/usr/bin/systemd-run":
                self.assertIn("--property=RuntimeMaxSec=480s", arguments)
                self.assertIn("--property=KillMode=control-group", arguments)
                self.assertIn("--property=RemainAfterExit=no", arguments)
                self.assertEqual(options["timeout"], 2)
                self.assertEqual(options["stdin"], subprocess.DEVNULL)
                self.assertNotIn(FIXTURE["launch"]["tunnelToken"], str(arguments))
                if self.lost_ack:
                    raise subprocess.TimeoutExpired("systemd-run", 2)
                self.state = {**absent(), "LoadState": "loaded", "ActiveState": "active", "SubState": "running",
                              "MainPID": "99", "Transient": "yes", "ControlGroup": "/system.slice/" + worker.UNIT}
                return subprocess.CompletedProcess(arguments, 0)
            self.assertEqual(arguments[0], "/usr/bin/systemctl")
            if arguments[1] == "show":
                raw = "\n".join(key + "=" + value for key, value in self.state.items()) + "\n"
                return subprocess.CompletedProcess(arguments, 0, stdout=raw.encode("ascii"))
            self.assertEqual(arguments[1:], ["stop", "--no-block", worker.UNIT])
            if not self.cancel_still_running:
                self.state = absent()
            return subprocess.CompletedProcess(arguments, 0, stdout=b"")

        patches = [patch.object(worker, "BUNDLE", self.bundle), patch.object(worker, "ROOT", self.root / "operation"),
                   patch.object(worker, "INSTALL_LOCK", self.root / "guest-install.lock"),
                   patch.object(worker, "CGROUP", self.root / "cgroup"), patch.object(worker, "ensure_root", ensure_root),
                   patch.object(worker, "guest_clock", lambda: self.clock), patch.object(worker.subprocess, "run", command)]
        if sys.platform != "linux":
            patches.append(patch.object(worker.ctypes, "CDLL", lambda *_args, **_kwargs: Libc()))
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(self.temporary.cleanup)

    def action(self, action):
        request = {key: value for key, value in self.request.items() if key not in ("manifest", "launch")}
        request["action"] = action
        return worker.control(request)

    def test_once_only_and_original_selection(self):
        first = worker.control(self.request)
        self.assertEqual(first["state"], "running")
        self.assertFalse(first["stopped"])
        worker.control(self.request)
        self.assertEqual(sum(cmd[0] == "/usr/bin/systemd-run" for cmd in self.commands), 1)
        saved = worker.decode(worker.read_file(worker.ROOT / "launch.json"))
        self.assertEqual(saved, self.request["launch"])
        self.assertEqual((worker.ROOT / "launch.json").stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.request["launch"]["tunnelToken"], json.dumps(first))

    def test_changed_replay_and_other_operation_rejected(self):
        worker.control(self.request)
        changed = copy.deepcopy(self.request)
        changed["launch"]["model"] = "other-model"
        with self.assertRaises(ValueError):
            worker.control(changed)
        changed = copy.deepcopy(self.request)
        changed["identity"]["operationId"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        with self.assertRaises(ValueError):
            worker.control(changed)

    def test_lost_dispatch_ack_does_not_repeat_or_claim_stopped(self):
        self.lost_ack = True
        with self.assertRaises(subprocess.TimeoutExpired):
            worker.control(self.request)
        result = worker.control(self.request)
        self.assertEqual(result["state"], "unknown")
        self.assertFalse(result["stopped"])
        self.assertEqual(sum(cmd[0] == "/usr/bin/systemd-run" for cmd in self.commands), 1)
        self.assertTrue(self.action("cancel")["stopped"])
        self.assertFalse((worker.ROOT / "launch.json").exists())

    def test_cancel_before_dispatch_fences_delayed_start(self):
        self.assertEqual(self.action("cancel")["state"], "cancelled")
        self.assertEqual(worker.control(self.request)["state"], "cancelled")
        self.assertFalse(any(cmd[0] == "/usr/bin/systemd-run" for cmd in self.commands))

    def test_cancel_queued_worker_never_executes(self):
        worker.control(self.request)
        self.action("cancel")
        with patch.object(worker, "run_installer") as execute:
            with self.assertRaises(ValueError):
                worker.run()
            execute.assert_not_called()

    def test_cancellation_requires_actual_exit(self):
        worker.control(self.request)
        self.cancel_still_running = True
        result = self.action("cancel")
        self.assertEqual(result["state"], "stopping")
        self.assertFalse(result["stopped"])
        self.assertTrue((worker.ROOT / "launch.json").exists())

    def test_loaded_inactive_queued_unit_is_not_stopped(self):
        worker.control(self.request)
        self.state = {**absent(), "LoadState": "loaded", "Transient": "yes"}
        self.assertFalse(self.action("status")["stopped"])
        self.assertEqual(self.action("status")["state"], "unknown")
        # The queued start is genuinely still able to execute; observation must
        # not have handed the existing operation to a delete/recovery worker.
        with patch.object(worker, "run_installer", return_value=0) as execute:
            self.assertEqual(worker.run(), 0)
            self.assertEqual(execute.call_count, 1)

    def test_started_marker_after_empty_sample_cannot_create_false_stop(self):
        worker.control(self.request)
        self.state = {**absent(), "LoadState": "loaded", "Transient": "yes"}
        original = worker.empty_worker
        retained = []

        def interleaving(state):
            self.assertTrue(original(state))
            retained.append(worker.lock(worker.ROOT / "run.lock"))
            worker.publish(worker.ROOT / "started.json", self.request["identity"])
            return True  # Was empty before the queued worker acquired its lock.

        try:
            with patch.object(worker, "empty_worker", interleaving):
                result = self.action("status")
                self.assertEqual(result["state"], "unknown")
                self.assertFalse(result["stopped"])
        finally:
            for fd in retained:
                os.close(fd)

    def test_success_requires_result_and_empty_worker_and_never_reexecutes(self):
        worker.control(self.request)
        with patch.object(worker, "run_installer", return_value=0) as execute:
            self.assertEqual(worker.run(), 0)
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(worker.decode(execute.call_args.args[0]), self.request["launch"])
            self.assertEqual(execute.call_args.args[1], self.clock["boottimeMs"] + 480000)
            with self.assertRaises(ValueError):
                worker.run()
        self.assertFalse((worker.ROOT / "launch.json").exists())
        self.assertFalse(self.action("status")["stopped"])
        self.state = absent()  # systemd collected the completed transient unit.
        self.assertEqual(self.action("status")["state"], "succeeded")

    def test_failed_installer_is_terminal_not_retried(self):
        worker.control(self.request)
        with patch.object(worker, "run_installer", return_value=42):
            self.assertEqual(worker.run(), 1)
        self.state = {**absent(), "LoadState": "loaded", "ActiveState": "failed", "SubState": "failed", "Transient": "yes"}
        self.assertEqual(worker.control(self.request)["state"], "failed")
        self.assertEqual(sum(cmd[0] == "/usr/bin/systemd-run" for cmd in self.commands), 1)

    def test_elapsed_dispatch_and_reboot_cannot_execute(self):
        worker.control(self.request)
        self.clock["boottimeMs"] += 20000
        with patch.object(worker, "run_installer") as execute:
            with self.assertRaises(ValueError):
                worker.run()
            execute.assert_not_called()
        self.clock = {**FIXTURE["clock"], "bootId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
        with self.assertRaises(ValueError):
            worker.run()

    def test_stale_request_no_filesystem_mutation(self):
        self.clock["boottimeMs"] += 20000
        with self.assertRaises(ValueError):
            worker.control(self.request)
        self.assertFalse(worker.ROOT.exists())
        self.assertFalse(self.commands)

    def test_status_before_dispatch_is_read_only_and_not_stopped(self):
        self.assertEqual(self.action("status")["state"], "unknown")
        self.assertFalse(worker.ROOT.exists())

    def test_populated_descendant_cgroup_blocks_completion(self):
        worker.control(self.request)
        self.action("cancel")
        worker.CGROUP.mkdir()
        (worker.CGROUP / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        self.assertEqual(self.action("status")["state"], "stopping")
        (worker.CGROUP / "cgroup.events").write_text("populated 0\nfrozen 0\n")
        self.assertEqual(self.action("status")["state"], "cancelled")

    def test_execution_lock_blocks_false_stop_in_pre_exec_window(self):
        worker.control(self.request)
        fd = worker.lock(worker.ROOT / "run.lock")
        try:
            self.assertEqual(self.action("cancel")["state"], "stopping")
        finally:
            os.close(fd)
        self.assertEqual(self.action("status")["state"], "cancelled")

    def test_custom_unit_is_not_overwritten_or_stopped(self):
        self.state = {**absent(), "LoadState": "loaded"}
        with self.assertRaises(ValueError):
            worker.control(self.request)
        with self.assertRaises(ValueError):
            self.action("cancel")
        self.assertFalse(any(cmd[0] == "/usr/bin/systemd-run" or cmd[1] == "stop" for cmd in self.commands))

    def test_manifest_and_asset_changes_rejected_before_dispatch(self):
        file = self.bundle / "hivra-agent-shell"
        file.write_text("unreviewed")
        with self.assertRaises(ValueError):
            worker.control(self.request)
        self.assertFalse(worker.ROOT.exists())

    def test_unsafe_credential_file_is_not_read_or_replaced(self):
        worker.control(self.request)
        outside = self.root / "outside"
        outside.write_text("untouched")
        file = worker.ROOT / "launch.json"
        file.unlink()
        file.symlink_to(outside)
        with self.assertRaises(OSError):
            worker.run()
        self.assertEqual(outside.read_text(), "untouched")

    def test_duplicate_or_unknown_protocol_fields_fail(self):
        with self.assertRaises(ValueError):
            worker.decode(b'{"action":"start","action":"cancel"}')
        with self.assertRaises(ValueError):
            worker.control({**self.request, "command": "ignored?"})
        with self.assertRaises(ValueError):
            worker.identity({**self.request["identity"], "version": True})

    def native(self):
        rows = worker.manifest_rows(self.request["identity"]["bundle"], self.request["manifest"])
        closure = [row for row in rows if row[0] in worker.NATIVE_FILES]
        self.request["identity"].update(version=2, nativeCleanup={"profile": worker.NATIVE_PROFILE,
            "closureSha256": hashlib.sha256(worker.encode(closure)).hexdigest()})
        self.request["launch"].update(version=2, agentKind="deepseek-harness", modelKey="", model="", modelBaseUrl="",
                                      publicOrigin="https://native.example.test")
        proof = {"service": "bux-hivra-chat.service", "serviceCgroupEmpty": True,
                 "listenersClosed": True, "wholeComputerCleanupVerified": False, "bootStartDisabled": True}
        boundary = patch.object(worker, "stop_retained_native", return_value=proof)
        self.native_stop = boundary.start()
        self.addCleanup(boundary.stop)
        observation = patch.object(worker, "observe_retained_native", return_value=True)
        self.native_observe = observation.start()
        self.addCleanup(observation.stop)

    def test_native_cleanup_proof_does_not_survive_reboot_without_reverification(self):
        self.native()
        self.finish_native()
        first = self.action("cancel")
        original_path = worker.native_proof_path()
        original = original_path.read_bytes()
        self.clock["bootId"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        self.request["clock"]["bootId"] = self.clock["bootId"]
        self.assertEqual(self.action("status")["nativeCleanup"], {"state": "pending"})
        second = self.action("cancel")
        self.assertNotEqual(first["nativeCleanup"]["bootId"], second["nativeCleanup"]["bootId"])
        self.assertEqual(second["nativeCleanup"]["state"], "verified_stopped")
        self.assertEqual(self.native_stop.call_count, 2)
        self.assertEqual(original_path.read_bytes(), original)
        self.assertNotEqual(original_path, worker.native_proof_path())

    def test_native_cached_proof_requires_live_disabled_empty_owned_service(self):
        self.native()
        self.finish_native()
        self.action("cancel")
        self.native_observe.return_value = False
        self.assertEqual(self.action("status")["nativeCleanup"], {"state": "pending"})
        self.assertEqual(self.native_stop.call_count, 1)  # Read-only observation.
        self.native_stop.side_effect = ValueError("ownership could not be verified")
        with self.assertRaises(ValueError):
            self.action("cancel")
        self.native_observe.side_effect = ValueError("installed unit changed")
        with self.assertRaises(ValueError):
            self.action("status")

    def test_native_failed_reboot_cleanup_preserves_old_proof_without_new_authority(self):
        self.native()
        self.finish_native()
        self.action("cancel")
        old = worker.native_proof_path()
        original = old.read_bytes()
        outcome = worker.read_file(worker.ROOT / "stopped-outcome.json")
        self.clock["bootId"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        self.request["clock"]["bootId"] = self.clock["bootId"]
        self.native_stop.side_effect = ValueError("stop failed after reboot")
        with self.assertRaises(ValueError):
            self.action("cancel")
        self.assertFalse(worker.native_proof_path().exists())
        self.assertEqual(old.read_bytes(), original)
        self.assertEqual(worker.read_file(worker.ROOT / "stopped-outcome.json"), outcome)
        self.assertEqual(self.action("status")["nativeCleanup"], {"state": "pending"})

    def test_native_cached_status_and_cancel_cannot_bypass_lifecycle_lock(self):
        self.native()
        self.finish_native()
        self.action("cancel")
        held = worker.lock(worker.INSTALL_LOCK)
        self.native_observe.reset_mock()
        try:
            for action in ("status", "cancel"):
                with self.subTest(action=action), self.assertRaises(BlockingIOError):
                    self.action(action)
            self.native_observe.assert_not_called()
            self.assertEqual(self.native_stop.call_count, 1)
        finally:
            os.close(held)

    def test_native_real_stop_wrapper_handles_exact_absence_and_disabled_loaded_unit(self):
        proof = {"service": "bux-hivra-chat.service", "serviceCgroupEmpty": True,
                 "listenersClosed": True, "wholeComputerCleanupVerified": False}
        for load in ("not-found", "loaded"):
            with self.subTest(load=load):
                owner = SimpleNamespace(SERVICE=proof["service"], definition=Mock(return_value={"LoadState": load}),
                                        service=Mock(return_value=b"disabled\n"), stop_owned=Mock(return_value=proof), empty=Mock(return_value=True))
                with patch.object(worker, "retained_native_owner", return_value=owner):
                    self.assertEqual(worker.stop_retained_native(Path("unused")), {**proof, "bootStartDisabled": True})
                if load == "not-found":
                    owner.service.assert_not_called()
                else:
                    self.assertEqual(owner.service.call_args_list[0].args, ("disable", proof["service"]))
                    self.assertEqual(owner.service.call_args_list[1].args, ("show", "--property=UnitFileState", "--value", proof["service"]))
                owner.stop_owned.assert_called_once()

    def test_native_stop_wrapper_never_certifies_enabled_or_unknown_service(self):
        for enabled in (b"enabled\n", b"static\n", b"", b"disabled\nextra\n"):
            owner = SimpleNamespace(SERVICE="bux-hivra-chat.service", definition=Mock(return_value={"LoadState": "loaded"}),
                                    service=Mock(return_value=enabled), stop_owned=Mock(return_value={}), empty=Mock(return_value=True))
            with self.subTest(enabled=enabled), patch.object(worker, "retained_native_owner", return_value=owner), self.assertRaises(ValueError):
                worker.stop_retained_native(Path("unused"))
        owner.definition.side_effect = ValueError("custom unit")
        owner.service.reset_mock()
        with patch.object(worker, "retained_native_owner", return_value=owner), self.assertRaises(ValueError):
            worker.stop_retained_native(Path("unused"))
        owner.service.assert_not_called()

    def finish_native(self, result=0):
        worker.control(self.request)
        with patch.object(worker, "run_installer", return_value=result):
            worker.run()
        self.state = absent()

    def test_native_requires_immutable_v2_obligation_before_any_mutation(self):
        self.native()
        self.request["identity"]["version"] = 1
        del self.request["identity"]["nativeCleanup"]
        with self.assertRaises(ValueError):
            worker.control(self.request)
        self.assertFalse(worker.ROOT.exists())
        self.native_stop.assert_not_called()

    def test_native_old_bundles_and_altered_closure_rejected(self):
        self.native()
        for version in ("2026.08.31.2", "2026.08.30.2"):
            value = copy.deepcopy(self.request["identity"])
            value["bundle"]["provisionerVersion"] = version
            with self.assertRaises(ValueError):
                worker.identity(value)
        self.request["identity"]["nativeCleanup"]["closureSha256"] = "f" * 64
        with self.assertRaises(ValueError):
            worker.control(self.request)
        self.assertFalse(worker.ROOT.exists())

    def test_native_retains_controller_and_complete_stop_closure_before_dispatch(self):
        self.native()
        observed = worker.control(self.request)
        self.assertEqual(observed["version"], 2)
        self.assertEqual(observed["nativeCleanup"], {"state": "pending"})
        folder = worker.retained_native(self.request["identity"])
        self.assertEqual(sorted(path.name for path in folder.iterdir()), sorted(Path(name).name for name in worker.NATIVE_FILES))
        self.assertEqual(worker.read_file(worker.ROOT / "controller.py"), (self.bundle / "hivra-provider-worker.py").read_bytes())
        self.assertIn(str(worker.ROOT / "controller.py"), self.commands[1])
        self.native_stop.assert_not_called()

    def test_native_cancel_before_dispatch_fences_without_touching_existing_service(self):
        self.native()
        observed = self.action("cancel")
        self.assertEqual(observed["nativeCleanup"], {"state": "not_started", "bootId": worker.guest_clock()["bootId"]})
        self.assertEqual(worker.control(self.request), observed)
        self.native_stop.assert_not_called()
        self.assertFalse(any(cmd[0] == "/usr/bin/systemd-run" for cmd in self.commands))

    def test_native_cancel_does_not_stop_service_until_worker_and_lock_are_empty(self):
        self.native()
        worker.control(self.request)
        self.cancel_still_running = True
        self.assertEqual(self.action("cancel")["nativeCleanup"], {"state": "pending"})
        self.native_stop.assert_not_called()
        self.cancel_still_running = False
        held = worker.lock(worker.ROOT / "run.lock")
        try:
            self.assertEqual(self.action("cancel")["nativeCleanup"], {"state": "pending"})
            self.native_stop.assert_not_called()
        finally:
            os.close(held)
        self.assertEqual(self.action("cancel")["nativeCleanup"], {"state": "verified_stopped", "bootId": worker.guest_clock()["bootId"]})
        self.native_stop.assert_called_once()

    def test_native_sigkill_without_result_is_failed_not_native_cleanup(self):
        self.native()
        worker.control(self.request)
        worker.publish(worker.ROOT / "started.json", self.request["identity"])
        self.state = absent()  # Actual worker exit/cgroup absence, no result.
        observed = self.action("status")
        self.assertEqual(observed["state"], "failed")
        self.assertTrue(observed["stopped"])
        self.assertEqual(observed["nativeCleanup"], {"state": "pending"})
        self.native_stop.assert_not_called()  # Status never executes cleanup code.
        cancelled = self.action("cancel")
        self.assertEqual(cancelled["state"], "failed")
        self.assertEqual(cancelled["nativeCleanup"], {"state": "verified_stopped", "bootId": worker.guest_clock()["bootId"]})

    def test_native_cached_success_survives_later_cancellation(self):
        self.native()
        self.finish_native()
        self.assertEqual(self.action("status")["state"], "succeeded")
        original = worker.read_file(worker.ROOT / "stopped-outcome.json")
        observed = self.action("cancel")
        self.assertEqual(observed["state"], "succeeded")
        self.assertEqual(observed["nativeCleanup"], {"state": "verified_stopped", "bootId": worker.guest_clock()["bootId"]})
        self.assertEqual(worker.read_file(worker.ROOT / "stopped-outcome.json"), original)
        self.assertEqual(self.action("cancel"), observed)
        self.native_stop.assert_called_once()

    def test_native_failure_and_lost_cancel_ack_use_separate_durable_proof(self):
        self.native()
        self.finish_native(result=42)
        observed = self.action("cancel")
        self.assertEqual(observed["state"], "failed")
        self.assertEqual(observed["nativeCleanup"], {"state": "verified_stopped", "bootId": worker.guest_clock()["bootId"]})
        self.assertEqual(self.action("status"), observed)  # Recover a lost ack.
        self.native_stop.assert_called_once()

    def test_native_queued_start_after_cancel_never_installs(self):
        self.native()
        worker.control(self.request)
        self.action("cancel")
        with patch.object(worker, "run_installer") as execute:
            with self.assertRaises(ValueError):
                worker.run()
            execute.assert_not_called()

    def test_native_recovery_uses_retained_files_after_current_bundle_removed(self):
        self.native()
        self.finish_native()
        self.bundle.rename(self.root / "retired-current-bundle")
        self.assertEqual(self.action("cancel")["nativeCleanup"], {"state": "verified_stopped", "bootId": worker.guest_clock()["bootId"]})
        self.assertEqual(self.native_stop.call_args.args[0], worker.ROOT / "native-cleanup")

    def test_native_each_retained_dependency_and_controller_are_verified_before_stop(self):
        self.native()
        self.finish_native()
        paths = [worker.ROOT / "controller.py", worker.ROOT / "manifest.json",
                 *(worker.ROOT / "native-cleanup" / Path(name).name for name in worker.NATIVE_FILES)]
        for target in paths:
            with self.subTest(path=target.name):
                original = target.read_bytes()
                target.write_bytes(b"changed")
                with self.assertRaises(ValueError):
                    self.action("cancel")
                target.write_bytes(original)
                self.native_stop.assert_not_called()
        self.assertFalse((worker.native_proof_path()).exists())

    def test_native_retained_symlink_or_extra_import_file_never_executes(self):
        self.native()
        self.finish_native()
        target = worker.ROOT / "native-cleanup/install-native.py"
        original = target.read_bytes()
        target.unlink()
        target.symlink_to(self.bundle / "deepseek-harness/install-native.py")
        with self.assertRaises(OSError):
            self.action("cancel")
        self.native_stop.assert_not_called()
        target.unlink()
        worker.publish_bytes(target, original)
        worker.publish_bytes(target.parent / "unexpected.py", b"raise Exception()")
        with self.assertRaises(ValueError):
            self.action("cancel")
        self.native_stop.assert_not_called()

    def test_native_stop_failure_or_incomplete_proof_never_publishes_cleanup(self):
        self.native()
        self.finish_native()
        for proof in (None, {"serviceCgroupEmpty": True}, {**self.native_stop.return_value, "listenersClosed": False},
                      {**self.native_stop.return_value, "wholeComputerCleanupVerified": True}):
            with self.subTest(proof=proof):
                self.native_stop.return_value = proof
                self.native_stop.side_effect = ValueError("custom/unknown native state") if proof is None else None
                with self.assertRaises(ValueError):
                    self.action("cancel")
                self.assertFalse((worker.native_proof_path()).exists())
                self.assertEqual(self.action("status")["nativeCleanup"], {"state": "pending"})

    def test_native_guest_lifecycle_lock_is_held_for_verified_stop(self):
        self.native()
        self.finish_native()
        held = worker.lock(worker.INSTALL_LOCK)
        try:
            with self.assertRaises(BlockingIOError):
                self.action("cancel")
            self.native_stop.assert_not_called()
        finally:
            os.close(held)
        proof = self.native_stop.return_value
        def check_lock(_folder):
            with self.assertRaises(BlockingIOError):
                worker.lock(worker.INSTALL_LOCK)
            return proof
        self.native_stop.side_effect = check_lock
        self.assertEqual(self.action("cancel")["nativeCleanup"], {"state": "verified_stopped", "bootId": worker.guest_clock()["bootId"]})

    def test_native_cached_proof_rejects_controller_drift_and_other_identity(self):
        self.native()
        self.finish_native()
        self.action("cancel")
        target = worker.ROOT / "controller.py"
        original = target.read_bytes()
        target.write_bytes(b"changed")
        with self.assertRaises(ValueError):
            self.action("status")
        target.write_bytes(original)
        saved = worker.native_proof_path()
        value = worker.decode(saved.read_bytes())
        value["identity"]["operationId"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        saved.write_bytes(worker.encode(value))
        with self.assertRaises(ValueError):
            self.action("status")


unittest.main(argv=[sys.argv[0]], verbosity=2)
