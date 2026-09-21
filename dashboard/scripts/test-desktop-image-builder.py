#!/usr/bin/env python3
"""Local candidate-artifact checks; no real Docker daemon or guest mutation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class CandidateBuilderTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("candidate_builder", Path(__file__).with_name("build-desktop-image.py"))
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)

    def test_candidate_is_source_built_saved_privately_and_never_published(self):
        with tempfile.TemporaryDirectory() as parent:
            output = Path(parent) / "candidate"
            identity = {"runtimeImageId": "sha256:" + "b" * 64}
            def save(image_id, stream):
                stream.write(b"synthetic-image-archive")
                stream.flush()
            with patch.object(self.builder.guest, "run") as run, \
                    patch.object(self.builder, "save_archive", side_effect=save) as export, \
                    patch.object(self.builder.guest, "build_identity_image", return_value=identity) as build:
                result = self.builder.build_candidate(1001, 1001, output)
            build.assert_called_once_with(1001, 1001)
            self.assertEqual([call.args[0][:3] for call in run.call_args_list],
                             [["/usr/bin/docker", "pull", self.builder.guest.IMAGE]])
            self.assertEqual(export.call_args.args[0], identity["runtimeImageId"])
            self.assertEqual(result["status"], "candidate-not-approved")
            self.assertEqual(result["installerSourceSha256"], hashlib.sha256(self.builder.SOURCE_BYTES).hexdigest())
            self.assertEqual(result["archive"]["sha256"], hashlib.sha256(b"synthetic-image-archive").hexdigest())
            self.assertEqual(json.loads((output / "candidate.json").read_text()), result)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            for file in ("desktop-image.tar", "candidate.json"):
                self.assertEqual((output / file).stat().st_mode & 0o777, 0o600)

    def test_existing_output_is_never_overwritten_or_used(self):
        with tempfile.TemporaryDirectory() as parent, patch.object(self.builder.guest, "run") as run:
            with self.assertRaises(FileExistsError):
                self.builder.build_candidate(1001, 1001, Path(parent))
            run.assert_not_called()

    def test_failed_build_has_no_candidate_receipt(self):
        with tempfile.TemporaryDirectory() as parent, patch.object(self.builder.guest, "run"), \
                patch.object(self.builder.guest, "build_identity_image", side_effect=RuntimeError("failed")):
            output = Path(parent) / "candidate"
            with self.assertRaises(RuntimeError):
                self.builder.build_candidate(1001, 1001, output)
            self.assertTrue(output.is_dir())
            self.assertFalse((output / "candidate.json").exists())

    def test_invalid_identity_precedes_output_and_docker_mutations(self):
        for uid, gid in ((0, 1001), (1001, 0), (True, 1001), (60001, 1001)):
            with self.subTest(uid=uid, gid=gid), tempfile.TemporaryDirectory() as parent, \
                    patch.object(self.builder.guest, "run") as run:
                output = Path(parent) / "candidate"
                with self.assertRaises(RuntimeError):
                    self.builder.build_candidate(uid, gid, output)
                self.assertFalse(output.exists())
                run.assert_not_called()

    def test_empty_archive_cannot_produce_a_receipt(self):
        with tempfile.TemporaryDirectory() as parent, patch.object(self.builder.guest, "run"), \
                patch.object(self.builder, "save_archive"), \
                patch.object(self.builder.guest, "build_identity_image", return_value={"runtimeImageId": "sha256:" + "b" * 64}):
            output = Path(parent) / "candidate"
            with self.assertRaisesRegex(RuntimeError, "desktop_candidate_archive_invalid"):
                self.builder.build_candidate(1001, 1001, output)
            self.assertFalse((output / "candidate.json").exists())

    def test_replacement_during_build_or_export_preserves_foreign_files(self):
        for phase in ("build", "export"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as parent:
                output = Path(parent) / "candidate"
                original = Path(parent) / "original"
                def replace():
                    output.rename(original)
                    output.mkdir()
                    (output / "desktop-image.tar").write_bytes(b"foreign")
                def build(uid, gid):
                    if phase == "build":
                        replace()
                    return {"runtimeImageId": "sha256:" + "b" * 64}
                def save(image_id, stream):
                    replace()
                    stream.write(b"owned")
                    stream.flush()
                with patch.object(self.builder.guest, "run"), \
                        patch.object(self.builder.guest, "build_identity_image", side_effect=build), \
                        patch.object(self.builder, "save_archive", side_effect=save):
                    with self.assertRaisesRegex(RuntimeError, "desktop_candidate_output_replaced"):
                        self.builder.build_candidate(1001, 1001, output)
                self.assertEqual((output / "desktop-image.tar").read_bytes(), b"foreign")
                self.assertFalse((output / "candidate.json").exists())
                self.assertFalse((original / "candidate.json").exists())

    def test_export_uses_stdout_not_an_overwrite_path(self):
        with tempfile.TemporaryFile() as stream, patch.object(self.builder.subprocess, "run") as run:
            self.builder.save_archive("sha256:" + "b" * 64, stream)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/docker", "image", "save", "sha256:" + "b" * 64])
            self.assertIs(run.call_args.kwargs["stdout"], stream)
            self.assertEqual(run.call_args.kwargs["timeout"], 900)

    def test_replaced_archive_cannot_issue_false_receipt(self):
        with tempfile.TemporaryDirectory() as parent:
            output = Path(parent) / "candidate"
            def save(image_id, stream):
                (output / "desktop-image.tar").unlink()
                (output / "desktop-image.tar").write_bytes(b"foreign")
                stream.write(b"owned")
                stream.flush()
            with patch.object(self.builder.guest, "run"), \
                    patch.object(self.builder.guest, "build_identity_image", return_value={"runtimeImageId": "sha256:" + "b" * 64}), \
                    patch.object(self.builder, "save_archive", side_effect=save):
                with self.assertRaisesRegex(RuntimeError, "desktop_candidate_archive_replaced"):
                    self.builder.build_candidate(1001, 1001, output)
            self.assertEqual((output / "desktop-image.tar").read_bytes(), b"foreign")
            self.assertFalse((output / "candidate.json").exists())


if __name__ == "__main__":
    unittest.main()
