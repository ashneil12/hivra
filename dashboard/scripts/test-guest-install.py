"""Execute the real guest entrypoint functions with owned files and fake services."""
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "provisioner/hivra-install-agent.py"
spec = importlib.util.spec_from_file_location("guest_install", SOURCE)
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


def launch(**overrides):
    return {"version": 1, "agentKind": "codex", "computerSubstrate": "proxmox-kvm",
            "wantBrowser": False, "modelKey": "fixture-key-'$(not-a-command)",
            "modelBaseUrl": "https://api.example.invalid/v1", "model": "fixture-model",
            "tunnelToken": "fixture-named-tunnel-only", "accessHostname": None, **overrides}


class LaunchContract(unittest.TestCase):
    def test_linux_desktop_requires_the_complete_v3_computer_contract(self):
        value = launch(version=3, agentKind="linux-desktop", wantBrowser=None, modelKey="", modelBaseUrl="", model="",
                       publicOrigin="https://computer.example.test", computerId="11111111-1111-4111-8111-111111111111",
                       controlOrigin="https://canary.example.test")
        self.assertEqual(guest.parse_launch(json.dumps(value).encode()), value)
        invalid = [
            {**value, "version": 1},
            {key: item for key, item in value.items() if key != "computerId"},
            {**value, "wantBrowser": False},
            {**value, "modelKey": "synthetic"},
            {**value, "computerSubstrate": "provider-vm"},
            {**value, "computerId": "not-a-uuid"},
            {**value, "controlOrigin": "http://canary.example.test"},
            {**value, "publicOrigin": "https://computer.example.test/"},
        ]
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaisesRegex(guest.InstallError, "^invalid guest launch document$"):
                guest.parse_launch(json.dumps(candidate).encode())

    def test_native_v2_requires_fixed_origin_and_explicit_supported_custody(self):
        value = launch(version=2, agentKind="deepseek-harness", computerSubstrate="provider-vm",
                       publicOrigin="https://native.example.test", modelKey="", modelBaseUrl="", model="")
        self.assertEqual(guest.parse_launch(json.dumps(value).encode()), value)
        direct = {**value, "tunnelToken": None, "accessHostname": "203-0-113-10.sslip.io", "publicOrigin": "https://203-0-113-10.sslip.io"}
        self.assertEqual(guest.parse_launch(json.dumps(direct).encode()), direct)
        invalid = [{**value, key: bad} for key, bad in (
            ("version", 1), ("version", True), ("agentKind", "codex"),
            ("tunnelToken", None), ("modelKey", "synthetic-key"), ("modelBaseUrl", "https://api.example.test"), ("model", "m"),
            ("publicOrigin", "https://Native.example.test"), ("publicOrigin", "https://native.example.test/"),
            ("publicOrigin", "https://native.example.test:443"), ("publicOrigin", "http://native.example.test"),
            ("publicOrigin", "https://user:pass@native.example.test"), ("publicOrigin", "https://native..test"),
            ("publicOrigin", "https://native.test?key=x"), ("publicOrigin", None), ("publicOrigin", "https://-native.test"))]
        invalid += [{**value, "publicOrigin": origin} for origin in
                    ("https://127.1", "https://0177.0.0.1", "https://example.123", "https://xn--a.example")]
        invalid += [{**direct, "publicOrigin": value["publicOrigin"]}, {key: val for key, val in value.items() if key != "publicOrigin"}]
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaisesRegex(guest.InstallError, "^invalid guest launch document$"):
                guest.parse_launch(json.dumps(candidate).encode())

    def test_native_v2_accepts_proxmox_only_with_named_https_authority(self):
        value = launch(version=2, agentKind="deepseek-harness", computerSubstrate="proxmox-kvm",
                       publicOrigin="https://native.example.test", modelKey="", modelBaseUrl="", model="")
        self.assertEqual(guest.parse_launch(json.dumps(value).encode()), value)
        for candidate in ({**value, "tunnelToken": None},
                          {**value, "accessHostname": "203-0-113-10.sslip.io"}):
            with self.assertRaisesRegex(guest.InstallError, "^invalid guest launch document$"):
                guest.parse_launch(json.dumps(candidate).encode())

    def test_every_catalog_runtime_and_substrate_is_preserved(self):
        for kind in sorted(guest.KINDS):
            for substrate in ("proxmox-kvm", "provider-vm"):
                with self.subTest(kind=kind, substrate=substrate):
                    value = launch(agentKind=kind, computerSubstrate=substrate)
                    self.assertEqual(guest.parse_launch(json.dumps(value).encode()), value)

    def test_invalid_documents_are_rejected_without_input_diagnostics(self):
        values = [b"", b"{" + b"sensitive" * 100, b"x" * 32769, b"[]", b"null", b"\xff",
                  json.dumps(launch()).replace('"version": 1', '"version": 1,"version": 1').encode()]
        for key, bad in (("version", True), ("version", 2), ("agentKind", "other"), ("agentKind", []),
                         ("computerSubstrate", "docker"), ("wantBrowser", "1"), ("wantBrowser", 1),
                         ("modelKey", "key\nINJECTION=1"), ("modelKey", "x" * 8193),
                         ("modelBaseUrl", "x" * 2049), ("model", "x" * 257), ("model", "bad\x00value"),
                         ("tunnelToken", "a\nb"), ("tunnelToken", "x" * 8193), ("tunnelToken", "$(command)")):
            values.append(json.dumps(launch(**{key: bad})).encode())
        values += [json.dumps({**launch(), "command": "do not execute"}).encode(),
                   json.dumps({key: value for key, value in launch().items() if key != "agentKind"}).encode(),
                   json.dumps(launch(computerSubstrate="provider-vm", tunnelToken=None)).encode(),
                   json.dumps(launch(computerSubstrate="provider-vm", accessHostname="203-0-113-10.sslip.io")).encode(),
                   json.dumps(launch(computerSubstrate="proxmox-kvm", tunnelToken=None, accessHostname="203-0-113-10.sslip.io")).encode()]
        for raw in values:
            with self.subTest(length=len(raw)):
                with self.assertRaisesRegex(guest.InstallError, "^invalid guest launch document$"):
                    guest.parse_launch(raw)

    def test_legacy_browser_default_and_quick_tunnel_are_proxmox_only(self):
        value = launch(wantBrowser=None, tunnelToken=None)
        self.assertEqual(guest.parse_launch(json.dumps(value).encode()), value)

    def test_provider_vm_accepts_exact_direct_hostname_without_tunnel_secret(self):
        value = launch(computerSubstrate="provider-vm", tunnelToken=None,
                       accessHostname="203-0-113-10.sslip.io")
        self.assertEqual(guest.parse_launch(json.dumps(value).encode()), value)

    def test_installer_uses_fixed_argv_explicit_environment_and_no_secret_stdin(self):
        for kind in sorted(guest.KINDS):
            for substrate in ("proxmox-kvm", "provider-vm"):
                value = launch(agentKind=kind, computerSubstrate=substrate)
                with patch.object(guest, "check_named_tunnel") as check, patch.object(guest, "check_effective_tunnel"), \
                     patch.object(guest, "configure_named_tunnel") as tunnel, \
                     patch.object(guest.subprocess, "run") as command:
                    guest.install_agent(value, Path("/owned-bundle"))
                    check.assert_called_once_with(value["tunnelToken"], 0)
                    tunnel.assert_called_once_with(value["tunnelToken"], 0)
                    self.assertEqual(command.call_args.args[0], ["/bin/bash", "/owned-bundle/provision-claude-code-box.sh"])
                    env = command.call_args.kwargs["env"]
                    self.assertEqual(env["HIVRA_AGENT_KIND"], kind)
                    self.assertEqual(env["HIVRA_COMPUTER_SUBSTRATE"], substrate)
                    self.assertEqual(env["HIVRA_MODEL_KEY"], value["modelKey"])
                    self.assertNotIn(value["tunnelToken"], env.values())
                    self.assertEqual(env["HIVRA_ACCESS_HOSTNAME"], "")
                    self.assertNotIn("BUX_REF", env)
                    self.assertEqual(command.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_failed_install_does_not_configure_access(self):
        with patch.object(guest, "check_named_tunnel"), patch.object(guest, "check_effective_tunnel"), \
             patch.object(guest, "configure_named_tunnel") as tunnel, \
             patch.object(guest.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "fixture")):
            with self.assertRaises(subprocess.CalledProcessError):
                guest.install_agent(launch(), Path("/owned-bundle"))
            tunnel.assert_not_called()

    def test_direct_access_is_checked_before_packages_and_configured_after_success(self):
        value = launch(computerSubstrate="provider-vm", tunnelToken=None,
                       accessHostname="203-0-113-10.sslip.io")
        with patch.object(guest, "check_direct_access") as check, \
             patch.object(guest, "check_effective_direct_access") as effective, \
             patch.object(guest, "configure_direct_access") as configure, \
             patch.object(Path, "read_text", return_value="2026.08.30.2\n"), \
             patch.object(guest.subprocess, "run") as command:
            guest.install_agent(value, Path("/owned-bundle"))
            check.assert_called_once_with(value["accessHostname"], 0)
            effective.assert_called_once_with(allow_missing=True)
            configure.assert_called_once_with(value["accessHostname"], 0)
            self.assertEqual(command.call_args_list[0].kwargs["env"]["HIVRA_ACCESS_HOSTNAME"], value["accessHostname"])
            self.assertEqual(command.call_args_list[1].args[0], ["/usr/bin/python3", "/owned-bundle/hivra-runtime-receipt.py",
                "--provisioner-version", "2026.08.30.2", "--agent-kind", "codex", "--substrate", "provider-vm", "--refresh-direct-access"])
            self.assertNotIn(value["modelKey"], command.call_args_list[1].kwargs["env"].values())

    def test_conflicting_tunnel_is_rejected_before_package_work(self):
        with patch.object(guest, "check_named_tunnel", side_effect=guest.InstallError("conflict")), \
             patch.object(guest.subprocess, "run") as command:
            with self.assertRaises(guest.InstallError):
                guest.install_agent(launch(), Path("/owned-bundle"))
            command.assert_not_called()

    def test_public_entry_rejects_payload_before_lock_or_process(self):
        stream = SimpleNamespace(buffer=io.BytesIO(b'{"sensitive":"do-not-print"}'))
        with patch.object(guest.sys, "stdin", stream), patch.object(guest.os, "open") as opening, \
             patch.object(guest.subprocess, "run") as command:
            with self.assertRaises(guest.InstallError):
                guest.main()
            opening.assert_not_called()
            command.assert_not_called()

    def test_linux_publication_is_atomic_no_replace_and_has_no_fallback(self):
        rename = Mock(return_value=0)
        with patch.object(guest.ctypes, "CDLL", return_value=SimpleNamespace(renameat2=rename)):
            guest.publish_exclusive("/owned/source", "/owned/destination")
            rename.assert_called_once_with(-100, b"/owned/source", -100, b"/owned/destination", 1)
        with patch.object(guest.ctypes, "CDLL", return_value=SimpleNamespace()):
            with self.assertRaises(guest.InstallError):
                guest.publish_exclusive("/owned/source", "/owned/destination")
        with patch.object(guest.ctypes, "CDLL", return_value=SimpleNamespace(renameat2=Mock(return_value=-1))), \
             patch.object(guest.ctypes, "get_errno", return_value=17):
            with self.assertRaises(FileExistsError):
                guest.publish_exclusive("/owned/source", "/owned/destination")

    def test_restart_budget_covers_the_real_systemd_stop_and_start_jobs(self):
        def delayed_restart(arguments, **kwargs):
            # The live Ubuntu fixture took 90s to drain its terminal connection.
            if kwargs["timeout"] < 91:
                raise subprocess.TimeoutExpired(arguments, kwargs["timeout"])
            return SimpleNamespace(returncode=0)
        with patch.object(guest.subprocess, "run", side_effect=delayed_restart) as run:
            guest.service(("restart", "hivra-cf-tunnel.service"))
            self.assertEqual(run.call_args.kwargs["timeout"], 195)
            guest.service(("restart", "hivra-direct-access.service"))
            self.assertEqual(run.call_args.kwargs["timeout"], 195)
        with patch.object(guest.subprocess, "run") as run:
            guest.service(("show", "hivra-cf-tunnel.service"), True)
            self.assertEqual(run.call_args.kwargs["timeout"], 15)
            guest.service(("restart", "other.service"))
            self.assertEqual(run.call_args.kwargs["timeout"], 15)

    def test_timeout_is_not_retried_and_does_not_print_exception_credentials(self):
        error = subprocess.TimeoutExpired(["fixture-sensitive-command"], 195, output=b"fixture-secret")
        output = io.StringIO()
        with patch.object(guest.subprocess, "run", side_effect=error) as run, patch.object(guest.sys, "stderr", output):
            with self.assertRaises(subprocess.TimeoutExpired):
                guest.service(("restart", "hivra-cf-tunnel.service"))
            self.assertEqual(run.call_count, 1)
        self.assertIn("bounded deadline", output.getvalue())
        self.assertNotIn("fixture", output.getvalue())

    def test_caddy_admission_uses_exact_pinned_bytes_not_a_reported_version(self):
        script = SOURCE.with_name("provision-claude-code-box.sh").read_text()
        start = script.index("assert_caddy_destination() {")
        end = script.index("\n}\n", start) + 3
        function = script[start:end]
        with tempfile.TemporaryDirectory(prefix="hivra-caddy-admission-") as directory:
            root = Path(directory)
            expected = root / "pinned"
            installed = root / "caddy"
            expected.write_bytes(b"pinned archive bytes")

            def admission():
                return subprocess.run(["/bin/bash", "--noprofile", "--norc", "-s", "--", str(expected), str(installed)],
                    input='set -euo pipefail\ndie() { printf "%s\\n" "$*" >&2; exit 1; }\n' + function
                    + '\nassert_caddy_destination "$1" "$2"\n', text=True, capture_output=True, timeout=3,
                    env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})

            self.assertEqual(admission().returncode, 0)  # fresh installation
            installed.write_bytes(expected.read_bytes())
            self.assertEqual(admission().returncode, 0)  # exact replay
            installed.write_bytes(b'#!/bin/sh\necho "v2.11.4"\n')
            rejected = admission()
            self.assertEqual(rejected.returncode, 1)
            self.assertIn("explicit repair required", rejected.stderr)
            installed.unlink()
            installed.symlink_to(expected)
            self.assertEqual(admission().returncode, 1)
        self.assertIn('assert_caddy_destination "$CADDY_TMP_DIR/unpacked/caddy" /usr/local/bin/caddy', script)
        self.assertNotIn('! caddy version', script)


class TunnelFiles(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hivra-guest-install-test-")
        self.root = Path(self.temporary.name)
        (self.root / "etc/systemd/system").mkdir(parents=True)
        self.token = self.root / "etc/hivra-cf-token.env"
        self.unit = self.root / "etc/systemd/system/hivra-cf-tunnel.service"
        self.uid = os.getuid()
        self.properties = b"FragmentPath=" + os.fsencode(self.unit) + b"\nDropInPaths=\nLoadState=loaded\n"
        self.token_patch = patch.object(guest, "TOKEN_FILE", self.token)
        self.unit_patch = patch.object(guest, "UNIT_FILE", self.unit)
        self.token_patch.start()
        self.unit_patch.start()
        self.addCleanup(self.unit_patch.stop)
        self.addCleanup(self.token_patch.stop)
        self.addCleanup(self.temporary.cleanup)
        # These owned-file tests also run on macOS. The production Linux
        # renameat2 boundary is checked above and on the disposable Ubuntu guest;
        # this no-concurrency test double models successful exclusive rename.
        def publish(source, destination):
            if destination.exists() or destination.is_symlink():
                raise FileExistsError()
            os.rename(source, destination)
        self.publication = patch.object(guest, "publish_exclusive", side_effect=publish)
        self.publication.start()
        self.addCleanup(self.publication.stop)

    def configure(self, token="fixture-only", failure=None, properties=None):
        calls = []

        def service(arguments, **kwargs):
            self.assertEqual(arguments[0], "/usr/bin/systemctl")
            self.assertNotIn(token, str(arguments))
            self.assertNotIn(token, str(kwargs))
            self.assertEqual(kwargs["timeout"], 195 if arguments[1] == "restart" else 15)
            calls.append(arguments[1:])
            if arguments[1] == failure:
                raise subprocess.CalledProcessError(1, "fixture")
            observed = self.properties if self.unit.exists() else b"FragmentPath=\nDropInPaths=\nLoadState=not-found\n"
            return SimpleNamespace(stdout=observed if properties is None else properties)

        with patch.object(guest.os, "access", return_value=True), patch.object(guest.subprocess, "run", side_effect=service):
            guest.configure_named_tunnel(token, self.uid)
        return calls

    def test_exact_private_configuration_and_replay_restart_only_our_service(self):
        first = self.configure()
        before = (self.token.stat().st_ino, self.unit.stat().st_ino)
        self.assertEqual(self.token.read_bytes(), b"TUNNEL_TOKEN=fixture-only\n")
        self.assertEqual(self.unit.read_bytes(), guest.UNIT)
        self.assertEqual(stat.S_IMODE(self.token.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.unit.stat().st_mode), 0o644)
        self.assertEqual(self.token.stat().st_nlink, 1)
        self.assertEqual(self.configure(), first)
        self.assertEqual((self.token.stat().st_ino, self.unit.stat().st_ino), before)
        self.assertEqual([item[0] for item in first], ["show", "daemon-reload", "show", "enable", "restart", "is-active"])
        self.assertEqual(first[-2], ["restart", "hivra-cf-tunnel.service"])
        self.assertEqual(list(self.root.rglob(".hivra-install-*")), [])

    def test_rotation_and_custom_units_are_preserved_not_overwritten(self):
        self.configure()
        original = self.token.read_bytes()
        with self.assertRaises(guest.InstallError):
            self.configure("different-fixture")
        self.assertEqual(self.token.read_bytes(), original)
        self.unit.write_bytes(b"custom unit\n")
        with self.assertRaises(guest.InstallError):
            self.configure()
        self.assertEqual(self.unit.read_bytes(), b"custom unit\n")
        self.assertEqual(self.token.read_bytes(), original)

    def test_invalid_unit_prevents_even_first_token_write(self):
        self.unit.write_bytes(b"custom unit\n")
        self.unit.chmod(0o644)
        with self.assertRaises(guest.InstallError):
            self.configure()
        self.assertFalse(self.token.exists())

    def test_symlink_hardlink_permissions_and_unowned_file_are_rejected(self):
        outside = self.root / "untouched"
        outside.write_bytes(b"untouched")
        for change in ("symlink", "hardlink", "mode", "uid"):
            with self.subTest(change=change):
                if self.token.exists() or self.token.is_symlink():
                    self.token.unlink()
                if change == "symlink":
                    self.token.symlink_to(outside)
                elif change == "hardlink":
                    os.link(outside, self.token)
                else:
                    self.token.write_bytes(b"TUNNEL_TOKEN=fixture-only\n")
                    self.token.chmod(0o644 if change == "mode" else 0o600)
                with self.assertRaises((OSError, guest.InstallError)):
                    guest.check_named_tunnel("fixture-only", self.uid + 1 if change == "uid" else self.uid)
                self.assertEqual(outside.read_bytes(), b"untouched")
                self.assertFalse(self.unit.exists())

    def test_service_failure_is_not_reported_as_success_and_retry_reconciles(self):
        for failure in ("daemon-reload", "show", "enable", "restart", "is-active"):
            with self.subTest(failure=failure):
                with self.assertRaises(subprocess.CalledProcessError):
                    self.configure(failure=failure)
                self.configure()

    def test_other_fragment_or_dropin_is_not_started(self):
        for properties in (b"FragmentPath=/elsewhere\nDropInPaths=\nLoadState=loaded\n", self.properties.replace(b"DropInPaths=", b"DropInPaths=/custom"), b"", self.properties * 2):
            with self.subTest(properties=properties):
                with self.assertRaises(guest.InstallError):
                    self.configure(properties=properties)
                self.assertFalse(self.token.exists())
                self.assertFalse(self.unit.exists())

    def test_mid_publication_failure_leaves_no_secret_temporary(self):
        with patch.object(guest, "publish_exclusive", side_effect=OSError("fixture")):
            with self.assertRaises(OSError):
                self.configure()
        self.assertFalse(self.token.exists())
        self.assertEqual(list(self.root.rglob(".hivra-install-*")), [])
        self.configure()

    def test_lost_ack_after_atomic_publication_is_recoverable_without_alias(self):
        original_unlink = guest.os.unlink
        def interrupted(path):
            if str(path).startswith(str(self.token.parent / ".hivra-install-")):
                raise OSError("fixture interrupted after publication")
            return original_unlink(path)
        with patch.object(guest.os, "unlink", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.configure()
        self.assertEqual(self.token.stat().st_nlink, 1)
        self.assertEqual(list(self.root.rglob(".hivra-install-*")), [])
        self.configure()


class DirectAccessFiles(TunnelFiles):
    def setUp(self):
        super().setUp()
        self.config = self.root / "etc/hivra-direct-access.Caddyfile"
        self.direct_unit = self.root / "etc/systemd/system/hivra-direct-access.service"
        self.config_patch = patch.object(guest, "DIRECT_CONFIG_FILE", self.config)
        self.direct_patch = patch.object(guest, "DIRECT_UNIT_FILE", self.direct_unit)
        self.config_patch.start(); self.direct_patch.start()
        self.addCleanup(self.config_patch.stop); self.addCleanup(self.direct_patch.stop)

    def test_pristine_guest_precheck_does_not_require_not_yet_installed_caddy(self):
        with patch.object(guest.os, "access", return_value=False) as executable:
            self.assertEqual(guest.check_direct_access("203-0-113-10.sslip.io", self.uid),
                             guest.direct_config("203-0-113-10.sslip.io"))
            executable.assert_not_called()

    def test_direct_configuration_is_exact_and_does_not_shadow_custom_units(self):
        calls = []
        def service(arguments, capture=False):
            calls.append(arguments)
            properties = (b"FragmentPath=" + os.fsencode(self.direct_unit) + b"\nDropInPaths=\nLoadState=loaded\n"
                          if self.direct_unit.exists() else b"FragmentPath=\nDropInPaths=\nLoadState=not-found\n")
            return SimpleNamespace(stdout=properties)
        with patch.object(guest, "service", side_effect=service), patch.object(guest.os, "access", return_value=True):
            guest.configure_direct_access("203-0-113-10.sslip.io", self.uid)
        self.assertEqual(self.config.read_bytes(), guest.direct_config("203-0-113-10.sslip.io"))
        self.assertEqual(self.direct_unit.read_bytes(), guest.DIRECT_UNIT)
        self.assertIn(("restart", "hivra-direct-access.service"), calls)
        with patch.object(guest, "service", return_value=SimpleNamespace(stdout=b"FragmentPath=/custom\nDropInPaths=\nLoadState=loaded\n")):
            with self.assertRaisesRegex(guest.InstallError, "override"):
                guest.configure_direct_access("203-0-113-10.sslip.io", self.uid)
        with self.assertRaisesRegex(guest.InstallError, "differs"):
            guest.check_direct_access("203-0-113-11.sslip.io", self.uid)


if __name__ == "__main__":
    unittest.main()
