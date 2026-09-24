#!/usr/bin/env python3
"""Guard the brand export's overwrite rule.

Run from anywhere: python3 docs/brand/test_export_brand_assets.py

Published exports (hivra-token-*, hivra-icon-*) are never changed: a changed
one stops the run before anything is written. The Next.js icon files have
framework-fixed names, so a changed mark rewrites them. The write rule runs
without Pillow; the end-to-end run of main() needs Pillow and is skipped
without it.
"""

import contextlib
import importlib.util
import io
import os
import shutil
import stat
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

_spec = importlib.util.spec_from_file_location("export_brand_assets", HERE / "export-brand-assets.py")
exporter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(exporter)

TOKEN = exporter.PUBLIC_BRAND / "hivra-token-1024.png"
ICON = exporter.PUBLIC_BRAND / "hivra-icon-192.png"
NEXT_ICON = exporter.APP / "icon.png"
FAVICON = exporter.FAVICON

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

    def read(self, path: Path) -> bytes:
        return (self.root / path).read_bytes()

    def exists(self, path: Path) -> bool:
        return (self.root / path).exists()

    def write(self, exports: list) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            exporter.write_exports(self.root, exports)
        return out.getvalue()


class ClassificationTest(unittest.TestCase):
    def test_public_brand_files_are_published_and_next_icons_are_not(self) -> None:
        outputs = [path for path, _edge in exporter.PNG_OUTPUTS] + [exporter.FAVICON]
        for path in outputs:
            with self.subTest(path=str(path)):
                self.assertEqual(exporter.is_published(path), path.parent == exporter.PUBLIC_BRAND)
        published = {path.name for path in outputs if exporter.is_published(path)}
        self.assertIn("hivra-token-1024.png", published)
        self.assertIn("hivra-icon-192.png", published)
        self.assertEqual(
            {path.name for path in outputs if not exporter.is_published(path)},
            {"icon.png", "apple-icon.png", "favicon.ico"},
        )


class WriteExportsTest(TempRoot):
    def test_writes_missing_files(self) -> None:
        output = self.write([(TOKEN, b"token"), (ICON, b"icon"), (NEXT_ICON, b"next"), (FAVICON, b"ico")])
        self.assertEqual(self.read(TOKEN), b"token")
        self.assertEqual(self.read(ICON), b"icon")
        self.assertEqual(self.read(NEXT_ICON), b"next")
        self.assertEqual(self.read(FAVICON), b"ico")
        self.assertEqual(output.count(" wrote "), 4)

    def test_keeps_identical_files_without_writing(self) -> None:
        for path, data in [(TOKEN, b"token"), (ICON, b"icon"), (NEXT_ICON, b"next")]:
            self.put(path, data)
            # A read-only file makes any write attempt fail loudly.
            (self.root / path).chmod(stat.S_IRUSR)
        output = self.write([(TOKEN, b"token"), (ICON, b"icon"), (NEXT_ICON, b"next")])
        self.assertEqual(output.count(" kept "), 3)

    def test_changed_published_file_stops_the_run_before_any_write(self) -> None:
        for published in (TOKEN, ICON):
            with self.subTest(published=str(published)):
                shutil.rmtree(self.root / "dashboard", ignore_errors=True)
                self.put(published, b"old published")
                self.put(NEXT_ICON, b"old next")
                exports = [(TOKEN, b"new token"), (ICON, b"new icon"), (NEXT_ICON, b"new next"), (FAVICON, b"new ico")]
                with self.assertRaises(SystemExit) as stop:
                    self.write(exports)
                self.assertIn("Refusing to overwrite published exports", str(stop.exception.code))
                self.assertIn(str(published), str(stop.exception.code))
                self.assertEqual(self.read(published), b"old published")
                # Nothing else was written either: not the other new file, not the Next.js icons.
                other = ICON if published == TOKEN else TOKEN
                self.assertFalse(self.exists(other))
                self.assertEqual(self.read(NEXT_ICON), b"old next")
                self.assertFalse(self.exists(FAVICON))

    def test_rewrites_nextjs_icons_when_the_mark_changes(self) -> None:
        self.put(TOKEN, b"token")
        self.put(NEXT_ICON, b"old next")
        self.put(FAVICON, b"old ico")
        output = self.write([(TOKEN, b"token"), (NEXT_ICON, b"new next"), (FAVICON, b"new ico")])
        self.assertEqual(self.read(TOKEN), b"token")
        self.assertEqual(self.read(NEXT_ICON), b"new next")
        self.assertEqual(self.read(FAVICON), b"new ico")
        self.assertEqual(output.count(" rewrote "), 2)
        self.assertEqual(output.count(" kept "), 1)


@unittest.skipUnless(HAVE_PILLOW, "Pillow is not installed")
class MainTest(TempRoot):
    """Runs the real export from the approved logo into a temporary root."""

    def setUp(self) -> None:
        super().setUp()
        self.put(exporter.SOURCE, (REPO / exporter.SOURCE).read_bytes())

    def run_main(self) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            exporter.main(self.root)
        return out.getvalue()

    def test_new_files_are_written_and_a_changed_published_file_stops_the_run(self) -> None:
        outputs = [path for path, _edge in exporter.PNG_OUTPUTS] + [exporter.FAVICON]

        self.assertEqual(self.run_main().count(" wrote "), len(outputs))
        fresh = {path: self.read(path) for path in outputs}
        self.assertEqual(self.run_main().count(" kept "), len(outputs))

        # A changed published file stops the run: it and a missing new file stay as they were.
        missing = exporter.PUBLIC_BRAND / "hivra-token-32.png"
        os.remove(self.root / missing)
        self.put(TOKEN, b"a different mark")
        self.put(NEXT_ICON, b"stale icon")
        with self.assertRaises(SystemExit):
            self.run_main()
        self.assertEqual(self.read(TOKEN), b"a different mark")
        self.assertFalse(self.exists(missing))
        self.assertEqual(self.read(NEXT_ICON), b"stale icon")

        # With the published file restored, the run writes the missing file and
        # brings the Next.js icon back to the approved mark.
        self.put(TOKEN, fresh[TOKEN])
        output = self.run_main()
        self.assertEqual(self.read(missing), fresh[missing])
        self.assertEqual(self.read(NEXT_ICON), fresh[NEXT_ICON])
        self.assertIn(" wrote ", output)
        self.assertIn(" rewrote ", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
