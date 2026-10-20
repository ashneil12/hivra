"""Root-only tests for the owned DeepSeek runtime update. No npm or systemd:
every service call is recorded, the filesystem effects are real."""
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "provisioner"
spec = importlib.util.spec_from_file_location("deepseek_update", SOURCE / "deepseek-harness/update-guest.py")
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)
real_load = update.load


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires disposable Linux root fixture")
class OwnedDeepSeekUpdate(unittest.TestCase):
    def setUp(self):
        previous = os.umask(0o022)
        self.addCleanup(os.umask, previous)
        self.temp = tempfile.TemporaryDirectory(prefix="hivra-update-test-", dir="/root")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.installed = self.root / "installed"
        shutil.copytree(SOURCE, self.installed)
        self.source = self.root / "next"
        shutil.copytree(SOURCE, self.source)
        self.opt = self.root / "opt/hivra"
        self.opt.mkdir(parents=True)
        self.opt.chmod(0o711)
        self.gateway = self.opt / "deepseek-gateway"
        self.runtime = self.opt / "deepseek-runtime"
        self.etc = self.root / "etc/hivra"
        self.etc.mkdir(parents=True)
        self.unit = self.root / "etc/systemd/system/bux-hivra-chat.service"
        self.unit.parent.mkdir(parents=True)
        self.events = []
        self.fail_ready = set()
        for name, value in (("LOCK", self.root / "install.lock"), ("RECORDED", self.root / "var/lib/hivra/deepseek-update-source"),
                            ("PREVIOUS", self.opt / ".deepseek-previous"), ("load", self.load)):
            change = patch.object(update, name, value)
            change.start()
            self.addCleanup(change.stop)
        (self.root / "var/lib/hivra").mkdir(parents=True)
        self.install_generation(self.installed)

    def load(self, source, name):
        module = real_load(source, name)
        tag = "next" if name.endswith("next") else "current"
        module.GATEWAY, module.CONFIG, module.INTENT = self.gateway, self.etc / "deepseek-native.json", self.etc / "deepseek-install.json"
        module.files.RUNTIME = self.runtime
        module.owner.UNIT_FILE = self.unit
        record = self.events.append

        def service(*args, **_):
            record(("service", args[0], tag))
            return b""

        def package(_):
            record(("package", tag))
            module.files.RUNTIME.mkdir(mode=0o755)
            (module.files.RUNTIME / "marker").write_text(tag)
            return {"version": tag}

        def ready(*_):
            record(("ready", tag))
            if tag in self.fail_ready:
                raise RuntimeError("synthetic readiness failure")
            return {"invocationId": tag}

        module.owner.service = service
        module.owner.definition = lambda allow_missing=False: record(("definition", tag)) or {}
        module.owner.stop_owned = lambda: record(("stop_owned", tag)) or {}
        module.owner.verify_running = lambda: record(("verify_running", tag)) or {"invocationId": "before"}
        module.owner.state = lambda: {}
        module.owner.empty = lambda _state: True
        module.wait_ready = ready
        module.files.install_package = package
        module.files.verified_existing = lambda: {"version": module.files.VERSION}
        return module

    def install_generation(self, source):
        guest = self.load(source, "fixture_install")
        assets = guest.source_assets(source)
        stage = Path(tempfile.mkdtemp(dir=self.opt))
        pending = update.stage_gateway(guest, assets, stage)
        os.rename(pending, self.gateway)
        shutil.rmtree(stage)
        self.runtime.mkdir(mode=0o755)
        for path, raw in ((guest.CONFIG, b'{"version":1,"publicOrigin":"https://native.example.test"}\n'),
                          (guest.INTENT, b'{"browserEnabled":false,"computerSubstrate":"proxmox-kvm","version":1}\n'),
                          (self.unit, guest.owner.TEMPLATE.read_bytes())):
            path.write_bytes(raw)
            path.chmod(0o644)
        self.events.clear()

    def change(self, relative, raw=b"// next release\n"):
        path = self.source / relative
        path.write_bytes(path.read_bytes() + raw)

    def run_update(self, seconds=None):
        return update.update(self.source, self.installed, seconds=seconds)

    def test_swaps_the_gateway_and_proves_the_new_generation(self):
        # The regression: a DeepSeek computer had no update path at all.
        self.change("hivra-chat/server.js")
        config = (self.etc / "deepseek-native.json").read_bytes()
        result = self.run_update()
        self.assertEqual(result["changed"], {"gateway": True, "package": False, "unit": False})
        self.assertEqual((self.gateway / "server.js").read_bytes(), (self.source / "hivra-chat/server.js").read_bytes())
        self.assertEqual(self.gateway.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.gateway / "server.js").stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.etc / "deepseek-native.json").read_bytes(), config)
        # Old generation proved and stopped before the swap, new one proved after.
        order = [event for event in self.events if event[0] in ("verify_running", "stop_owned", "ready")]
        self.assertEqual(order, [("verify_running", "current"), ("stop_owned", "current"), ("ready", "next")])
        self.assertIn(("service", "start", "next"), self.events)
        self.assertEqual((update.PREVIOUS / "previous-gateway/server.js").read_bytes(),
                         (self.installed / "hivra-chat/server.js").read_bytes())
        self.assertEqual((update.RECORDED / "hivra-chat/server.js").read_bytes(), (self.source / "hivra-chat/server.js").read_bytes())
        self.assertEqual(list(self.opt.glob(".deepseek-update-*")), [])

    def test_unchanged_release_restarts_nothing(self):
        result = self.run_update()
        self.assertEqual(result["changed"], {"gateway": False, "package": False, "unit": False})
        self.assertNotIn("stop_owned", [event[0] for event in self.events])
        self.assertNotIn(("service", "start", "next"), self.events)
        self.assertTrue(update.RECORDED.is_dir())

    def test_the_next_update_compares_with_the_last_update_not_the_install(self):
        self.change("hivra-chat/server.js")
        self.run_update()
        self.events.clear()
        self.change("hivra-chat/app.js")
        result = self.run_update()
        self.assertEqual(result["changed"]["gateway"], True)
        self.assertEqual((self.gateway / "app.js").read_bytes(), (self.source / "hivra-chat/app.js").read_bytes())

    def test_a_customized_gateway_is_refused_before_anything_stops(self):
        self.change("hivra-chat/server.js")
        (self.gateway / "server.js").write_bytes(b"owner edit\n")
        with self.assertRaisesRegex(Exception, "custom configuration|custom gateway"):
            self.run_update()
        self.assertEqual(self.events, [])
        self.assertEqual((self.gateway / "server.js").read_bytes(), b"owner edit\n")
        self.assertFalse(update.RECORDED.exists())

    def test_a_customized_configuration_is_refused_before_anything_stops(self):
        self.change("hivra-chat/server.js")
        (self.etc / "deepseek-native.json").chmod(0o666)
        with self.assertRaisesRegex(Exception, "unsafe file|custom configuration"):
            self.run_update()
        self.assertNotIn("stop_owned", [event[0] for event in self.events])

    def test_failed_readiness_puts_the_previous_generation_back(self):
        self.change("hivra-chat/server.js")
        self.change("deepseek-harness/bux-hivra-chat.service", b"# next\n")
        old_unit = self.unit.read_bytes()
        self.fail_ready.add("next")
        with self.assertRaisesRegex(RuntimeError, "synthetic readiness failure"):
            self.run_update()
        self.assertEqual((self.gateway / "server.js").read_bytes(), (self.installed / "hivra-chat/server.js").read_bytes())
        self.assertEqual(self.unit.read_bytes(), old_unit)
        tail = [event for event in self.events if event[0] in ("service", "ready")][-4:]
        self.assertEqual(tail, [("service", "stop", "next"), ("service", "daemon-reload", "current"),
                                ("service", "start", "current"), ("ready", "current")])
        self.assertFalse(update.PREVIOUS.exists())
        self.assertFalse(update.RECORDED.exists())
        self.assertEqual(list(self.opt.glob(".deepseek-update-*")), [])

    def test_a_new_package_is_staged_beside_the_live_one_and_swapped(self):
        self.change("hivra-chat/server.js")
        (self.runtime / "marker").write_text("current")
        with patch.dict(os.environ, {}):
            # A pin change is what moves the package; simulate one on the next generation.
            original = self.load

            def load_with_new_pins(source, name):
                module = original(source, name)
                if name.endswith("next"):
                    module.files.VERSION = "next-version"
                return module
            with patch.object(update, "load", load_with_new_pins):
                result = self.run_update()
        self.assertTrue(result["changed"]["package"])
        self.assertEqual((self.runtime / "marker").read_text(), "next")
        self.assertEqual((update.PREVIOUS / "previous-runtime/marker").read_text(), "current")
        package_at = self.events.index(("package", "next"))
        self.assertLess(package_at, self.events.index(("stop_owned", "current")))

    def test_too_little_time_left_changes_nothing(self):
        self.change("hivra-chat/server.js")
        with self.assertRaisesRegex(update.UpdateError, "not enough time left"):
            self.run_update(seconds=60)
        self.assertNotIn("stop_owned", [event[0] for event in self.events])
        self.assertEqual((self.gateway / "server.js").read_bytes(), (self.installed / "hivra-chat/server.js").read_bytes())
        self.assertEqual(list(self.opt.glob(".deepseek-update-*")), [])

    def test_a_running_installation_blocks_the_update(self):
        fd = update.lock()
        try:
            with self.assertRaisesRegex(update.UpdateError, "another installation"):
                update.lock()
        finally:
            os.close(fd)


if __name__ == "__main__":
    unittest.main()
