#!/usr/bin/env python3
"""Owned root Linux container only, no network/mounts. Seed a pinned archive."""
import base64
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bundle', '/tmp/run-attached-codex-bundle.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)
sources = {name: Path('/tmp/' + filename).read_bytes() for name, filename in {
    'fetcher': 'fetch-attached-codex.py', 'worker': 'run-attached-codex-stage.py', 'stager': 'stage-attached-codex.py'}.items()}
identity = {'operationId': '11111111-1111-4111-8111-111111111111', 'dispatchId': '22222222-2222-4222-8222-222222222222',
            'installationId': '33333333-3333-4333-8333-333333333333', 'bindingId': '44444444-4444-4444-8444-444444444444',
            'computerId': '55555555-5555-4555-8555-555555555555', 'sourceId': '66666666-6666-4666-8666-666666666666', 'architecture': 'x86_64'}
request = {'version': 1, 'action': 'fetch', 'identity': identity,
           'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
           'assets': {name: base64.b64encode(source).decode() for name, source in sources.items()}}
fetcher = bundle.load_reviewed('fetcher', sources['fetcher'])
cache = fetcher['ROOT'] / (fetcher['ARTIFACTS']['x86_64'][1] + '.tar.gz')


def execute(action, **changes):
    return bundle.execute_bundle(json.dumps(dict(request, action=action, **changes)).encode())


class BundleTests(unittest.TestCase):
    def test_invalid_assets_actions_and_shapes_never_load(self):
        for change in ({'version': True}, {'action': 'arbitrary'}, {'extra': True},
                       {'assets': dict(request['assets'], worker=base64.b64encode(b'bad source').decode())}):
            with patch.object(bundle, 'load_reviewed', side_effect=AssertionError('no source load')):
                with self.assertRaises(ValueError):
                    bundle.execute_bundle(json.dumps(dict(request, **change)).encode())
        with self.assertRaises(ValueError):
            bundle.decode_bundle(b'x' * 65537)

    def test_fetch_is_available_not_staged(self):
        result = execute('fetch')
        self.assertEqual(result['state'], 'available')
        self.assertFalse(Path('/var/lib/hivra/attachment-staging/staging.json').exists())
        self.assertFalse(Path('/opt/hivra/agent-installations').exists())

    def test_observe_missing_root_never_creates(self):
        original_open = os.open
        def readonly_open(path, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_CREAT | os.O_WRONLY | os.O_RDWR | os.O_TRUNC))
            return original_open(path, flags, *args, **kwargs)
        with patch.object(os, 'open', side_effect=readonly_open), \
                patch.object(Path, 'mkdir', side_effect=AssertionError('no mkdir')), \
                patch('subprocess.run', side_effect=AssertionError('no subprocess')):
            with self.assertRaises(FileNotFoundError):
                execute('observe')
        self.assertFalse(Path('/var/lib/hivra/attachment-staging').exists())

    def test_stage_missing_cache_never_downloads_or_starts(self):
        moved = cache.with_suffix('.fixture-hidden')
        cache.rename(moved)
        try:
            with self.assertRaises(FileNotFoundError):
                execute('stage')
            self.assertFalse(Path('/var/lib/hivra/attachment-staging/staging.json').exists())
        finally:
            moved.rename(cache)

    def test_stage_real_and_replay_preserve_journal_and_remove_only_temporary_stager(self):
        result = execute('stage')
        self.assertEqual(result['phase'], 'staged')
        self.assertEqual(result['identity'], identity)
        journal = Path('/var/lib/hivra/attachment-staging/staging.json')
        before = journal.read_bytes()
        with patch('subprocess.run', side_effect=AssertionError('no installation replay')):
            self.assertEqual(execute('stage'), result)
        self.assertEqual(journal.read_bytes(), before)
        self.assertEqual(list(Path('/run').glob('hivra-attachment-stager-*')), [])
        self.check_readonly_observation(result, journal, before)

    def check_readonly_observation(self, result, journal, before):
        original_open = os.open
        def readonly_open(path, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_CREAT | os.O_WRONLY | os.O_RDWR | os.O_TRUNC))
            return original_open(path, flags, *args, **kwargs)
        root = journal.parent
        inventory = sorted(p.name for p in root.iterdir())
        metadata = bundle.file_identity(journal.stat())
        with patch.object(os, 'open', side_effect=readonly_open), \
                patch.object(Path, 'mkdir', side_effect=AssertionError('no mkdir')), \
                patch('subprocess.run', side_effect=AssertionError('no subprocess')), \
                patch.object(bundle, 'load_reviewed', wraps=bundle.load_reviewed) as loaded:
            self.assertEqual(execute('observe'), result)
            self.assertEqual([call.args[0] for call in loaded.call_args_list], ['worker'])
        self.assertEqual(journal.read_bytes(), before)
        self.assertEqual(bundle.file_identity(journal.stat()), metadata)
        self.assertEqual(sorted(p.name for p in root.iterdir()), inventory)
        lock = root / 'installer.lock'
        with lock.open('rb') as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                execute('observe')
        for path in (lock, journal):
            moved = path.with_suffix('.fixture-hidden')
            path.rename(moved)
            try:
                with self.assertRaises(FileNotFoundError):
                    execute('observe')
                self.assertFalse(path.exists())
                path.symlink_to(moved)
                try:
                    with self.assertRaises(OSError):
                        execute('observe')
                finally:
                    path.unlink()
            finally:
                moved.rename(path)
        invalid = [None, dict(result, version=True), dict(result, phase='started'),
                   dict(result, bootId='99999999-9999-4999-8999-999999999999'),
                   dict(result, receipt=dict(result['receipt'], uid=True)),
                   dict(result, identity=dict(identity, dispatchId='99999999-9999-4999-8999-999999999999'))]
        try:
            for record in invalid:
                encoded = json.dumps(record).encode()
                journal.write_bytes(encoded)
                with self.assertRaises(ValueError):
                    execute('observe')
                self.assertEqual(journal.read_bytes(), encoded)
            journal.chmod(0o644)
            with self.assertRaises(ValueError):
                execute('observe')
        finally:
            journal.chmod(0o600)
            journal.write_bytes(before)
        self.assertEqual(execute('observe'), result)

    def test_temporary_collision_is_preserved(self):
        collision = Path('/run/hivra-attachment-stager-collision.py')
        with collision.open('xb') as output:
            output.write(b'preserve existing bytes')
        try:
            with patch.object(bundle.secrets, 'token_hex', return_value='collision'):
                with self.assertRaises(FileExistsError):
                    execute('stage')
            self.assertEqual(collision.read_bytes(), b'preserve existing bytes')
        finally:
            collision.unlink()

    def test_wrong_boot_cannot_create_a_temporary_stager(self):
        before = list(Path('/run').glob('hivra-attachment-stager-*'))
        with patch.object(os, 'open', side_effect=AssertionError('no os.open before boot validation')):
            with self.assertRaises(ValueError):
                execute('stage', bootId='99999999-9999-4999-8999-999999999999')
        self.assertEqual(list(Path('/run').glob('hivra-attachment-stager-*')), before)


if __name__ == '__main__':
    if os.geteuid() != 0 or not Path('/.dockerenv').exists():
        raise SystemExit('owned root Docker fixture required')
    root = fetcher['private_root']()
    os.close(root)
    with cache.open('xb') as output, open('/tmp/codex.tar.gz', 'rb') as source:
        shutil.copyfileobj(source, output)
    cache.chmod(0o600)
    unittest.main(verbosity=2)
