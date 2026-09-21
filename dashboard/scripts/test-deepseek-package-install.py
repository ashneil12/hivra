"""Root-only Linux filesystem tests, entirely inside an owned /root temporary dir.

No real npm, services or existing guests are modified. CI runs this with sudo;
local acceptance runs it in the existing disposable read-only Linux container.
"""
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "provisioner/deepseek-harness"
spec = importlib.util.spec_from_file_location("native_install", SOURCE / "install-native.py")
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0, "requires disposable Linux root fixture")
class PackageInstall(unittest.TestCase):
    def setUp(self):
        # Hosted CI makes /opt runner-writable. Use the root-owned fixture
        # parent rather than weakening production ancestry checks or chmodding
        # the runner's shared directories to make this test pass.
        guest.ancestors(Path("/root"))
        self.temporary = tempfile.TemporaryDirectory(prefix="hivra-native-test-", dir="/root")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "runtime"
        self.patcher = patch.object(guest, "RUNTIME", self.target)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def populate(self, package, *_):
        previous = os.umask(0o022)  # npm's explicit child umask, not the worker's.
        try:
            self.populate_files(package)
        finally:
            os.umask(previous)

    def populate_files(self, package):
        dependency = package / "node_modules/@deepseek-ai/dsh"
        dependency.mkdir(parents=True)
        (dependency / "package.json").write_text(json.dumps({"name": "@deepseek-ai/dsh", "version": guest.VERSION}))
        (dependency / "cli.js").write_text("synthetic executable fixture\n")
        binaries = package / "node_modules/.bin"
        binaries.mkdir()
        (binaries / "dsh").symlink_to("../@deepseek-ai/dsh/cli.js")
        helper = package / guest.HELPER
        helper.parent.mkdir(parents=True)
        helper.write_bytes(b"synthetic native helper - never executed\n")

    def install(self):
        with patch.object(guest, "npm_install", side_effect=self.populate) as install:
            value = guest.install_package(SOURCE)
        install.assert_called_once()
        return value

    def test_publish_reuse_byte_inventory_and_reviewed_helper_mode(self):
        value = self.install()
        self.assertEqual(value["version"], guest.VERSION)
        self.assertTrue(value["helper"]["present"])
        self.assertEqual(stat.S_IMODE((self.target / guest.HELPER).stat().st_mode), 0o755)
        self.assertEqual(value["tree"], guest.tree_digest(self.target))
        with patch.object(guest, "npm_install", side_effect=AssertionError("must not reinstall")):
            self.assertEqual(guest.install_package(SOURCE), value)
        self.assertEqual(list(self.root.glob(".deepseek-install-*")), [])

    def test_provider_worker_private_umask_does_not_make_runtime_unreadable(self):
        previous = os.umask(0o077)
        try:
            self.install()
            self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o755)
        finally:
            os.umask(previous)

    def test_recipe_change_rejects_before_npm_and_preserves_existing_target(self):
        source = self.root / "bad-recipe"
        source.mkdir()
        for name, raw in guest.recipe(SOURCE).items():
            (source / name).write_bytes(raw + b" ")
        self.target.mkdir()
        (self.target / "custom").write_text("keep me")
        with patch.object(guest, "npm_install") as install, self.assertRaisesRegex(guest.InstallError, "recipe pin mismatch"):
            guest.install_package(source)
        install.assert_not_called()
        self.assertEqual((self.target / "custom").read_text(), "keep me")

    def test_tampered_installed_bytes_fail_without_reinstall_or_removal(self):
        self.install()
        target = self.target / "node_modules/@deepseek-ai/dsh/cli.js"
        target.write_text("custom modified code")
        with patch.object(guest, "npm_install") as install, self.assertRaises(guest.InstallError):
            guest.install_package(SOURCE)
        install.assert_not_called()
        self.assertEqual(target.read_text(), "custom modified code")

    def test_receipt_helper_claims_are_recomputed_without_chmod_or_reinstall(self):
        value = self.install()
        for helper in (None, {"path": guest.HELPER, "present": False}, {**value["helper"], "sha256": "0" * 64}):
            with self.subTest(helper=helper):
                (self.target / guest.RECEIPT).write_bytes(guest.canonical({**value, "helper": helper}))
                with patch.object(guest, "npm_install") as install, patch.object(guest, "repair_helper") as repair, self.assertRaises(guest.InstallError):
                    guest.install_package(SOURCE)
                install.assert_not_called()
                repair.assert_not_called()

    def test_conflicting_destination_is_not_overwritten(self):
        self.target.mkdir()
        (self.target / "custom").write_text("preserve")
        with patch.object(guest, "npm_install") as install, self.assertRaises(FileNotFoundError):
            guest.install_package(SOURCE)
        install.assert_not_called()
        self.assertEqual((self.target / "custom").read_text(), "preserve")

    def test_failed_npm_cleans_only_its_temporary_directory(self):
        unrelated = self.root / "unrelated"
        unrelated.write_text("preserve")
        with patch.object(guest, "npm_install", side_effect=guest.InstallError("fixture failure")), self.assertRaises(guest.InstallError):
            guest.install_package(SOURCE)
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.root.glob(".deepseek-install-*")), [])
        self.assertEqual(unrelated.read_text(), "preserve")

    def test_writable_install_parent_fails_before_npm_or_staging(self):
        self.root.chmod(0o777)
        try:
            with patch.object(guest, "npm_install") as install, self.assertRaisesRegex(guest.InstallError, "unsafe directory"):
                guest.install_package(SOURCE)
            install.assert_not_called()
            self.assertEqual(list(self.root.iterdir()), [])
        finally:
            self.root.chmod(0o700)

    def test_publish_collision_keeps_custom_destination(self):
        real_publish = guest.publish
        def collision(source, target):
            target.mkdir()
            (target / "custom").write_text("preserve")
            return real_publish(source, target)
        with patch.object(guest, "npm_install", side_effect=self.populate), patch.object(guest, "publish", side_effect=collision), self.assertRaises(FileExistsError):
            guest.install_package(SOURCE)
        self.assertEqual((self.target / "custom").read_text(), "preserve")
        self.assertEqual(list(self.root.glob(".deepseek-install-*")), [])

    def test_symlink_hardlink_and_fifo_are_rejected_before_chmod(self):
        outside = self.root / "outside"
        outside.write_bytes(b"preserve")
        outside.chmod(0o600)
        for kind in ("symlink", "hardlink", "fifo", "writable"):
            with self.subTest(kind=kind):
                package = self.root / kind
                package.mkdir(mode=0o755)
                helper = package / guest.HELPER
                helper.parent.mkdir(parents=True)
                if kind == "symlink":
                    helper.symlink_to(outside)
                elif kind == "hardlink":
                    os.link(outside, helper)
                elif kind == "fifo":
                    os.mkfifo(helper)
                else:
                    helper.write_bytes(b"synthetic")
                    helper.chmod(0o666)
                with self.assertRaises((guest.InstallError, OSError)):
                    guest.repair_helper(package)
                self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o600)
                self.assertEqual(outside.read_bytes(), b"preserve")

    def test_tree_links_cannot_escape_and_directories_cannot_be_agent_writable(self):
        self.install()
        link = self.target / "node_modules/.bin/dsh"
        link.unlink()
        link.symlink_to("/etc/passwd")
        with self.assertRaisesRegex(guest.InstallError, "link escape"):
            guest.tree_digest(self.target)
        link.unlink()
        (self.target / "node_modules").chmod(0o777)
        with self.assertRaises(guest.InstallError):
            guest.tree_digest(self.target)

    def test_npm_has_clean_environment_no_hooks_no_shell_and_bounded_deadline(self):
        user_config = self.root / "empty-user-npmrc"
        global_config = self.root / "empty-global-npmrc"
        with patch.object(guest, "ancestors"), patch.object(guest, "read_regular"), \
             patch.object(Path, "resolve", return_value=Path("/usr/bin/fixture-npm")), \
             patch.object(guest.subprocess, "run", return_value=Mock(returncode=0)) as run:
            guest.npm_install(self.root, self.root / "home", user_config, global_config)
        argv = run.call_args.args[0]
        self.assertEqual(argv[:3], ["/usr/bin/npm", "ci", "--ignore-scripts"])
        self.assertNotIn("--omit=optional", argv)
        self.assertIn("--userconfig=" + str(user_config), argv)
        self.assertIn("--globalconfig=" + str(global_config), argv)
        self.assertNotEqual(user_config, global_config)
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": str(self.root / "home"), "LANG": "C.UTF-8"})
        self.assertEqual(run.call_args.kwargs["timeout"], 600)
        self.assertEqual(run.call_args.kwargs["umask"], 0o022)
        self.assertNotIn("shell", run.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
