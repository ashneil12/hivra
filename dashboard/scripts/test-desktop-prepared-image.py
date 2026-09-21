#!/usr/bin/env python3
"""Prepared-image admission regressions; no Docker or live mutation."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent / "provisioner/remote-desktop/install-guest.py"
spec = importlib.util.spec_from_file_location("prepared_guest", SOURCE)
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class PreparedImageTest(unittest.TestCase):
    def setUp(self):
        self.payload = b"synthetic reviewed archive"
        self.approval = {**guest.PREPARED_IMAGE, "archiveBytes": len(self.payload),
                         "archiveSha256": hashlib.sha256(self.payload).hexdigest()}
        config = {"User": "1000", "Entrypoint": guest.BASE_IMAGE_ENTRYPOINT,
                  "Cmd": None, "WorkingDir": "/home/ubuntu", "Volumes": None,
                  "Labels": {"base-label": "preserved"}, "Env": ["BASE=value"]}
        self.base = {"Id": self.approval["baseImageId"], "Os": "linux", "Architecture": "amd64",
                     "Config": config, "RepoDigests": [guest.IMAGE],
                     "RootFS": {"Type": "layers", "Layers": ["sha256:" + "a" * 64]}}
        self.derived = copy.deepcopy(self.base)
        self.derived["Id"] = self.approval["configDigest"]
        self.derived["Config"]["User"] = "ubuntu"
        self.derived["RootFS"]["Layers"].append("sha256:" + "b" * 64)
        values = {"base-index-digest": guest.IMAGE_INDEX_DIGEST, "base-image-id": self.base["Id"],
                  "identity-recipe-sha256": self.approval["recipeSha256"], "desktop-user": "ubuntu",
                  "desktop-uid": "1001", "desktop-gid": "1001"}
        self.derived["Config"]["Labels"].update({guest.DERIVED_IMAGE_LABEL_PREFIX + "." + k: v for k, v in values.items()})

    def exercise(self, payload=None, load_error=None, inventory=None):
        archive = tempfile.TemporaryFile()
        archive.write(self.payload if payload is None else payload)
        archive.seek(0)
        with patch.object(guest, "PREPARED_IMAGE", self.approval), \
                patch.object(guest, "open_prepared_image_archive", return_value=archive), \
                patch.object(guest, "inspect_image", side_effect=[self.base, self.derived]) as inspect, \
                patch.object(guest, "run", side_effect=inventory,
                             return_value=SimpleNamespace(stdout=self.derived["Id"] + "\n")) as listing, \
                patch.object(guest.subprocess, "run", return_value=SimpleNamespace(returncode=0), side_effect=load_error) as load, \
                patch.object(guest, "build_identity_image", return_value={"source": True}) as source:
            self.last_load, self.last_source, self.last_inspect = load, source, inspect
            self.last_listing = listing
            result = guest.resolve_identity_image(1001, 1001)
            return result, load, source

    def test_untagged_import_hidden_by_default_listing_is_found(self):
        # Observed on Ubuntu Docker 29's containerd image store: load succeeds,
        # exact manifest inspection works, but only --all lists this image.
        self.derived["Id"] = self.approval["manifestDigest"]

        def inventory(command, **kwargs):
            visible = [self.base["Id"]]
            if "--all" in command:
                visible.append(self.derived["Id"])
            return SimpleNamespace(stdout="\n".join(visible) + "\n")

        result, _, source = self.exercise(inventory=inventory)
        self.assertEqual(result["runtimeImageId"], self.approval["manifestDigest"])
        source.assert_not_called()
        self.assertEqual(self.last_inspect.call_args.args[0], self.approval["manifestDigest"])

    def test_successful_load_without_pinned_inventory_entry_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "identity_missing"):
            self.exercise(inventory=lambda *args, **kwargs: SimpleNamespace(stdout=""))
        self.last_source.assert_not_called()

    def test_matching_labels_cannot_admit_foreign_inspected_id(self):
        self.derived["Id"] = "sha256:" + "c" * 64
        with self.assertRaisesRegex(RuntimeError, "identity_mismatch"):
            self.exercise(inventory=lambda *args, **kwargs:
                          SimpleNamespace(stdout=self.approval["manifestDigest"] + "\n"))
        self.last_source.assert_not_called()

    def test_reviewed_archive_accepts_both_observed_engine_id_forms(self):
        for identity in (self.approval["configDigest"], self.approval["manifestDigest"]):
            with self.subTest(identity=identity):
                self.derived["Id"] = identity
                result, load, source = self.exercise()
                self.assertEqual(result["runtimeImageId"], identity)
                self.assertEqual(result["baseImageId"], self.base["Id"])
                source.assert_not_called()
                self.assertEqual(load.call_args.args[0], ["/usr/bin/docker", "image", "load"])
                self.assertIsNotNone(load.call_args.kwargs["stdin"])
                self.assertEqual(self.last_inspect.call_args.args[0], identity)

    def test_missing_archive_keeps_source_path(self):
        with patch.object(guest, "open_prepared_image_archive", return_value=None), \
                patch.object(guest, "build_identity_image", return_value={"source": True}) as source:
            self.assertEqual(guest.resolve_identity_image(1001, 1001), {"source": True})
            source.assert_called_once_with(1001, 1001)

    def test_other_identity_does_not_even_open_archive(self):
        with patch.object(guest, "open_prepared_image_archive") as archive, \
                patch.object(guest, "build_identity_image", return_value={"source": True}):
            self.assertEqual(guest.resolve_identity_image(1002, 1002), {"source": True})
            archive.assert_not_called()

    def test_recipe_change_uses_source_instead_of_old_artifact(self):
        with patch.object(guest, "identity_image_recipe", return_value="changed"), \
                patch.object(guest, "open_prepared_image_archive") as archive, \
                patch.object(guest, "build_identity_image", return_value={"source": True}):
            self.assertEqual(guest.resolve_identity_image(1001, 1001), {"source": True})
            archive.assert_not_called()

    def test_corruption_cannot_load_or_fall_back(self):
        with self.assertRaisesRegex(RuntimeError, "archive_mismatch"):
            self.exercise(payload=b"corrupt")
        self.last_load.assert_not_called()
        self.last_source.assert_not_called()

    def test_other_base_engine_identity_preserves_source_contract(self):
        self.base["Id"] = "sha256:" + "c" * 64
        result, load, source = self.exercise()
        self.assertEqual(result, {"source": True})
        load.assert_not_called()
        source.assert_called_once_with(1001, 1001)

    def test_arbitrary_runtime_id_is_not_accepted(self):
        self.derived["Id"] = "sha256:" + "c" * 64
        with self.assertRaisesRegex(RuntimeError, "identity_missing"):
            self.exercise()

    def test_base_digest_cannot_be_forged(self):
        self.base["RepoDigests"] = []
        with self.assertRaisesRegex(RuntimeError, "base_image_digest_mismatch"):
            self.exercise()

    def test_inherited_config_labels_and_layers_remain_strict(self):
        original = copy.deepcopy(self.derived)
        for change in ("env", "label", "layer", "user"):
            with self.subTest(change=change):
                self.derived = copy.deepcopy(original)
                if change == "env": self.derived["Config"]["Env"] = ["CHANGED=1"]
                if change == "label": self.derived["Config"]["Labels"]["base-label"] = "changed"
                if change == "layer": self.derived["RootFS"]["Layers"][0] = "sha256:" + "c" * 64
                if change == "user": self.derived["Config"]["User"] = "root"
                with self.assertRaises(RuntimeError): self.exercise()

    def test_load_failure_is_not_hidden_by_source_build(self):
        with self.assertRaisesRegex(RuntimeError, "load_failed"):
            self.exercise(load_error=guest.subprocess.TimeoutExpired("docker", 900))


if __name__ == "__main__":
    unittest.main()
