#!/usr/bin/env python3
"""Retained desktop recovery: real private files, substituted service probes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parent.parent / "provisioner"
spec = importlib.util.spec_from_file_location("desktop_cleanup_worker", SOURCE / "hivra-provider-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
COMPUTER = "11111111-1111-4111-8111-111111111111"
OPERATION = "22222222-2222-4222-8222-222222222222"
BOOT = "33333333-3333-4333-8333-333333333333"


class DesktopCleanupTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="hivra-desktop-cleanup-test-")
        self.addCleanup(folder.cleanup)
        self.base = Path(folder.name)
        self.root, self.bundle = self.base / "journal", self.base / "bundle"
        self.root.mkdir(mode=0o700)
        self.bundle.mkdir(mode=0o700)
        (self.bundle / "remote-desktop").mkdir(mode=0o700)
        rows = []
        for name in ("hivra-provider-worker.py", *worker.DESKTOP_FILES):
            raw = (SOURCE / name).read_bytes()
            self.write(self.bundle / name, raw)
            rows.append([name, hashlib.sha256(raw).hexdigest(), len(raw), 0o600])
        rows.sort()
        self.manifest = [dict(zip(("path", "sha256", "size", "mode"), row)) for row in rows]
        self.expected = {"version": 3, "agentId": COMPUTER, "operationId": OPERATION,
            "bundle": {"version": 1, "state": "bundle_installed", "scopeSha256": "d" * 64,
                "provisionerVersion": worker.DESKTOP_VERSION,
                "bundleSha256": hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()},
            "desktopCleanup": {"profile": worker.DESKTOP_PROFILE,
                "closureSha256": hashlib.sha256(worker.encode([row for row in rows if row[0] in worker.DESKTOP_FILES])).hexdigest()}}
        self.boot = BOOT
        for attribute, value in (("ROOT", self.root), ("BUNDLE", self.bundle), ("INSTALL_LOCK", self.base / "install.lock")):
            context = patch.object(worker, attribute, value)
            context.start()
            self.addCleanup(context.stop)
        # Darwin lacks renameat2: only exclusive publication is substituted.
        context = patch.object(worker, "publish_bytes", side_effect=self.publish_bytes)
        context.start()
        self.addCleanup(context.stop)
        context = patch.object(worker, "guest_clock", side_effect=lambda: {"bootId": self.boot, "boottimeMs": 1000})
        context.start()
        self.addCleanup(context.stop)
        worker.publish(self.root / "manifest.json", self.manifest)
        worker.retain_desktop(self.expected, self.manifest)
        original = worker.retained_desktop_owner(self.expected)
        self.plan = {"version": 1, "computerId": COMPUTER, "operationId": OPERATION,
            "units": {name: "a" * 64 for name in original.UNITS},
            "container": {"id": "b" * 64, "imageId": "sha256:" + "c" * 64}}
        self.proof = {"computerId": COMPUTER, "operationId": OPERATION,
            **{name: True for name in ("servicesStopped", "serviceCgroupsEmpty", "containerStopped", "listenersClosed", "bootStartDisabled")},
            "wholeComputerCleanupVerified": False}
        self.owner = Mock()
        self.owner.ownership.side_effect = original.ownership
        self.owner.stop_owned.return_value = self.proof
        self.owner.observe_stopped.return_value = True

    def write(self, path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def publish_bytes(self, path, raw):
        if path.exists():
            self.assertEqual(worker.read_file(path), raw)
        else:
            with path.open("xb") as stream:
                stream.write(raw)
            path.chmod(0o600)

    def prepare_cleanup(self, *, dispatched=True, owned=True):
        worker.publish(self.root / "cancel.json", self.expected)
        if dispatched:
            worker.publish(self.root / "dispatch.json", {"identity": self.expected})
        if owned:
            worker.publish(self.root / "desktop-ownership.json", self.plan)

    def cleanup(self, *, stopped=True):
        with patch.object(worker, "unit_state", return_value={}), \
                patch.object(worker, "empty_worker", return_value=stopped), \
                patch.object(worker, "retained_desktop_owner", return_value=self.owner):
            return worker.cleanup_desktop(self.expected)

    def test_retained_code_survives_current_bundle_disappearance(self):
        self.bundle.rename(self.base / "retired-bundle")
        owner = worker.retained_desktop_owner(self.expected)
        self.assertEqual(owner.ownership(self.plan), self.plan)

    def test_retained_bytes_and_controller_are_checked_before_import(self):
        for relative in ("controller.py", "desktop-cleanup/provider-service-owner.py"):
            path = self.root / relative
            original = path.read_bytes()
            self.write(path, b"# changed\n" + original)
            with self.assertRaises(ValueError): worker.retained_desktop_owner(self.expected)
            self.write(path, original)
        self.write(self.root / "desktop-cleanup/unexpected.py", b"pass\n")
        with self.assertRaises(ValueError): worker.retained_desktop_owner(self.expected)

    def test_retention_rejects_interrupted_publication_residue(self):
        residue = self.root / "desktop-cleanup/.pending-owned-test"
        self.write(residue, b"partial retained owner\n")
        with self.assertRaises(ValueError): worker.retain_desktop(self.expected, self.manifest)
        self.assertEqual(residue.read_bytes(), b"partial retained owner\n")
        with self.assertRaises(ValueError): worker.retained_desktop_owner(self.expected)

    def test_success_binds_original_ownership_and_rechecks_cached_proof(self):
        self.prepare_cleanup()
        self.assertEqual(self.cleanup(), {"state": "verified_stopped", "bootId": BOOT})
        self.owner.stop_owned.assert_called_once_with(self.plan)
        proof = worker.decode(worker.read_file(worker.desktop_proof_path()[0]))
        self.assertEqual(proof["ownershipSha256"], hashlib.sha256(worker.encode(self.plan)).hexdigest())
        self.owner.observe_stopped.return_value = False
        with patch.object(worker, "retained_desktop_owner", return_value=self.owner):
            self.assertEqual(worker.desktop_observation(self.expected), {"state": "pending"})
        self.owner.stop_owned.assert_called_once()

    def test_dispatched_without_ownership_is_pending_not_not_started(self):
        self.prepare_cleanup(owned=False)
        self.assertEqual(self.cleanup(), {"state": "pending"})
        self.assertFalse(worker.desktop_proof_path()[0].exists())
        self.owner.stop_owned.assert_not_called()

    def test_cancel_before_dispatch_fences_not_started_without_stopping(self):
        self.prepare_cleanup(dispatched=False, owned=False)
        self.assertEqual(self.cleanup(), {"state": "not_started", "bootId": BOOT})
        self.owner.stop_owned.assert_not_called()
        worker.publish(self.root / "desktop-preparation-intent.json", {})
        with self.assertRaises(ValueError): worker.desktop_observation(self.expected)

    def test_partial_preparation_without_dispatch_is_not_clean(self):
        self.prepare_cleanup(dispatched=False, owned=False)
        worker.publish(self.root / "desktop-preparation-intent.json", {})
        with self.assertRaises(ValueError): self.cleanup()
        self.owner.stop_owned.assert_not_called()

    def test_wrong_operation_and_cancel_identity_cannot_stop(self):
        self.plan["operationId"] = COMPUTER
        self.prepare_cleanup()
        with self.assertRaises(ValueError): self.cleanup()
        self.owner.stop_owned.assert_not_called()
        self.write(self.root / "cancel.json", worker.encode({}))
        with self.assertRaises(ValueError): self.cleanup()
        self.owner.stop_owned.assert_not_called()

    def test_active_worker_prevents_cleanup(self):
        self.prepare_cleanup()
        self.assertEqual(self.cleanup(stopped=False), {"state": "pending"})
        self.owner.stop_owned.assert_not_called()

    def test_incomplete_stop_proof_and_boot_change_cannot_publish(self):
        self.prepare_cleanup()
        self.proof["listenersClosed"] = False
        with self.assertRaises(ValueError): self.cleanup()
        self.assertFalse(worker.desktop_proof_path()[0].exists())
        self.proof["listenersClosed"] = True
        def changed_boot(plan):
            self.boot = OPERATION
            return self.proof
        self.owner.stop_owned.side_effect = changed_boot
        with self.assertRaises(ValueError): self.cleanup()
        self.assertEqual(list(self.root.glob("desktop-cleanup-*.json")), [])

    def test_v3_identity_requires_candidate_release_and_desktop_closure(self):
        self.assertEqual(worker.identity(self.expected), self.expected)
        for field, value in (("provisionerVersion", "2026.09.05.5"), ("scopeSha256", "bad")):
            changed = {**self.expected, "bundle": {**self.expected["bundle"], field: value}}
            with self.assertRaises(ValueError): worker.identity(changed)
        with self.assertRaises(ValueError): worker.identity({**self.expected, "nativeCleanup": self.expected["desktopCleanup"]})

    def launch(self):
        return {"version": 3, "agentKind": "linux-desktop", "computerSubstrate": "provider-vm",
            "wantBrowser": None, "modelKey": "", "modelBaseUrl": "", "model": "", "tunnelToken": None,
            "accessHostname": "203-0-113-9.sslip.io", "publicOrigin": "https://203-0-113-9.sslip.io",
            "controlOrigin": "https://canary.example.test", "computerId": COMPUTER}

    def test_v3_dispatch_retains_usable_original_controller_once_on_lost_ack(self):
        launch = self.launch()
        module = SimpleNamespace(parse_launch=lambda raw, **kwargs: launch)
        request = {"action": "start", "identity": self.expected, "clock": worker.guest_clock(),
                   "manifest": self.manifest, "launch": launch}
        def lost_ack(argv, **kwargs):
            self.assertIn(str(self.root / "controller.py"), argv)
            self.assertTrue((self.root / "dispatch.json").exists())
            worker.retained_desktop_owner(self.expected)
            raise TimeoutError("lost systemd acknowledgement")
        with patch.object(worker, "verify_bundle"), patch.object(worker, "ensure_root"), \
                patch.object(worker, "installer", return_value=module), \
                patch.object(worker, "unit_state", return_value={"LoadState": "not-found"}), \
                patch.object(worker, "observe", return_value={"state": "running", "stopped": False}), \
                patch.object(worker.subprocess, "run", side_effect=lost_ack) as dispatch:
            with self.assertRaises(TimeoutError): worker.control(request)
            self.assertEqual(worker.control(request)["desktopCleanup"], {"state": "pending"})
            dispatch.assert_called_once()

    def test_unusable_retention_never_dispatches(self):
        self.write(self.root / "desktop-cleanup/.pending-test", b"interrupted")
        request = {"action": "start", "identity": self.expected, "clock": worker.guest_clock(),
                   "manifest": self.manifest, "launch": self.launch()}
        with patch.object(worker, "verify_bundle"), patch.object(worker, "ensure_root"), \
                patch.object(worker, "installer", return_value=SimpleNamespace(parse_launch=lambda raw, **kw: self.launch())), \
                patch.object(worker, "unit_state", return_value={"LoadState": "not-found"}), \
                patch.object(worker.subprocess, "run") as dispatch:
            with self.assertRaises(ValueError): worker.control(request)
            dispatch.assert_not_called()
            self.assertFalse((self.root / "dispatch.json").exists())

    def test_original_run_consumes_launch_and_uses_desktop_not_legacy_installer(self):
        clock = worker.guest_clock()
        worker.publish(self.root / "identity.json", self.expected)
        worker.publish(self.root / "dispatch.json", {"identity": self.expected, "clock": clock})
        worker.publish(self.root / "launch.json", self.launch())
        with patch.object(worker, "verify_bundle"), \
                patch.object(worker, "installer", return_value=SimpleNamespace(parse_launch=lambda raw, **kw: self.launch())), \
                patch.object(worker, "run_provider_desktop", return_value=0) as desktop, \
                patch.object(worker, "run_installer") as legacy:
            self.assertEqual(worker.run(), 0)
            desktop.assert_called_once_with(self.expected, self.launch(), clock)
            legacy.assert_not_called()
            self.assertFalse((self.root / "launch.json").exists())
            with self.assertRaises(ValueError): worker.run()
            desktop.assert_called_once()

    def test_locked_composition_binds_original_ids_and_checks_cancel_before_callback(self):
        clock = worker.guest_clock()
        def compose(args, operation, journal, command, owner, guest):
            self.assertEqual((args.computer_id, operation), (COMPUTER, OPERATION))
            with self.assertRaises(BlockingIOError): worker.lock(worker.INSTALL_LOCK)
            journal.publish("desktop-ready.json", {"fixture": True})
            return {"fixture": True}
        plan, guest = SimpleNamespace(install_prepared_base=compose), object()
        def install(launch, source, *, provider_desktop):
            self.assertEqual(launch, self.launch())
            return provider_desktop()
        module = SimpleNamespace(install_agent=install)
        with patch.object(worker, "desktop_module", side_effect=lambda name: plan if name == "provider-service-plan.py" else guest), \
                patch.object(worker, "retained_desktop_owner", return_value=self.owner), \
                patch.object(worker, "desktop_preflight"), patch.object(worker, "prepare_desktop_runtime_parent"), \
                patch.object(worker, "prepare_desktop_state_parent"), \
                patch.object(worker, "installer", return_value=module):
            self.assertEqual(worker.run_provider_desktop(self.expected, self.launch(), clock), 0)
            worker.publish(self.root / "cancel.json", self.expected)
            with self.assertRaises(ValueError): worker.run_provider_desktop(self.expected, self.launch(), clock)

    def test_journal_cannot_publish_after_cancel_or_outside_fixed_namespace(self):
        journal = worker.DesktopJournal(self.expected, worker.guest_clock())
        with self.assertRaises(ValueError): journal.publish("../foreign.json", {})
        worker.publish(self.root / "cancel.json", self.expected)
        with self.assertRaises(ValueError): journal.publish("desktop-activation.json", {})
        self.assertFalse((self.root / "desktop-activation.json").exists())

    def test_journal_waits_for_normal_status_lock_without_replaying_mutation(self):
        manager = worker.lock(self.root / "manager.lock")
        released = threading.Event()
        def release():
            os.close(manager)
            released.set()
        timer = threading.Timer(0.1, release)
        timer.start()
        try:
            journal = worker.DesktopJournal(self.expected, worker.guest_clock())
            journal.publish("desktop-network-intent.json", {"once": True})
            self.assertTrue(released.is_set())
            self.assertEqual(journal.read("desktop-network-intent.json"), {"once": True})
        finally:
            timer.join(timeout=2)

    def test_journal_lock_wait_remains_cancel_and_boot_fenced(self):
        manager = worker.lock(self.root / "manager.lock")
        try:
            journal = worker.DesktopJournal(self.expected, worker.guest_clock())
            with patch.object(worker.time, "sleep", side_effect=lambda _: setattr(self, "boot", OPERATION)):
                with self.assertRaises(ValueError): journal.publish("desktop-activation.json", {})
            self.boot = BOOT
            clock = worker.guest_clock()
            with patch.object(worker, "guest_clock", return_value=clock), \
                    patch.object(worker.time, "sleep", side_effect=lambda _: clock.update(boottimeMs=1000 + worker.DESKTOP_MAX_RUN_MS)):
                with self.assertRaises(ValueError): journal.publish("desktop-activation.json", {})
            with patch.object(worker.time, "sleep", side_effect=lambda _: worker.publish(self.root / "cancel.json", self.expected)):
                with self.assertRaises(ValueError): journal.publish("desktop-activation.json", {})
            self.assertFalse((self.root / "desktop-activation.json").exists())
        finally:
            os.close(manager)

    def test_desktop_cold_start_deadline_is_bounded_at_twenty_minutes(self):
        clock = worker.guest_clock()
        journal = worker.DesktopJournal(self.expected, clock)
        with patch.object(worker, "guest_clock", return_value={**clock, "boottimeMs": 1000 + worker.MAX_RUN_MS}):
            journal.fence()
        with patch.object(worker, "guest_clock", return_value={**clock, "boottimeMs": 1000 + worker.DESKTOP_MAX_RUN_MS - 1}):
            journal.fence()
        with patch.object(worker, "guest_clock", return_value={**clock, "boottimeMs": 1000 + worker.DESKTOP_MAX_RUN_MS}):
            with self.assertRaises(ValueError): journal.fence()

    def test_desktop_dispatch_sets_bounded_systemd_deadline_once(self):
        request = {"action": "start", "identity": self.expected, "clock": worker.guest_clock(),
                   "manifest": self.manifest, "launch": {}}
        with patch.object(worker, "verify_bundle"), patch.object(worker, "parse_worker_launch", return_value={}), \
                patch.object(worker, "ensure_root"), patch.object(worker, "unit_state", return_value={"LoadState": "not-found"}), \
                patch.object(worker, "observe", return_value={"state": "running", "stopped": False}), \
                patch.object(worker, "desktop_observation", return_value={"state": "pending"}), \
                patch.object(worker.subprocess, "run") as run:
            worker.control(request)
            worker.control(request)
            self.assertEqual(run.call_count, 1)
            command = run.call_args.args[0]
            self.assertIn("--property=RuntimeMaxSec=1200s", command)
            self.assertIn("--property=KillMode=control-group", command)
            self.assertIn("--property=Restart=no", command)

    def test_fresh_base_and_resource_preflight_is_read_only(self):
        command = Mock(return_value=b"LoadState=not-found\nFragmentPath=\nDropInPaths=\n")
        with patch.object(worker.pwd, "getpwnam", side_effect=KeyError), patch.object(worker.grp, "getgrnam", side_effect=KeyError), \
                patch.object(worker.os.path, "lexists", return_value=False), patch.object(worker.os, "cpu_count", return_value=2), \
                patch.object(Path, "read_text", return_value="MemTotal:       8000000 kB\n") as memory:
            worker.desktop_preflight(command)
            self.assertTrue(all(call.args[0][:2] == ["/usr/bin/systemctl", "show"] for call in command.call_args_list))
            memory.return_value = "MemTotal:       4000000 kB\n"
            with self.assertRaises(ValueError): worker.desktop_preflight(command)
        with patch.object(worker.pwd, "getpwnam", return_value=object()):
            command.reset_mock()
            with self.assertRaises(ValueError): worker.desktop_preflight(command)
            command.assert_not_called()

    def test_runtime_traversal_does_not_expose_private_bundle_or_relax_custom_tree(self):
        parent = self.base / "hivra"
        private = parent / "provider-bundle"
        current = private / "current"
        parent.mkdir(mode=0o700)
        private.mkdir(mode=0o700)
        current.mkdir(mode=0o700)
        with patch.object(worker, "BUNDLE", current):
            worker.prepare_desktop_runtime_parent()
            self.assertEqual(parent.stat().st_mode & 0o777, 0o711)
            self.assertEqual(private.stat().st_mode & 0o777, 0o700)
            self.assertEqual(current.stat().st_mode & 0o777, 0o700)
            parent.chmod(0o700)
            (parent / "custom").mkdir()
            with self.assertRaises(ValueError): worker.prepare_desktop_runtime_parent()
            self.assertEqual(parent.stat().st_mode & 0o777, 0o700)

    def test_custom_docker_root_or_inactive_existing_daemon_is_not_a_fresh_base(self):
        missing = b"LoadState=not-found\nFragmentPath=\nDropInPaths=\n"
        with patch.object(worker.pwd, "getpwnam", side_effect=KeyError), patch.object(worker.grp, "getgrnam", side_effect=KeyError):
            command = Mock(return_value=missing)
            with patch.object(worker.os.path, "lexists", side_effect=lambda path: str(path) == "/etc/docker"):
                with self.assertRaises(ValueError): worker.desktop_preflight(command)
                command.assert_not_called()
            def state(argv):
                if argv[-1] == "docker.service":
                    # Stopped/disabled is not absence, regardless of data-root.
                    return b"LoadState=loaded\nFragmentPath=/lib/systemd/system/docker.service\nDropInPaths=/etc/systemd/system/docker.service.d/custom-root.conf\n"
                return missing
            with patch.object(worker.os.path, "lexists", return_value=False):
                with self.assertRaises(ValueError): worker.desktop_preflight(state)

    def test_fresh_state_parent_allows_broker_traversal_but_keeps_journal_private(self):
        parent = self.base / "state-hivra"
        journal = parent / "provider-install"
        parent.mkdir(mode=0o700)
        journal.mkdir(mode=0o700)
        with patch.object(worker, "ROOT", journal):
            worker.prepare_desktop_state_parent()
            self.assertEqual(parent.stat().st_mode & 0o777, 0o711)
            self.assertEqual(journal.stat().st_mode & 0o777, 0o700)
            parent.chmod(0o700)
            (parent / "custom").mkdir()
            with self.assertRaises(ValueError): worker.prepare_desktop_state_parent()
            self.assertEqual(parent.stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
