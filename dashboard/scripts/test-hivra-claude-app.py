#!/usr/bin/env python3
"""Offline tests for dashboard/provisioner/hivra-claude-app.py.

No Docker, systemd or network: the helper's process boundary (`run`,
`in_container`) is replaced, so each test asserts the exact commands the root
helper would issue and the decisions it makes between them.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("hivra_claude_app", ROOT / "provisioner" / "hivra-claude-app.py")
app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app)

class Real:
    """The helper's real streaming functions, captured before any test patches them."""
    stream_to_file = staticmethod(app.stream_to_file)


GOOD_PIN = json.loads((ROOT / "provisioner" / "claude-desktop-pin.json").read_text(encoding="utf-8"))


class Completed:
    def __init__(self, stdout=b"", returncode=0, stderr=b""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


class Fixture:
    """Temporary state/cache directories plus a recording container."""

    def __init__(self, test: unittest.TestCase):
        self.dir = tempfile.TemporaryDirectory()
        test.addCleanup(self.dir.cleanup)
        base = Path(self.dir.name)
        self.pin_file = base / "pin.json"
        self.pin_file.write_text(json.dumps(GOOD_PIN), encoding="utf-8")
        self.calls: list[list[str]] = []
        self.container_up = True
        self.responses: list[tuple[str, Completed]] = []
        patches = [
            mock.patch.object(app, "STATE", base / "state"),
            mock.patch.object(app, "CACHE", base / "cache"),
            mock.patch.object(app, "PIN_FILE", self.pin_file),
            mock.patch.object(app, "ENABLED", base / "state" / "enabled"),
            mock.patch.object(app, "MODE_FILE", base / "state" / "mode"),
            mock.patch.object(app, "SNAPSHOT", base / "state" / "profile.tar.gz"),
            mock.patch.object(app, "INSTALL_LOCK", base / "state" / "install.lock"),
            mock.patch.object(app, "LAST_ERROR", base / "state" / "last-error"),
            mock.patch.object(app, "container_running", lambda: self.container_up),
            mock.patch.object(app, "in_container", self.in_container),
            mock.patch.object(app, "run", self.run),
            mock.patch.object(app, "stream_from_file", self.stream_from_file),
            mock.patch.object(app, "stream_to_file", self.stream_to_file),
        ]
        self.units_active: set[str] = set()
        self.snapshot_result: tuple[int, bytes, bool] = (0, b"", False)
        self.streams_in: list[tuple[list[str], str]] = []
        for patch in patches:
            patch.start()
            test.addCleanup(patch.stop)

    def respond(self, needle: str, completed: Completed) -> None:
        self.responses.append((needle, completed))

    def in_container(self, argv, **kwargs):
        self.calls.append(list(argv))
        joined = " ".join(argv)
        for needle, completed in self.responses:
            if needle in joined:
                return completed
        return Completed()

    def run(self, argv, **kwargs):
        self.calls.append(list(argv))
        if argv[:2] == ["/usr/bin/systemctl", "is-active"]:
            return Completed(returncode=0 if argv[-1] in self.units_active else 3)
        return Completed()

    def stream_from_file(self, argv, path, timeout=600):
        self.calls.append(list(argv))
        self.streams_in.append((list(argv), Path(path).read_text(errors="replace")))

    def stream_to_file(self, argv, path, limit, timeout=300):
        self.calls.append(list(argv))
        code, data, exceeded = self.snapshot_result
        if data and not exceeded:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
        return code, len(data), exceeded

    def commands(self) -> list[str]:
        return [" ".join(call) for call in self.calls]


class PinTests(unittest.TestCase):
    def test_the_shipped_pin_is_valid(self):
        fixture = Fixture(self)
        self.assertEqual(app.read_pin()["version"], GOOD_PIN["version"])
        self.assertTrue(fixture.pin_file.exists())

    def test_a_pin_must_name_anthropic_download_host_and_exact_version(self):
        fixture = Fixture(self)
        for mutation in (
            {"url": "https://example.com/claude-desktop_%s_amd64.deb" % GOOD_PIN["version"]},
            {"url": GOOD_PIN["url"].replace("2.26454.0", "9.9.9")},
            {"sha256": "abc"},
            {"bytes": 10},
            {"version": "not-a-version"},
        ):
            fixture.pin_file.write_text(json.dumps({**GOOD_PIN, **mutation}), encoding="utf-8")
            with self.assertRaises(RuntimeError, msg=str(mutation)):
                app.read_pin()
        fixture.pin_file.write_text(json.dumps({**GOOD_PIN, "extra": 1}), encoding="utf-8")
        with self.assertRaises(RuntimeError):
            app.read_pin()


class WindowModeTests(unittest.TestCase):
    LISTING = (
        b"0x02200013 -1 0 0 1760 1168 plasmashell.plasmashell host Desktop\n"
        b"0x02e00004  0 5 5 40 30 com.anthropic.claude.com.anthropic.Claude host tiny\n"
        b"0x02e00003  0 176 241 1208 804 com.anthropic.claude.com.anthropic.Claude host Claude\n"
    )

    def test_app_mode_fullscreens_the_largest_app_window_only(self):
        fixture = Fixture(self)
        fixture.respond("wmctrl -lGx", Completed(self.LISTING))
        self.assertTrue(app.apply_mode("app"))
        commands = fixture.commands()
        self.assertIn("wmctrl -i -r 0x02e00003 -b add,fullscreen", commands)
        self.assertFalse(any("0x02200013" in command or "0x02e00004" in command for command in commands))

    def test_desktop_mode_leaves_fullscreen_and_resizes_into_the_desktop(self):
        fixture = Fixture(self)
        fixture.respond("wmctrl -lGx", Completed(self.LISTING))
        fixture.respond("getdisplaygeometry", Completed(b"1000 500\n"))
        self.assertTrue(app.apply_mode("desktop"))
        commands = fixture.commands()
        self.assertIn("wmctrl -i -r 0x02e00003 -b remove,fullscreen", commands)
        self.assertIn("wmctrl -i -r 0x02e00003 -e 0,140,50,720,360", commands)

    def test_no_window_means_nothing_is_applied(self):
        fixture = Fixture(self)
        fixture.respond("wmctrl -lGx", Completed(b"0x1 -1 0 0 10 10 plasmashell.plasmashell host Desktop\n"))
        self.assertFalse(app.apply_mode("app"))

    def test_the_mode_verb_refuses_an_unknown_mode_and_an_uninstalled_app(self):
        fixture = Fixture(self)
        self.assertEqual(app.verb_mode("full"), 2)
        with mock.patch("builtins.print") as printed:
            self.assertEqual(app.verb_mode("app"), 3)
        self.assertIn("not_installed", printed.call_args[0][0])
        self.assertFalse(app.MODE_FILE.exists())

    def test_the_mode_is_remembered_even_when_the_window_is_not_up_yet(self):
        fixture = Fixture(self)
        app.write_state(app.ENABLED, "x\n")
        with mock.patch("builtins.print"):
            self.assertEqual(app.verb_mode("desktop"), 0)
        self.assertEqual(app.read_mode(), "desktop")


class ProfileTests(unittest.TestCase):
    def test_snapshot_excludes_caches_runs_as_the_desktop_user_and_keeps_one_root_only_copy(self):
        fixture = Fixture(self)
        fixture.respond("test -d", Completed())
        fixture.snapshot_result = (1, b"archive-bytes", False)  # tar exit 1: a file changed while read
        self.assertTrue(app.snapshot_profile())
        self.assertEqual(app.SNAPSHOT.read_bytes(), b"archive-bytes")
        self.assertEqual(oct(app.SNAPSHOT.stat().st_mode & 0o777), "0o600")
        tar = next(call for call in fixture.calls if "tar" in call and "-czf" in call)
        self.assertEqual(tar[:5], [app.DOCKER, "exec", "-u", app.DESKTOP_USER, app.CONTAINER])
        self.assertIn("--exclude=.config/Claude/Cache", tar)
        self.assertIn("--exclude=.config/Claude/claude-code", tar)
        self.assertEqual(tar[-1], ".config/Claude")
        self.assertEqual(sorted(path.name for path in app.SNAPSHOT.parent.iterdir()), ["profile.tar.gz"], "no second copy is left behind")

    def test_a_failed_snapshot_never_replaces_the_previous_one(self):
        fixture = Fixture(self)
        app.write_state(app.SNAPSHOT, "old")
        fixture.respond("test -d", Completed())
        fixture.snapshot_result = (2, b"x", False)
        self.assertFalse(app.snapshot_profile())
        self.assertEqual(app.SNAPSHOT.read_text(), "old")

    def test_a_profile_over_the_cap_is_not_backed_up_and_the_previous_backup_stays(self):
        fixture = Fixture(self)
        app.write_state(app.SNAPSHOT, "old")
        fixture.respond("test -d", Completed())
        fixture.snapshot_result = (0, b"z" * 10, True)
        self.assertFalse(app.snapshot_profile())
        self.assertEqual(app.SNAPSHOT.read_text(), "old")
        self.assertFalse(any(path.name.endswith(".tmp") for path in app.SNAPSHOT.parent.iterdir()))

    def test_the_cap_stops_a_runaway_archive_without_holding_it_in_memory(self):
        # The real streaming helper, with a child that emits more than the limit.
        target = Path(tempfile.mkdtemp()) / "out"
        self.addCleanup(lambda: target.unlink(missing_ok=True))
        code, written, exceeded = Real.stream_to_file([sys.executable, "-c", "import sys\nwhile True: sys.stdout.buffer.write(b'x'*65536)"], target, 3 * (1 << 20))
        self.assertTrue(exceeded)
        self.assertLessEqual(written, 5 * (1 << 20))
        code, written, exceeded = Real.stream_to_file([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'abc')"], target, 1 << 20)
        self.assertEqual((code, written, exceeded, target.read_bytes()), (0, 3, False, b"abc"))
        self.assertEqual(oct(target.stat().st_mode & 0o777), "0o600")

    def test_restore_never_overwrites_a_populated_profile(self):
        fixture = Fixture(self)
        app.write_state(app.SNAPSHOT, "snapshot")
        fixture.respond("Local\\ Storage", Completed(returncode=0))  # the profile already exists
        self.assertFalse(app.restore_profile())
        self.assertEqual(fixture.streams_in, [])

    def test_restore_unpacks_as_the_desktop_user_without_ownership_or_modes(self):
        fixture = Fixture(self)
        app.write_state(app.SNAPSHOT, "snapshot")
        fixture.respond("Local\\ Storage", Completed(returncode=1))
        self.assertTrue(app.restore_profile())
        argv, sent = fixture.streams_in[0]
        self.assertEqual(argv[:6], [app.DOCKER, "exec", "-i", "-u", app.DESKTOP_USER, app.CONTAINER])
        self.assertIn("--no-same-owner", argv)
        self.assertIn("--no-same-permissions", argv)
        self.assertEqual(sent, "snapshot")


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(self)
        self.systemctl = lambda: [call for call in self.fixture.calls if call[:1] == ["/usr/bin/systemctl"]]

    def start(self):
        with mock.patch("builtins.print") as printed:
            code = app.verb_install()
        return code, printed

    def job(self):
        with mock.patch.object(app, "unpack"):
            return app.verb_install_run()

    # -- the verb the gateway reaches: it only starts a systemd job --------------------

    def test_install_needs_a_running_desktop_and_says_so_on_the_owners_screen(self):
        self.fixture.container_up = False
        code, printed = self.start()
        self.assertEqual(code, 3)
        self.assertIn("desktop_not_running", printed.call_args[0][0])
        self.assertIn("desktop is not running", app.LAST_ERROR.read_text())

    def test_install_runs_the_work_as_its_own_transient_unit_that_outlives_the_gateway(self):
        code, printed = self.start()
        self.assertEqual(code, 0)
        self.assertIn('"installing": true', printed.call_args[0][0])
        started = next(call for call in self.fixture.calls if call[:1] == ["/usr/bin/systemd-run"])
        self.assertIn("--unit=hivra-claude-app-install", started)
        self.assertIn("KillMode=process", started)
        self.assertEqual(started[-5:], ["/usr/bin/python3", "-I", "-B", "/usr/local/bin/hivra-claude-app", "install-run"])

    def test_asking_again_while_a_job_runs_does_not_start_another(self):
        self.fixture.units_active.add("hivra-claude-app-install.service")
        code, printed = self.start()
        self.assertEqual(code, 0)
        self.assertFalse(any(call[:1] == ["/usr/bin/systemd-run"] for call in self.fixture.calls))
        self.assertIn('"installing": true', printed.call_args[0][0])

    # -- the job itself ------------------------------------------------------------------

    def test_first_install_enables_and_restarts_the_supervisor(self):
        with mock.patch.object(app, "installed_version", return_value=None), mock.patch.object(app, "app_running", return_value=False):
            self.assertEqual(self.job(), 0)
        self.assertTrue(app.ENABLED.exists())
        self.assertEqual(app.read_mode(), "app")
        self.assertIn(["/usr/bin/systemctl", "restart", "hivra-claude-app.service"], self.systemctl())

    def test_asking_again_while_current_and_running_does_not_restart_the_app(self):
        app.write_state(app.ENABLED, "x\n")
        with mock.patch.object(app, "installed_version", return_value=GOOD_PIN["version"]), mock.patch.object(app, "app_running", return_value=True):
            self.assertEqual(self.job(), 0)
        self.assertNotIn(["/usr/bin/systemctl", "restart", "hivra-claude-app.service"], self.systemctl())

    def test_a_new_pinned_version_restarts_the_app_once(self):
        app.write_state(app.ENABLED, "x\n")
        with mock.patch.object(app, "installed_version", return_value="1.0.0"), mock.patch.object(app, "app_running", return_value=True):
            self.job()
        self.assertIn(["/usr/bin/systemctl", "restart", "hivra-claude-app.service"], self.systemctl())

    def test_a_failure_is_recorded_for_the_owners_screen(self):
        with mock.patch.object(app, "installed_version", return_value=None), \
             mock.patch.object(app, "unpack", side_effect=RuntimeError("downloaded package does not match the pinned size and SHA-256")):
            self.assertEqual(app.verb_install_run(), 1)
        self.assertIn("does not match the pinned", app.LAST_ERROR.read_text())
        self.assertFalse(app.ENABLED.exists())

    def test_the_job_yields_to_a_writer_that_holds_the_lock(self):
        with app.install_lock(blocking=False) as first:
            self.assertTrue(first)
            with mock.patch.object(app, "unpack") as unpack:
                self.assertEqual(app.verb_install_run(), 0)
            unpack.assert_not_called()
            with app.install_lock(blocking=False) as second:
                self.assertFalse(second)

    def test_remove_stops_a_running_job_and_waits_for_the_lock(self):
        app.write_state(app.ENABLED, "x\n")
        with mock.patch("builtins.print"):
            self.assertEqual(app.verb_remove(), 0)
        commands = self.systemctl()
        self.assertEqual(commands[0], ["/usr/bin/systemctl", "stop", "hivra-claude-app-install.service"])
        self.assertIn(["/usr/bin/systemctl", "disable", "--now", "hivra-claude-app.service"], commands)
        self.assertFalse(app.ENABLED.exists())
        self.assertTrue(any("rm -rf" in command and ".config/Claude" in command for command in self.fixture.commands()))

    def test_status_reports_a_running_job_and_the_last_error(self):
        self.fixture.units_active.add("hivra-claude-app-install.service")
        app.write_state(app.LAST_ERROR, "boom\n")
        status = app.status()
        self.assertTrue(status["installing"])
        self.assertEqual(status["lastError"], "boom")

    # -- files -----------------------------------------------------------------------------

    def test_a_running_app_is_never_left_without_its_files(self):
        """Older version folders are removed only while no app is running."""
        fixture = self.fixture
        package = Path(self.fixture.dir.name) / "pkg.deb"
        package.write_bytes(b"x")
        with mock.patch.object(app, "download", return_value=package), mock.patch.object(app, "app_running", return_value=True):
            app.unpack(GOOD_PIN)
        self.assertFalse(any("rm -rf {}/$old".format(app.APP_ROOT) in command for command in fixture.commands()))
        fixture.calls.clear()
        with mock.patch.object(app, "download", return_value=package), mock.patch.object(app, "app_running", return_value=False):
            app.unpack(GOOD_PIN)
        self.assertTrue(any("rm -rf {}/$old".format(app.APP_ROOT) in command for command in fixture.commands()))

    def test_the_package_is_streamed_in_as_the_desktop_user_never_copied_by_root(self):
        fixture = self.fixture
        package = Path(fixture.dir.name) / "pkg.deb"
        package.write_bytes(b"deb-bytes")
        fixture.respond("test -x", Completed(returncode=1))  # not unpacked yet
        with mock.patch.object(app, "download", return_value=package), mock.patch.object(app, "app_running", return_value=True):
            app.unpack(GOOD_PIN)
        self.assertFalse(any(call[:2] == [app.DOCKER, "cp"] for call in fixture.calls))
        argv, sent = fixture.streams_in[0]
        self.assertEqual(argv[:6], [app.DOCKER, "exec", "-i", "-u", app.DESKTOP_USER, app.CONTAINER])
        self.assertEqual(sent, "deb-bytes")
        self.assertIn(".cache/hivra-claude-app/claude-desktop.deb", " ".join(argv))

    def test_the_download_never_exceeds_the_pinned_size(self):
        fixture = self.fixture

        class Endless:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size): return b"x" * size

        with mock.patch.object(app.urllib.request, "urlopen", return_value=Endless()):
            with self.assertRaises(RuntimeError) as raised:
                app.download({**GOOD_PIN, "bytes": 3 * (1 << 20), "version": "2.26454.0"})
        self.assertIn("larger than the pinned size", str(raised.exception))
        self.assertFalse(any(path.suffix == ".part" for path in app.CACHE.iterdir()))


class SudoersContractTests(unittest.TestCase):
    """The gateway may run exactly these commands as root; the helper must accept
    each of them and nothing broader."""

    def sudoers_commands(self, script: str) -> list[list[str]]:
        text = (ROOT / "provisioner" / script).read_text(encoding="utf-8")
        line = next(item for item in text.splitlines() if "NOPASSWD: /usr/local/bin/hivra-claude-app" in item)
        commands = re.search(r"NOPASSWD:\s*([^\"']+)", line).group(1)
        return [part.strip().split()[1:] for part in commands.split(",")]

    def test_provisioning_and_update_grant_the_same_exact_commands(self):
        provisioning = self.sudoers_commands("provision-claude-code-box.sh")
        update = self.sudoers_commands("hivra-update-guest-runtime.sh")
        self.assertEqual(provisioning, update)
        self.assertEqual(provisioning, [["status"], ["install"], ["mode", "app"], ["mode", "desktop"], ["remove"]])

    def test_every_granted_command_is_accepted_and_nothing_else_is(self):
        with mock.patch.object(os, "geteuid", return_value=0), \
             mock.patch.object(app, "status", return_value={}), \
             mock.patch.object(app, "verb_install", return_value=0), \
             mock.patch.object(app, "verb_mode", return_value=0), \
             mock.patch.object(app, "verb_remove", return_value=0), \
             mock.patch.object(app, "supervise", return_value=0), \
             mock.patch("builtins.print"):
            for args in (["status"], ["install"], ["mode", "app"], ["mode", "desktop"], ["remove"]):
                self.assertEqual(app.main(["x"] + args), 0, args)
            for args in ([], ["status", "extra"], ["install", "--force"], ["mode"], ["mode", "app", "x"], ["restore"], ["snapshot"], ["install-run", "x"]):
                self.assertEqual(app.main(["x"] + args), 2, args)
            # The job's own verb exists, but only root's transient unit runs it.
            with mock.patch.object(app, "verb_install_run", return_value=0):
                self.assertEqual(app.main(["x", "install-run"]), 0)
        for script in ("provision-claude-code-box.sh", "hivra-update-guest-runtime.sh"):
            self.assertNotIn("install-run", [part for command in self.sudoers_commands(script) for part in command])

    def test_the_helper_refuses_to_run_without_root(self):
        with mock.patch.object(os, "geteuid", return_value=1000), mock.patch("builtins.print"):
            self.assertEqual(app.main(["x", "status"]), 2)


class BundleFileTests(unittest.TestCase):
    def test_the_supervisor_unit_is_inert_until_the_app_is_added(self):
        unit = (ROOT / "provisioner" / "hivra-claude-app.service").read_text(encoding="utf-8")
        self.assertIn("ConditionPathExists=/var/lib/hivra/claude-app/enabled", unit)
        self.assertIn("PartOf=hivra-selkies-desktop.service", unit)
        self.assertIn("After=hivra-selkies-desktop.service", unit)
        self.assertIn("ExecStart=/usr/bin/python3 -I -B /usr/local/bin/hivra-claude-app supervise", unit)
        self.assertNotIn("docker", unit.split("ExecStart=")[0].lower().replace("selkies", ""))

    def test_the_helper_adds_no_privilege_to_the_desktop_container(self):
        source = (ROOT / "provisioner" / "hivra-claude-app.py").read_text(encoding="utf-8")
        for forbidden in ("--privileged", "--mount", "--publish", "docker\", \"run", "docker.sock", "--cap-add"):
            self.assertNotIn(forbidden, source)
        self.assertIn('"-u", DESKTOP_USER', source)

    def test_it_never_touches_a_claude_credential(self):
        source = (ROOT / "provisioner" / "hivra-claude-app.py").read_text(encoding="utf-8")
        self.assertNotIn("credentials", source.lower().replace("never reads, stores or transmits a claude credential", ""))
        self.assertNotRegex(source, r"(?i)api[_-]?key|oauth|sessionKey|Bearer")


if __name__ == "__main__":
    unittest.main(verbosity=2)
