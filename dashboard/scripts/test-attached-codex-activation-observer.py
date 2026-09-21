#!/usr/bin/env python3
"""Owned Linux fixture: actual staging/preflight; systemd observation simulated."""
import base64
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, '/tmp/' + filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


fixture = module('starter_tests', 'test-attached-codex-start.py')
observer = module('activation_observer', 'observe-attached-codex-activation.py')


class ObserverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.StarterTests.setUpClass()

    def setUp(self):
        self.base = fixture.StarterTests()
        self.base.setUp()
        self.root_patch = patch.object(observer, 'ROOT', self.base.root)
        self.root_patch.start()
        self.raw = json.dumps({'version': 1,
            'starter': base64.b64encode(Path('/tmp/start-attached-codex.py').read_bytes()).decode(),
            'packet': json.loads(self.base.raw)}).encode()
        self.journal = self.base.root / 'activation.json'
        self.calls = []

    def tearDown(self):
        self.root_patch.stop()
        self.base.tearDown()

    def observe(self, control=None, raw=None, probe=None):
        original_load = observer.load_starter
        def load(source):
            value = original_load(source)
            def command(args, timeout=20):
                self.assertEqual(args[:2], ['/usr/bin/systemctl', 'show'])
                self.calls.append(args)
                return (control or self.base.control)(args, timeout)
            value['command'] = command
            value['checked_process'] = lambda pid, request, service: self.assertEqual(pid, 1234)
            for name in ('start', 'publish', 'private_root', 'exclusive_file'):
                value[name] = lambda *args, **kwargs: self.fail('observer must not mutate')
            return value
        with patch.object(observer, 'load_starter', side_effect=load):
            return observer.observe(self.raw if raw is None else raw, probe)

    def test_probe_runs_inside_observation_and_journal_change_is_refused(self):
        self.base.run_start()
        calls = []
        def probe(verifier, request, service, pid):
            calls.append((request, service, pid))
            self.journal.write_text('changed during protocol')
        with self.assertRaises(ValueError):
            self.observe(probe=probe)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2], 1234)
        self.assertEqual(self.journal.read_text(), 'changed during protocol')

    def test_inactive_never_invokes_protocol_probe(self):
        self.base.run_start()
        self.base.active = False
        def probe(*args):
            self.fail('inactive service must not be probed')
        self.assertEqual(self.observe(probe=probe)['state'], 'service_inactive')

    def test_running_observation_is_readonly_and_not_readiness(self):
        self.base.run_start()
        before = self.journal.read_bytes()
        original_open = os.open
        def readonly(path, flags, *args, **kwargs):
            if path != os.devnull or flags != os.O_RDWR:
                self.assertFalse(flags & (os.O_CREAT | os.O_WRONLY | os.O_RDWR | os.O_TRUNC))
            return original_open(path, flags, *args, **kwargs)
        with patch.object(os, 'open', side_effect=readonly):
            result = self.observe()
        self.assertEqual(result['state'], 'process_running')
        self.assertEqual(result['mainPid'], 1234)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.journal.read_bytes(), before)
        self.assertNotIn('ready', result)
        self.assertNotIn('leaseReleased', result)

    def test_lost_ack_start_requested_can_be_observed_without_redispatch(self):
        self.base.run_start()
        record = json.loads(self.journal.read_bytes())
        record['phase'] = 'start_requested'
        del record['mainPid']
        self.journal.write_text(json.dumps(record))
        self.assertEqual(self.observe()['state'], 'process_running')
        self.assertEqual(sum(args[1] == 'start' for args in self.base.events), 1)
        self.assertEqual(json.loads(self.journal.read_bytes())['phase'], 'start_requested')

    def test_inactive_is_not_release_or_restart_permission(self):
        self.base.run_start()
        self.base.active = False
        result = self.observe()
        self.assertEqual(result['state'], 'service_inactive')
        self.assertNotIn('mainPid', result)
        self.assertEqual(sum(args[1] == 'start' for args in self.base.events), 1)

    def test_preparing_and_failed_stay_unresolved_without_control(self):
        self.base.run_start()
        request = json.loads(self.journal.read_bytes())['request']
        for record in ({'version': 1, 'request': request, 'phase': 'preparing'},
                       {'version': 1, 'request': request, 'phase': 'start_failed', 'cleanup': 'stop_requested'}):
            self.journal.write_text(json.dumps(record))
            self.assertEqual(self.observe()['state'], 'activation_unresolved')
        self.assertEqual(self.calls, [])

    def test_missing_journal_creates_nothing(self):
        with self.assertRaises(FileNotFoundError):
            self.observe()
        self.assertFalse(self.base.root.exists())
        self.assertFalse(self.base.unit.exists())

    def test_busy_worker_lock_is_not_bypassed(self):
        self.base.run_start()
        with (self.base.root / 'worker.lock').open('rb') as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.observe()
        self.assertEqual(self.calls, [])

    def test_changed_journal_during_show_is_preserved_and_refused(self):
        self.base.run_start()
        def control(args, timeout=20):
            value = self.base.control(args, timeout)
            self.journal.write_text('foreign journal')
            return value
        with self.assertRaises(ValueError):
            self.observe(control)
        self.assertEqual(self.journal.read_text(), 'foreign journal')

    def test_changed_unit_during_final_show_is_preserved_and_refused(self):
        self.base.run_start()
        def control(args, timeout=20):
            value = self.base.control(args, timeout)
            if len(self.calls) == 2:
                self.base.unit.write_text('foreign unit')
            return value
        with self.assertRaises(ValueError):
            self.observe(control)
        self.assertEqual(self.base.unit.read_text(), 'foreign unit')

    def test_recorded_pid_and_request_mismatch_refused(self):
        self.base.run_start()
        record = json.loads(self.journal.read_bytes())
        record['mainPid'] = 9999
        self.journal.write_text(json.dumps(record))
        with self.assertRaises(ValueError):
            self.observe()
        record['request']['activationId'] = '88888888-8888-4888-8888-888888888888'
        self.journal.write_text(json.dumps(record))
        with self.assertRaises(ValueError):
            self.observe()

    def test_unreviewed_dependency_and_duplicate_fields_refused(self):
        packet = json.loads(self.raw)
        packet['starter'] = base64.b64encode(b'not reviewed').decode()
        with self.assertRaises(ValueError):
            self.observe(raw=json.dumps(packet).encode())
        with self.assertRaises(ValueError):
            self.observe(raw=b'{"version":1,"version":1}')
        self.assertFalse(self.base.root.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
