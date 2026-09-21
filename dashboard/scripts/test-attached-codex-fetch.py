#!/usr/bin/env python3
"""Owned root Linux container only; real archive must already be fetched once."""
import importlib.util
import io
import os
from pathlib import Path
import signal
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fetcher', '/tmp/fetch-attached-codex.py')
fetcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetcher)
REAL_ROOT = fetcher.ROOT
BOOT = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
ARCH = 'x86_64'
FILE, DIGEST, SIZE = fetcher.ARTIFACTS[ARCH]
RUN_ID = uuid.uuid4().hex


class Response(io.BytesIO):
    status = 200
    headers = {'Content-Length': str(SIZE)}

    def geturl(self):
        return 'https://release-assets.githubusercontent.com/fixture'


class FetchTests(unittest.TestCase):
    def setUp(self):
        fetcher.ROOT = Path('/var/lib/hivra/artifact-tests') / RUN_ID / self._testMethodName

    def acquire(self):
        return fetcher.acquire(ARCH, BOOT)

    def test_real_cached_archive_replays_without_network_or_mutation(self):
        fetcher.ROOT = REAL_ROOT
        artifact = REAL_ROOT / (DIGEST + '.tar.gz')
        before = (artifact.stat().st_ino, artifact.stat().st_mtime_ns, artifact.stat().st_size)
        with patch.object(fetcher.urllib.request, 'build_opener', side_effect=AssertionError('no download on replay')):
            result = self.acquire()
        self.assertEqual(result['archiveSha256'], DIGEST)
        self.assertEqual(result['state'], 'available')
        self.assertEqual(result['size'], SIZE)
        self.assertEqual(before, (artifact.stat().st_ino, artifact.stat().st_mtime_ns, artifact.stat().st_size))

    def test_wrong_boot_refuses_before_directory_setup(self):
        with patch.object(fetcher, 'private_root', side_effect=AssertionError('no mutation')):
            with self.assertRaises(ValueError):
                fetcher.acquire(ARCH, '11111111-1111-4111-8111-111111111111')

    def test_redirects_require_fixed_https_release_hosts(self):
        for url in ['http://github.com/file', 'https://evil.example/file', 'https://github.com.evil.example/file',
                    'https://user:pass@github.com/file', 'https://github.com:444/file', 'https://127.0.0.1/file']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                fetcher.checked_url(url)
        self.assertEqual(fetcher.checked_url('https://release-assets.githubusercontent.com/file?signature=fixture'),
                         'https://release-assets.githubusercontent.com/file?signature=fixture')

    def test_truncated_download_removes_only_its_temporary_file(self):
        root = fetcher.private_root()
        os.close(root)
        marker = fetcher.ROOT / 'preserve-marker'
        marker.write_bytes(b'owned fixture marker')
        with patch.object(fetcher.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = Response(b'truncated')
            with self.assertRaises(ValueError):
                self.acquire()
        self.assertEqual(marker.read_bytes(), b'owned fixture marker')
        self.assertEqual(sorted(p.name for p in fetcher.ROOT.iterdir()), ['download.lock', 'preserve-marker'])
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_deadline_aborts_and_cleans_exclusive_partial(self):
        class Expiring(Response):
            def read(self, size):
                self.assertion = signal.getitimer(signal.ITIMER_REAL)[0] > 0
                signal.raise_signal(signal.SIGALRM)
        response = Expiring(b'')
        with patch.object(fetcher.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = response
            with self.assertRaises(TimeoutError):
                self.acquire()
        self.assertTrue(response.assertion)
        self.assertEqual([p.name for p in fetcher.ROOT.iterdir()], ['download.lock'])

    def test_colliding_temporary_file_is_not_deleted(self):
        root = fetcher.private_root()
        os.close(root)
        collision = fetcher.ROOT / '.download-existing'
        collision.write_bytes(b'preserve collision')
        with patch.object(fetcher.secrets, 'token_hex', return_value='existing'):
            with self.assertRaises(FileExistsError):
                self.acquire()
        self.assertEqual(collision.read_bytes(), b'preserve collision')

    def test_existing_symlink_is_preserved_and_not_downloaded_over(self):
        root = fetcher.private_root()
        os.close(root)
        victim = fetcher.ROOT / 'victim'
        victim.write_bytes(b'preserve victim')
        cached = fetcher.ROOT / (DIGEST + '.tar.gz')
        cached.symlink_to(victim)
        with patch.object(fetcher.urllib.request, 'build_opener', side_effect=AssertionError('no replacement download')):
            with self.assertRaises(OSError):
                self.acquire()
        self.assertTrue(cached.is_symlink())
        self.assertEqual(victim.read_bytes(), b'preserve victim')

    def test_root_namespace_replacement_is_rejected(self):
        original = fetcher.ROOT
        moved = original.with_name(original.name + '-moved')

        class ReplacingResponse(Response):
            def __init__(self):
                super().__init__(b'')
                self.archive = open(REAL_ROOT / (DIGEST + '.tar.gz'), 'rb')
                self.replaced = False

            def read(self, size):
                if not self.replaced:
                    original.rename(moved)
                    original.mkdir(mode=0o700)
                    (original / 'preserve-replacement').write_bytes(b'new namespace')
                    self.replaced = True
                return self.archive.read(size)

            def close(self):
                self.archive.close()
                super().close()

        with patch.object(fetcher.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = ReplacingResponse()
            with self.assertRaises(ValueError):
                self.acquire()
        self.assertEqual((original / 'preserve-replacement').read_bytes(), b'new namespace')
        self.assertFalse((original / (DIGEST + '.tar.gz')).exists())
        self.assertTrue((moved / (DIGEST + '.tar.gz')).exists())


if __name__ == '__main__':
    if os.geteuid() != 0 or not Path('/.dockerenv').exists():
        raise SystemExit('owned root Docker fixture required')
    unittest.main(verbosity=2)
