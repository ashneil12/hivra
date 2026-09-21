"""Lifecycle-core checks with actual Sunshine, explicitly substituted systemd.

Run only in the pinned disposable network-none Linux image documented in the
administration runtime receipt. These are not systemd/guest/desktop acceptance.
"""

import hashlib
import base64
import http.client
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'requires isolated Linux root')
class GuardianLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert Path('/.dockerenv').is_file()
        assert all(name == 'lo' or not int(Path('/sys/class/net', name, 'flags').read_text(), 16) & 1
                   for _, name in socket.if_nameindex())
        assert len(Path('/proc/net/route').read_text().splitlines()) == 1
        assert hashlib.sha256(Path('/usr/bin/sunshine').read_bytes()).hexdigest() == (
            'd1cd30c8aa06824801b074de6aadc7ff3f75f9d63a0b69e2cddfb1a15b3f633c')

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hivra-guardian-lifecycle-')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.folder.chmod(0o711)
        self.base = self.folder / 'preparation'
        self.leases = self.folder / 'leases'
        self.base.mkdir(mode=0o711)
        self.leases.mkdir(mode=0o711)
        program = self.folder / 'program'
        program.mkdir()
        for name in ['omarchy-native-supervisor.py', 'omarchy-sunshine-ownership.py']:
            shutil.copyfile(ROOT / 'provisioner' / 'remote-desktop' / name, program / name)
        spec = importlib.util.spec_from_file_location('lifecycle', program / 'omarchy-native-supervisor.py')
        self.guardian = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.guardian)
        identity = pwd.getpwnam('hermes')
        self.binding = {'computerId': str(uuid.uuid4()), 'operationId': str(uuid.uuid4()), 'vmid': 2099,
                        'ownerUid': identity.pw_uid, 'guestPrivateIpv4': '10.240.20.99', 'waylandDisplay': 'wayland-1'}
        self.guardian.prepare(self.binding, self.base)
        self.root = self.base / self.binding['computerId']
        self.originals = {name: (self.root / name).read_bytes() for name in self.guardian.FILES}
        subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-sha256', '-days', '1', '-config', '/dev/null', '-subj', '/CN=lease-client',
                        '-addext', 'basicConstraints=critical,CA:FALSE',
                        '-keyout', str(self.folder / 'client.key'), '-out', str(self.folder / 'client.pem')],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        pem = (self.folder / 'client.pem').read_text()
        sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        self.grant = {'protocol': self.guardian.GRANT_PROTOCOL, 'binding': self.binding,
                      **{key: str(uuid.uuid4()) for key in ('ownerId', 'capabilityGeneration', 'sessionId', 'leaseId', 'clientId')},
                      'observedRevision': 'a' * 64, 'unitSha256': 'b' * 64,
                      'clientCertificatePem': pem, 'clientCertificateSha256': hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest(),
                      'guestBootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                      'expiresAtUnixMs': int(time.time() * 1000) + 8_000,
                      'deadlineBoottimeNs': self.guardian.boottime_ns() + 8_000_000_000,
                      'continuousDeadlineBoottimeNs': self.guardian.boottime_ns() + 43_200_000_000_000,
                      'runtimeMaxUsec': 8_000_000,
                      'sunshineSha256': sha(Path('/usr/bin/sunshine')),
                      'guardianSha256': sha(program / 'omarchy-native-supervisor.py'),
                      'ownershipSha256': sha(program / 'omarchy-sunshine-ownership.py'),
                      'preparedSha256': sha(self.root / 'prepared.json')}
        self.session = self.leases / self.binding['computerId'] / self.grant['leaseId']
        self.context_calls = 0
        self.outcome = []
        self.worker = None
        self.addCleanup(self.cleanup_worker)
        notify = patch.object(self.guardian, 'systemd_notify')
        notify.start()
        self.addCleanup(notify.stop)

    def cleanup_worker(self):
        if self.worker and self.worker.is_alive():
            if self.session.is_dir() and not (self.session / 'revoked.json').exists():
                self.guardian.ownership.write_new(self.session / 'revoked.json', b'{}')
            self.worker.join(12)
            self.assertFalse(self.worker.is_alive(), 'owned guardian worker did not finish')

    def context(self, grant):
        self.context_calls += 1
        return {'unit': self.guardian.guardian_unit_name(grant), 'invocationId': 'test-not-systemd', 'controlGroup': 'substituted'}

    def run_core(self, grant=None, context=None):
        return self.guardian.supervise_lease(grant or self.grant, self.base, self.leases, context or self.context)

    def start_core(self):
        def work():
            try:
                self.outcome.append(self.run_core())
            except Exception as error:
                self.outcome.append(error)
        self.worker = threading.Thread(target=work)
        self.worker.start()
        context = ssl.create_default_context(cafile=str(self.root / 'credentials/cert.pem'))
        context.check_hostname = False
        context.load_cert_chain(str(self.folder / 'client.pem'), str(self.folder / 'client.key'))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.outcome:
                self.fail(str(self.outcome))
            connection = http.client.HTTPSConnection('127.0.0.1', 47984, timeout=.3, context=context)
            try:
                connection.request('GET', '/applist')
                response = connection.getresponse()
                body = response.read()
                if response.status == 200 and b'status_code="200"' in body:
                    ready = self.session / 'readiness/ready.json'
                    marker_deadline = time.monotonic() + 2
                    while time.monotonic() < marker_deadline and not ready.is_file():
                        time.sleep(.02)
                    if ready.is_file():
                        return
            except (OSError, http.client.HTTPException):
                pass
            finally:
                connection.close()
            time.sleep(.1)
        self.fail('actual paired client did not authenticate to owned Sunshine')

    def finish_core(self):
        self.worker.join(10)
        self.assertFalse(self.worker.is_alive())
        for port in (47984, 47989, 47990, 48010):
            with socket.socket() as probe:
                probe.settimeout(.2)
                self.assertNotEqual(probe.connect_ex(('127.0.0.1', port)), 0)
        for name, data in self.originals.items():
            self.assertEqual((self.root / name).read_bytes(), data)

    def test_actual_sunshine_expires_without_claiming_controller_release(self):
        self.start_core()
        self.finish_core()
        self.assertIsInstance(self.outcome[0], dict, str(self.outcome[0]))
        self.assertEqual(self.outcome[0]['reason'], 'expired')
        self.assertTrue(self.outcome[0]['releasePending'])
        self.assertFalse(self.outcome[0]['desktopReady'])
        self.assertTrue((self.session.parent / 'active.json').exists())
        self.assertTrue((self.session / 'consumed.json').exists())
        ready = json.loads((self.session / 'readiness/ready.json').read_text())
        self.assertEqual(ready, self.guardian.sunshine_ready_record(self.root, self.grant))
        self.assertTrue(ready['desktopReady'])
        self.assertTrue(ready['pairingVerified'])
        self.assertNotIn('password', json.dumps(ready).lower())
        self.assertEqual(json.loads((self.session / 'terminal.json').read_text())['reason'], 'expired')
        self.assertEqual(self.context_calls, 2)

    def test_revocation_stops_actual_sunshine_and_replay_or_next_lease_is_held(self):
        self.start_core()
        self.guardian.ownership.write_new(self.session / 'revoked.json', b'{}')
        self.finish_core()
        self.assertEqual(self.outcome[0]['reason'], 'revoked')
        for grant in (self.grant, {**self.grant, 'leaseId': str(uuid.uuid4()), 'sessionId': str(uuid.uuid4())}):
            with self.assertRaises(FileExistsError):
                self.run_core(grant)

    def test_observation_timeout_at_deadline_stops_as_expired(self):
        original = self.guardian.require_paired_client
        def expire_during_observation(root, grant, timeout):
            remaining = (grant['deadlineBoottimeNs'] - self.guardian.boottime_ns()) / 1_000_000_000
            if remaining < .2:
                time.sleep(max(0, remaining) + .01)
                raise TimeoutError('fixture observation reached the lease deadline')
            return original(root, grant, timeout)
        with patch.object(self.guardian, 'require_paired_client', side_effect=expire_during_observation):
            self.start_core()
            self.finish_core()
        self.assertIsInstance(self.outcome[0], dict, str(self.outcome[0]))
        self.assertEqual(self.outcome[0]['reason'], 'expired')

    def test_unexpected_pairing_stops_owned_process_without_deleting_foreign_record(self):
        self.start_core()
        state = self.session / 'state/sunshine_state.json'
        value = json.loads(state.read_text())
        value['root']['named_devices'].append({'name': 'unexpected-fixture'})
        state.write_text(json.dumps(value))
        self.finish_core()
        self.assertIsInstance(self.outcome[0], self.guardian.ownership.Refused)
        self.assertIn('guardian_pairing_changed', str(self.outcome[0]))
        self.assertEqual(json.loads(state.read_text()), value)
        self.assertTrue((self.session.parent / 'active.json').exists())

    def test_expired_or_rebooted_grant_has_no_claim_or_child(self):
        for update in ({'deadlineBoottimeNs': self.guardian.boottime_ns() - 1}, {'guestBootId': str(uuid.uuid4())}):
            with self.assertRaises(self.guardian.ownership.Refused):
                self.run_core({**self.grant, **update})
        self.assertEqual(list(self.leases.iterdir()), [])

    def test_in_memory_client_change_is_detected_even_when_pairing_file_is_read_only(self):
        self.start_core()
        state = self.session / 'state/sunshine_state.json'
        original = state.read_bytes()
        secret = json.loads((self.root / 'admin-secret.json').read_text())
        context = ssl.create_default_context(cafile=str(self.root / 'credentials/cert.pem'))
        context.check_hostname = False
        connection = http.client.HTTPSConnection('127.0.0.1', 47990, timeout=1, context=context)
        auth = base64.b64encode((secret['username'] + ':' + secret['password']).encode()).decode()
        try:
            connection.request('POST', '/api/clients/update',
                body=json.dumps({'uuid': self.grant['clientId'], 'enabled': False}),
                headers={'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth})
            connection.getresponse().read()
        except (OSError, http.client.HTTPException):
            # The guardian can kill the owned service after observing the
            # changed client and before this response is delivered. The exact
            # reason and unchanged file below, not a POST status, are evidence.
            pass
        finally:
            connection.close()
        self.finish_core()
        self.assertIsInstance(self.outcome[0], self.guardian.ownership.Refused)
        self.assertEqual(str(self.outcome[0]), 'guardian_pairing_changed')
        self.assertEqual(state.read_bytes(), original)

    def test_changed_readiness_record_stops_the_owned_process(self):
        self.start_core()
        marker = self.session / 'readiness/ready.json'
        marker.write_text('{"foreign":true}\n')
        self.finish_core()
        self.assertIsInstance(self.outcome[0], self.guardian.ownership.Refused)
        self.assertEqual(str(self.outcome[0]), 'guardian_readiness_changed')
        self.assertEqual(json.loads(marker.read_text()), {'foreign': True})

    def test_real_context_without_installed_unit_refuses_before_consumption(self):
        with self.assertRaises(OSError):
            self.run_core(context=self.guardian.require_guardian_context)
        self.assertEqual(list(self.leases.iterdir()), [])

    def test_pre_spawn_revocation_retains_claim_without_child(self):
        def revoke_on_second_context(grant):
            result = self.context(grant)
            if self.context_calls == 2:
                self.guardian.ownership.write_new(self.session / 'revoked.json', b'{}')
            return result
        with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_grant_revoked_before_spawn'):
            self.run_core(context=revoke_on_second_context)
        self.assertTrue((self.session / 'consumed.json').exists())
        self.assertTrue((self.session.parent / 'active.json').exists())
        self.assertFalse((self.session / 'process.log').exists())

    def test_pre_spawn_pairing_change_retains_claim_and_foreign_record_without_child(self):
        changed = None
        def change_on_second_context(grant):
            nonlocal changed
            result = self.context(grant)
            if self.context_calls == 2:
                state = self.session / 'state/sunshine_state.json'
                changed = json.loads(state.read_text())
                changed['root']['named_devices'].append({'name': 'unexpected-before-spawn'})
                state.write_text(json.dumps(changed))
            return result
        with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_pairing_changed'):
            self.run_core(context=change_on_second_context)
        self.assertTrue((self.session.parent / 'active.json').exists())
        self.assertFalse((self.session / 'process.log').exists())
        self.assertEqual(json.loads((self.session / 'state/sunshine_state.json').read_text()), changed)

    def test_service_uid_cannot_overwrite_or_replace_pairing_authority(self):
        self.start_core()
        identity = pwd.getpwnam('hermes')
        state = self.session / 'state/sunshine_state.json'
        for expression in ('p.read_bytes()', 'p.write_bytes(b"{}")', 'p.unlink()'):
            result = subprocess.run([sys.executable, '-I', '-S', '-c',
                'from pathlib import Path; import sys; p=Path(sys.argv[1]); ' + expression, str(state)],
                user=identity.pw_uid, group=identity.pw_gid, extra_groups=[],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
            self.assertEqual(result.returncode, 0 if expression == 'p.read_bytes()' else 1)
        self.guardian.ownership.write_new(self.session / 'revoked.json', b'{}')
        self.finish_core()
        self.assertEqual(self.outcome[0]['reason'], 'revoked')

    def test_state_parent_cannot_become_service_replaceable_before_spawn(self):
        def change_parent_on_second_context(grant):
            result = self.context(grant)
            if self.context_calls == 2:
                (self.session / 'state').chmod(0o777)
            return result
        with self.assertRaises(self.guardian.ownership.Refused):
            self.run_core(context=change_parent_on_second_context)
        self.assertTrue((self.session.parent / 'active.json').exists())
        self.assertFalse((self.session / 'process.log').exists())
        self.assertEqual((self.session / 'state').stat().st_mode & 0o777, 0o777)

    def test_runtime_source_change_during_context_check_cannot_spawn(self):
        def replace_on_second_context(grant):
            result = self.context(grant)
            if self.context_calls == 2:
                source = Path(self.guardian.__file__)
                source.write_text(source.read_text() + '\n# test-owned changed source\n')
            return result
        with self.assertRaisesRegex(self.guardian.ownership.Refused, 'guardian_runtime_identity_changed'):
            self.run_core(context=replace_on_second_context)
        self.assertTrue((self.session / 'consumed.json').exists())
        self.assertFalse((self.session / 'process.log').exists())

    def test_systemd_duration_formats_are_bounded(self):
        for text, expected in [('4min', 240_000_000_000), ('1min 20s', 80_000_000_000),
                               ('500ms', 500_000_000), ('1.5s', 1_500_000_000), ('5us', 5000)]:
            self.assertEqual(self.guardian.systemd_duration_ns(text), expected)
        for text in ('infinity', '0', '-1s', '5min', '1s 2s', '1s garbage'):
            with self.assertRaises(self.guardian.ownership.Refused):
                self.guardian.systemd_duration_ns(text)

    def test_context_requires_notify_start_boundary_and_rejects_weaker_settings(self):
        name = self.guardian.guardian_unit_name(self.grant)
        group = '/system.slice/' + name
        state = {'Id': name, 'LoadState': 'loaded', 'ActiveState': 'activating', 'SubState': 'start',
                 'MainPID': str(os.getpid()), 'FragmentPath': '/etc/systemd/system/' + name,
                 'DropInPaths': '', 'NeedDaemonReload': 'no', 'User': 'root', 'Type': 'notify',
                 'Restart': 'no', 'KillMode': 'control-group', 'KillSignal': '9', 'SendSIGKILL': 'yes',
                 'NoNewPrivileges': 'no', 'RuntimeRandomizedExtraUSec': '0', 'NotifyAccess': 'main',
                 'InvocationID': '1' * 32, 'ControlGroup': group, 'RuntimeMaxUSec': '4s',
                 'ActiveEnterTimestampMonotonic': '100000000', 'ExecMainStartTimestampMonotonic': '98000000'}
        grant = {**self.grant, 'unitSha256': hashlib.sha256(b'unit').hexdigest(),
                 'deadlineBoottimeNs': 104_000_000_000, 'runtimeMaxUsec': 4_000_000}
        def read(path, *args, **kwargs):
            return self.grant['guestBootId'] if str(path).endswith('boot_id') else '0::' + group + '\n'
        def observe(*args, **kwargs):
            return SimpleNamespace(stdout=('\n'.join(key + '=' + value for key, value in state.items())).encode())
        with patch.object(self.guardian.ownership, 'regular', return_value=(b'unit', None)), \
                patch.object(self.guardian.subprocess, 'run', side_effect=observe), \
                patch.object(Path, 'read_text', read), patch.dict(os.environ, {'INVOCATION_ID': '1' * 32}), \
                patch.object(self.guardian, 'boottime_ns', return_value=100_000_000_000), \
                patch.object(self.guardian.time, 'monotonic_ns', return_value=100_000_000_000):
            self.assertEqual(self.guardian.require_guardian_context(grant)['controlGroup'], group)
            for key, value in [('RuntimeMaxUSec', '6s'), ('RuntimeRandomizedExtraUSec', '1s'),
                               ('NotifyAccess', 'all'), ('Type', 'exec')]:
                previous = state[key]
                state[key] = value
                with self.assertRaises(self.guardian.ownership.Refused):
                    self.guardian.require_guardian_context(grant)
                state[key] = previous


if __name__ == '__main__':
    unittest.main()
