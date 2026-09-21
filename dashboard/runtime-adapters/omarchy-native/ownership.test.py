import importlib.util
import errno
import json
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'provisioner/remote-desktop/omarchy-sunshine-ownership.py'
spec = importlib.util.spec_from_file_location('ownership', SCRIPT)
ownership = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ownership)
SERVICE_GROUPS = ownership.service_groups


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hivra-sunshine-ownership-test-')
        self.addCleanup(self.temp.cleanup)
        # These are root-controlled but traversable service prerequisites.
        self.temp_root = Path(self.temp.name).resolve()
        self.temp_root.chmod(0o711)
        self.base = self.temp_root / 'owned'
        self.units = self.temp_root / 'units'
        self.base.mkdir(mode=0o711)
        self.units.mkdir(mode=0o700)
        self.owner = os.getuid()
        self.request = {
            'computerId': '11111111-1111-4111-8111-111111111111',
            'operationId': '22222222-2222-4222-8222-222222222222',
            'vmid': 2099, 'ownerUid': self.owner if self.owner >= 100 else 1000,
            'guestPrivateIpv4': '10.240.20.99', 'waylandDisplay': 'wayland-1',
        }
        self.identity = {'ownerGid': os.getgid() or 1000, 'sunshineSha256': 'a' * 64}
        # Fixture numeric UIDs need not be installed in the disposable image.
        groups = patch.object(ownership, 'service_groups', lambda uid, gid: [gid])
        groups.start()
        self.addCleanup(groups.stop)
        self.calls = []

    def probe(self, request, fresh):
        self.assertEqual(request, self.request)
        self.calls.append(fresh)
        return self.identity

    def prepare(self):
        return ownership.prepare(self.request, self.base, self.units, self.owner, self.probe)

    def observe(self):
        return ownership.observe(self.request, self.base, self.units, self.owner, self.probe)

    def resume(self):
        return ownership.resume(self.request, self.base, self.units, self.owner, self.probe)

    @property
    def root(self):
        return self.base / self.request['computerId']

    @property
    def unit(self):
        return self.units / ('hivra-omarchy-native-' + self.request['computerId'] + '.service')

    def test_prepares_exclusive_inactive_namespace_without_starting_any_service(self):
        original_unit = self.units / ownership.STANDARD_UNIT
        original_unit.write_text('untouched owner unit\n')
        before = original_unit.stat()
        result = self.prepare()
        self.assertFalse(result['desktopReady'])
        self.assertEqual(result['activation'], 'forbidden')
        self.assertEqual(len(result['certificateSha256']), 64)
        self.assertEqual(self.calls, [True] * 7 + [False] * 3)
        self.assertEqual(self.observe(), result)
        self.assertEqual(original_unit.read_text(), 'untouched owner unit\n')
        self.assertEqual(original_unit.stat().st_ino, before.st_ino)
        unit = self.unit.read_text()
        self.assertIn('ConditionPathExists=' + str(self.root / 'lease-authorized'), unit)
        self.assertIn('KillMode=control-group', unit)
        self.assertNotIn('[Install]', unit)
        self.assertNotIn('WantedBy', unit)
        self.assertNotIn(str(original_unit), unit)
        self.assertFalse((self.root / 'lease-authorized').exists())
        self.assertEqual(list((self.root / 'state').iterdir()), [])
        self.assertEqual((self.root / 'credentials/key.pem').stat().st_mode & 0o777, 0o400)

    def test_shared_primary_group_has_no_private_key_access_even_with_restrictive_umask(self):
        # macOS staff is a shared primary group. Never grant a group read bit,
        # even when the group happens to be private on a particular guest.
        previous = os.umask(0o077)
        try:
            self.prepare()
        finally:
            os.umask(previous)
        key = (self.root / 'credentials/key.pem').stat()
        self.assertEqual(key.st_uid, self.request['ownerUid'])
        self.assertEqual(key.st_mode & 0o777, 0o400)
        self.assertEqual((self.root / 'credentials').stat().st_mode & 0o777, 0o711)
        self.assertEqual((self.root / 'sunshine.conf').stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.root / 'apps.json').stat().st_mode & 0o777, 0o644)
        self.assertEqual(json.loads((self.root / 'apps.json').read_text()), {
            'env': {}, 'apps': [{'name': 'Desktop'}],
        })
        self.assertEqual((self.root / 'credentials/cert.pem').stat().st_mode & 0o777, 0o644)
        (self.root / 'credentials/key.pem').chmod(0o440)
        with self.assertRaisesRegex(ownership.Refused, 'owned_file_replaced'):
            self.observe()

    @unittest.skipUnless(sys.platform == 'linux' and os.getuid() == 0, 'requires real Linux UID separation')
    def test_root_only_parent_refuses_before_creating_owned_resources(self):
        self.base.chmod(0o700)
        with self.assertRaisesRegex(ownership.Refused, 'service_path_not_traversable'):
            self.prepare()
        self.assertFalse(self.root.exists())
        self.assertFalse(self.unit.exists())
        self.assertEqual(self.base.stat().st_mode & 0o777, 0o700)

    @unittest.skipUnless(sys.platform == 'linux' and os.getuid() == 0, 'requires real Linux UID separation')
    def test_actual_service_uid_reads_config_and_key_but_shared_group_cannot_read_key(self):
        self.prepare()
        def read_as(uid, path):
            return subprocess.run([sys.executable, '-c',
                                   'import sys; open(sys.argv[1], "rb").read()', str(path)],
                                  user=uid, group=self.identity['ownerGid'], extra_groups=[],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5).returncode
        self.assertEqual(read_as(self.request['ownerUid'], self.root / 'sunshine.conf'), 0)
        self.assertEqual(read_as(self.request['ownerUid'], self.root / 'credentials/key.pem'), 0)
        self.assertNotEqual(read_as(self.request['ownerUid'] + 1, self.root / 'credentials/key.pem'), 0)
        self.temp_root.chmod(0o700)
        with self.assertRaisesRegex(ownership.Refused, 'service_path_not_traversable'):
            self.observe()

    @unittest.skipUnless(sys.platform == 'linux' and os.getuid() == 0, 'requires real Linux UID separation')
    def test_supplementary_group_denial_overrides_other_execute(self):
        shared_gid = self.identity['ownerGid'] + 1
        os.chown(self.base, 0, shared_gid)
        self.base.chmod(0o701)
        with patch.object(ownership, 'service_groups', return_value=[self.identity['ownerGid'], shared_gid]):
            with self.assertRaisesRegex(ownership.Refused, 'service_path_not_traversable'):
                self.prepare()
        self.assertFalse(self.root.exists())
        self.assertEqual(self.base.stat().st_mode & 0o777, 0o701)

    @unittest.skipUnless(sys.platform == 'linux' and os.getuid() == 0, 'requires Linux POSIX ACLs')
    def test_named_user_acl_denial_overrides_other_execute(self):
        # Linux POSIX ACL version 2: owner rwx, named service user denied,
        # owning group denied, mask denied, other execute. No setfacl dependency.
        undefined = 0xffffffff
        entries = [(1, 7, undefined), (2, 0, self.request['ownerUid']),
                   (4, 0, undefined), (16, 0, undefined), (32, 1, undefined)]
        acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
        try:
            os.setxattr(self.base, 'system.posix_acl_access', acl)
        except OSError as error:
            if error.errno == errno.EOPNOTSUPP:
                self.skipTest('test filesystem does not support POSIX ACLs')
            raise
        self.assertEqual(self.base.stat().st_mode & 0o777, 0o701)
        control = subprocess.run(
            [sys.executable, '-I', '-S', '-c', 'import os,sys; os.chdir(sys.argv[1])', str(self.base)],
            user=self.request['ownerUid'], group=self.identity['ownerGid'], extra_groups=[],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        if control.returncode == 0:
            self.skipTest('test filesystem stores ACLs but does not enforce named-user traversal denial')
        with self.assertRaisesRegex(ownership.Refused, 'service_path_not_traversable'):
            self.prepare()
        self.assertFalse(self.root.exists())
        self.assertEqual(os.getxattr(self.base, 'system.posix_acl_access'), acl)

    def test_service_group_lookup_uses_account_membership_and_explicit_primary_group(self):
        from types import SimpleNamespace
        # Bypass the fixture's stand-in resolver to test the actual definition.
        with patch.object(ownership.pwd, 'getpwuid', return_value=SimpleNamespace(pw_name='fixture-owner')) as account:
            with patch.object(ownership.os, 'getgrouplist', return_value=[1234, 5678]) as groups:
                self.assertEqual(SERVICE_GROUPS(1000, 1234), [1234, 5678])
                account.assert_called_once_with(1000)
                groups.assert_called_once_with('fixture-owner', 1234)

    def test_service_probe_disables_python_site_and_user_startup_customization(self):
        from types import SimpleNamespace
        with patch.object(ownership.os, 'geteuid', return_value=0):
            with patch.object(ownership.subprocess, 'run', return_value=SimpleNamespace(returncode=1)) as child:
                with self.assertRaisesRegex(ownership.Refused, 'service_path_not_traversable'):
                    ownership.require_service_traversal(self.base, 1000, 1234)
        args, options = child.call_args
        self.assertEqual(args[0][:4], [sys.executable, '-I', '-S', '-c'])
        self.assertEqual(args[0][-1], str(self.base))
        self.assertEqual(options['user'], 1000)
        self.assertEqual(options['group'], 1234)
        self.assertEqual(options['extra_groups'], [1234])
        self.assertEqual(options['timeout'], 5)
        self.assertEqual(options['env'], {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})

    def test_refuses_existing_service_before_creating_namespace(self):
        self.unit.write_text('existing service\n')
        before = self.unit.stat()
        with self.assertRaisesRegex(ownership.Refused, 'ownership_conflict'):
            self.prepare()
        self.assertEqual(self.calls, [])
        self.assertFalse(self.root.exists())
        self.assertEqual(self.unit.stat().st_ino, before.st_ino)
        self.assertEqual(self.unit.read_text(), 'existing service\n')

    def test_effective_unit_rejects_every_missing_or_changed_property(self):
        state = ownership.unit_properties(self.request, self.identity['ownerGid'])
        ownership.check_unit_state(state, self.request, self.identity['ownerGid'], False)
        for key in state:
            with self.subTest(key=key):
                missing = {k: v for k, v in state.items() if k != key}
                for changed in (missing, {**state, key: state[key] + 'unexpected'}):
                    with self.assertRaisesRegex(ownership.Refused, 'effective_definition_mismatch'):
                        ownership.check_unit_state(changed, self.request, self.identity['ownerGid'], False)

    def test_runtime_prefix_dropins_stale_cache_and_other_fragment_are_rejected(self):
        state = ownership.unit_properties(self.request, self.identity['ownerGid'])
        for key, value in [('DropInPaths', '/run/systemd/system/service.d/override.conf'),
                           ('DropInPaths', '/etc/systemd/system/hivra-.service.d/override.conf'),
                           ('FragmentPath', '/run/systemd/system/foreign.service'),
                           ('NeedDaemonReload', 'yes'), ('ActiveState', 'active'), ('MainPID', '123')]:
            with self.subTest(key=key, value=value), self.assertRaises(ownership.Refused):
                ownership.check_unit_state({**state, key: value}, self.request, self.identity['ownerGid'], False)

    def test_fresh_unit_must_not_be_known_and_environment_order_is_irrelevant(self):
        ownership.check_unit_state({'LoadState': 'not-found'}, self.request, self.identity['ownerGid'], True)
        state = ownership.unit_properties(self.request, self.identity['ownerGid'])
        with self.assertRaisesRegex(ownership.Refused, 'unit_already_known'):
            ownership.check_unit_state(state, self.request, self.identity['ownerGid'], True)
        state['Environment'] = ' '.join(reversed(state['Environment'].split()))
        ownership.check_unit_state(state, self.request, self.identity['ownerGid'], False)

    def test_systemd_empty_exec_arrays_are_omitted_but_duplicate_commands_refuse(self):
        state = ownership.unit_properties(self.request, self.identity['ownerGid'])
        output = '\n'.join(k + '=' + v for k, v in state.items() if not (k.startswith('Exec') and v == ''))
        ownership.check_unit_state(ownership.parse_unit_state(output), self.request, self.identity['ownerGid'], False)
        with self.assertRaisesRegex(ownership.Refused, 'unit_property_duplicate'):
            ownership.parse_unit_state('ExecStart=unexpected\n' + output)
        with self.assertRaisesRegex(ownership.Refused, 'unit_property_shape'):
            ownership.parse_unit_state('unparseable')

    def test_probe_conflict_has_no_filesystem_side_effects(self):
        def conflict(request, fresh):
            raise ownership.Refused('sunshine_port_conflict')
        with self.assertRaisesRegex(ownership.Refused, 'sunshine_port_conflict'):
            ownership.prepare(self.request, self.base, self.units, self.owner, conflict)
        self.assertEqual(list(self.base.iterdir()), [])
        self.assertEqual(list(self.units.iterdir()), [])

    def test_no_replay_or_adoption_of_identical_preparation(self):
        result = self.prepare()
        with self.assertRaisesRegex(ownership.Refused, 'ownership_conflict'):
            self.prepare()
        self.assertEqual(self.observe(), result)

    def test_explicit_resume_of_sealed_preparation_preserves_every_byte(self):
        result = self.prepare()
        before = {str(p): ownership.evidence(p, p.stat().st_uid)
                  for p in self.temp_root.rglob('*') if p.is_file()}
        self.assertEqual(self.resume(), result)
        after = {str(p): ownership.evidence(p, p.stat().st_uid)
                 for p in self.temp_root.rglob('*') if p.is_file()}
        self.assertEqual(after, before)

    def interrupt_after_checkpoint(self, phase):
        original = ownership.checkpoint
        def interrupted(root, unit, intent, index, owner):
            original(root, unit, intent, index, owner)
            if index == phase:
                raise ownership.Refused('checkpoint_fixture_interrupt')
        with patch.object(ownership, 'checkpoint', interrupted):
            with self.assertRaisesRegex(ownership.Refused, 'checkpoint_fixture_interrupt'):
                self.prepare()

    def test_resume_every_durable_boundary_without_rewriting_sealed_resources(self):
        for phase in range(8):
            with self.subTest(phase=phase):
                self.base = self.temp_root / ('owned-' + str(phase))
                self.units = self.temp_root / ('units-' + str(phase))
                self.base.mkdir(mode=0o711)
                self.units.mkdir(mode=0o700)
                original_unit = self.units / ownership.STANDARD_UNIT
                original_unit.write_text('unrelated service\n')
                self.interrupt_after_checkpoint(phase)
                before = {p: ownership.evidence(p, p.stat().st_uid)
                          for p in self.temp_root.rglob('*') if p.is_file()}
                result = self.resume()
                self.assertFalse(result['desktopReady'])
                self.assertEqual(result['activation'], 'forbidden')
                for path, expected in before.items():
                    self.assertEqual(ownership.evidence(path, path.stat().st_uid), expected)
                self.assertEqual(self.observe(), result)

    def test_in_step_unsealed_side_effects_are_never_adopted_or_removed(self):
        for phase in range(8):
            with self.subTest(phase=phase):
                self.base = self.temp_root / ('partial-' + str(phase))
                self.units = self.temp_root / ('partial-units-' + str(phase))
                self.base.mkdir(mode=0o711)
                self.units.mkdir(mode=0o700)
                original = ownership.checkpoint
                def interrupted(root, unit, intent, index, owner):
                    if index == phase:
                        raise ownership.Refused('unsealed_fixture_interrupt')
                    return original(root, unit, intent, index, owner)
                with patch.object(ownership, 'checkpoint', interrupted):
                    with self.assertRaisesRegex(ownership.Refused, 'unsealed_fixture_interrupt'):
                        self.prepare()
                before = {p: ownership.evidence(p, p.stat().st_uid)
                          for p in self.temp_root.rglob('*') if p.is_file()}
                with self.assertRaisesRegex(ownership.Refused, 'do_not_adopt'):
                    self.resume()
                after = {p: ownership.evidence(p, p.stat().st_uid)
                         for p in self.temp_root.rglob('*') if p.is_file()}
                self.assertEqual(before, after)

    def test_resume_holds_the_same_nonblocking_intent_lock_as_prepare(self):
        self.interrupt_after_checkpoint(2)
        with ownership.operation_lock(self.root, self.owner):
            with self.assertRaisesRegex(ownership.Refused, 'ownership_operation_busy'):
                self.resume()
        self.assertFalse(self.resume()['desktopReady'])

    def test_resume_refuses_changed_operation_and_installed_source_without_writes(self):
        self.interrupt_after_checkpoint(2)
        with self.assertRaisesRegex(ownership.Refused, 'ownership_binding_mismatch'):
            ownership.resume({**self.request, 'operationId': '33333333-3333-4333-8333-333333333333'},
                             self.base, self.units, self.owner, self.probe)
        self.identity = {**self.identity, 'sunshineSha256': 'b' * 64}
        with self.assertRaisesRegex(ownership.Refused, 'installed_identity_changed'):
            self.resume()
        self.assertEqual(list((self.root / 'credentials').iterdir()), [])

    def test_resume_refuses_replaced_identical_file_and_skipped_checkpoint(self):
        self.interrupt_after_checkpoint(4)
        apps = self.root / 'apps.json'
        apps.rename(self.temp_root / 'retained-apps.json')
        ownership.write_new(apps, (self.temp_root / 'retained-apps.json').read_bytes(), 0o644)
        with self.assertRaisesRegex(ownership.Refused, 'owned_file_replaced'):
            self.resume()
        (self.root / 'checkpoint-3.json').rename(self.temp_root / 'retained-checkpoint.json')
        with self.assertRaisesRegex(ownership.Refused, 'do_not_adopt'):
            self.resume()

    def test_resume_rechecks_after_probe_and_does_not_publish_prepared_for_stale_systemd(self):
        self.interrupt_after_checkpoint(6)
        def stale(request, fresh):
            self.assertFalse(fresh)
            raise ownership.Refused('owned_unit_effective_definition_mismatch')
        with self.assertRaisesRegex(ownership.Refused, 'effective_definition_mismatch'):
            ownership.resume(self.request, self.base, self.units, self.owner, stale)
        self.assertFalse((self.root / 'prepared.json').exists())
        def changed(request, fresh):
            (self.root / 'state/foreign').write_text('preserve me')
            return self.identity
        with self.assertRaisesRegex(ownership.Refused, 'preparation_no_longer_inactive'):
            ownership.resume(self.request, self.base, self.units, self.owner, changed)
        self.assertFalse((self.root / 'prepared.json').exists())
        self.assertEqual((self.root / 'state/foreign').read_text(), 'preserve me')

    def test_resume_refuses_legacy_intent_instead_of_migrating_it(self):
        self.interrupt_after_checkpoint(0)
        path = self.root / 'intent.json'
        intent = json.loads(path.read_bytes())
        intent['protocol'] = 'hivra-omarchy-native-ownership-v1'
        path.write_bytes(ownership.encoded(intent))
        with self.assertRaisesRegex(ownership.Refused, 'legacy_preparation_not_resumable'):
            self.resume()
        self.assertFalse((self.root / 'state').exists())

    def test_checkpoint_never_rebases_previously_sealed_key_after_validation(self):
        self.interrupt_after_checkpoint(3)
        original = ownership.check_record_resources
        injected = False
        def changed_after_check(root, unit, record, intent, owner):
            nonlocal injected
            original(root, unit, record, intent, owner)
            if record['phase'] == 3 and (root / 'apps.json').exists() and not injected:
                injected = True
                key = root / 'credentials/key.pem'
                key.chmod(0o600)
                key.write_bytes(key.read_bytes() + b'\n')
                key.chmod(0o400)
        with patch.object(ownership, 'check_record_resources', changed_after_check):
            with self.assertRaises(ownership.Refused):
                self.resume()
        self.assertTrue(injected)
        self.assertFalse((self.root / 'checkpoint-4.json').exists())

    def test_final_observation_cannot_issue_receipt_after_probe_changes_state(self):
        self.interrupt_after_checkpoint(6)
        probes = 0
        def changed_on_final_probe(request, fresh):
            nonlocal probes
            probes += 1
            if probes == 3:
                (self.root / 'state/foreign').write_text('preserve final probe residue')
            return self.identity
        with self.assertRaisesRegex(ownership.Refused, 'preparation_no_longer_inactive'):
            ownership.resume(self.request, self.base, self.units, self.owner, changed_on_final_probe)
        self.assertEqual(probes, 3)
        self.assertEqual((self.root / 'state/foreign').read_text(), 'preserve final probe residue')

    def test_checkpoint_rejects_duplicate_keys_and_paths_outside_fixed_recipe(self):
        with self.assertRaisesRegex(ownership.Refused, 'duplicate_key'):
            ownership.decoded_record(b'{"phase":0,"phase":1}')
        self.interrupt_after_checkpoint(0)
        path = self.root / 'checkpoint-0.json'
        record = json.loads(path.read_bytes())
        record['files']['../foreign'] = record['files'].pop('intent.json')
        path.write_bytes(ownership.encoded(record))
        with self.assertRaisesRegex(ownership.Refused, 'checkpoint_record_invalid'):
            self.resume()
        self.assertFalse((self.root / 'state').exists())

    def test_resume_rejects_extra_checkpoint_activation_and_credential_entries(self):
        self.interrupt_after_checkpoint(2)
        for path in (self.root / 'checkpoint-8.json', self.root / 'lease-authorized',
                     self.root / 'credentials/foreign.pem'):
            with self.subTest(path=path):
                path.write_text('unowned fixture bytes')
                with self.assertRaisesRegex(ownership.Refused, 'do_not_adopt'):
                    self.resume()
                self.assertEqual(path.read_text(), 'unowned fixture bytes')
                path.unlink()
        self.assertFalse(self.unit.exists())

    def test_operation_lock_rejects_intent_or_root_replacement_before_next_write(self):
        self.interrupt_after_checkpoint(2)
        with ownership.operation_lock(self.root, self.owner) as guard:
            intent = self.root / 'intent.json'
            intent.rename(self.root / 'retained-intent.json')
            ownership.write_new(intent, (self.root / 'retained-intent.json').read_bytes())
            with self.assertRaisesRegex(ownership.Refused, 'ownership_lock_replaced'):
                guard()
        with ownership.operation_lock(self.root, self.owner) as guard:
            self.root.rename(self.base / 'retained-root')
            self.root.mkdir(mode=0o711)
            with self.assertRaisesRegex(ownership.Refused, 'owned_directory_replaced'):
                guard()

    def test_durable_intent_precedes_certificate_creation_and_interruption_is_not_adopted(self):
        def interrupted(args):
            self.assertTrue((self.root / 'intent.json').exists())
            self.assertFalse(self.unit.exists())
            raise ownership.Refused('interrupted_fixture')
        with patch.object(ownership, 'run', interrupted):
            with self.assertRaisesRegex(ownership.Refused, 'interrupted_fixture'):
                self.prepare()
        self.assertEqual(json.loads((self.root / 'intent.json').read_text())['binding'], self.request)
        with self.assertRaisesRegex(ownership.Refused, 'preparation_incomplete_do_not_adopt'):
            self.observe()
        with self.assertRaisesRegex(ownership.Refused, 'ownership_conflict'):
            self.prepare()

    def test_replaced_identical_config_is_not_adopted(self):
        self.prepare()
        path = self.root / 'sunshine.conf'
        data = path.read_bytes()
        path.rename(self.root / 'old.conf')
        ownership.write_new(path, data, 0o640, self.identity['ownerGid'])
        with self.assertRaisesRegex(ownership.Refused, 'owned_file_replaced'):
            self.observe()

    def test_replaced_empty_state_directory_is_not_adopted(self):
        self.prepare()
        (self.root / 'state').rename(self.root / 'old-state')
        (self.root / 'state').mkdir(mode=0o700)
        os.chown(self.root / 'state', self.request['ownerUid'], self.identity['ownerGid'])
        with self.assertRaisesRegex(ownership.Refused, 'owned_directory_replaced'):
            self.observe()

    def test_nonempty_pairing_namespace_is_not_called_inactive(self):
        self.prepare()
        (self.root / 'state/sunshine_state.json').write_text('{}')
        with self.assertRaisesRegex(ownership.Refused, 'preparation_no_longer_inactive'):
            self.observe()

    def test_unit_replacement_and_dropin_are_rejected(self):
        self.prepare()
        dropin = Path(str(self.unit) + '.d')
        dropin.mkdir()
        with self.assertRaisesRegex(ownership.Refused, 'preparation_no_longer_inactive'):
            self.observe()
        dropin.rmdir()
        self.unit.write_text('replacement\n')
        with self.assertRaisesRegex(ownership.Refused, 'owned_unit_replaced'):
            self.observe()

    def test_symlink_and_writable_claim_are_rejected(self):
        self.prepare()
        intent = self.root / 'intent.json'
        intent.chmod(0o666)
        with self.assertRaisesRegex(ownership.Refused, 'unsafe_file'):
            self.observe()
        intent.chmod(0o600)
        config = self.root / 'sunshine.conf'
        config.rename(self.root / 'retained.conf')
        config.symlink_to(self.root / 'retained.conf')
        with self.assertRaises(OSError):
            self.observe()

    def test_fresh_observation_checks_runtime_identity_again(self):
        self.prepare()
        self.identity = {**self.identity, 'sunshineSha256': 'b' * 64}
        with self.assertRaisesRegex(ownership.Refused, 'installed_identity_changed'):
            self.observe()

    def test_mismatched_binding_is_rejected(self):
        self.prepare()
        for field, value in [('operationId', '33333333-3333-4333-8333-333333333333'), ('vmid', 2100)]:
            with self.subTest(field=field), self.assertRaisesRegex(ownership.Refused, 'ownership_binding_mismatch'):
                ownership.observe({**self.request, field: value}, self.base, self.units, self.owner, self.probe)

    def test_invalid_identity_or_injected_path_fails_before_writes(self):
        for field, value in [('computerId', '../other'), ('ownerUid', True), ('vmid', 0),
                             ('guestPrivateIpv4', '127.0.0.1'), ('waylandDisplay', 'wayland-1\nExecStart=bad')]:
            with self.subTest(field=field), self.assertRaises(ownership.Refused):
                ownership.prepare({**self.request, field: value}, self.base, self.units, self.owner, self.probe)
        self.assertEqual(list(self.base.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
