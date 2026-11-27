import argparse
import importlib.util
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("kvm_disk", Path(__file__).with_name("kvm-portable-disk.py"))
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)
GENERATION = "a" * 32
BASE = "b" * 64
SNAPSHOT = "c" * 64


class PortableDiskTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.target = Path(scratch.name)
        self.base = self.target / "base.img"
        self.base.write_bytes(b"base")
        self.layer = b"fixture dirty blocks"
        self.digest = disk.hashlib.sha256(self.layer).hexdigest()
        self.manifest = {"version": 1, "generation": GENERATION, "base_sha256": BASE, "virtual_bytes": 1024,
                         "artifacts": {lane: {"name": name, "bytes": len(self.layer), "sha256": self.digest}
                                       for lane, name in disk.FILES.items()}}
        self.fence = self.target / "fence.receipt"
        self.write_fence(datetime.now(UTC) + timedelta(minutes=5))

    def write_fence(self, deadline):
        self.fence.write_text("\n".join(("hivra-kvm-fence-v1", GENERATION + " origin 9343 target 9393",
                                        deadline.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                        BASE, self.digest, "d" * 64, "ssh-ed25519 witness")) + "\n")

    def read_from_storage(self, _restic, _snapshot, path, output, _maximum):
        content = json.dumps(self.manifest).encode() if path.endswith(".json") else self.layer
        output.write(content)
        return len(content), disk.hashlib.sha256(content).hexdigest(), 5

    def test_manifest_rejects_missing_or_traversing_artifacts(self):
        self.manifest["artifacts"]["delta"]["name"] = "../guest.qcow2"
        with self.assertRaises(ValueError):
            disk.validate_manifest(self.manifest, GENERATION)
        del self.manifest["artifacts"]["delta"]
        with self.assertRaises(ValueError):
            disk.validate_manifest(self.manifest, GENERATION)

    def test_fence_refuses_expired_claim(self):
        self.write_fence(datetime.now(UTC) - timedelta(seconds=1))
        with self.assertRaises(ValueError):
            disk.fence_receipt(self.fence, GENERATION)

    def test_restores_to_a_fresh_target_and_emits_exact_boot_receipt(self):
        with (patch.object(disk, "checked_restic"), patch.object(disk, "fetch", side_effect=self.read_from_storage),
              patch.object(disk, "image_info", return_value=1024)):
            result = disk.restore(self.target, self.base, GENERATION, SNAPSHOT, "whole")
        self.assertEqual(result["checkpoint_bytes"], len(self.layer))
        self.assertEqual((self.target / "guest.qcow2").read_bytes(), self.layer)
        self.assertEqual((self.target / "verified-wake.receipt").read_text().splitlines(),
                         ["hivra-kvm-verified-wake-v1", disk.digest_file(self.fence), "whole", self.digest])

    def test_rejects_wrong_base_before_making_the_delta_disk_visible(self):
        with (patch.object(disk, "checked_restic"), patch.object(disk, "fetch", side_effect=self.read_from_storage),
              self.assertRaisesRegex(ValueError, "exact standalone base")):
            disk.restore(self.target, self.base, GENERATION, SNAPSHOT, "delta")
        self.assertFalse((self.target / "guest.qcow2").exists())
        self.assertFalse((self.target / "verified-wake.receipt").exists())

    def test_rejects_modified_disk_without_overwriting_existing_image(self):
        old = self.target / "guest.qcow2"
        old.write_bytes(b"existing destination")
        self.layer = b"corrupt archive"
        with (patch.object(disk, "checked_restic"), patch.object(disk, "fetch", side_effect=self.read_from_storage),
              self.assertRaisesRegex(ValueError, "did not match")):
            disk.restore(self.target, self.base, GENERATION, SNAPSHOT, "whole")
        self.assertEqual(old.read_bytes(), b"existing destination")
        self.assertFalse((self.target / "verified-wake.receipt").exists())

    def test_refuses_storage_credentials_outside_the_exact_qa_namespace(self):
        with patch.dict(os.environ, {"RESTIC_REPOSITORY": "sftp:cold:other-workload"}), self.assertRaises(ValueError):
            disk.checked_restic(GENERATION)

    def test_accepts_empty_proxmox_boot_default_but_not_an_unexpected_boot_route(self):
        fixture = Path(__file__).with_name("kvm-portable-fixture.sh")
        config = self.target / "qm.conf"
        base = [
            "name: fixture", "tags: fixture-tag", "args: fixture-arguments", "smbios1: uuid=fixture-id",
            "vmgenid: fixture-id", "onboot: 0", "memory: 2048", "cores: 2", "cpulimit: 1",
            "cpu: x86-64-v2-AES", "ostype: l26", "bios: seabios", "machine: pc-i440fx-8.1",
        ]
        command = [
            "bash", "-c", """
            source "$1"
            vm=9343 cfg="$2" lxc_cfg="$2.lxc" name=fixture tag=fixture-tag args=fixture-arguments uuid=fixture-id
            check_provision_absent() { :; }
            qm() { cat "$cfg"; }
            check_vm none
            """, "operator-scope-test", fixture, config,
        ]
        for boot, expected in (("boot:  ", 0), ("boot: order=net0", 1)):
            config.write_text("\n".join([*base, boot]) + "\n")
            with self.subTest(boot=boot):
                result = subprocess.run(command, check=False, capture_output=True)
                self.assertEqual(result.returncode, expected, result.stderr.decode())

    @unittest.skipUnless(all(shutil.which(tool) for tool in ("qemu-img", "qemu-io", "restic")),
                         "requires QEMU image tools and Restic")
    def test_real_whole_and_delta_round_trip_preserves_dirty_unchanged_and_zero_blocks(self):
        generation = secrets.token_hex(16)
        root = disk.checkpoint_folder(generation).parent
        root.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, root)
        staging = root / "checkpoint"
        staging.mkdir(mode=0o700)
        base = root / "base.img"
        source = root / "guest.qcow2"
        commands = [
            ["qemu-img", "create", "-q", "-f", "qcow2", base, "8M"],
            ["qemu-io", "-f", "qcow2", "-c", "write -P 0x3a 0 2M", base],
            ["qemu-img", "create", "-q", "-f", "qcow2", "-b", "base.img", "-F", "qcow2", source],
            ["qemu-io", "-f", "qcow2", "-c", "write -z 0 64k", "-c", "write -P 0x7c 4M 1M", source],
        ]
        for command in commands:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        base_sha = disk.digest_file(base)
        fence = root / "fence.receipt"
        deadline = (datetime.now(UTC) + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        fence.write_text("\n".join(("hivra-kvm-fence-v1", f"{generation} origin 9343 target 9393", deadline,
                                    base_sha, disk.digest_file(source), "a" * 64, "ssh-ed25519 synthetic")) + "\n")
        manifest = disk.pack(source, staging, base, argparse.Namespace(id=generation, base_sha256=base_sha))
        self.assertLess(manifest["artifacts"]["delta"]["bytes"], manifest["artifacts"]["whole"]["bytes"])
        password = root / "password"
        password.write_text(secrets.token_hex(32))
        password.chmod(0o600)
        restic = ["restic", "-r", str(root / "restic")]
        with patch.dict(os.environ, {"RESTIC_PASSWORD_FILE": str(password)}), patch.object(disk, "checked_restic", return_value=restic):
            subprocess.run([*restic, "init", "--quiet"], check=True, stdout=subprocess.DEVNULL)
            snapshot = disk.publish(staging, generation)["snapshot"]
            self.assertEqual(disk.publish(staging, generation)["snapshot"], snapshot)
            for lane in ("whole", "delta"):
                destination = root / lane
                destination.mkdir(mode=0o700)
                shutil.copyfile(base, destination / "base.img")
                shutil.copyfile(fence, destination / "fence.receipt")
                disk.restore(destination, destination / "base.img", generation, snapshot, lane)
                subprocess.run(["qemu-img", "compare", "-q", "-f", "qcow2", "-F", "qcow2", source,
                                destination / "guest.qcow2"], check=True)


if __name__ == "__main__":
    unittest.main()
