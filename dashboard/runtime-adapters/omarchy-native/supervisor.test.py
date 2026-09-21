import importlib.util
import hashlib
import json
import os
import subprocess
import ssl
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'provisioner/remote-desktop/omarchy-native-supervisor.py'
spec = importlib.util.spec_from_file_location('guardian', SCRIPT)
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)


class GuardianPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hivra-native-v3-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.base.chmod(0o711)
        self.owner = os.getuid()
        self.uid = self.owner if self.owner >= 100 else 1000
        self.gid = os.getgid() or 1000
        self.request = {'computerId': '11111111-1111-4111-8111-111111111111',
                        'operationId': '22222222-2222-4222-8222-222222222222',
                        'vmid': 2099, 'ownerUid': self.uid,
                        'guestPrivateIpv4': '10.240.20.99', 'waylandDisplay': 'wayland-1'}
        self.root = self.base / self.request['computerId']
        for target, name, value in [(guardian.pwd, 'getpwuid', lambda uid: SimpleNamespace(pw_gid=self.gid)),
                                    (guardian.ownership, 'service_groups', lambda uid, gid: [gid])]:
            mocked = patch.object(target, name, value)
            mocked.start()
            self.addCleanup(mocked.stop)

    def prepare(self):
        return guardian.prepare(self.request, self.base, self.owner)

    def observe(self):
        return guardian.observe(self.request, self.base, self.owner)

    def test_pinned_sunshine_hash_uses_reverse_byte_order_and_uppercase(self):
        # SHA-256 standard abc vector, encoded by pinned util::Hex rev=false.
        self.assertEqual(guardian.sunshine_password('abc', ''),
                         'AD1500F261FF10B49C7A1796A36103B02322AE5DDE404141EACF018FBF1678BA')
        self.assertEqual(guardian.sunshine_password('a', 'bc'), guardian.sunshine_password('abc', ''))

    def test_grant_accepts_clerk_owner_identity_and_rejects_unsafe_owner_text(self):
        with patch.object(guardian, 'client_certificate', return_value='certificate'):
            grant = {
                'protocol': guardian.GRANT_PROTOCOL, 'binding': self.request,
                'ownerId': 'user_0000000000000000',
                **{key: '11111111-1111-4111-8111-111111111111' for key in
                   ('capabilityGeneration', 'sessionId', 'leaseId', 'clientId', 'guestBootId')},
                **{key: 'a' * 64 for key in ('observedRevision', 'sunshineSha256',
                   'guardianSha256', 'ownershipSha256', 'preparedSha256', 'unitSha256',
                   'clientCertificateSha256')},
                'clientCertificatePem': 'certificate', 'expiresAtUnixMs': 1,
                'deadlineBoottimeNs': 1, 'continuousDeadlineBoottimeNs': 2,
                'runtimeMaxUsec': 1,
            }
            self.assertEqual(guardian.lease_grant(grant)['ownerId'], grant['ownerId'])
            for owner in ('', 'contains space', '../owner', 'x' * 257):
                with self.assertRaises(guardian.ownership.Refused):
                    guardian.lease_grant({**grant, 'ownerId': owner})

    def test_only_pre_authentication_admin_readiness_can_retry_during_startup(self):
        transient = guardian.ownership.Refused('guardian_pairing_observation_failed')
        changed = guardian.ownership.Refused('guardian_pairing_changed')
        self.assertTrue(guardian.pairing_observation_may_retry(transient, False, 9, 10))
        self.assertFalse(guardian.pairing_observation_may_retry(transient, True, 9, 10))
        self.assertFalse(guardian.pairing_observation_may_retry(transient, False, 10, 10))
        self.assertFalse(guardian.pairing_observation_may_retry(changed, False, 9, 10))

    def test_native_sunshine_child_receives_only_existing_capture_device_groups(self):
        groups = {'video': 983, 'render': 987}
        with patch.object(guardian.ownership, 'service_groups', return_value=[self.gid, 998]), \
                patch.object(guardian.grp, 'getgrnam', side_effect=lambda name: SimpleNamespace(gr_gid=groups[name])):
            self.assertEqual(
                guardian.capture_service_groups(self.uid, self.gid),
                sorted({self.gid, 998, 983, 987}),
            )

        with patch.object(guardian.ownership, 'service_groups', return_value=[self.gid]), \
                patch.object(guardian.grp, 'getgrnam', side_effect=KeyError):
            self.assertEqual(guardian.capture_service_groups(self.uid, self.gid), [self.gid])

    def test_ready_record_contains_only_public_grant_bound_server_identity(self):
        pem = ssl.DER_cert_to_PEM_cert(b'fixture-server-certificate')
        grant = {
            'sessionId': '33333333-3333-4333-8333-333333333333',
            'leaseId': '44444444-4444-4444-8444-444444444444',
            'guestBootId': '55555555-5555-4555-8555-555555555555',
            'capabilityGeneration': '66666666-6666-4666-8666-666666666666',
            'observedRevision': 'a' * 64,
            'binding': self.request,
        }
        with patch.object(guardian.ownership, 'regular', return_value=(pem.encode(), None)):
            ready = guardian.sunshine_ready_record(self.root, grant)
        self.assertTrue(ready['desktopReady'])
        self.assertTrue(ready['pairingVerified'])
        self.assertEqual(ready['serverId'], self.request['computerId'])
        self.assertEqual(ready['guestPrivateIpv4'], self.request['guestPrivateIpv4'])
        self.assertEqual(ready['serverCertificatePem'], pem)
        self.assertEqual(ready['serverCertificateSha256'],
                         hashlib.sha256(b'fixture-server-certificate').hexdigest())
        self.assertNotIn('password', json.dumps(ready).lower())

    def test_private_admin_is_prepared_before_any_activation_exists(self):
        result = self.prepare()
        self.assertEqual(self.observe(), result)
        self.assertTrue(result['administrationPrepared'])
        self.assertFalse(result['desktopReady'])
        self.assertEqual(result['activation'], 'forbidden')
        secret = json.loads((self.root / 'admin-secret.json').read_bytes())
        auth = json.loads((self.root / 'credentials/admin.json').read_bytes())
        self.assertTrue(auth['username'])
        self.assertEqual(auth['password'], guardian.sunshine_password(secret['password'], auth['salt']))
        self.assertNotIn(secret['password'], json.dumps(result))
        self.assertNotIn(secret['password'], (self.root / 'prepared.json').read_text())
        self.assertNotIn(secret['password'], (self.root / 'sunshine.conf').read_text())
        self.assertIn('capture = kms\nencoder = software\n',
                      (self.root / 'sunshine.conf').read_text())
        self.assertIn('sw_preset = ultrafast\nsw_tune = zerolatency\n',
                      (self.root / 'sunshine.conf').read_text())
        self.assertEqual(list((self.root / 'state').iterdir()), [])
        self.assertEqual(list(self.base.glob('*.service')), [])
        self.assertFalse((self.root / 'lease-authorized').exists())
        self.assertIn('credentials_file = ' + str(self.root / 'credentials/admin.json'),
                      (self.root / 'sunshine.conf').read_text())
        for name, uid in [('admin-secret.json', self.owner), ('credentials/admin.json', self.uid)]:
            info = (self.root / name).stat()
            self.assertEqual(info.st_uid, uid)
            self.assertEqual(info.st_mode & 0o777, 0o400)

    def test_another_prepare_never_replaces_owned_credentials(self):
        self.prepare()
        before = (self.root / 'admin-secret.json').read_bytes()
        self.assertEqual(self.prepare()['binding'], self.request)
        self.assertEqual((self.root / 'admin-secret.json').read_bytes(), before)

    def test_completed_namespace_is_retired_for_a_new_operation(self):
        self.prepare()
        previous = self.root / 'admin-secret.json'
        before = previous.read_bytes()
        next_request = {**self.request,
                        'operationId': '77777777-7777-4777-8777-777777777777'}
        result = guardian.prepare(next_request, self.base, self.owner)
        self.assertEqual(result['binding']['operationId'], next_request['operationId'])
        self.assertNotEqual((self.root / 'admin-secret.json').read_bytes(), before)
        retired = list(self.base.glob(self.request['computerId'] + '.superseded-*'))
        self.assertEqual(len(retired), 1)
        self.assertEqual((retired[0] / 'admin-secret.json').read_bytes(), before)

    @unittest.skipUnless(sys.platform == 'linux' and os.getuid() == 0, 'requires real Linux UID separation')
    def test_service_reads_hash_but_not_plain_admin_password(self):
        self.prepare()
        for name, expected in [('credentials/admin.json', 0), ('admin-secret.json', 1)]:
            result = subprocess.run([sys.executable, '-I', '-S', '-c',
                                     'import pathlib,sys; pathlib.Path(sys.argv[1]).read_bytes()',
                                     str(self.root / name)],
                                    user=self.uid, group=self.gid, extra_groups=[self.gid],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=5,
                                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
            self.assertEqual(result.returncode, expected)

    def test_probe_cannot_publish_after_pairing_state_appears(self):
        self.prepare()
        with patch.object(guardian.ownership, 'require_service_traversal',
                          side_effect=lambda *args: (self.root / 'state/client.json').write_text('{}')):
            with self.assertRaisesRegex(guardian.ownership.Refused, 'guardian_preparation_not_inactive'):
                self.observe()

    def test_failed_bootstrap_cannot_be_adopted_or_started(self):
        with patch.object(guardian.secrets, 'token_hex', side_effect=RuntimeError('interruption')):
            with self.assertRaises(RuntimeError):
                self.prepare()
        self.assertFalse((self.root / 'prepared.json').exists())
        with self.assertRaises(FileNotFoundError):
            self.observe()
        with self.assertRaises(FileExistsError):
            self.prepare()

    def test_namespace_replacement_before_lock_is_not_adopted(self):
        original_write = guardian.ownership.write_new
        original_root = self.base / 'original-root'
        def replace_after_intent(path, data, *args, **kwargs):
            original_write(path, data, *args, **kwargs)
            if path.name == 'intent.json':
                self.root.rename(original_root)
                self.root.mkdir(mode=0o711)
                original_write(self.root / 'intent.json', data)
        with patch.object(guardian.ownership, 'write_new', side_effect=replace_after_intent):
            with self.assertRaisesRegex(guardian.ownership.Refused, 'owned_directory_replaced'):
                self.prepare()
        self.assertEqual({p.name for p in self.root.iterdir()}, {'intent.json'})
        self.assertEqual({p.name for p in original_root.iterdir()}, {'intent.json'})

    def test_changed_operation_is_not_the_original_preparation(self):
        self.prepare()
        other = {**self.request, 'operationId': '33333333-3333-4333-8333-333333333333'}
        with self.assertRaisesRegex(guardian.ownership.Refused, 'guardian_preparation_mismatch'):
            guardian.observe(other, self.base, self.owner)

    def test_widened_secret_permissions_are_rejected(self):
        self.prepare()
        (self.root / 'admin-secret.json').chmod(0o440)
        with self.assertRaisesRegex(guardian.ownership.Refused, 'owned_file_replaced'):
            self.observe()

    def test_empty_or_changed_credentials_cannot_be_observed(self):
        self.prepare()
        target = self.root / 'credentials/admin.json'
        target.chmod(0o600)
        target.write_text('{"username":"","password":"","salt":""}')
        target.chmod(0o400)
        with self.assertRaisesRegex(guardian.ownership.Refused, 'owned_file_replaced'):
            self.observe()

    def test_pairing_or_activation_residue_is_not_preparation_evidence(self):
        self.prepare()
        (self.root / 'state/unexpected-client.json').write_text('{}')
        with self.assertRaisesRegex(guardian.ownership.Refused, 'guardian_preparation_not_inactive'):
            self.observe()

    def test_replaced_key_symlink_is_rejected_without_touching_target(self):
        self.prepare()
        outside = self.base / 'unrelated'
        outside.write_text('preserve')
        key = self.root / 'credentials/key.pem'
        key.unlink()
        key.symlink_to(outside)
        with self.assertRaises(OSError):
            self.observe()
        self.assertEqual(outside.read_text(), 'preserve')


@unittest.skipUnless(sys.platform == 'linux', 'client certificate policy uses the Linux guest OpenSSL')
class GuardianClientCertificateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='guardian-client-cert-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def certificate(self, extensions=('basicConstraints=critical,CA:FALSE',), version_one=False):
        key, cert = self.base / 'key.pem', self.base / 'cert.pem'
        args = ['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-sha256', '-days', '1', '-config', '/dev/null', '-subj', '/CN=isolated-client',
                '-keyout', str(key), '-out', str(cert)]
        if version_one:
            args += ['-x509v1']
        for extension in extensions:
            args += ['-addext', extension]
        subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        pem = cert.read_text()
        digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
        return pem, digest

    def test_accepts_non_ca_self_signed_certificate_bound_to_der_hash(self):
        for extensions in (('basicConstraints=critical,CA:FALSE',),
                           ('basicConstraints=critical,CA:FALSE', 'keyUsage=digitalSignature')):
            pem, digest = self.certificate(extensions)
            self.assertEqual(guardian.client_certificate(pem, digest), pem)

    def test_rejects_ca_certificate_that_sunshine_would_trust_as_an_issuer(self):
        pem, digest = self.certificate(('basicConstraints=critical,CA:TRUE',))
        with self.assertRaisesRegex(guardian.ownership.Refused, 'client_certificate_can_sign'):
            guardian.client_certificate(pem, digest)

    def test_rejects_legacy_ca_inference_and_missing_explicit_non_ca_constraint(self):
        for extensions, version_one in [((), True), (('nsCertType=sslCA',), False), ((), False)]:
            pem, digest = self.certificate(extensions, version_one)
            with self.assertRaisesRegex(guardian.ownership.Refused, 'client_certificate_non_ca_required'):
                guardian.client_certificate(pem, digest)

    def test_rejects_certificate_sign_usage_even_without_ca_constraint(self):
        pem, digest = self.certificate(('keyUsage=keyCertSign',))
        with self.assertRaisesRegex(guardian.ownership.Refused, 'client_certificate_can_sign'):
            guardian.client_certificate(pem, digest)

    def test_rejects_wrong_fingerprint_and_multiple_or_malformed_certificates(self):
        pem, digest = self.certificate()
        for supplied, fingerprint in ((pem, '0' * 64), (pem + pem, digest),
                                      ('not a certificate', digest), (pem, 'x' * 64)):
            with self.assertRaises(guardian.ownership.Refused):
                guardian.client_certificate(supplied, fingerprint)

    def test_rejects_invalid_self_signature_even_when_names_and_hash_match(self):
        pem, _ = self.certificate()
        der = bytearray(ssl.PEM_cert_to_DER_cert(pem))
        der[-1] ^= 1
        changed = ssl.DER_cert_to_PEM_cert(bytes(der))
        with self.assertRaisesRegex(guardian.ownership.Refused, 'client_certificate_not_self_signed'):
            guardian.client_certificate(changed, hashlib.sha256(der).hexdigest())


class GuardianReadinessObserverTests(unittest.TestCase):
    def setUp(self):
        self.base = Path('/fixture/preparation')
        self.leases = Path('/fixture/leases')
        self.grant = {
            'binding': {'computerId': '11111111-1111-4111-8111-111111111111'},
            'sessionId': '33333333-3333-4333-8333-333333333333',
            'leaseId': '44444444-4444-4444-8444-444444444444',
            'guestBootId': '55555555-5555-4555-8555-555555555555',
            'capabilityGeneration': '66666666-6666-4666-8666-666666666666',
            'observedRevision': 'a' * 64, 'deadlineBoottimeNs': 2_000_000_000,
            'unitSha256': hashlib.sha256(b'fixture-unit').hexdigest(),
        }
        self.name = guardian.guardian_unit_name(self.grant)
        self.group = '/system.slice/' + self.name
        self.claim = {'leaseId': self.grant['leaseId'], 'sessionId': self.grant['sessionId'],
                      'context': {'unit': self.name, 'invocationId': '1' * 32,
                                  'controlGroup': self.group}}
        self.ready = {'sessionId': self.grant['sessionId'], 'leaseId': self.grant['leaseId'],
                      'guestBootId': self.grant['guestBootId'],
                      'capabilityGeneration': self.grant['capabilityGeneration'],
                      'observedRevision': self.grant['observedRevision'],
                      'serverId': self.grant['binding']['computerId'],
                      'guestPrivateIpv4': '10.240.20.99',
                      'serverCertificatePem': 'public-certificate',
                      'serverCertificateSha256': 'b' * 64,
                      'pairingVerified': True, 'desktopReady': True}
        self.state = {'Id': self.name, 'LoadState': 'loaded', 'ActiveState': 'active',
                      'SubState': 'running', 'MainPID': '42', 'InvocationID': '1' * 32,
                      'ControlGroup': self.group,
                      'FragmentPath': '/etc/systemd/system/' + self.name,
                      'DropInPaths': '', 'NeedDaemonReload': 'no', 'Restart': 'no'}

    def test_exact_active_paired_lease_is_ready_without_taking_mutation_lock(self):
        consumed = guardian.ownership.encoded(self.grant)
        active = guardian.ownership.encoded(self.claim)
        ready = guardian.ownership.encoded(self.ready)
        def regular(path, *args):
            name = str(path)
            if name.endswith('/consumed.json'):
                return consumed, None
            if name.endswith('/active.json'):
                return active, None
            if name.endswith('/ready.json'):
                return ready, None
            if name.startswith('/etc/systemd/system/'):
                return b'fixture-unit', None
            raise AssertionError(name)
        with patch.object(guardian.sys, 'platform', 'linux'), \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian, 'lease_grant', return_value=self.grant), \
                patch.object(guardian, 'check_grant_clock'), \
                patch.object(guardian, 'boottime_ns', return_value=1_000_000_000), \
                patch.object(guardian, 'sunshine_ready_record', return_value=self.ready), \
                patch.object(guardian, 'verify_activation_sources'), \
                patch.object(guardian.ownership, 'directory_evidence', side_effect=lambda path, owner: str(path)), \
                patch.object(guardian.ownership, 'regular', side_effect=regular), \
                patch.object(guardian.os.path, 'lexists', return_value=False), \
                patch.object(guardian, 'read_guardian_stop_state', return_value=self.state) as systemd, \
                patch.object(guardian, 'require_populated_guardian_cgroup') as cgroup, \
                patch.object(guardian, 'require_paired_client') as paired, \
                patch.object(guardian.ownership, 'operation_lock') as mutation_lock:
            self.assertEqual(guardian.observe_lease_ready(self.grant, self.base, self.leases), self.ready)
        mutation_lock.assert_not_called()
        cgroup.assert_called_once_with(self.group)
        paired.assert_called_once()
        self.assertEqual(systemd.call_count, 2)

    def test_process_change_during_ready_observation_is_held(self):
        changed = {**self.state, 'MainPID': '43'}
        consumed = guardian.ownership.encoded(self.grant)
        active = guardian.ownership.encoded(self.claim)
        ready = guardian.ownership.encoded(self.ready)
        def regular(path, *args):
            name = str(path)
            if name.endswith('/consumed.json'):
                return consumed, None
            if name.endswith('/active.json'):
                return active, None
            if name.endswith('/ready.json'):
                return ready, None
            return b'fixture-unit', None
        with patch.object(guardian.sys, 'platform', 'linux'), \
                patch.object(guardian.os, 'geteuid', return_value=0), \
                patch.object(guardian, 'lease_grant', return_value=self.grant), \
                patch.object(guardian, 'check_grant_clock'), \
                patch.object(guardian, 'boottime_ns', return_value=1_000_000_000), \
                patch.object(guardian, 'sunshine_ready_record', return_value=self.ready), \
                patch.object(guardian, 'verify_activation_sources'), \
                patch.object(guardian.ownership, 'directory_evidence', side_effect=lambda path, owner: str(path)), \
                patch.object(guardian.ownership, 'regular', side_effect=regular), \
                patch.object(guardian.os.path, 'lexists', return_value=False), \
                patch.object(guardian, 'read_guardian_stop_state', side_effect=[self.state, changed]), \
                patch.object(guardian, 'require_populated_guardian_cgroup'), \
                patch.object(guardian, 'require_paired_client'):
            with self.assertRaisesRegex(guardian.ownership.Refused, 'guardian_readiness_process_changed'):
                guardian.observe_lease_ready(self.grant, self.base, self.leases)


if __name__ == '__main__':
    unittest.main()
