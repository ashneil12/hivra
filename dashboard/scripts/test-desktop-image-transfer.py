#!/usr/bin/env python3
"""Local host-transfer and shared cache-path fault tests; no SSH or Docker."""
import hashlib
import importlib.util
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent / "provisioner"
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
host = module("image_transfer", ROOT / "hivra-copy-desktop-image.py")
guest = module("image_admission", ROOT / "remote-desktop/install-guest.py")


class ImageTransferTest(unittest.TestCase):
    def test_transfer_keeps_verified_fd_when_path_is_replaced(self):
        data = b"reviewed archive"
        with tempfile.TemporaryDirectory() as root:
            cache = Path(root) / "cache"
            cache.mkdir()
            archive = cache / "archive.tar"
            archive.write_bytes(data)
            observed = []
            def send(command, **kwargs):
                cache.rename(Path(root) / "original")
                cache.mkdir()
                (cache / "archive.tar").write_bytes(b"foreign private bytes")
                observed.append(kwargs["stdin"].read())
                return SimpleNamespace(returncode=0)
            with patch.object(host, "open_archive", return_value=archive.open("rb")), \
                    patch.object(host, "ARCHIVE_SHA256", hashlib.sha256(data).hexdigest()), \
                    patch.object(host, "ARCHIVE_BYTES", len(data)), \
                    patch.object(host.subprocess, "run", side_effect=send):
                self.assertTrue(host.copy_image(cache, ["ssh", "fixture"]))
            self.assertEqual(observed, [data])
            self.assertEqual((cache / "archive.tar").read_bytes(), b"foreign private bytes")

    def test_bad_hash_never_reaches_ssh(self):
        with tempfile.TemporaryFile() as stream:
            stream.write(b"foreign")
            stream.seek(0)
            with patch.object(host, "open_archive", return_value=stream), patch.object(host.subprocess, "run") as ssh:
                with self.assertRaisesRegex(RuntimeError, "archive_mismatch"):
                    host.copy_image(Path("/cache"), ["ssh", "fixture"])
                ssh.assert_not_called()

    def test_missing_cache_does_not_connect(self):
        with patch.object(host, "open_archive", return_value=None), patch.object(host.subprocess, "run") as ssh:
            self.assertFalse(host.copy_image(Path("/cache"), ["ssh", "fixture"]))
            ssh.assert_not_called()

    def test_host_and_guest_pins_agree(self):
        self.assertEqual(host.ARCHIVE_SHA256, guest.PREPARED_IMAGE["archiveSha256"])
        self.assertEqual(host.ARCHIVE_BYTES, guest.PREPARED_IMAGE["archiveBytes"])
        source = (ROOT / "hivra-provision-on-host.sh").read_text()
        self.assertIn(host.ARCHIVE_SHA256, source)
        self.assertIn('"${PROV_DIR}.desktop-images"', source)
        self.assertTrue('conv=excl' in source)

    @unittest.skipUnless(sys.platform.startswith("linux"), "The guest uses GNU dd on Linux")
    def test_real_guest_writer_creates_exclusively_without_overwrite(self):
        source = (ROOT / "hivra-provision-on-host.sh").read_text()
        lines = [line for line in source.splitlines() if line.startswith("/bin/dd of=/var/cache/hivra/desktop-images/")]
        self.assertEqual(len(lines), 1)
        command = shlex.split(lines[0])
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "archive.tar"
            command[1] = "of=" + str(archive)
            def write(data):
                return subprocess.run(command, input=data, capture_output=True, timeout=5, umask=0o077)
            created = write(b"reviewed archive")
            self.assertEqual(created.returncode, 0, created.stderr.decode())
            self.assertEqual(archive.read_bytes(), b"reviewed archive")
            self.assertEqual(stat.S_IMODE(archive.stat().st_mode), 0o600)
            self.assertNotEqual(write(b"replacement").returncode, 0)
            self.assertEqual(archive.read_bytes(), b"reviewed archive")
            archive.unlink()
            private = Path(root) / "private"
            private.write_bytes(b"preserved")
            archive.symlink_to(private)
            self.assertNotEqual(write(b"replacement").returncode, 0)
            self.assertEqual(private.read_bytes(), b"preserved")

    def test_real_fd_cache_walk_rejects_unsafe_entries_for_host_and_guest(self):
        for target in (host, guest):
            for fault in ("none", "missing", "parent_mode", "parent_symlink", "file_symlink", "file_mode", "file_owner", "fifo"):
                with self.subTest(target=target.__name__, fault=fault), tempfile.TemporaryDirectory() as root:
                    root = Path(root)
                    cache = root / "cache"
                    cache.mkdir(mode=0o700)
                    filename = host.ARCHIVE_SHA256 + ".tar"
                    archive = cache / filename
                    archive.write_bytes(b"fixture")
                    archive.chmod(0o600)
                    if fault == "missing": archive.unlink()
                    if fault == "parent_mode": cache.chmod(0o777)
                    if fault == "parent_symlink":
                        cache.rename(root / "other")
                        cache.symlink_to(root / "other", target_is_directory=True)
                    if fault in ("file_symlink", "fifo"):
                        archive.unlink()
                        if fault == "file_symlink": archive.symlink_to(root / "private")
                        else: os.mkfifo(archive, 0o600)
                    if fault == "file_mode": archive.chmod(0o666)
                    real_open, real_stat = os.open, os.fstat
                    def opened(path, flags, *args, **kwargs):
                        return real_open(str(root) if path == "/" else path, flags, *args, **kwargs)
                    def inspected(fd):
                        info = real_stat(fd)
                        fields = {name: getattr(info, name) for name in ("st_mode", "st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")}
                        fields["st_uid"] = 1001 if fault == "file_owner" and stat.S_ISREG(info.st_mode) else 0
                        return SimpleNamespace(**fields)
                    with patch.object(os, "open", side_effect=opened), patch.object(os, "fstat", side_effect=inspected), \
                            patch.object(guest, "PREPARED_IMAGE_DIRECTORY", Path("/cache")):
                        def call():
                            return target.open_archive(Path("/cache")) if target is host else target.open_prepared_image_archive()
                        if fault == "none":
                            with call() as stream: self.assertEqual(stream.read(), b"fixture")
                        elif fault == "missing": self.assertIsNone(call())
                        else:
                            with self.assertRaises((OSError, RuntimeError)): call()


if __name__ == "__main__":
    unittest.main()
