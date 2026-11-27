import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PROVISIONER = ROOT / "provisioner"
spec = importlib.util.spec_from_file_location("bux", PROVISIONER / "hivra-bux-bake.py")
bux = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bux)


class BuxBake(unittest.TestCase):
    def test_locked_stock_and_upstream_pins(self):
        lock = json.loads(bux.LOCK.read_bytes())
        source = (PROVISIONER / "provision-claude-code-box.sh").read_text()
        self.assertIn(lock["buxRef"], source)
        self.assertIn(lock["baseImageSha256"], (ROOT / "scripts/ubuntu-qga-bake-pins.env").read_text())
        names = [asset["name"] for asset in lock["assets"]]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(asset["url"].startswith("https://") for asset in lock["assets"]))
        self.assertTrue({"nodejs", "gh", "at", "qemu-guest-agent"}.issubset(lock["packages"]))
        self.assertFalse({"claude", "codex", "npm", "google-chrome-stable", "docker.io"} & lock["packages"].keys())

    def test_bypass_requires_exact_bytes_and_does_not_touch_tenant_setup(self):
        lines = [f"# line {index}\n".encode() for index in range(1, 700)]
        original = b"".join(lines)
        lock = {"installerSha256": hashlib.sha256(original).hexdigest()}
        with tempfile.TemporaryDirectory() as tmp:
            installer = Path(tmp) / "install.sh"
            tampered = b"# changed\n" + original
            installer.write_bytes(tampered)
            with self.assertRaisesRegex(ValueError, "exact reviewed"):
                bux.patch_installer(lock, installer)
            self.assertEqual(installer.read_bytes(), tampered)
            installer.write_bytes(original)
            bux.patch_installer(lock, installer)
            self.assertEqual(installer.read_bytes(), b"".join(
                lines[:93] + lines[103:118] + lines[130:164] + lines[179:]))

    def test_receipt_absence_and_mismatch_fail_before_package_reuse(self):
        lock = json.loads(bux.LOCK.read_bytes())
        args = ["bux", "verify", lock["buxRef"], lock["packages"]["gh"]]
        with tempfile.TemporaryDirectory() as tmp, patch.object(bux, "MARKER", Path(tmp) / "receipt"), \
                patch.object(bux, "safe_root_path"), patch.object(bux, "check_dependencies") as check, \
                patch.object(bux.subprocess, "run"), patch.object(bux.sys, "argv", args):
            with self.assertRaises(FileNotFoundError):
                bux.main()
            bux.MARKER.write_bytes(b"{}\n")
            with self.assertRaisesRegex(ValueError, "dependency lock"):
                bux.main()
            check.assert_not_called()
            bux.MARKER.write_bytes(bux.marker(lock))
            bux.main()
            check.assert_called_once_with(lock)

    def test_package_drift_and_payload_tampering_fail_even_with_matching_version(self):
        lock = {"packages": {"nodejs": "24.22.3"}}
        with patch.object(bux.subprocess, "check_output", return_value="nodejs removed 24.22.3\n"):
            with self.assertRaisesRegex(ValueError, "versions"):
                bux.check_dependencies(lock)
        with patch.object(bux.subprocess, "check_output", side_effect=[
            "nodejs installed 24.22.3\n", "??5??????   /usr/bin/node\n"
        ]):
            with self.assertRaisesRegex(ValueError, "missing or changed"):
                bux.check_dependencies(lock)

    def test_base_package_calls_are_skipped_only_after_verification(self):
        source = (PROVISIONER / "provision-claude-code-box.sh").read_text()
        left = source.index('if [ "$HERMES_BAKED" = 1 ]; then\n  verify_hermes_bake')
        right = source.index('\nok "base packages present"', left)
        section = source[left:right]
        guard_start = source.index('BUX_BAKED="${HIVRA_BUX_DEPENDENCIES_BAKED:-0}"')
        guard = source[guard_start:source.index("uses_standalone_access_base()", guard_start)]
        for mode, browser, invalid, retained, expected in [
            (0, 0, 0, 0, ["apt:update", "apt:install", "apt:install", "systemctl"]),
            (1, 0, 0, 0, ["verify", "systemctl"]),
            (1, 1, 0, 0, []),
            (1, 0, 1, 0, ["verify", "baked bux dependency verification failed"]),
            (1, 0, 0, 1, ["baked bux dependencies require a fresh tenant"]),
        ]:
            with self.subTest(mode=mode, browser=browser, invalid=invalid, retained=retained):
                with tempfile.TemporaryDirectory() as tmp:
                    home = Path(tmp) / "bux"
                    if retained:
                        home.mkdir()
                    wrapped = f"""
set -euo pipefail
HERMES_BAKED=0 HIVRA_BUX_DEPENDENCIES_BAKED={mode} HIVRA_WANT_BROWSER={browser} COMPUTER_SUBSTRATE=proxmox-kvm AGENT_KIND=claude
BUX_DIR={tmp}/checkout AGENT_HOME={home} AGENT_USER=bux SRC_DIR=fixture BUX_REF=fixture GH_VERSION=2.98.0
apt_get() {{ printf 'apt:%s\\n' "$1"; }}
python3() {{ printf '%s\\n' verify; return {invalid}; }}
systemctl() {{ printf '%s\\n' systemctl; }}
id() {{ return 1; }}
ok() {{ :; }}
die() {{ printf '%s\\n' "$*"; exit 1; }}
{guard}
{section}
"""
                    proc = subprocess.run(["/bin/bash", "-c", wrapped], capture_output=True, text=True)
                    self.assertEqual(proc.stdout.splitlines(), expected)
                    if mode and browser:
                        self.assertIn("unsupported baked bux dependency profile", proc.stderr)
                    self.assertEqual(proc.returncode, int(bool(invalid or retained or (mode and browser))))


if __name__ == "__main__":
    unittest.main()
