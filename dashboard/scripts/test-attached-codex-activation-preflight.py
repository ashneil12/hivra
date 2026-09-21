#!/usr/bin/env python3
"""Real staged binary, owned root Linux container only. No network required."""
import base64
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, '/tmp/' + filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


preflight = module('preflight', 'preflight-attached-codex-activation.py')
bundle = module('bundle', 'run-attached-codex-bundle.py')
sources = {name: Path('/tmp/' + filename).read_bytes() for name, filename in {
    'worker': 'run-attached-codex-stage.py', 'stager': 'stage-attached-codex.py',
    'fetcher': 'fetch-attached-codex.py'}.items()}
identity = {'operationId': '11111111-1111-4111-8111-111111111111', 'dispatchId': '22222222-2222-4222-8222-222222222222',
            'installationId': '33333333-3333-4333-8333-333333333333', 'bindingId': '44444444-4444-4444-8444-444444444444',
            'computerId': '55555555-5555-4555-8555-555555555555', 'sourceId': '66666666-6666-4666-8666-666666666666', 'architecture': 'x86_64'}


class PreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.geteuid() == 0 and Path('/.dockerenv').exists(), 'owned root Docker fixture required'
        if os.environ.get('HIVRA_PREFLIGHT_TEST_REUSE') == '1':
            # Only repeat assertions on this exact disposable fixture; never
            # retry its installer or reset any worker journal.
            staged = json.loads(Path('/var/lib/hivra/attachment-staging/staging.json').read_bytes())
            assert staged['identity'] == identity and staged['phase'] == 'staged'
        else:
            fetcher = bundle.load_reviewed('fetcher', sources['fetcher'])
            root = fetcher['private_root']()
            os.close(root)
            cache = fetcher['ROOT'] / (fetcher['ARTIFACTS']['x86_64'][1] + '.tar.gz')
            with cache.open('xb') as target, open('/tmp/codex.tar.gz', 'rb') as source:
                shutil.copyfileobj(source, target)
            cache.chmod(0o600)
            staged = bundle.execute_bundle(json.dumps({'version': 1, 'action': 'stage', 'identity': identity,
                'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                'assets': {name: base64.b64encode(source).decode() for name, source in sources.items()}}).encode())
        cls.request = {'version': 1, 'operationId': identity['operationId'],
            'activationId': '77777777-7777-4777-8777-777777777777', 'generation': '2',
            'servicePolicySha256': preflight.POLICY,
            'serviceDefinitionSha256': preflight.service_definition(staged)['sha256'], 'staged': staged}
        cls.assets = {'worker': base64.b64encode(sources['worker']).decode(),
                      'observer': base64.b64encode(Path('/tmp/run-attached-codex-bundle.py').read_bytes()).decode()}

    def check(self, request=None, assets=None):
        return preflight.preflight(json.dumps({'version': 1, 'request': self.request if request is None else request,
            'assets': self.assets if assets is None else assets}).encode())

    def test_real_staged_bytes_checked_without_writes_or_agent_processes(self):
        original_open = os.open
        def readonly(path, flags, *args, **kwargs):
            if path == os.devnull and flags == os.O_RDWR:
                return original_open(path, flags, *args, **kwargs)  # Fixed child output sink only.
            self.assertFalse(flags & (os.O_CREAT | os.O_WRONLY | os.O_RDWR | os.O_TRUNC))
            return original_open(path, flags, *args, **kwargs)
        with patch.object(os, 'open', side_effect=readonly), \
                patch.object(Path, 'mkdir', side_effect=AssertionError('no mkdir')), \
                patch('subprocess.run', wraps=subprocess.run) as probe:
            result = self.check()
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(probe.call_args.args[0][:5], ['/usr/bin/python3', '-I', '-B', '-S', '-c'])
        self.assertEqual(probe.call_args.kwargs['user'], self.request['staged']['receipt']['uid'])
        self.assertEqual(probe.call_args.kwargs['extra_groups'], [])
        self.assertEqual(result['state'], 'preflight_verified')
        self.assertEqual(result['uid'], self.request['staged']['receipt']['uid'])
        self.assertEqual(result['binarySha256'], self.request['staged']['receipt']['binarySha256'])
        self.assertFalse(Path(preflight.service_definition(self.request['staged'])['unitPath']).exists())

    def test_invalid_requests_and_boot_refuse_before_filesystem_open(self):
        for change in ({'version': True}, {'generation': '2\n'}, {'generation': '9223372036854775808'},
                       {'servicePolicySha256': '0' * 64}, {'serviceDefinitionSha256': '0' * 64},
                       {'operationId': identity['sourceId']}, {'extra': True}):
            with patch.object(os, 'open', side_effect=AssertionError('no os.open')):
                with self.assertRaises(ValueError):
                    self.check(dict(self.request, **change))
        wrong = copy.deepcopy(self.request)
        wrong['staged']['bootId'] = identity['sourceId']
        with patch.object(os, 'open', side_effect=AssertionError('no os.open')):
            with self.assertRaises(ValueError):
                self.check(wrong)
        with self.assertRaises(ValueError):
            self.check(assets=dict(self.assets, worker=base64.b64encode(b'changed').decode()))
        with self.assertRaises(ValueError):
            preflight.decode(b'x' * 65537)

    def test_account_and_supplementary_group_drift_refused(self):
        with patch.object(os, 'getgrouplist', return_value=[0, self.request['staged']['receipt']['gid']]):
            with self.assertRaises(ValueError):
                self.check()
        actual = preflight.pwd.getpwnam(self.request['staged']['receipt']['account'])
        changed = preflight.pwd.struct_passwd((actual.pw_name, actual.pw_passwd, actual.pw_uid,
            actual.pw_gid, actual.pw_gecos, actual.pw_dir, '/bin/bash'))
        with patch.object(preflight.pwd, 'getpwnam', return_value=changed):
            with self.assertRaises(ValueError):
                self.check()

    def test_unsafe_modes_and_symlinks_preserved(self):
        receipt = self.request['staged']['receipt']
        for pathname in (receipt['home'], receipt['executable'], str(Path(receipt['executable']).parent / 'installation.json')):
            target = Path(pathname)
            before = target.stat().st_mode & 0o777
            try:
                target.chmod(0o777)
                with self.assertRaises(ValueError):
                    self.check()
                self.assertEqual(target.stat().st_mode & 0o777, 0o777)
            finally:
                target.chmod(before)
            moved = target.with_name(target.name + '.fixture-preserved')
            target.rename(moved)
            try:
                target.symlink_to(moved)
                with self.assertRaises(OSError):
                    self.check()
                self.assertTrue(target.is_symlink())
            finally:
                target.unlink()
                moved.rename(target)

    def test_changed_binary_bytes_refused_without_repair(self):
        target = Path(self.request['staged']['receipt']['executable'])
        with target.open('r+b') as f:
            original = f.read(1)
            f.seek(0)
            f.write(bytes([original[0] ^ 0xff]))
        try:
            with self.assertRaises(ValueError):
                self.check()
            with target.open('rb') as f:
                self.assertNotEqual(f.read(1), original)
        finally:
            with target.open('r+b') as f:
                f.write(original)

    def test_busy_staging_journal_stays_held(self):
        with open('/var/lib/hivra/attachment-staging/installer.lock', 'rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.check()

    def test_home_change_after_binary_hash_must_not_be_adopted(self):
        target = Path(self.request['staged']['receipt']['home'])
        original = preflight.checked_file
        def change_after_hash(parent, name, *args, **kwargs):
            result = original(parent, name, *args, **kwargs)
            if name == 'codex':
                target.chmod(0o755)
            return result
        try:
            with patch.object(preflight, 'checked_file', side_effect=change_after_hash):
                with self.assertRaises(ValueError):
                    self.check()
            self.assertEqual(target.stat().st_mode & 0o777, 0o755, 'preflight must not repair the change')
        finally:
            target.chmod(0o700)

    def test_service_account_inaccessible_ancestor_refused(self):
        for pathname in ('/opt/hivra/agent-installations', '/var/lib/hivra/agent-homes'):
            target = Path(pathname)
            mode = target.stat().st_mode & 0o777
            try:
                target.chmod(0o700)
                with self.assertRaises(ValueError):
                    self.check()
                self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            finally:
                target.chmod(mode)

    def test_receipt_and_journal_changes_after_hash_refused(self):
        receipt = self.request['staged']['receipt']
        for pathname in (str(Path(receipt['executable']).parent / 'installation.json'),
                         '/var/lib/hivra/attachment-staging/staging.json'):
            target = Path(pathname)
            before = target.read_bytes()
            original = preflight.checked_file
            def change_after_hash(parent, name, *args, **kwargs):
                result = original(parent, name, *args, **kwargs)
                if name == 'codex':
                    target.write_bytes(b'{}')
                return result
            try:
                with patch.object(preflight, 'checked_file', side_effect=change_after_hash):
                    with self.assertRaises(ValueError):
                        self.check()
                self.assertEqual(target.read_bytes(), b'{}')
            finally:
                target.write_bytes(before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
