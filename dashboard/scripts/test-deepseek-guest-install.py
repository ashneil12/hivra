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

    # Launch-time model seed. The fixture runs the real writer as the invoking
    # user (the agent account does not exist here); ownership is checked against
    # that same uid, exactly as it is against bux in the guest.
    KEY = "fixture-model-key-\"quoted\"\\slash#hash"
    MODEL = {"modelKey": KEY, "modelBaseUrl": "https://models.example.test/api/v1", "model": "deepseek-v4-1-flash"}

    def seeded(self, **overrides):
        self.launch = {**self.launch, **self.MODEL, **overrides}
        home = guest.HOME

        def bootstrap():
            self.events.append("bootstrap")
            (home / ".hivra").mkdir(parents=True, mode=0o755)
        self.bootstrap.side_effect = bootstrap
        change = patch.object(guest, "AGENT_ACCOUNT", None)
        change.start()
        self.addCleanup(change.stop)
        original = guest.seed_model
        self.addCleanup(setattr, guest, "seed_model", original)
        guest.seed_model = lambda value: (self.events.append("seed"), original(value))[1]
        return home / ".hivra/deepseek/.dsh"

    def test_fresh_install_seeds_the_model_before_the_service_starts(self):
        dsh = self.seeded()
        previous = os.umask(0o022)
        try:
            self.install()
        finally:
            os.umask(previous)
        self.assertEqual(self.events, ["stop", "bootstrap", "stop", "seed", "package", "daemon-reload", "enable", "start", "ready"])
        for directory in (dsh.parent, dsh):
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((dsh.parent.parent).stat().st_mode & 0o777, 0o755)  # Existing base directory is untouched.
        for name in ("settings.yaml", ".credentials.yaml"):
            self.assertEqual((dsh / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(sorted(path.name for path in dsh.iterdir()), [".credentials.yaml", "settings.yaml"])
        self.assertEqual((dsh / "settings.yaml").read_text(), "\n".join([
            "llm-pi-ai:", "  providers:", "    hivra-venice:", "      displayName: Venice", "      api: openai-completions",
            '      baseURL: "https://models.example.test/api/v1"', "      apiKeyEnv: HIVRA_MODEL_KEY", "      models:",
            '        - id: "deepseek-v4-1-flash"', '          name: "deepseek-v4-1-flash"',
            "          contextWindow: 1000000", "          maxTokens: 262144",
            "agent-default-model:", "  provider: hivra-venice", '  model: "deepseek-v4-1-flash"', ""]))
        self.assertEqual((dsh / ".credentials.yaml").read_text(), "version: 1\nrefs:\n  HIVRA_MODEL_KEY: " + json.dumps(self.KEY) + "\n")
        # The key lives in the credential document only.
        self.assertNotIn(self.KEY, (dsh / "settings.yaml").read_text())

    def test_seeded_documents_parse_as_the_runtime_shapes(self):
        try:
            import yaml as yaml_module
        except ImportError:
            self.skipTest("PyYAML is not installed")
        settings, credentials = guest.render_model_files(self.KEY, self.MODEL["modelBaseUrl"], "other-model")
        parsed = yaml_module.safe_load(settings)
        self.assertEqual(parsed["agent-default-model"], {"provider": "hivra-venice", "model": "other-model"})
        # A model Hivra has no declared capacity for keeps the runtime defaults.
        self.assertEqual(parsed["llm-pi-ai"]["providers"]["hivra-venice"]["models"], [{"id": "other-model", "name": "other-model"}])
        self.assertEqual(yaml_module.safe_load(credentials), {"version": 1, "refs": {"HIVRA_MODEL_KEY": self.KEY}})

    def test_the_key_never_reaches_argv_environment_or_diagnostics(self):
        self.seeded()
        real = guest.subprocess.run
        seen = []

        def run(*args, **kwargs):
            seen.append((args, kwargs))
            return real(*args, **kwargs)
        with patch.object(guest.subprocess, "run", run):
            self.install()
        (args, kwargs), = seen
        self.assertFalse([part for part in args[0] if self.KEY in part])
        self.assertFalse([value for value in kwargs["env"].values() if self.KEY in value])
        self.assertIn(json.dumps(self.KEY), json.loads(kwargs["input"])["credentials"])
        self.assertEqual(kwargs["env"].keys(), {"PATH", "LC_ALL", "HOME"})
        self.assertEqual(kwargs["umask"], 0o077)

    def test_the_writer_runs_as_the_agent_account_with_no_supplementary_groups(self):
        self.seeded()
        with patch.object(guest, "AGENT_ACCOUNT", "bux"), patch.object(guest.subprocess, "run") as run:
            guest.seed_model(("k" * 8, "https://models.example.test/v1", "m"))
        self.assertEqual({key: run.call_args.kwargs[key] for key in ("user", "group", "extra_groups")},
                         {"user": "bux", "group": "bux", "extra_groups": []})

    def test_launch_without_model_settings_seeds_nothing(self):
        self.seeded(modelKey="", modelBaseUrl="", model="")
        self.install()
        self.assertNotIn("seed", self.events)
        self.assertFalse((guest.HOME / ".hivra/deepseek").exists())

    def test_partial_model_settings_are_refused_before_anything_changes(self):
        self.seeded(modelBaseUrl="")
        with self.assertRaisesRegex(guest.files.InstallError, "incomplete model settings"):
            self.install()
        self.assertEqual(self.events, [])

    def test_replay_never_reseeds_or_overwrites_owner_edits(self):
        dsh = self.seeded()
        self.install()
        (dsh / "settings.yaml").write_text("owner edited\n")
        self.reused = True
        self.events.clear()
        with patch.object(guest.files, "verified_existing", return_value={}):
            self.install()
        self.assertNotIn("seed", self.events)
        self.assertEqual((dsh / "settings.yaml").read_text(), "owner edited\n")

    def test_fresh_install_refuses_pre_existing_seed_files_and_removes_its_own_partial_write(self):
        dsh = self.seeded()
        dsh.mkdir(parents=True)
        for directory in (dsh, dsh.parent):
            directory.chmod(0o700)
        dsh.parent.parent.chmod(0o755)
        (dsh / "settings.yaml").write_text("pre-existing")
        # The base bootstrap in this fixture creates .hivra; the seed finds the rest present.
        self.bootstrap.side_effect = lambda: self.events.append("bootstrap")
        with patch.object(guest, "base_exists", return_value=False), self.assertRaisesRegex(guest.files.InstallError, r"seeded \(code 12\)"):
            self.install()
        self.assertEqual((dsh / "settings.yaml").read_text(), "pre-existing")
        self.assertFalse((dsh / ".credentials.yaml").exists())  # The credential file written first was removed again.
        self.assertNotIn("package", self.events)

    def test_seed_refuses_links_and_unsafe_directories(self):
        self.seeded()
        outside = self.root / "outside"
        outside.mkdir(mode=0o700)
        settings = ("k" * 8, "https://models.example.test/v1", "m")
        state = guest.HOME / ".hivra"
        state.mkdir(parents=True, mode=0o755)
        (state / "deepseek").symlink_to(outside)
        with self.assertRaisesRegex(guest.files.InstallError, r"code 11"):
            guest.seed_model(settings)
        self.assertEqual(list(outside.iterdir()), [])
        (state / "deepseek").unlink()
        (state / "deepseek").mkdir(mode=0o700)
        (state / "deepseek/.dsh").symlink_to(outside)
        with self.assertRaisesRegex(guest.files.InstallError, r"code 11"):
            guest.seed_model(settings)
        self.assertEqual(list(outside.iterdir()), [])
        (state / "deepseek/.dsh").unlink()
        for mode in (0o750, 0o705):
            (state / "deepseek").chmod(mode)
            with self.subTest(mode=oct(mode)), self.assertRaisesRegex(guest.files.InstallError, r"code 11"):
                guest.seed_model(settings)
        (state / "deepseek").chmod(0o700)
        state.chmod(0o775)
        with self.assertRaisesRegex(guest.files.InstallError, r"code 11"):
            guest.seed_model(settings)
        state.chmod(0o755)
        # A missing or linked home is refused too.
        with patch.object(guest, "HOME", self.root / "absent"), self.assertRaisesRegex(guest.files.InstallError, r"code 10"):
            guest.seed_model(settings)
        link = self.root / "home-link"
        link.symlink_to(guest.HOME)
        with patch.object(guest, "HOME", link), self.assertRaisesRegex(guest.files.InstallError, r"code 10"):
            guest.seed_model(settings)

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
