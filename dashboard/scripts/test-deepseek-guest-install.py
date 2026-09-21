"""Root-only owned filesystem composition tests. No npm/base/systemd execution."""
import importlib.util
import json
import os
import pty
from pathlib import Path
import shutil
import select
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[1] / "provisioner"
spec = importlib.util.spec_from_file_location("native_guest", SOURCE / "deepseek-harness/install-guest.py")
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
real_wait_ready = guest.wait_ready
entry_spec = importlib.util.spec_from_file_location("shared_guest", SOURCE / "hivra-install-agent.py")
entry = importlib.util.module_from_spec(entry_spec)
entry_spec.loader.exec_module(entry)


class Response:
    status = 200
    def __init__(self, value=None):
        self.value = value
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self, size):
        return json.dumps(self.value).encode()[:size]


class ReadinessGeneration(unittest.TestCase):
    def test_readiness_is_bracketed_by_the_same_owned_service_generation(self):
        running = {"invocationId": "a" * 32, "supervisorPid": 123}
        metadata = {"agentKind": "deepseek-harness", "nativeSurface": "/", "nativeReady": True}
        for final in (running, {**running, "invocationId": "b" * 32}, {**running, "supervisorPid": 124}):
            client = SimpleNamespace(open=Mock(side_effect=[Response(), Response(metadata)]))
            with patch.object(guest.urllib.request, "build_opener", return_value=client), \
                 patch.object(guest.owner, "definition", return_value={"InvocationID": "a" * 32, "MainPID": "123"}), \
                 patch.object(guest.owner, "verify_running", return_value=final):
                if final == running:
                    self.assertEqual(real_wait_ready(), running)
                else:
                    with self.assertRaisesRegex(guest.files.InstallError, "generation changed"):
                        real_wait_ready()

    def test_generic_healthy_gateway_never_counts_as_native_readiness(self):
        client = SimpleNamespace(open=Mock(side_effect=[Response(), Response({"agentKind": "claude"})]))
        with patch.object(guest.urllib.request, "build_opener", return_value=client), \
             patch.object(guest.time, "monotonic", side_effect=[0, 0, 100]), patch.object(guest.time, "sleep"), \
             patch.object(guest.owner, "definition", return_value={}), patch.object(guest.owner, "verify_running") as verify:
            with self.assertRaisesRegex(guest.files.InstallError, "deadline exceeded"):
                real_wait_ready(timeout=1)
            verify.assert_not_called()


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires disposable Linux root fixture")
class NativeGuestInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hivra-guest-test-", dir="/root")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        shutil.copytree(SOURCE, self.source)
        self.gateway = self.root / "opt/hivra/deepseek-gateway"
        self.config = self.root / "etc/hivra/deepseek-native.json"
        self.unit = self.root / "etc/systemd/system/bux-hivra-chat.service"
        self.unit.parent.mkdir(parents=True)
        self.gateway.parent.parent.mkdir(parents=True)
        self.events = []
        self.launch = {"publicOrigin": "https://native.example.test", "computerSubstrate": "provider-vm", "wantBrowser": False}
        self.reused = False
        self.bootstrap = Mock(side_effect=lambda: self.events.append("bootstrap"))
        for target, name, value in (
            (guest, "GATEWAY", self.gateway), (guest, "CONFIG", self.config),
            (guest, "INTENT", self.config.with_name("deepseek-install.json")),
            (guest, "BASE", self.root / "opt/bux"), (guest, "HOME", self.root / "home/bux"),
            (guest, "BASE_PATHS", (self.root / "etc/bux",)), (guest, "BASE_UNITS", ()),
            (guest, "__file__", str(self.source / "deepseek-harness/install-guest.py")),
            # Like the delivered guest bundle, every consumed asset belongs to
            # this root-owned fixture, not the CI runner's checkout.
            (guest.owner, "TEMPLATE", self.source / "deepseek-harness/bux-hivra-chat.service"),
            (guest.owner, "UNIT_FILE", self.unit), (guest.files, "RUNTIME", self.gateway.parent / "runtime"),
            (guest.owner, "definition", self.definition), (guest.owner, "stop_owned", lambda: self.events.append("stop")),
            (guest.owner, "service", self.service), (guest, "wait_ready", self.ready),
            (guest.files, "install_package", self.package),
            (guest.pwd, "getpwnam", Mock(side_effect=KeyError)), (guest.grp, "getgrnam", Mock(side_effect=KeyError))):
            change = patch.object(target, name, value)
            change.start()
            self.addCleanup(change.stop)

    def definition(self, allow_missing=False):
        return {"LoadState": "loaded" if self.reused else "not-found"}

    def package(self, source):
        self.events.append("package")
        guest.files.RUNTIME.mkdir(exist_ok=True)
        return {"version": "fixture"}

    def service(self, *args, **kwargs):
        self.events.append(args[0])
        return b""

    def ready(self):
        self.events.append("ready")
        return {"wholeComputerCleanupVerified": False}

    def install(self):
        return guest.install(self.launch, self.source, self.bootstrap)

    def test_fresh_install_orders_base_immutable_assets_and_service(self):
        previous = os.umask(0o077)
        try:
            receipt = self.install()
        finally:
            os.umask(previous)
        self.assertEqual(self.events, ["stop", "bootstrap", "stop", "package", "daemon-reload", "enable", "start", "ready"])
        self.assertFalse(receipt["publicAccessVerified"])
        self.assertFalse(receipt["baseReused"])
        self.assertEqual(json.loads(self.config.read_bytes()), {"version": 1, "publicOrigin": self.launch["publicOrigin"]})
        self.assertEqual(self.unit.read_bytes(), guest.owner.TEMPLATE.read_bytes())
        self.assertEqual(self.gateway.stat().st_mode & 0o777, 0o755)
        guest.verify_gateway(guest.source_assets(self.source))
        self.assertEqual(list(self.root.rglob(".deepseek-*-*")), [])

    def test_owned_replay_preserves_native_state_and_never_reruns_base(self):
        self.install()
        private = self.root / "private-native-state"
        private.write_text("synthetic stored credential and session")
        self.reused = True
        self.events.clear()
        self.bootstrap.reset_mock()
        with patch.object(guest.files, "verified_existing", return_value={}):
            receipt = self.install()
        self.bootstrap.assert_not_called()
        self.assertTrue(receipt["baseReused"])
        self.assertEqual(private.read_text(), "synthetic stored credential and session")

    def test_private_provider_delivery_parent_allows_only_public_runtime_traversal(self):
        self.gateway.parent.mkdir(mode=0o700)
        private = self.gateway.parent / "provider-bundle"
        private.mkdir(mode=0o700)
        (private / "current").mkdir(mode=0o700)
        token = private / "current/fixture-secret"
        token.write_text("synthetic preserved private input")
        token.chmod(0o600)
        self.install()
        self.assertEqual(self.gateway.parent.stat().st_mode & 0o777, 0o711)
        self.assertEqual(private.stat().st_mode & 0o777, 0o700)
        self.assertEqual(token.stat().st_mode & 0o777, 0o600)
        self.assertEqual(token.read_text(), "synthetic preserved private input")

    def test_unknown_private_parent_is_never_made_traversable(self):
        self.gateway.parent.mkdir(mode=0o700)
        (self.gateway.parent / "custom-private-file").write_text("preserve")
        with self.assertRaisesRegex(guest.files.InstallError, "directory mode"):
            self.install()
        self.assertEqual(self.gateway.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.events, [])

    def test_existing_base_home_config_or_group_is_not_adopted(self):
        for name in (guest.BASE, guest.HOME, *guest.BASE_PATHS):
            name.parent.mkdir(parents=True, exist_ok=True)
            name.symlink_to(self.root / "missing")
            with self.subTest(name=name), self.assertRaisesRegex(guest.files.InstallError, "adoption or repair"):
                self.install()
            name.unlink()
        with patch.object(guest.grp, "getgrnam", return_value=object()), self.assertRaisesRegex(guest.files.InstallError, "adoption or repair"):
            self.install()
        self.assertEqual(self.events, [])

    def test_custom_gateway_or_origin_is_not_stopped_or_overwritten(self):
        self.install()
        self.reused = True
        for target in (self.config, self.gateway / "server.js"):
            original = target.read_bytes()
            target.write_bytes(b"custom retained bytes")
            self.events.clear()
            with self.subTest(target=target), self.assertRaises(guest.files.InstallError):
                self.install()
            self.assertEqual(self.events, [])
            self.assertEqual(target.read_bytes(), b"custom retained bytes")
            target.write_bytes(original)

    def test_private_gateway_subdirectory_rejects_before_stopping_retained_service(self):
        self.install()
        self.reused = True
        self.events.clear()
        (self.gateway / "deepseek-harness").chmod(0o700)
        with self.assertRaisesRegex(guest.files.InstallError, "gateway directory mode"):
            self.install()
        self.assertEqual(self.events, [])
        self.assertEqual((self.gateway / "deepseek-harness").stat().st_mode & 0o777, 0o700)

    def test_shared_entrypoint_stops_native_service_on_access_or_receipt_failure(self):
        value = {"version": 2, "agentKind": "deepseek-harness", **self.launch,
                 "modelKey": "", "modelBaseUrl": "", "model": "", "tunnelToken": None,
                 "accessHostname": "203-0-113-10.sslip.io"}
        for failure in ("receipt", "access"):
            native = SimpleNamespace(install=Mock(), owner=SimpleNamespace(stop_owned=Mock()))
            loader = SimpleNamespace(loader=SimpleNamespace(exec_module=Mock()))
            with patch.object(entry.importlib.util, "spec_from_file_location", return_value=loader), \
                 patch.object(entry.importlib.util, "module_from_spec", return_value=native), \
                 patch.object(entry, "check_direct_access"), patch.object(entry, "check_effective_direct_access"), \
                 patch.object(entry.subprocess, "run", side_effect=RuntimeError("fixture") if failure == "receipt" else None), \
                 patch.object(entry, "configure_access", side_effect=RuntimeError("fixture") if failure == "access" else None), \
                 self.assertRaises(RuntimeError):
                entry.install_agent(value, self.source)
            native.install.assert_called_once()
            native.owner.stop_owned.assert_called_once()

    def test_incomplete_owned_install_does_not_bootstrap_over_user_home(self):
        self.reused = True
        with self.assertRaisesRegex(guest.files.InstallError, "incomplete retained runtime"):
            self.install()
        self.assertEqual(self.events, [])

    def test_changed_browser_intent_cannot_relabel_an_unchanged_base(self):
        self.install()
        self.reused = True
        self.launch["wantBrowser"] = True
        self.events.clear()
        with self.assertRaisesRegex(guest.files.InstallError, "custom configuration"):
            self.install()
        self.assertEqual(self.events, [])

    def test_untrusted_source_link_rejects_before_any_service_or_file_mutation(self):
        target = self.source / "provision-claude-code-box.sh"
        target.unlink()
        target.symlink_to(self.root / "outside")
        with self.assertRaises(OSError):
            self.install()
        self.assertEqual(self.events, [])
        self.assertFalse(self.config.parent.exists())

    def test_user_owned_template_is_rejected_before_any_mutation(self):
        self.assertTrue(guest.owner.TEMPLATE.is_relative_to(self.source))
        os.chown(guest.owner.TEMPLATE, 1000, 1000)
        with self.assertRaisesRegex(guest.files.InstallError, "unsafe file"):
            self.install()
        self.assertEqual(self.events, [])
        self.assertFalse(self.config.parent.exists())

    def test_failed_native_start_or_readiness_stops_only_owned_service(self):
        with patch.object(guest, "wait_ready", side_effect=RuntimeError("synthetic failure")), self.assertRaises(RuntimeError):
            self.install()
        self.assertEqual(self.events[-2:], ["start", "stop"])
        self.assertTrue(self.gateway.exists())  # Published assets/data retained, not deleted.

    def test_gateway_extra_file_link_and_collision_are_preserved(self):
        self.install()
        target = self.gateway / "custom.js"
        target.symlink_to(self.root / "outside")
        with self.assertRaises(guest.files.InstallError):
            guest.publish_gateway(guest.source_assets(self.source))
        self.assertTrue(target.is_symlink())

    def test_native_terminal_branch_executes_a_real_shell_in_a_pty(self):
        home = self.root / "terminal-home"
        (home / ".hivra").mkdir(parents=True)
        (home / ".hivra/agent-kind").write_text("deepseek-harness\n")
        pid, terminal = pty.fork()
        if pid == 0:
            os.execve("/bin/bash", ["/bin/bash", str(SOURCE / "hivra-agent-shell")],
                      {"HOME": str(home), "PATH": "/usr/bin:/bin", "TERM": "xterm", "LANG": "C.UTF-8"})
        collected = b""
        reaped = False
        try:
            os.write(terminal, b"printf '%s%s\\n' native- shell-ok; exit\n")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if select.select([terminal], [], [], 0.1)[0]:
                    try:
                        data = os.read(terminal, 4096)
                        if not data:
                            break
                        collected += data
                    except OSError:
                        break  # Linux PTY EIO after the shell exits.
                if len(collected) > 32768:
                    self.fail("unexpected terminal output")
            self.assertIn(b"This is your computer shell.", collected)
            self.assertIn(b"native-shell-ok", collected)  # Not present in echoed input.
            # Linux can report PTY EOF/EIO just before the child becomes
            # waitable. Poll the process within a short bound instead of
            # turning that scheduler race into a release-safety failure.
            reap_deadline = time.monotonic() + 2
            done, status = os.waitpid(pid, os.WNOHANG)
            while done == 0 and time.monotonic() < reap_deadline:
                time.sleep(0.01)
                done, status = os.waitpid(pid, os.WNOHANG)
            self.assertEqual(done, pid)
            reaped = True
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        finally:
            os.close(terminal)
            if not reaped:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)


if __name__ == "__main__":
    unittest.main()
