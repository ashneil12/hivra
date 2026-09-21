#!/usr/bin/env python3
"""Owned Linux fixture: real staging/preflight, simulated systemd boundary."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, '/tmp/' + filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


fixture = module('preflight_tests', 'test-attached-codex-activation-preflight.py')
starter = module('starter', 'start-attached-codex.py')


class StarterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.PreflightTests.setUpClass()
        cls.request = fixture.PreflightTests.request
        cls.service = fixture.preflight.service_definition(cls.request['staged'])
        cls.raw = json.dumps({'version': 1,
            'preflight': base64.b64encode(Path('/tmp/preflight-attached-codex-activation.py').read_bytes()).decode(),
            'packet': {'version': 1, 'request': cls.request, 'assets': fixture.PreflightTests.assets}}).encode()

    def setUp(self):
        self.root = Path('/var/lib/hivra') / ('activation-fixture-' + uuid.uuid4().hex)
        self.root_patch = patch.object(starter, 'ROOT', self.root)
        self.root_patch.start()
        self.unit = Path(self.service['unitPath'])
        assert not os.path.lexists(self.unit), 'owned fixture unit collision'
        self.unit.parent.mkdir(parents=True, exist_ok=True)
        self.events = []
        self.active = False

    def tearDown(self):
        # Exact disposable-fixture files only, not an application cleanup path.
        self.unit.unlink(missing_ok=True)
        if self.root.exists():
            for name in ('activation.json', '.activation-next', 'worker.lock'):
                (self.root / name).unlink(missing_ok=True)
            self.root.rmdir()
        self.root_patch.stop()

    def control(self, args, timeout=20):
        self.events.append(args)
        if args[0] == '/usr/bin/systemd-analyze' or args[1] == 'daemon-reload':
            return ''
        action = args[1]
        if action == 'start':
            record = json.loads((self.root / 'activation.json').read_bytes())
            self.assertEqual(record['phase'], 'start_requested', 'durable journal must precede systemctl start')
            self.active = True
            return ''
        if action == 'stop':
            self.active = False
            return ''
        self.assertEqual(action, 'show')
        if not self.unit.exists():
            return 'LoadState=not-found\nActiveState=inactive\nMainPID=0\n'
        receipt = self.request['staged']['receipt']
        values = {'LoadState': 'loaded', 'FragmentPath': str(self.unit), 'DropInPaths': '',
            'User': receipt['account'], 'Group': receipt['account'], 'WorkingDirectory': receipt['home'],
            'Restart': 'no', 'KillMode': 'control-group', 'NoNewPrivileges': 'yes', 'ProtectSystem': 'strict',
            'ProtectHome': 'yes', 'UnitFileState': 'disabled', 'ActiveState': 'active' if self.active else 'inactive',
            'SubState': 'running' if self.active else 'dead', 'MainPID': '1234' if self.active else '0'}
        values.update(NeedDaemonReload='no', Type='exec', UMask='0077',
            RuntimeDirectory=self.service['unitName'].removesuffix('.service'),
            RuntimeDirectoryMode='0700', RuntimeDirectoryPreserve='no',
            Environment=f"HOME={receipt['home']} CODEX_HOME={receipt['home']}/.codex PATH=/usr/bin:/bin",
            ReadWritePaths=receipt['home'], CapabilityBoundingSet='', AmbientCapabilities='',
            PrivateTmp='yes', ProtectControlGroups='yes', ProtectKernelTunables='yes', ProtectKernelModules='yes',
            RestrictSUIDSGID='yes', RestrictAddressFamilies='AF_INET AF_INET6 AF_UNIX', KillSignal='15',
            TimeoutStopUSec='15s', SendSIGKILL='yes', ExecStartPost='', ExecStop='', ExecStopPost='',
            ExecCondition='', ExecReload='')
        for key in ('ExecStart', 'ExecStartPre'):
            commands = [line.split('=', 1)[1] for line in self.service['content'].splitlines() if line.startswith(key + '=')]
            values[key] = ['{ path=' + line.split(' ', 1)[0] + ' ; argv[]=' + line
                + ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }'
                for line in commands]
        lines = []
        for key, value in values.items():
            if key in starter.EXEC_PROPERTIES:
                if value:
                    lines.extend(key + '=' + item + '\n' for item in value)
            else:
                lines.append(key + '=' + value + '\n')
        return ''.join(lines)

    def run_start(self, control=None):
        with patch.object(starter, 'command', side_effect=control or self.control), \
                patch.object(starter, 'checked_process') as process:
            result = starter.start(self.raw)
        process.assert_called_once_with(1234, self.request, self.service)
        return result

    def test_one_start_and_replay_refusal_without_binding_readiness(self):
        result = self.run_start()
        self.assertEqual(result['phase'], 'service_started')
        self.assertEqual(result['request'], self.request)
        self.assertEqual(self.unit.read_text(), self.service['content'])
        before = (self.root / 'activation.json').read_bytes()
        with patch.object(starter, 'command', side_effect=AssertionError('no replay control command')):
            with self.assertRaises(ValueError):
                starter.start(self.raw)
        self.assertEqual((self.root / 'activation.json').read_bytes(), before)
        self.assertEqual(sum(args[1] == 'start' for args in self.events), 1)
        self.assertFalse(any(args[1] == 'enable' for args in self.events))

    def test_existing_unit_is_preserved(self):
        self.unit.write_text('foreign fixture bytes')
        with patch.object(starter, 'command', side_effect=AssertionError('no control command')):
            with self.assertRaises(ValueError):
                starter.start(self.raw)
        self.assertEqual(self.unit.read_text(), 'foreign fixture bytes')
        self.assertFalse((self.root / 'activation.json').exists())

    def test_unknown_service_state_refused_before_unit_write(self):
        with patch.object(starter, 'command', return_value='LoadState=error\nActiveState=inactive\nMainPID=0\n'):
            with self.assertRaises(ValueError):
                starter.start(self.raw)
        self.assertFalse(self.unit.exists())

    def test_uncertain_start_requests_only_owned_stop_and_retains_journal(self):
        def control(args, timeout=20):
            value = self.control(args, timeout)
            if args[1] == 'start':
                raise TimeoutError('simulated lost start response')
            return value
        with patch.object(starter, 'command', side_effect=control):
            with self.assertRaises(TimeoutError):
                starter.start(self.raw)
        result = json.loads((self.root / 'activation.json').read_bytes())
        self.assertEqual(result['phase'], 'start_failed')
        self.assertEqual(result['cleanup'], 'stop_requested')
        self.assertEqual(sum(args[1] == 'start' for args in self.events), 1)
        self.assertEqual(sum(args[1] == 'stop' for args in self.events), 1)

    def test_replaced_unit_is_not_stopped_or_repaired(self):
        def control(args, timeout=20):
            value = self.control(args, timeout)
            if args[1] == 'start':
                self.unit.write_text('foreign replacement bytes')
            return value
        with patch.object(starter, 'command', side_effect=control):
            with self.assertRaises(ValueError):
                starter.start(self.raw)
        self.assertEqual(self.unit.read_text(), 'foreign replacement bytes')
        self.assertFalse(any(args[1] == 'stop' for args in self.events))
        self.assertEqual(json.loads((self.root / 'activation.json').read_bytes())['cleanup'], 'unconfirmed')

    def test_failed_journal_publication_prevents_start(self):
        original = starter.publish
        def publish(root, record, initial=False, check=lambda: None):
            if record['phase'] == 'start_requested':
                raise OSError('simulated journal persistence failure')
            return original(root, record, initial, check)
        with patch.object(starter, 'command', side_effect=self.control), patch.object(starter, 'publish', side_effect=publish):
            with self.assertRaises(OSError):
                starter.start(self.raw)
        self.assertFalse(any(args[1] == 'start' for args in self.events))

    def test_effective_policy_changes_prevent_start(self):
        # Reuse the valid rendering only as input; mutate each material boundary.
        self.unit.write_text(self.service['content'])
        with patch.object(starter, 'command', side_effect=self.control):
            values = starter.properties(self.service['unitName'])
        for key, replacement in {'NeedDaemonReload': 'yes', 'ExecStart': '{ path=/bin/false ; argv[]=/bin/false ; ignore_errors=no }',
                'ExecStartPre': '', 'ExecStopPost': '/bin/false', 'ProtectSystem': 'no',
                'Environment': 'HOME=/root', 'CapabilityBoundingSet': 'cap_sys_admin',
                'ActiveState': 'active', 'SubState': 'running', 'MainPID': '1234'}.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                starter.checked_properties(dict(values, **{key: replacement}), self.request, self.service, before_start=True)
        for command in (values['ExecStart'] + values['ExecStart'], values['ExecStart'] + ' trailing',
                        values['ExecStart'].replace('ignore_errors=no', 'ignore_errors=yes')):
            with self.assertRaises(ValueError):
                starter.checked_properties(dict(values, ExecStart=command), self.request, self.service)

    def test_systemctl_repeated_exec_lines_and_omitted_empty_arrays(self):
        self.unit.write_text(self.service['content'])
        raw = self.control(['/usr/bin/systemctl', 'show'])
        self.assertEqual(raw.count('\nExecStartPre='), 2)
        self.assertNotIn('ExecStop=', raw)
        with patch.object(starter, 'command', return_value=raw):
            value = starter.properties(self.service['unitName'])
        self.assertEqual(len(starter.command_definitions(value['ExecStartPre'])), 2)
        starter.checked_properties(value, self.request, self.service, before_start=True)
        with patch.object(starter, 'command', return_value=raw + 'MainPID=0\n'), self.assertRaises(ValueError):
            starter.properties(self.service['unitName'])

    def test_activation_after_initial_check_prevents_start(self):
        def control(args, timeout=20):
            value = self.control(args, timeout)
            if args[1] == 'daemon-reload':
                self.active = True
            return value
        with patch.object(starter, 'command', side_effect=control), self.assertRaises(ValueError):
            starter.start(self.raw)
        self.assertFalse(any(args[1] in ('start', 'stop') for args in self.events))

    def test_replaced_journal_preserved_before_start(self):
        def control(args, timeout=20):
            value = self.control(args, timeout)
            if args[1] == 'daemon-reload':
                (self.root / 'activation.json').write_text('foreign journal')
            return value
        with patch.object(starter, 'command', side_effect=control), self.assertRaises(ValueError):
            starter.start(self.raw)
        self.assertEqual((self.root / 'activation.json').read_text(), 'foreign journal')
        self.assertFalse(any(args[1] in ('start', 'stop') for args in self.events))

    def test_replaced_lock_preserved_before_start(self):
        def control(args, timeout=20):
            value = self.control(args, timeout)
            if args[1] == 'daemon-reload':
                (self.root / 'worker.lock').unlink()
                (self.root / 'worker.lock').write_text('foreign lock')
            return value
        with patch.object(starter, 'command', side_effect=control), self.assertRaises(ValueError):
            starter.start(self.raw)
        self.assertEqual((self.root / 'worker.lock').read_text(), 'foreign lock')
        self.assertEqual(json.loads((self.root / 'activation.json').read_bytes())['phase'], 'preparing')
        self.assertFalse(any(args[1] in ('start', 'stop') for args in self.events))

    def test_replaced_root_preserved_before_start(self):
        moved = self.root.with_name(self.root.name + '-original')
        def control(args, timeout=20):
            value = self.control(args, timeout)
            if args[1] == 'daemon-reload':
                self.root.rename(moved)
                self.root.mkdir(mode=0o700)
                (self.root / 'activation.json').write_text('foreign namespace')
            return value
        try:
            with patch.object(starter, 'command', side_effect=control), self.assertRaises(ValueError):
                starter.start(self.raw)
            self.assertEqual((self.root / 'activation.json').read_text(), 'foreign namespace')
            self.assertEqual(json.loads((moved / 'activation.json').read_bytes())['phase'], 'preparing')
            self.assertFalse(any(args[1] in ('start', 'stop') for args in self.events))
        finally:
            if moved.exists():
                for name in ('activation.json', 'worker.lock'):
                    (moved / name).unlink()
                moved.rmdir()

    def test_unreviewed_preflight_never_creates_state(self):
        packet = json.loads(self.raw)
        packet['preflight'] = base64.b64encode(b'not reviewed').decode()
        with self.assertRaises(ValueError):
            starter.start(json.dumps(packet).encode())
        self.assertFalse(self.root.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
