import dataclasses
import gzip
import hashlib
import importlib.util
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "hivra_gvisor_generation", Path(__file__).with_name("hivra-gvisor-generation.py")
)
generation = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = generation
spec.loader.exec_module(generation)


class RemoteFile:
    def __init__(self, path, mode):
        self.file = path.open("xb" if mode == "wx" else "rb")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.file.close()

    def stat(self):
        return os.fstat(self.file.fileno())

    def read(self, size):
        return self.file.read(size)

    def seek(self, offset):
        return self.file.seek(offset)

    def readv(self, offsets):
        if len(offsets) > 32:
            raise AssertionError("unbounded prefetch")
        for offset, size in offsets:
            self.file.seek(offset)
            yield self.file.read(size)

    def write(self, value):
        self.file.write(value)

    def set_pipelined(self):
        pass


class InProcessSFTP:
    def __init__(self, root):
        self.root = root
        self.events = []
        self.corrupt_temp = False
        self.corrupt_final = False
        self.disconnect_after_rename = False

    def open(self, path, mode):
        self.events.append((mode, path))
        file = self.root / path
        if mode == "rb" and path.endswith(".part") and self.corrupt_temp:
            file.write_bytes(b"incomplete")
        return RemoteFile(file, mode)

    def rename(self, source, target):
        self.events.append(("rename", target))
        (self.root / target).hardlink_to(self.root / source)
        self.remove(source)
        if self.corrupt_final:
            self.corrupt(target)
        if self.disconnect_after_rename:
            raise ConnectionError("rename reply lost")

    def remove(self, path):
        (self.root / path).unlink()

    def corrupt(self, path):
        p = self.root / path
        data = p.read_bytes()
        p.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))


class WorkspaceGenerationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.workspace = self.root / "workspace"
        self.stage = self.root / "stage"
        self.scratch = self.root / "scratch"
        self.remote = self.root / "remote"
        for path in (self.workspace, self.stage, self.scratch, self.remote):
            path.mkdir(mode=0o700)
        (self.remote / "cold").mkdir()
        self.sftp = InProcessSFTP(self.remote)
        self.store = generation.StorageBox(self.sftp, "cold")
        self.identity = generation.GenerationIdentity(
            "a" * 64, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002",
            "save-001", "python:3.13-slim@sha256:" + "b" * 64, "runsc-20260907.0",
        )
        self.key = b"k" * 32
        self.limits = generation.GenerationLimits(8 * 1024 * 1024, 100, 8 * 1024 * 1024)

    def publish(self, identity=None, *, limits=None):
        return generation.publish_generation(
            self.workspace, self.store, identity or self.identity, self.key, limits or self.limits,
            scratch_dir=self.scratch,
        )

    def restore(self, receipt, *, identity=None, key=None, limits=None):
        generation.restore_generation(
            self.stage, self.store, identity or self.identity, self.key if key is None else key, limits or self.limits,
            receipt, scratch_dir=self.scratch, uid=os.getuid(), gid=os.getgid(),
        )

    def test_roundtrip_metadata_and_verified_immutable_publish(self):
        data = b"private-content marker" + os.urandom(2 * generation.CHUNK)
        file = self.workspace / "secret-file"
        file.write_bytes(data)
        file.chmod(0o751)
        mtime = 1_700_000_000_123_456_789
        os.utime(file, ns=(mtime, mtime))
        sub = self.workspace / "sub"
        sub.mkdir(mode=0o751)
        (sub / "relative").symlink_to("../secret-file")
        (sub / "hardlink").hardlink_to(file)
        os.utime(sub, ns=(mtime, mtime))
        with open(os.fsencode(self.workspace) + b"/byte-name-\xff", "wb") as stream:
            stream.write(b"invalid-utf8-filename")

        prior = self.publish()
        receipt = generation.GenerationReceipt.from_dict(prior.to_dict())
        self.assertEqual(receipt, prior)
        self.assertEqual(receipt.entries, 6)
        self.assertEqual(receipt.bytes, len(data) + len(b"invalid-utf8-filename"))
        path = self.remote / "cold" / self.identity.object_name()
        ciphertext = path.read_bytes()
        self.assertNotIn(b"private-content marker", ciphertext)
        self.assertNotIn(b"secret-file", ciphertext)
        self.assertNotIn(self.key, ciphertext)
        self.assertEqual(receipt.sha256, hashlib.sha256(ciphertext).hexdigest())
        self.assertEqual([mode for mode, _ in self.sftp.events], ["rb", "wx", "rb", "rename", "rb"])
        self.assertEqual(self.sftp.events[-1][1], "cold/" + path.name)

        self.assertEqual(self.publish(), receipt)
        newer = dataclasses.replace(self.identity, generation="save-002")
        new_receipt = self.publish(newer)
        self.assertNotEqual(new_receipt.sha256, receipt.sha256)
        self.assertEqual(path.read_bytes(), ciphertext)
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()), sorted([path.name, newer.object_name()]))

        inode = self.stage.stat().st_ino
        self.restore(receipt)
        self.assertEqual(self.stage.stat().st_ino, inode)
        recovered = self.stage / "secret-file"
        self.assertEqual(recovered.read_bytes(), data)
        self.assertEqual(stat.S_IMODE(recovered.stat().st_mode), 0o751)
        self.assertEqual(recovered.stat().st_mtime_ns, mtime)
        self.assertEqual((self.stage / "sub").stat().st_mtime_ns, mtime)
        self.assertEqual((self.stage / "sub/relative").readlink(), Path("../secret-file"))
        self.assertEqual((self.stage / "sub/hardlink").stat().st_ino, recovered.stat().st_ino)
        with open(os.fsencode(self.stage) + b"/byte-name-\xff", "rb") as stream:
            self.assertEqual(stream.read(), b"invalid-utf8-filename")
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_bad_temp_or_final_readback_does_not_issue_receipt_or_remove_prior(self):
        prior = self.publish()
        alternate = dataclasses.replace(self.identity, generation="save-002")
        self.sftp.corrupt_temp = True
        with self.assertRaisesRegex(generation.GenerationError, "size or type"):
            self.publish(alternate)
        prior_path = self.remote / "cold" / self.identity.object_name()
        self.assertEqual(list(prior_path.parent.iterdir()), [prior_path])
        self.sftp.corrupt_temp = False
        self.sftp.corrupt_final = True
        with self.assertRaisesRegex(generation.GenerationError, "digest"):
            self.publish(alternate)
        self.assertEqual(hashlib.sha256(prior_path.read_bytes()).hexdigest(), prior.sha256)
        self.assertEqual(len(list(prior_path.parent.iterdir())), 2)

    def test_receipt_loss_recovers_only_an_authenticated_canonical_generation(self):
        (self.workspace / "payload").write_bytes(b"contents")
        self.sftp.disconnect_after_rename = True
        with self.assertRaises(ConnectionError):
            self.publish()
        self.sftp.disconnect_after_rename = False
        self.sftp.events.clear()
        path = self.remote / "cold" / self.identity.object_name()
        ciphertext = path.read_bytes()
        receipt = self.publish()
        self.assertEqual(receipt.sha256, hashlib.sha256(ciphertext).hexdigest())
        self.assertEqual((receipt.entries, receipt.bytes), (2, len(b"contents")))
        self.assertEqual(self.sftp.events, [("rb", "cold/" + path.name)])
        self.sftp.corrupt("cold/" + path.name)
        corrupted = path.read_bytes()
        self.sftp.events.clear()
        with self.assertRaisesRegex(generation.GenerationError, "authentication"):
            self.publish()
        self.assertEqual(self.sftp.events, [("rb", "cold/" + path.name)])
        self.assertEqual(path.read_bytes(), corrupted)

    def test_every_identity_field_and_key_is_bound_by_aead(self):
        (self.workspace / "payload").write_bytes(b"contents")
        receipt = self.publish()
        original = self.remote / "cold" / self.identity.object_name()
        variations = {
            "owner_hash": "c" * 64,
            "computer_id": "00000000-0000-4000-8000-000000000003",
            "sandbox_id": "00000000-0000-4000-8000-000000000004",
            "generation": "save-002",
            "image": "python:3.13-slim@sha256:" + "e" * 64,
            "runtime": "runsc-20260908.0",
        }
        for field, value in variations.items():
            with self.subTest(field=field):
                identity = dataclasses.replace(self.identity, **{field: value})
                substitute = original.with_name(identity.object_name())
                if substitute != original:
                    substitute.write_bytes(original.read_bytes())
                with self.assertRaisesRegex(generation.GenerationError, "authentication"):
                    self.restore(receipt, identity=identity)
                self.assertEqual(list(self.stage.iterdir()), [])
        with self.assertRaisesRegex(generation.GenerationError, "authentication"):
            self.restore(receipt, key=b"m" * 32)
        with self.assertRaisesRegex(generation.GenerationError, "32-byte"):
            self.restore(receipt, key=b"short")
        self.sftp.corrupt("cold/" + original.name)
        with self.assertRaisesRegex(generation.GenerationError, "digest"):
            self.restore(receipt)
        altered_receipt = dataclasses.replace(receipt, sha256=hashlib.sha256(original.read_bytes()).hexdigest())
        with self.assertRaisesRegex(generation.GenerationError, "authentication"):
            self.restore(altered_receipt)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_source_links_and_special_files_cannot_cross_boundary(self):
        outside = self.root / "outside"
        outside.write_bytes(b"do not read")
        entry = self.workspace / "entry"
        for target in ("../outside", str(outside), "foo/../../outside"):
            with self.subTest(target=target):
                entry.symlink_to(target)
                with self.assertRaisesRegex(generation.GenerationError, "symlink"):
                    self.publish()
                entry.unlink()
        entry.hardlink_to(outside)
        with self.assertRaisesRegex(generation.GenerationError, "hardlink"):
            self.publish()
        entry.unlink()
        os.mkfifo(entry)
        with self.assertRaisesRegex(generation.GenerationError, "unsupported entry"):
            self.publish()
        self.assertTrue(all(mode == "rb" for mode, _ in self.sftp.events))

    def test_source_and_destination_limits_and_existing_stage(self):
        (self.workspace / "payload").write_bytes(b"contents")
        for limits, message in [
            (dataclasses.replace(self.limits, max_bytes=7), "byte limit"),
            (dataclasses.replace(self.limits, max_entries=1), "entry limit"),
            (dataclasses.replace(self.limits, max_ciphertext_bytes=64), "ciphertext limit"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(generation.GenerationError, message):
                self.publish(limits=limits)
        self.assertTrue(all(mode == "rb" for mode, _ in self.sftp.events))
        receipt = self.publish()
        original_events = self.sftp.events[:]
        with self.assertRaisesRegex(generation.GenerationError, "restore limits"):
            self.restore(receipt, limits=dataclasses.replace(self.limits, max_entries=1))
        preserved = self.stage / "preserve"
        preserved.write_bytes(b"do not replace")
        with self.assertRaisesRegex(generation.GenerationError, "not empty"):
            self.restore(receipt)
        self.assertEqual(preserved.read_bytes(), b"do not replace")
        self.assertEqual(self.sftp.events, original_events)

    def test_authenticated_unsafe_or_malformed_generations_discard_partial_extraction(self):
        regular = {"type": "file", "path": "first", "mode": 0o600, "mtime": 0, "size": 1}
        cases = [
            ({**regular, "path": "../outside"}, "path"),
            ({**regular, "path": "/outside"}, "path"),
            (regular, "duplicate"),
            ({"type": "hardlink", "path": "unsafe", "target": "../outside"}, "path"),
            ({"type": "hardlink", "path": "unsafe", "target": "future"}, "regular file"),
            ({"type": "file", "path": "first/child", "mode": 0o600, "mtime": 0, "size": 0}, "destination"),
            ({"type": "symlink", "path": "unsafe", "target": "/", "mode": 0o777, "mtime": 0}, "symlink"),
            ({"type": "directory", "path": "unsafe", "mode": 0o4755, "mtime": 0}, "metadata"),
            ({"type": "fifo", "path": "unsafe"}, "Unsupported"),
            ({"type": "manifest", "entries": 2, "bytes": 2}, "manifest"),
        ]
        stage_inode = self.stage.stat().st_ino
        path = self.remote / "cold" / self.identity.object_name()
        for bad_record, message in cases:
            with self.subTest(bad_record=bad_record):
                with path.open("wb") as stream:
                    writer = generation.EncryptedWriter(stream, self.identity, self.key, self.limits.max_ciphertext_bytes)
                    with gzip.GzipFile(fileobj=writer, mode="wb", mtime=0) as archive:
                        generation.write_record(archive, {"type": "directory", "path": "", "mode": 0o755, "mtime": 0})
                        generation.write_record(archive, regular)
                        archive.write(b"x")
                        generation.write_record(archive, bad_record)
                    receipt = writer.finish(3, 1)
                with self.assertRaisesRegex(generation.GenerationError, message):
                    self.restore(receipt)
                self.assertEqual(self.stage.stat().st_ino, stage_inode)
                self.assertEqual(stat.S_IMODE(self.stage.stat().st_mode), 0o700)
                self.assertEqual(list(self.stage.iterdir()), [])
                self.assertFalse((self.root / "outside").exists())

    def test_sftp_rejects_paths_and_oversized_reads(self):
        for directory in ("/", "../elsewhere", "safe/./cold", "safe\\cold"):
            with self.subTest(directory=directory), self.assertRaises(generation.GenerationError):
                generation.StorageBox(self.sftp, directory)
        with self.assertRaisesRegex(generation.GenerationError, "object name"):
            self.store.download("../escape", None, None)
        receipt = self.publish()
        remote = self.remote / "cold" / self.identity.object_name()
        with remote.open("ab") as stream:
            stream.write(b"unexpected bytes")
        with self.assertRaisesRegex(generation.GenerationError, "size or type"):
            self.restore(receipt)
        self.assertEqual(list(self.stage.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
