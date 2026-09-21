"""Deterministic systemd activation contracts for the Omarchy guardian."""

import hashlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import uuid
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'provisioner/remote-desktop/omarchy-native-supervisor.py'
spec = importlib.util.spec_from_file_location('guardian_unit', SCRIPT)
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)


class GuardianUnitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hivra-guardian-unit-')
        self.addCleanup(self.temporary.cleanup)
        folder = Path(self.temporary.name)
        self.base = folder / 'preparation'
        self.leases = folder / 'leases'
        self.units = folder / 'units'
        for path in (self.base, self.leases, self.units):
            path.mkdir(mode=0o700)
        self.binding = {'computerId': str(uuid.uuid4()), 'operationId': str(uuid.uuid4()),
                        'vmid': 2099, 'ownerUid': 1000,
                        'guestPrivateIpv4': '10.240.20.99', 'waylandDisplay': 'wayland-1'}
        root = self.base / self.binding['computerId']
        root.mkdir(mode=0o700)
        (root / 'intent.json').write_text('{}')
        (root / 'intent.json').chmod(0o600)
        self.grant = {'protocol': guardian.GRANT_PROTOCOL, 'binding': self.binding,
                      **{key: str(uuid.uuid4()) for key in
                         ('ownerId', 'capabilityGeneration', 'sessionId', 'leaseId', 'clientId')},
                      'observedRevision': 'a' * 64, 'clientCertificatePem': 'certificate-fixture',
                      'clientCertificateSha256': 'b' * 64,
                      'guestBootId': str(uuid.uuid4()), 'expiresAtUnixMs': 1_788_847_440_000,
                      'deadlineBoottimeNs': 200_000_000_000,
                      'continuousDeadlineBoottimeNs': 43_000_000_000_000,
                      'runtimeMaxUsec': 90_000_000, 'sunshineSha256': 'c' * 64,
                      'guardianSha256': 'd' * 64, 'ownershipSha256': 'e' * 64,
                      'preparedSha256': 'f' * 64, 'unitSha256': '0' * 64}

    def test_unit_is_root_guarded_unrestartable_and_deadline_bounded(self):
        unit = guardian.guardian_unit(self.grant, SCRIPT)
        self.assertIn('Type=notify\nUser=root\n', unit)
        self.assertIn('Restart=no\nKillMode=control-group\nKillSignal=SIGKILL\n', unit)
        self.assertIn('RuntimeMaxSec=90000000us\n', unit)
        self.assertIn('NoNewPrivileges=no\n', unit)
        self.assertIn('NotifyAccess=main\n', unit)
        self.assertNotIn(self.grant['clientCertificatePem'], unit)
        self.assertNotIn(self.binding['guestPrivateIpv4'], unit)
        self.assertEqual(unit.count('ExecStart='), 1)
        self.assertTrue(unit.endswith('\n'))

    def test_unit_rejects_unbounded_runtime(self):
        for value in (0, -1, 240_000_001, 1.5, '90000000'):
            with self.assertRaises(guardian.ownership.Refused):
                guardian.guardian_unit({**self.grant, 'runtimeMaxUsec': value}, SCRIPT)

    def test_activation_writes_exact_grant_and_unit_before_one_start(self):
        unit = guardian.guardian_unit(self.grant, SCRIPT)
        self.grant['unitSha256'] = hashlib.sha256(unit.encode()).hexdigest()
        commands = []

        def command(args, **_kwargs):
            commands.append(args)
            if args[1] == 'start':
                with (self.base / self.binding['computerId'] / 'intent.json').open() as stream:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return SimpleNamespace(returncode=0, stdout=b'', stderr=b'')

        with patch.object(guardian, 'lease_grant', side_effect=lambda value: dict(value)), \
                patch.object(guardian, 'check_grant_clock', return_value=100_000_000_000), \
                patch.object(guardian, 'verify_activation_sources'), \
                patch.object(guardian, 'require_closed_guardian_listeners') as listeners, \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian.sys, 'platform', 'linux'), \
                patch.object(guardian.subprocess, 'run', side_effect=command):
            result = guardian.activate_lease(
                self.grant, self.base, self.leases, self.units, SCRIPT, os.getuid(),
            )

        unit_path = self.units / guardian.guardian_unit_name(self.grant)
        grant_path = self.leases / '.grants' / (self.grant['sessionId'] + '.json')
        self.assertEqual(unit_path.read_text(), unit)
        self.assertEqual(json.loads(grant_path.read_text()), self.grant)
        self.assertEqual(commands, [
            ['/usr/bin/systemctl', 'daemon-reload'],
            ['/usr/bin/systemctl', 'start', guardian.guardian_unit_name(self.grant)],
        ])
        self.assertEqual(result, {'sessionId': self.grant['sessionId'],
                                  'leaseId': self.grant['leaseId'],
                                  'activation': 'started', 'desktopReady': False})
        listeners.assert_called_once_with()

        with patch.object(guardian, 'lease_grant', side_effect=lambda value: dict(value)), \
                patch.object(guardian, 'check_grant_clock', return_value=100_000_000_000), \
                patch.object(guardian, 'verify_activation_sources'), \
                patch.object(guardian, 'require_closed_guardian_listeners'), \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian.sys, 'platform', 'linux'):
            with self.assertRaises(FileExistsError):
                guardian.activate_lease(self.grant, self.base, self.leases, self.units, SCRIPT, os.getuid())

    def test_start_failure_leaves_durable_non_replayable_evidence(self):
        unit = guardian.guardian_unit(self.grant, SCRIPT)
        self.grant['unitSha256'] = hashlib.sha256(unit.encode()).hexdigest()
        calls = 0

        def command(args, **_kwargs):
            nonlocal calls
            calls += 1
            return SimpleNamespace(returncode=0 if calls == 1 else 1, stdout=b'', stderr=b'failure')

        with patch.object(guardian, 'lease_grant', side_effect=lambda value: dict(value)), \
                patch.object(guardian, 'check_grant_clock', return_value=100_000_000_000), \
                patch.object(guardian, 'verify_activation_sources'), \
                patch.object(guardian, 'require_closed_guardian_listeners'), \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian.sys, 'platform', 'linux'), \
                patch.object(guardian.subprocess, 'run', side_effect=command):
            with self.assertRaisesRegex(guardian.ownership.Refused, 'guardian_start_failed'):
                guardian.activate_lease(self.grant, self.base, self.leases, self.units, SCRIPT, os.getuid())
        self.assertTrue((self.leases / '.grants' / (self.grant['sessionId'] + '.json')).exists())
        self.assertTrue((self.units / guardian.guardian_unit_name(self.grant)).exists())

    def active_lease(self):
        computer = self.leases / self.binding['computerId']
        session = computer / self.grant['leaseId']
        computer.mkdir(mode=0o700)
        session.mkdir(mode=0o700)
        claim = {'leaseId': self.grant['leaseId'], 'sessionId': self.grant['sessionId'],
                 'context': {'unit': guardian.guardian_unit_name(self.grant),
                             'invocationId': '1' * 32,
                             'controlGroup': '/system.slice/' + guardian.guardian_unit_name(self.grant)}}
        guardian.ownership.write_new(computer / 'active.json', guardian.ownership.encoded(claim), 0o400)
        guardian.ownership.write_new(session / 'consumed.json', guardian.ownership.encoded(self.grant), 0o400)
        return computer, session, claim

    def renewal(self, count=1, deadline=300_000_000_000):
        return {'protocol': guardian.RENEWAL_PROTOCOL, 'sessionId': self.grant['sessionId'],
                'leaseId': self.grant['leaseId'],
                'capabilityGeneration': self.grant['capabilityGeneration'],
                'guestBootId': self.grant['guestBootId'], 'renewalId': str(uuid.uuid4()),
                'renewalCount': count, 'deadlineBoottimeNs': deadline,
                'continuousDeadlineBoottimeNs': self.grant['continuousDeadlineBoottimeNs']}

    def test_renewal_is_sequential_idempotent_and_applied_only_after_pid1_notify(self):
        _computer, session, _claim = self.active_lease()
        for path in (session / 'renewals', session / 'renewals/requested', session / 'renewals/applied'):
            path.mkdir(mode=0o700)
        first = self.renewal()
        envelope = {'grant': self.grant, 'renewal': first}
        with patch.object(guardian, 'lease_grant', side_effect=lambda value: dict(value)), \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian.sys, 'platform', 'linux'), \
                patch.object(Path, 'read_text', return_value=self.grant['guestBootId']), \
                patch.object(guardian, 'boottime_ns', return_value=100_000_000_000):
            accepted = guardian.renew_lease(envelope, self.base, self.leases, os.getuid())
            self.assertEqual(guardian.renew_lease(
                envelope, self.base, self.leases, os.getuid()), accepted)
            notifications = []
            count, deadline, applied = guardian.consume_next_renewal(
                session, self.grant, 0, self.grant['deadlineBoottimeNs'],
                notifications.append, os.getuid())
        self.assertEqual((count, deadline, applied), (1, first['deadlineBoottimeNs'], True))
        self.assertEqual(notifications, ['EXTEND_TIMEOUT_USEC=200000000'])
        self.assertEqual(json.loads((session / 'renewals/applied/001.json').read_text()), first)

    def test_renewal_cannot_skip_the_last_applied_deadline(self):
        _computer, session, _claim = self.active_lease()
        for path in (session / 'renewals', session / 'renewals/requested', session / 'renewals/applied'):
            path.mkdir(mode=0o700)
        second = self.renewal(2, 400_000_000_000)
        with patch.object(guardian, 'lease_grant', side_effect=lambda value: dict(value)), \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian.sys, 'platform', 'linux'), \
                patch.object(Path, 'read_text', return_value=self.grant['guestBootId']), \
                patch.object(guardian, 'boottime_ns', return_value=100_000_000_000):
            with self.assertRaises(FileNotFoundError):
                guardian.renew_lease(
                    {'grant': self.grant, 'renewal': second}, self.base, self.leases, os.getuid())

    def test_revoke_requests_exact_active_lease_and_is_idempotent(self):
        computer, session, claim = self.active_lease()
        with patch.object(guardian, 'lease_grant', side_effect=lambda value: dict(value)), \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian.sys, 'platform', 'linux'), \
                patch.object(Path, 'read_text', return_value=self.grant['guestBootId']):
            # The real lifecycle holds this lock until Sunshine exits. Revoke
            # must remain callable during that exact interval.
            with guardian.ownership.operation_lock(
                    self.base / self.binding['computerId'], os.getuid()):
                first = guardian.revoke_lease(self.grant, self.base, self.leases, os.getuid())
            second = guardian.revoke_lease(self.grant, self.base, self.leases, os.getuid())
        self.assertEqual(first, second)
        self.assertEqual(first['revocation'], 'requested')
        self.assertTrue(first['releasePending'])
        self.assertFalse(first['desktopReady'])
        self.assertEqual(json.loads((session / 'revoked.json').read_text()), {
            'leaseId': self.grant['leaseId'], 'sessionId': self.grant['sessionId'],
            'reason': 'control-plane-revoked',
        })
        self.assertEqual(json.loads((computer / 'active.json').read_text()), claim)

    def test_revoke_rejects_changed_grant_claim_or_boot_without_replacing_evidence(self):
        computer, session, claim = self.active_lease()
        cases = [
            ({**self.grant, 'ownerId': str(uuid.uuid4())}, claim, self.grant['guestBootId'],
             'guardian_consumed_grant_changed'),
            (self.grant, {**claim, 'leaseId': str(uuid.uuid4())}, self.grant['guestBootId'],
             'guardian_revoke_claim_mismatch'),
            (self.grant, claim, str(uuid.uuid4()), 'guardian_revoke_boot_changed'),
        ]
        for value, active, boot, error in cases:
            (computer / 'active.json').chmod(0o600)
            (computer / 'active.json').write_bytes(guardian.ownership.encoded(active))
            (computer / 'active.json').chmod(0o400)
            with patch.object(guardian, 'lease_grant', side_effect=lambda candidate: dict(candidate)), \
                    patch.object(guardian.os, 'geteuid', return_value=0), \
                    patch.object(guardian.sys, 'platform', 'linux'), \
                    patch.object(Path, 'read_text', return_value=boot):
                with self.assertRaisesRegex(guardian.ownership.Refused, error):
                    guardian.revoke_lease(value, self.base, self.leases, os.getuid())
            self.assertFalse((session / 'revoked.json').exists())

    def test_revoke_recovers_idempotently_after_the_claim_was_already_released(self):
        _computer, _session, _claim = self.active_lease()
        (self.leases / self.binding['computerId'] / 'active.json').unlink()
        with patch.object(guardian, 'lease_grant', side_effect=lambda value: dict(value)), \
                patch.object(guardian, 'observe_released_lease') as released, \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian.sys, 'platform', 'linux'):
            result = guardian.revoke_lease(self.grant, self.base, self.leases, os.getuid())
        released.assert_called_once_with(self.grant, self.base, self.leases, os.getuid())
        self.assertFalse(result['releasePending'])
        self.assertEqual(result['revocation'], 'requested')


if __name__ == '__main__':
    unittest.main()
