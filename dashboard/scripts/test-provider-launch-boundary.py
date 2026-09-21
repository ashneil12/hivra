#!/usr/bin/env python3
"""Exercise the worker admission boundary without loading a runtime bundle."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent / "provisioner/hivra-provider-worker.py"
spec = importlib.util.spec_from_file_location("worker_launch_boundary", SOURCE)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
installer_spec = importlib.util.spec_from_file_location("owned_desktop_installer", SOURCE.with_name("hivra-install-agent.py"))
guest = importlib.util.module_from_spec(installer_spec)
installer_spec.loader.exec_module(guest)


class DesktopInstallerCompositionTest(unittest.TestCase):
    def setUp(self):
        self.launch = {"version": 3, "agentKind": "linux-desktop", "computerSubstrate": "provider-vm",
            "wantBrowser": None, "modelKey": "", "modelBaseUrl": "", "model": "", "tunnelToken": None,
            "accessHostname": "203-0-113-9.sslip.io", "publicOrigin": "https://203-0-113-9.sslip.io",
            "controlOrigin": "https://canary.example.test", "computerId": "11111111-1111-4111-8111-111111111111"}
        self.events = []
        self.fail_at = None
        self.capability = {"protocol": "hivra-remote-desktop-installed-v1", "computerId": self.launch["computerId"], "computerKind": "hivra-agent"}

    def callback(self):
        self.events.append("owned-desktop")
        if self.fail_at == "owned-desktop":
            raise RuntimeError("owned phase failed")
        return self.capability

    def command(self, argv, **kwargs):
        if argv[0] == "/bin/bash":
            self.assertEqual(kwargs["env"]["HIVRA_PROVIDER_DESKTOP_PREPARE_ONLY"], "1")
            self.assertEqual(kwargs["env"]["HIVRA_AGENT_KIND"], "linux-desktop")
            self.events.append("base")
        else:
            self.assertIn("--browser-enabled", argv)
            self.assertEqual(argv[-1], "0")
            self.assertIn("provider-vm", argv)
            self.events.append("runtime-receipt")
        if self.fail_at == self.events[-1]:
            raise RuntimeError("command failed")

    def execute(self):
        with patch.object(guest, "check_direct_access"), patch.object(guest, "check_effective_direct_access"), \
                patch.object(guest.subprocess, "run", side_effect=self.command), \
                patch.object(guest, "configure_access", side_effect=lambda *args: self.events.append("access")):
            guest.install_agent(self.launch, SOURCE.parent, provider_desktop=self.callback)

    def test_base_owned_readiness_receipt_access_order(self):
        self.execute()
        self.assertEqual(self.events, ["base", "owned-desktop", "runtime-receipt", "access"])

    def test_each_failure_prevents_later_steps(self):
        order = ["base", "owned-desktop", "runtime-receipt"]
        for index, phase in enumerate(order):
            self.events = []
            self.fail_at = phase
            with self.assertRaises(RuntimeError): self.execute()
            self.assertEqual(self.events, order[:index + 1])

    def test_wrong_readiness_identity_never_records_runtime_or_access(self):
        self.capability["computerId"] = "foreign"
        with self.assertRaises(guest.InstallError): self.execute()
        self.assertEqual(self.events, ["base", "owned-desktop"])

    def test_public_parser_and_missing_callback_stay_closed(self):
        raw = json.dumps(self.launch).encode()
        with self.assertRaises(guest.InstallError): guest.parse_launch(raw)
        self.assertEqual(guest.parse_launch(raw, provider_desktop=True), self.launch)
        with patch.object(guest.subprocess, "run") as run:
            with self.assertRaises(guest.InstallError): guest.install_agent(self.launch, SOURCE.parent)
            run.assert_not_called()

    def test_private_parser_does_not_widen_settings_or_other_contracts(self):
        for field, value in (("version", 1), ("agentKind", "codex"), ("computerSubstrate", "proxmox-kvm"),
                             ("wantBrowser", True), ("modelKey", "private-test-secret"), ("controlOrigin", "http://bad.test"),
                             ("publicOrigin", "https://foreign.example.test"), ("provider_desktop", True)):
            changed = {**self.launch, field: value}
            with self.assertRaises(guest.InstallError): guest.parse_launch(json.dumps(changed).encode(), provider_desktop=True)

    def test_callback_cannot_be_attached_to_legacy_or_managed_launch(self):
        for substrate, kind in (("proxmox-kvm", "linux-desktop"), ("provider-vm", "codex")):
            changed = {**self.launch, "computerSubstrate": substrate, "agentKind": kind}
            with patch.object(guest.subprocess, "run") as run:
                with self.assertRaises(guest.InstallError): guest.install_agent(changed, SOURCE.parent, provider_desktop=self.callback)
                run.assert_not_called()


class LaunchBoundaryTest(unittest.TestCase):
    def check(self, identity_version, launch_version, kind, substrate="provider-vm"):
        worker.check_launch({"version": identity_version}, {
            "version": launch_version, "agentKind": kind, "computerSubstrate": substrate,
        })

    def test_preserves_all_existing_legacy_runtimes(self):
        for kind in ("claude", "codex", "aeon", "openclaw", "agent-zero"):
            with self.subTest(kind=kind):
                self.check(1, 1, kind)

    def test_native_runtime_requires_matching_cleanup_identity(self):
        self.check(2, 2, "deepseek-harness")
        for identity_version, launch_version in ((1, 1), (1, 2), (2, 1)):
            with self.subTest(identity=identity_version, launch=launch_version):
                with self.assertRaisesRegex(ValueError, "^provider worker rejected$"):
                    self.check(identity_version, launch_version, "deepseek-harness")

    def test_desktops_cannot_enter_legacy_or_native_worker_paths(self):
        for identity_version in (1, 2):
            for launch_version in (1, 2, 3):
                with self.subTest(identity=identity_version, launch=launch_version):
                    with self.assertRaisesRegex(ValueError, "^provider worker rejected$"):
                        self.check(identity_version, launch_version, "linux-desktop")

    def test_future_versions_and_unknown_kinds_are_not_legacy(self):
        for identity_version, launch_version, kind in ((1, 3, "codex"), (3, 1, "codex"),
                                                      (1, 1, "future-runtime"), (2, 2, "codex")):
            with self.assertRaisesRegex(ValueError, "^provider worker rejected$"):
                self.check(identity_version, launch_version, kind)

    def test_managed_substrate_is_never_a_provider_worker_launch(self):
        for identity_version, launch_version, kind in ((1, 1, "codex"), (2, 2, "deepseek-harness")):
            with self.assertRaisesRegex(ValueError, "^provider worker rejected$"):
                self.check(identity_version, launch_version, kind, "proxmox-kvm")

    def test_control_rejects_desktop_before_journal_or_dispatch(self):
        # Simulate the future parser admitting provider-vm v3. The independent
        # worker boundary must still fail before acquiring/publishing ownership.
        launch = {"version": 3, "agentKind": "linux-desktop", "computerSubstrate": "provider-vm"}
        for identity_version in (1, 2):
            expected = {"version": identity_version, "bundle": {}}
            with patch.object(worker, "identity", return_value=expected), patch.object(worker, "fresh"), \
                 patch.object(worker, "verify_bundle"), patch.object(worker, "installer") as installer, \
                 patch.object(worker, "ensure_root") as ensure, patch.object(worker, "publish") as publish, \
                 patch.object(worker.subprocess, "run") as execute:
                installer.return_value.parse_launch.return_value = launch
                with self.assertRaisesRegex(ValueError, "^provider worker rejected$"):
                    worker.control({"action": "start", "identity": expected, "clock": {}, "manifest": [], "launch": launch})
                ensure.assert_not_called()
                publish.assert_not_called()
                execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
