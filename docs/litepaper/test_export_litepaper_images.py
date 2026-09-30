#!/usr/bin/env python3
"""Guard the litepaper image export: pinned sources and the overwrite rule.

Run from anywhere: python3 docs/litepaper/test_export_litepaper_images.py

A published export is never changed: a changed one stops the run before
anything is written, and a source that is not the approved file stops it too.
The end-to-end tests need Pillow and are skipped without it.
"""

import contextlib
import hashlib
import importlib.util
import io
import stat
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

_spec = importlib.util.spec_from_file_location("export_litepaper_images", HERE / "export-litepaper-images.py")
exporter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(exporter)

try:
    import PIL  # noqa: F401

    HAVE_PILLOW = True
except ImportError:
    HAVE_PILLOW = False


class TempRoot(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name)

    def tearDown(self) -> None:
        for path in self.root.rglob("*"):
            if path.is_file():
                path.chmod(stat.S_IWUSR | stat.S_IRUSR)
        self._dir.cleanup()

    def put(self, path: Path, data: bytes) -> None:
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def run_quiet(self, function, *args) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            function(*args)
        return out.getvalue()


class PinnedSourcesTest(unittest.TestCase):
    def test_sources_match_the_committed_renders(self) -> None:
        for source, sha256 in exporter.SOURCES.items():
            with self.subTest(source=str(source)):
                self.assertEqual(hashlib.sha256((REPO / source).read_bytes()).hexdigest(), sha256)

    def test_outputs_sit_beside_their_sources_and_never_replace_one(self) -> None:
        outputs = exporter.output_paths()
        self.assertEqual(len(outputs), len(exporter.SOURCES) * len(exporter.WIDTHS))
        self.assertEqual(len(set(outputs)), len(outputs))
        for path in outputs:
            self.assertEqual(path.suffix, ".webp")
            self.assertNotIn(path, exporter.SOURCES)

    def test_committed_exports_are_fresh_exports_of_the_committed_sources(self) -> None:
        if not HAVE_PILLOW:
            self.skipTest("Pillow is not installed")
        for source in exporter.SOURCES:
            image = exporter.load_source(REPO, source)
            for width in exporter.WIDTHS:
                path = exporter.output_path(source, width)
                with self.subTest(path=str(path)):
                    self.assertEqual((REPO / path).read_bytes(), exporter.webp_bytes(image, width))


class WriteExportsTest(TempRoot):
    OUT = exporter.output_paths()[0]
    OTHER = exporter.output_paths()[1]

    def test_writes_missing_and_keeps_identical_files(self) -> None:
        self.assertEqual(self.run_quiet(exporter.write_exports, self.root, [(self.OUT, b"a")]).count(" wrote "), 1)
        (self.root / self.OUT).chmod(stat.S_IRUSR)  # any write attempt would now fail loudly
        self.assertEqual(self.run_quiet(exporter.write_exports, self.root, [(self.OUT, b"a")]).count(" kept "), 1)

    def test_changed_published_file_stops_the_run_before_any_write(self) -> None:
        self.put(self.OUT, b"old")
        with self.assertRaises(SystemExit) as stop:
            self.run_quiet(exporter.write_exports, self.root, [(self.OTHER, b"new other"), (self.OUT, b"new")])
        self.assertIn("Refusing to overwrite published exports", str(stop.exception.code))
        self.assertEqual((self.root / self.OUT).read_bytes(), b"old")
        self.assertFalse((self.root / self.OTHER).exists())


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class MainTest(TempRoot):
    def test_a_source_that_is_not_the_approved_file_stops_the_run(self) -> None:
        for source in exporter.SOURCES:
            self.put(source, (REPO / source).read_bytes())
        changed = next(iter(exporter.SOURCES))
        self.put(changed, (REPO / changed).read_bytes() + b"\0")
        with self.assertRaises(SystemExit) as stop:
            self.run_quiet(exporter.main, self.root)
        self.assertIn("is not the approved render", str(stop.exception.code))
        self.assertFalse(any(self.root.rglob("*.webp")))

    def test_export_is_deterministic_and_matches_the_committed_files(self) -> None:
        for source in exporter.SOURCES:
            self.put(source, (REPO / source).read_bytes())
        outputs = exporter.output_paths()
        self.assertEqual(self.run_quiet(exporter.main, self.root).count(" wrote "), len(outputs))
        for path in outputs:
            self.assertEqual((self.root / path).read_bytes(), (REPO / path).read_bytes())
        self.assertEqual(self.run_quiet(exporter.main, self.root).count(" kept "), len(outputs))


if __name__ == "__main__":
    unittest.main(verbosity=2)
