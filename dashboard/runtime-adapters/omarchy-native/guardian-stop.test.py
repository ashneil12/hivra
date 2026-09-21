"""Stop-observer contracts; systemd/cgroup are fixtures, socket checks are real."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('lifecycle_fixtures', Path(__file__).with_name('guardian-lifecycle.test.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'requires isolated Linux root')
class StopObserverTests(unittest.TestCase):
    setUpClass = classmethod(lambda cls: fixtures.GuardianLifecycleTests.setUpClass())
    cleanup_worker = fixtures.GuardianLifecycleTests.cleanup_worker

    def setUp(self):
        fixtures.GuardianLifecycleTests.setUp(self)
        self.session.parent.mkdir(mode=0o711)
        self.session.mkdir(mode=0o711)
        self.name = self.guardian.guardian_unit_name(self.grant)
        self.group = '/system.slice/' + self.name
        self.grant['unitSha256'] = hashlib.sha256(b'fixture-unit').hexdigest()
        self.grant = self.guardian.lease_grant(self.grant)
        self.claim = {'leaseId': self.grant['leaseId'], 'sessionId': self.grant['sessionId'],
                      'context': {'unit': self.name, 'controlGroup': self.group, 'invocationId': '1' * 32}}
        self.guardian.ownership.write_new(self.session.parent / 'active.json', self.guardian.ownership.encoded(self.claim))
        self.guardian.ownership.write_new(self.session / 'consumed.json', self.guardian.ownership.encoded(self.grant))
        self.state = {'Id': self.name, 'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
                      'MainPID': '0', 'Restart': 'no', 'InvocationID': '1' * 32,
                      'FragmentPath': '/etc/systemd/system/' + self.name,
                      'DropInPaths': '', 'NeedDaemonReload': 'no', 'ControlGroup': ''}
        regular = self.guardian.ownership.regular
        def unit_file(path, *args, **kwargs):
            if str(path) == self.state['FragmentPath']:
                return b'fixture-unit', None
            return regular(path, *args, **kwargs)
        self.addCleanup(patch.stopall)
        patch.object(self.guardian.ownership, 'regular', side_effect=unit_file).start()
        self.unit_probe = patch.object(self.guardian, 'read_guardian_stop_state', side_effect=lambda name: dict(self.state)).start()
        self.cgroup_probe = patch.object(self.guardian, 'require_empty_guardian_cgroup').start()

    def observe(self):
        return self.guardian.observe_lease_stop(self.grant, self.base, self.leases)

    def test_exact_stopped_invocation_is_observed_without_releasing_or_changing_files(self):
        before = {path: path.read_bytes() for path in self.folder.rglob('*') if path.is_file()}
        result = self.observe()
        self.assertTrue(result['ownedProcessBoundaryStopped'])
        self.assertTrue(result['releasePending'])
        self.assertFalse(result['desktopReady'])
        self.assertEqual(before, {path: path.read_bytes() for path in self.folder.rglob('*') if path.is_file()})
        self.cgroup_probe.assert_called_once_with(self.group)
        self.assertEqual(self.unit_probe.call_count, 2)

    def test_release_moves_exact_claim_and_retains_audit_evidence(self):
        result = self.guardian.release_stopped_lease(self.grant, self.base, self.leases)
        self.assertTrue(result['controllerReleased'])
        self.assertFalse(result['releasePending'])
        self.assertFalse((self.session.parent / 'active.json').exists())
        self.assertEqual(json.loads((self.session / 'released-claim.json').read_text()), self.claim)
        self.assertEqual(json.loads((self.session / 'release-authorized.json').read_text())['invocationId'], '1' * 32)
        self.assertTrue(json.loads((self.session / 'released.json').read_text())['controllerReleased'])
        self.assertTrue((self.session / 'consumed.json').exists())
        self.assertEqual(self.guardian.release_stopped_lease(self.grant, self.base, self.leases), result)

    def test_running_changed_collected_or_restarting_unit_is_held(self):
        for update in ({'MainPID': '55'}, {'ActiveState': 'active', 'SubState': 'running'},
                       {'LoadState': 'not-found'}, {'InvocationID': '2' * 32}, {'InvocationID': ''},
                       {'Restart': 'always'}, {'NeedDaemonReload': 'yes'}, {'DropInPaths': '/foreign'},
                       {'ControlGroup': '/foreign'}):
            original = dict(self.state)
            self.state.update(update)
            with self.assertRaises(self.guardian.ownership.Refused, msg=str(update)):
                self.observe()
            self.state = original

    def test_unit_change_during_socket_observation_is_held(self):
        original = self.guardian.require_closed_guardian_listeners
        def changing():
            original()
            self.state['InvocationID'] = '2' * 32
        with patch.object(self.guardian, 'require_closed_guardian_listeners', side_effect=changing):
            with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_stop_state_changed'):
                self.observe()

    def test_claim_change_during_observation_is_preserved_and_held(self):
        def changing(group):
            (self.session.parent / 'active.json').write_text('{"foreign":true}')
        self.cgroup_probe.side_effect = changing
        with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_stop_identity_changed'):
            self.observe()
        self.assertEqual(json.loads((self.session.parent / 'active.json').read_text()), {'foreign': True})

    def test_rebooted_original_grant_is_held(self):
        original = Path.read_text
        def reboot(path, *args, **kwargs):
            return '00000000-0000-4000-8000-000000000001' if str(path).endswith('/boot_id') else original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', reboot):
            with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_stop_boot_changed'):
                self.observe()

    def test_actual_tcp_and_udp_ipv4_and_ipv6_sockets_hold_teardown(self):
        for family, address in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
            for kind, port in ((socket.SOCK_STREAM, 47990), (socket.SOCK_DGRAM, 48000)):
                with socket.socket(family, kind) as listener:
                    listener.bind((address, port))
                    if kind == socket.SOCK_STREAM:
                        listener.listen(1)
                    with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_listener_still_present'):
                        self.observe()
                self.assertTrue(self.observe()['ownedProcessBoundaryStopped'])

    def test_missing_socket_observation_is_not_absence(self):
        original = Path.read_text
        def missing(path, *args, **kwargs):
            if str(path) == '/proc/net/udp6':
                raise FileNotFoundError('fixture missing observation')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', missing):
            with self.assertRaises(FileNotFoundError):
                self.observe()

    def test_changed_grant_cannot_observe_another_lease(self):
        self.grant['ownerId'] = '00000000-0000-4000-8000-000000000001'
        with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_consumed_grant_changed'):
            self.observe()

    def test_cleared_inactive_invocation_requires_exact_journal_terminal(self):
        self.state['InvocationID'] = ''
        (self.session / 'terminal.json').write_bytes(self.guardian.ownership.encoded({
            'leaseId': self.grant['leaseId'], 'sessionId': self.grant['sessionId'],
            'reason': 'expired', 'releasePending': True, 'desktopReady': False,
        }))
        with patch.object(self.guardian, 'require_stopped_invocation_journal') as journal:
            self.assertTrue(self.observe()['ownedProcessBoundaryStopped'])
        journal.assert_called_once_with(self.name, '1' * 32, self.session, self.grant)

    def test_cleared_invocation_without_terminal_is_a_controlled_hold(self):
        self.state['InvocationID'] = ''
        with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_invocation_journal_invalid'):
            self.observe()


class CgroupStopContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('stop_module', Path(__file__).resolve().parents[2] / 'provisioner/remote-desktop/omarchy-native-supervisor.py')
        cls.guardian = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.guardian)

    def test_cgroup_populated_is_recursive_evidence_not_top_level_pid_list(self):
        with patch.object(self.guardian.ownership, 'directory'), patch.object(Path, 'read_text', return_value='populated 1\nfrozen 0\n'):
            with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_cgroup_not_empty'):
                self.guardian.require_empty_guardian_cgroup('/system.slice/fixture.service')
        with patch.object(self.guardian.ownership, 'directory'), patch.object(Path, 'read_text', return_value='populated 0\nfrozen 0\n'):
            self.guardian.require_empty_guardian_cgroup('/system.slice/fixture.service')

    def test_missing_hierarchy_is_not_empty_cgroup(self):
        with patch.object(Path, 'read_text', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                self.guardian.require_empty_guardian_cgroup('/system.slice/fixture.service')


if __name__ == '__main__':
    unittest.main()
