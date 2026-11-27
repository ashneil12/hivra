"""Exercise the producer's orchestration without downloads, privileges or a VM."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
BASE = dict(line.split("=", 1) for line in (SCRIPTS / "runtime-bake-pins.env").read_text().splitlines())["BASE_IMAGE_SHA256"]
DISK = b"sealed fixture"
DIGEST = hashlib.sha256(DISK).hexdigest()
TOOLS = {
    "curl": 'touch "${@: -1}"',
    "sha256sum": 'if [[ "$1" == --check ]]; then cat >/dev/null; exit "${FIXTURE_CHECK_STATUS:-0}"; fi; exec /usr/bin/sha256sum "$@"',
    "qemu-img": """case "$1" in
    create|check) ;;
    info) printf '%s' "$FIXTURE_INFO" ;;
  esac""",
    "guestfish": 'printf "%s\n" "$@" > "$FIXTURE_GROW"',
    "virt-customize": """
  for flag in "$@"; do
    if [[ "$flag" == *hivra-image-bake:/root ]]; then
      stage="${flag%:/root}"
      ls -1 "$stage" > "$FIXTURE_STAGE"
    fi
  done
  printf '%s\n' "$@" > "$FIXTURE_CUSTOMIZE" """,
    "virt-sparsify": 'printf %s "sealed fixture" > "${@: -1}"',
    "virt-cat": 'printf "%s\n" "$@" > "$FIXTURE_CAT"; printf "%s" "$FIXTURE_MARKER"',
}


class RuntimeImageBake(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        tools = self.root / "bin"
        tools.mkdir()
        self.output = self.root / "out"
        self.output.mkdir()
        for name, script in TOOLS.items():
            path = tools / name
            path.write_text("#!/bin/bash\nset -eu\n" + script + "\n")
            path.chmod(0o755)
        self.env = {
            "PATH": str(tools) + ":" + os.environ["PATH"],
            "FIXTURE_INFO": json.dumps({"format": "qcow2", "virtual-size": 8 * 1024**3, "format-specific": {"data": {}}}),
            **{"FIXTURE_" + name: str(self.root / name) for name in ("STAGE", "CUSTOMIZE", "CAT", "GROW")},
        }

    def produce(self, kind, *, marker=None, **env):
        if marker is None:
            marker = {"schema": 1, "kind": kind, "baseImageSha256": BASE}
        command = ["bash", str(SCRIPTS / "bake-runtime-image.sh"), kind]
        if kind == "official-hermes":
            command = ["bash", str(SCRIPTS / "bake-official-hermes.sh")]
        return subprocess.run([*command, str(self.output)], capture_output=True, text=True, timeout=10,
                              env={**self.env, "FIXTURE_MARKER": json.dumps(marker), **env})

    def test_native_recipe_uses_shared_sealer_and_embedded_receipt(self):
        marker = {"schema": 1, "kind": "deepseek-harness", "baseImageSha256": BASE, "nativePackage": {"version": "fixture"}}
        result = self.produce("deepseek-harness", marker=marker)
        self.assertEqual(result.returncode, 0, result.stderr)
        stem = self.output / f"hivra-deepseek-harness-{DIGEST}"
        self.assertEqual(stem.with_suffix(".qcow2").read_bytes(), DISK)
        self.assertEqual(json.loads(stem.with_suffix(".json").read_text()), {**marker, "format": "qcow2", "imageSha256": DIGEST})
        stage = (self.root / "STAGE").read_text().splitlines()
        self.assertIn("install-native.py", stage)
        self.assertIn("package-lock.json", stage)
        self.assertNotIn("hermes-install.sh", stage)
        expansion = (self.root / "GROW").read_text()
        self.assertIn("part-expand-gpt\n/dev/sda\n", expansion)
        self.assertIn("part-resize\n/dev/sda\n1\n16777182\n", expansion)
        self.assertIn("resize2fs\n/dev/sda1\n", expansion)
        self.assertIn("/root/hivra-image-bake", (self.root / "CUSTOMIZE").read_text().splitlines())
        self.assertRegex((self.root / "CAT").read_text(), r"sealed\.qcow2\n/etc/hivra/deepseek-harness-bake\.json")

    def test_hermes_keeps_output_name_marker_and_memory_override(self):
        result = self.produce("official-hermes", HIVRA_HERMES_BAKE_MEMORY_MB="8192")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.output / f"hivra-hermes-{DIGEST}.json").is_file())
        self.assertIn("hermes-install.sh", (self.root / "STAGE").read_text().splitlines())
        self.assertIn("--memsize\n8192\n", (self.root / "CUSTOMIZE").read_text())
        self.assertIn("/etc/hivra/hermes-bake.json", (self.root / "CAT").read_text())

    def test_refuses_invalid_inputs_and_artifacts_without_publication(self):
        for env in (
            {"HIVRA_BAKE_MEMORY_MB": "1"},
            {"FIXTURE_CHECK_STATUS": "1"},
            {"FIXTURE_INFO": '{"format":"qcow2","virtual-size":8589934592,"backing-filename":"another.qcow2"}'},
            {"FIXTURE_INFO": '{"format":"qcow2","virtual-size":8589934592,"format-specific":{"data":{"data-file":"external"}}}'},
        ):
            with self.subTest(env=env):
                self.assertNotEqual(self.produce("deepseek-harness", **env).returncode, 0)
                self.assertEqual(list(self.output.iterdir()), [])
        self.assertNotEqual(self.produce("anything-else").returncode, 0)
        self.assertNotEqual(self.produce("deepseek-harness", marker={"schema": 1, "kind": "official-hermes", "baseImageSha256": BASE}).returncode, 0)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_manifest_collision_does_not_replace_existing_file_or_publish_partial_artifact(self):
        existing = self.output / f"hivra-deepseek-harness-{DIGEST}.json"
        existing.write_text("keep")
        self.assertNotEqual(self.produce("deepseek-harness").returncode, 0)
        self.assertEqual(existing.read_text(), "keep")
        self.assertEqual(list(self.output.iterdir()), [existing])

    def test_disk_output_directory_collision_does_not_write_through(self):
        existing = self.output / f"hivra-deepseek-harness-{DIGEST}.qcow2"
        existing.mkdir()
        self.assertNotEqual(self.produce("deepseek-harness").returncode, 0)
        self.assertEqual(list(existing.iterdir()), [])
        self.assertEqual(list(self.output.iterdir()), [existing])


if __name__ == "__main__":
    unittest.main()
