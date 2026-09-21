#!/usr/bin/env python3
"""V3 preparation and per-lease guardian lifecycle.

This is deliberately separate from ownership-v1/v2. No existing preparation is
adopted, rewritten or started. Secrets stay in the new guest-owned namespace.
"""

import hashlib
import base64
import binascii
import contextlib
from decimal import Decimal
import grp
import http.client
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time

HELPER = Path(__file__).with_name('omarchy-sunshine-ownership.py')
spec = importlib.util.spec_from_file_location('omarchy_ownership', HELPER)
ownership = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ownership)

BASE = Path('/var/lib/hivra/omarchy-native-v3')
LEASES = Path('/var/lib/hivra/omarchy-native-v3-leases')
UNITS = Path('/etc/systemd/system')
PROTOCOL = 'hivra-omarchy-native-guardian-preparation-v3'
PIN = '14ffa6fdaa53f7b51512be2b3d24f3939695403c'
GRANT_PROTOCOL = 'hivra-omarchy-guardian-grant-v2'
RENEWAL_PROTOCOL = 'hivra-omarchy-guardian-renewal-v1'


def lease_grant(value):
    keys = {'protocol', 'binding', 'ownerId', 'capabilityGeneration', 'observedRevision',
            'sessionId', 'leaseId', 'clientId', 'clientCertificatePem', 'clientCertificateSha256',
            'guestBootId', 'expiresAtUnixMs', 'deadlineBoottimeNs', 'continuousDeadlineBoottimeNs',
            'runtimeMaxUsec', 'sunshineSha256', 'guardianSha256', 'ownershipSha256',
            'preparedSha256', 'unitSha256'}
    if not isinstance(value, dict) or set(value) != keys or value['protocol'] != GRANT_PROTOCOL:
        raise ownership.Refused('guardian_grant_shape')
    request = ownership.binding(value['binding'])
    if (not isinstance(value['ownerId'], str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', value['ownerId'])):
        raise ownership.Refused('guardian_grant_owner')
    for key in ('capabilityGeneration', 'sessionId', 'leaseId', 'clientId', 'guestBootId'):
        if not isinstance(value[key], str) or not ownership.UUID.fullmatch(value[key]):
            raise ownership.Refused('guardian_grant_identity')
    for key in ('observedRevision', 'sunshineSha256', 'guardianSha256', 'ownershipSha256',
                'preparedSha256', 'unitSha256', 'clientCertificateSha256'):
        if not isinstance(value[key], str) or not re.fullmatch('[0-9a-f]{64}', value[key]):
            raise ownership.Refused('guardian_grant_revision')
    if (type(value['expiresAtUnixMs']) is not int or not 0 < value['expiresAtUnixMs'] < 2 ** 53
            or type(value['deadlineBoottimeNs']) is not int
            or not 0 < value['deadlineBoottimeNs'] < 2 ** 53
            or type(value['continuousDeadlineBoottimeNs']) is not int
            or not value['deadlineBoottimeNs'] < value['continuousDeadlineBoottimeNs'] < 2 ** 53):
        raise ownership.Refused('guardian_grant_deadline')
    if type(value['runtimeMaxUsec']) is not int or not 0 < value['runtimeMaxUsec'] <= 240_000_000:
        raise ownership.Refused('guardian_grant_runtime')
    canonical = client_certificate(value['clientCertificatePem'], value['clientCertificateSha256'])
    return {**value, 'binding': request, 'clientCertificatePem': canonical}


def lease_renewal(value, grant):
    keys = {'protocol', 'sessionId', 'leaseId', 'capabilityGeneration', 'guestBootId',
            'renewalId', 'renewalCount', 'deadlineBoottimeNs', 'continuousDeadlineBoottimeNs'}
    if not isinstance(value, dict) or set(value) != keys or value.get('protocol') != RENEWAL_PROTOCOL:
        raise ownership.Refused('guardian_renewal_shape')
    for key in ('sessionId', 'leaseId', 'capabilityGeneration', 'guestBootId', 'renewalId'):
        if not isinstance(value.get(key), str) or not ownership.UUID.fullmatch(value[key]):
            raise ownership.Refused('guardian_renewal_identity')
    if (value['sessionId'] != grant['sessionId'] or value['leaseId'] != grant['leaseId']
            or value['capabilityGeneration'] != grant['capabilityGeneration']
            or value['guestBootId'] != grant['guestBootId']
            or type(value.get('renewalCount')) is not int or not 1 <= value['renewalCount'] <= 240
            or type(value.get('deadlineBoottimeNs')) is not int
            or type(value.get('continuousDeadlineBoottimeNs')) is not int
            or value['continuousDeadlineBoottimeNs'] != grant['continuousDeadlineBoottimeNs']
            or not grant['deadlineBoottimeNs'] < value['deadlineBoottimeNs']
            <= value['continuousDeadlineBoottimeNs'] < 2 ** 53):
        raise ownership.Refused('guardian_renewal_mismatch')
    return value


def renewal_envelope(value):
    if not isinstance(value, dict) or set(value) != {'grant', 'renewal'}:
        raise ownership.Refused('guardian_renewal_envelope')
    grant = lease_grant(value['grant'])
    return grant, lease_renewal(value['renewal'], grant)


def boottime_ns():
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME)


def capture_service_groups(uid, gid):
    """Grant this Sunshine child only the guest's display-device groups."""
    groups = set(ownership.service_groups(uid, gid))
    for name in ('video', 'render'):
        try:
            groups.add(grp.getgrnam(name).gr_gid)
        except KeyError:
            pass
    return sorted(groups)


def check_grant_clock(grant):
    if Path('/proc/sys/kernel/random/boot_id').read_text().strip() != grant['guestBootId']:
        raise ownership.Refused('guardian_guest_rebooted')
    remaining = grant['deadlineBoottimeNs'] - boottime_ns()
    if remaining <= 0 or remaining > 240_000_000_000:
        raise ownership.Refused('guardian_grant_expired_or_unbounded')
    return remaining


def guardian_unit_name(grant):
    return 'hivra-omarchy-v3-' + grant['sessionId'] + '.service'


def guardian_unit(grant, script=Path(__file__)):
    """Build the exact, hash-bound systemd boundary for one lease."""
    runtime = grant.get('runtimeMaxUsec')
    if type(runtime) is not int or not 0 < runtime <= 240_000_000:
        raise ownership.Refused('guardian_grant_runtime')
    script = Path(script)
    if (not script.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9._/+@=-]+', str(script))
            or not ownership.UUID.fullmatch(grant.get('sessionId', ''))):
        raise ownership.Refused('guardian_unit_identity')
    return '\n'.join([
        '[Unit]',
        'Description=Hivra Omarchy native desktop lease ' + grant['sessionId'],
        '[Service]',
        'Type=notify',
        'User=root',
        'ExecStart=/usr/bin/python3 -I -B ' + str(script) + ' run ' + grant['sessionId'],
        'Restart=no',
        'KillMode=control-group',
        'KillSignal=SIGKILL',
        'SendSIGKILL=yes',
        'TimeoutStartSec=15',
        'TimeoutStopSec=5',
        'RuntimeMaxSec=' + str(runtime) + 'us',
        'RuntimeRandomizedExtraSec=0',
        # The pinned Omarchy Sunshine package uses file capabilities for its
        # capture/input path. no_new_privs strips them and leaves this image on
        # an unavailable RemoteDesktop portal path.
        'NoNewPrivileges=no',
        'NotifyAccess=main',
        'UMask=0077',
        '',
    ])


def verify_activation_sources(grant, base=BASE, script=Path(__file__)):
    request = grant['binding']
    observe(request, base)
    root = base / request['computerId']
    for path, key in ((Path(script), 'guardianSha256'), (HELPER, 'ownershipSha256'),
                      (root / 'prepared.json', 'preparedSha256'), (Path('/usr/bin/sunshine'), 'sunshineSha256')):
        data, info = ownership.regular(path, 0, 268435456)
        if hashlib.sha256(data).hexdigest() != grant[key]:
            raise ownership.Refused('guardian_runtime_identity_changed')
        if key in ('guardianSha256', 'sunshineSha256') and not info.st_mode & 0o111:
            raise ownership.Refused('guardian_runtime_not_executable')


def activate_lease(value, base=BASE, leases=LEASES, units=UNITS, script=Path(__file__), owner=0):
    """Durably install and start one exact lease; failures remain non-replayable."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ownership.Refused('linux_root_required')
    grant = lease_grant(value)
    remaining = check_grant_clock(grant)
    if grant['runtimeMaxUsec'] * 1000 > remaining:
        raise ownership.Refused('guardian_backstop_exceeds_lease')
    ownership.directory(base, owner)
    ownership.directory(leases, owner)
    ownership.directory(units, owner)
    root = base / grant['binding']['computerId']
    with ownership.operation_lock(root, owner) as guard:
        verify_activation_sources(grant, base, script)
        guard()
        # A standard Sunshine service or unexplained listener must be resolved
        # before consuming the grant. Never race it and hope our child wins the
        # ports after authority has already been persisted.
        require_closed_guardian_listeners()
        guard()
        grants = leases / '.grants'
        try:
            grants.mkdir(mode=0o700)
            ownership.sync_dir(leases)
        except FileExistsError:
            pass
        ownership.directory(grants, owner)
        unit_data = guardian_unit(grant, script).encode()
        if hashlib.sha256(unit_data).hexdigest() != grant['unitSha256']:
            raise ownership.Refused('guardian_unit_revision_changed')
        grant_path = grants / (grant['sessionId'] + '.json')
        unit_path = units / guardian_unit_name(grant)
        # The grant is the durable one-use marker. Once written, no retry may
        # silently create a second process even if systemd start acknowledgement
        # is lost.
        ownership.write_new(grant_path, ownership.encoded(grant), 0o400)
        ownership.write_new(unit_path, unit_data, 0o644)
        result = subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
                                check=False, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        if result.returncode != 0:
            raise ownership.Refused('guardian_reload_failed')
    # The guardian intentionally owns the preparation lock for Sunshine's
    # lifetime. Release the activation transaction before systemd starts it;
    # otherwise the child deterministically refuses its own launch as busy.
    result = subprocess.run(['/usr/bin/systemctl', 'start', guardian_unit_name(grant)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=20, check=False,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    if result.returncode != 0:
        raise ownership.Refused('guardian_start_failed')
    return {'sessionId': grant['sessionId'], 'leaseId': grant['leaseId'],
            'activation': 'started', 'desktopReady': False}


def renewal_result(grant, renewal, state):
    return {'sessionId': grant['sessionId'], 'leaseId': grant['leaseId'],
            'guestBootId': grant['guestBootId'], 'renewalId': renewal['renewalId'],
            'renewalCount': renewal['renewalCount'],
            'deadlineBoottimeNs': renewal['deadlineBoottimeNs'],
            'continuousDeadlineBoottimeNs': renewal['continuousDeadlineBoottimeNs'],
            'renewal': state, 'desktopReady': True}


def renewal_name(count):
    if type(count) is not int or not 1 <= count <= 240:
        raise ownership.Refused('guardian_renewal_count')
    return f'{count:03d}.json'


def write_stable_record(directory, name, data, owner, identity_error):
    """Create or re-read one exact root record through a pinned directory fd."""
    identity = ownership.directory_evidence(directory, owner)
    encoded = ownership.encoded(data)
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = os.fstat(directory_fd)
        if (not stat.S_ISDIR(current.st_mode) or current.st_uid != owner
                or stat.S_IMODE(current.st_mode) != identity['mode']
                or current.st_dev != identity['device'] or current.st_ino != identity['inode']):
            raise ownership.Refused(identity_error)
        try:
            record_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                0o400, dir_fd=directory_fd)
        except FileExistsError:
            record_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                info = os.fstat(record_fd)
                existing = os.read(record_fd, len(encoded) + 1)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1
                        or stat.S_IMODE(info.st_mode) != 0o400 or existing != encoded):
                    raise ownership.Refused(identity_error)
            finally:
                os.close(record_fd)
        else:
            try:
                os.fchmod(record_fd, 0o400)
                with os.fdopen(record_fd, 'wb', closefd=False) as stream:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(record_fd)
            finally:
                os.close(record_fd)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    if (ownership.directory_evidence(directory, owner) != identity
            or ownership.regular(directory / name, owner)[0] != encoded):
        raise ownership.Refused(identity_error)


def renew_lease(value, base=BASE, leases=LEASES, owner=0):
    """Persist one exact sequential renewal for the running guardian to consume."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ownership.Refused('linux_root_required')
    grant, renewal = renewal_envelope(value)
    root = base / grant['binding']['computerId']
    computer = leases / grant['binding']['computerId']
    session = computer / grant['leaseId']
    requested = session / 'renewals/requested'
    applied = session / 'renewals/applied'
    identities = {path: ownership.directory_evidence(path, owner)
                  for path in (root, leases, computer, session, requested, applied)}
    consumed = ownership.regular(session / 'consumed.json', owner)[0]
    active = ownership.regular(computer / 'active.json', owner)[0]
    claim = ownership.decoded_record(active)
    context = claim.get('context', {}) if isinstance(claim, dict) else {}
    expected_name = guardian_unit_name(grant)
    if (ownership.decoded_record(consumed) != grant
            or set(claim) != {'leaseId', 'sessionId', 'context'}
            or claim['leaseId'] != grant['leaseId'] or claim['sessionId'] != grant['sessionId']
            or not isinstance(context, dict) or context.get('unit') != expected_name
            or context.get('controlGroup') != '/system.slice/' + expected_name
            or not isinstance(context.get('invocationId'), str)
            or not re.fullmatch('[0-9a-f]{32}', context['invocationId'])
            or os.path.lexists(session / 'revoked.json')
            or Path('/proc/sys/kernel/random/boot_id').read_text().strip() != grant['guestBootId']):
        raise ownership.Refused('guardian_renewal_identity_changed')
    previous_deadline = grant['deadlineBoottimeNs']
    if renewal['renewalCount'] > 1:
        previous = ownership.decoded_record(ownership.regular(
            applied / renewal_name(renewal['renewalCount'] - 1), owner)[0])
        previous = lease_renewal(previous, grant)
        if previous['renewalCount'] != renewal['renewalCount'] - 1:
            raise ownership.Refused('guardian_renewal_sequence')
        previous_deadline = previous['deadlineBoottimeNs']
    now_ns = boottime_ns()
    if (now_ns >= previous_deadline or renewal['deadlineBoottimeNs'] <= previous_deadline
            or renewal['deadlineBoottimeNs'] - now_ns > 300_000_000_000):
        raise ownership.Refused('guardian_renewal_deadline')
    write_stable_record(requested, renewal_name(renewal['renewalCount']), renewal, owner,
                        'guardian_renewal_identity_changed')
    if (any(ownership.directory_evidence(path, owner) != identity
            for path, identity in identities.items())
            or ownership.regular(session / 'consumed.json', owner)[0] != consumed
            or ownership.regular(computer / 'active.json', owner)[0] != active
            or os.path.lexists(session / 'revoked.json')):
        raise ownership.Refused('guardian_renewal_identity_changed')
    return renewal_result(grant, renewal, 'accepted')


def observe_lease_renewal(value, base=BASE, leases=LEASES, owner=0):
    """Prove the running guardian consumed one exact renewal."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ownership.Refused('linux_root_required')
    grant, renewal = renewal_envelope(value)
    root = base / grant['binding']['computerId']
    computer = leases / grant['binding']['computerId']
    session = computer / grant['leaseId']
    requested = session / 'renewals/requested'
    applied = session / 'renewals/applied'
    identities = {path: ownership.directory_evidence(path, owner)
                  for path in (root, leases, computer, session, requested, applied)}
    encoded = ownership.encoded(renewal)
    if (ownership.regular(session / 'consumed.json', owner)[0] != ownership.encoded(grant)
            or ownership.regular(requested / renewal_name(renewal['renewalCount']), owner)[0] != encoded
            or ownership.regular(applied / renewal_name(renewal['renewalCount']), owner)[0] != encoded
            or os.path.lexists(session / 'revoked.json')
            or Path('/proc/sys/kernel/random/boot_id').read_text().strip() != grant['guestBootId']
            or boottime_ns() >= renewal['deadlineBoottimeNs']):
        raise ownership.Refused('guardian_renewal_not_applied')
    state = read_guardian_stop_state(guardian_unit_name(grant))
    if (state.get('ActiveState'), state.get('SubState')) != ('active', 'running'):
        raise ownership.Refused('guardian_renewal_process_changed')
    require_populated_guardian_cgroup('/system.slice/' + guardian_unit_name(grant))
    require_paired_client(root, grant, .5)
    if (any(ownership.directory_evidence(path, owner) != identity
            for path, identity in identities.items())
            or read_guardian_stop_state(guardian_unit_name(grant)) != state):
        raise ownership.Refused('guardian_renewal_identity_changed')
    return renewal_result(grant, renewal, 'applied')


def revoke_lease(value, base=BASE, leases=LEASES, owner=0):
    """Request stop for one exact consumed lease without releasing its claim.

    Revocation is deliberately idempotent because the caller may lose the host
    acknowledgement.  It can only create or re-observe the same marker inside
    the exact active lease; a different grant, claim, boot or replacement
    namespace is a hold.  The guardian and systemd deadline remain the process
    termination boundary, while observe-stop/release-stop retain separate proof.
    """
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ownership.Refused('linux_root_required')
    grant = lease_grant(value)
    computer = leases / grant['binding']['computerId']
    session = computer / grant['leaseId']
    active = computer / 'active.json'
    marker = session / 'revoked.json'
    expected_claim = {'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'],
                      'context': {'unit': guardian_unit_name(grant),
                                  'invocationId': None, 'controlGroup': None}}
    record = {'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'],
              'reason': 'control-plane-revoked'}
    # The running guardian owns the preparation mutation lock for the whole
    # Sunshine lifetime. Revocation must therefore not contend for that lock.
    # Anchor the marker creation to the already-proven session directory file
    # descriptor, then prove every path and record stayed unchanged before and
    # after the write. A concurrent replacement becomes a hold, never a write
    # into the replacement namespace.
    root = base / grant['binding']['computerId']
    identities = {path: ownership.directory_evidence(path, owner)
                  for path in (root, leases, computer, session)}
    consumed = ownership.regular(session / 'consumed.json', owner)[0]
    try:
        active_bytes = ownership.regular(active, owner)[0]
    except FileNotFoundError:
        observe_released_lease(grant, base, leases, owner)
        return {**record, 'revocation': 'requested', 'releasePending': False,
                'desktopReady': False}

    def original_evidence():
        if Path('/proc/sys/kernel/random/boot_id').read_text().strip() != grant['guestBootId']:
            raise ownership.Refused('guardian_revoke_boot_changed')
        if any(ownership.directory_evidence(path, owner) != identity
               for path, identity in identities.items()):
            raise ownership.Refused('guardian_revoke_identity_changed')
        if (ownership.regular(session / 'consumed.json', owner)[0] != consumed
                or ownership.regular(active, owner)[0] != active_bytes):
            raise ownership.Refused('guardian_revoke_identity_changed')

    if ownership.decoded_record(consumed) != grant:
        raise ownership.Refused('guardian_consumed_grant_changed')
    claim = ownership.decoded_record(active_bytes)
    if (not isinstance(claim, dict) or set(claim) != {'leaseId', 'sessionId', 'context'}
            or claim['leaseId'] != expected_claim['leaseId']
            or claim['sessionId'] != expected_claim['sessionId']
            or not isinstance(claim['context'], dict)
            or set(claim['context']) != {'unit', 'invocationId', 'controlGroup'}
            or claim['context']['unit'] != expected_claim['context']['unit']
            or not isinstance(claim['context']['invocationId'], str)
            or not re.fullmatch('[0-9a-f]{32}', claim['context']['invocationId'])
            or claim['context']['controlGroup'] != '/system.slice/' + guardian_unit_name(grant)):
        raise ownership.Refused('guardian_revoke_claim_mismatch')
    encoded = ownership.encoded(record)
    original_evidence()
    directory_fd = os.open(session, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = os.fstat(directory_fd)
        expected = identities[session]
        if (not stat.S_ISDIR(current.st_mode) or current.st_uid != owner
                or stat.S_IMODE(current.st_mode) != expected['mode']
                or current.st_dev != expected['device'] or current.st_ino != expected['inode']):
            raise ownership.Refused('guardian_revoke_identity_changed')
        try:
            marker_fd = os.open('revoked.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                0o400, dir_fd=directory_fd)
        except FileExistsError:
            marker_fd = os.open('revoked.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                info = os.fstat(marker_fd)
                existing = os.read(marker_fd, len(encoded) + 1)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1
                        or stat.S_IMODE(info.st_mode) != 0o400 or existing != encoded):
                    raise ownership.Refused('guardian_revoke_changed')
            finally:
                os.close(marker_fd)
        else:
            try:
                os.fchmod(marker_fd, 0o400)
                with os.fdopen(marker_fd, 'wb', closefd=False) as stream:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(marker_fd)
            finally:
                os.close(marker_fd)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    original_evidence()
    if ownership.regular(marker, owner)[0] != encoded:
        raise ownership.Refused('guardian_revoke_identity_changed')
    return {**record, 'revocation': 'requested', 'releasePending': True,
            'desktopReady': False}


def run_installed_grant(session_id, base=BASE, leases=LEASES):
    if not isinstance(session_id, str) or not ownership.UUID.fullmatch(session_id):
        raise ownership.Refused('guardian_session_identity')
    grants = leases / '.grants'
    ownership.directory(grants, 0)
    value = ownership.decoded_record(ownership.regular(grants / (session_id + '.json'), 0, 32768)[0])
    grant = lease_grant(value)
    if grant['sessionId'] != session_id:
        raise ownership.Refused('guardian_session_identity')
    return supervise_lease(grant, base, leases)


def read_guardian_stop_state(name):
    properties = ('Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,'
                  'FragmentPath,DropInPaths,NeedDaemonReload,Restart')
    result = subprocess.run(['/usr/bin/systemctl', 'show', '--all', name, '--property=' + properties],
                            check=True, timeout=2, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    return ownership.parse_unit_state(result.stdout.decode())


def require_empty_guardian_cgroup(group):
    # An absent leaf is meaningful only on the actual unified hierarchy, not
    # when a missing/unmounted cgroup filesystem hides the owned processes.
    root = Path('/sys/fs/cgroup')
    (root / 'cgroup.controllers').read_text()
    ownership.directory(root / 'system.slice', 0)
    leaf = root / group.lstrip('/')
    try:
        ownership.directory(leaf, 0)
    except FileNotFoundError:
        return
    fields = {}
    for line in (leaf / 'cgroup.events').read_text().splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[0] in fields:
            raise ownership.Refused('guardian_cgroup_observation_invalid')
        fields[parts[0]] = parts[1]
    # populated includes descendants; an empty top-level cgroup.procs does not.
    if fields.get('populated') != '0':
        raise ownership.Refused('guardian_cgroup_not_empty')


def require_closed_guardian_listeners():
    # Observe the guest's network namespace, including IPv6 and UDP. A loopback
    # connect alone would miss wildcard/private-address and UDP listeners.
    if os.stat('/proc/self/ns/net').st_ino != os.stat('/proc/1/ns/net').st_ino:
        raise ownership.Refused('guardian_observer_network_namespace')
    for protocol, ports in (('tcp', {47984, 47989, 47990, 48010}),
                            ('udp', {47998, 47999, 48000, 48002, 48010})):
        for suffix in ('', '6'):
            lines = Path('/proc/net/' + protocol + suffix).read_text().splitlines()
            if not lines or 'local_address' not in lines[0]:
                raise ownership.Refused('guardian_socket_observation_invalid')
            for line in lines[1:]:
                parts = line.split()
                if len(parts) < 10 or not re.fullmatch(r'[0-9A-Fa-f]+:[0-9A-Fa-f]{4}', parts[1]):
                    raise ownership.Refused('guardian_socket_observation_invalid')
                if int(parts[1].rsplit(':', 1)[1], 16) in ports and (protocol == 'udp' or parts[3] != '06'):
                    raise ownership.Refused('guardian_listener_still_present')


def require_stopped_invocation_journal(name, invocation_id, session, grant):
    """Bind an inactive unit to its retained invocation after systemd clears it."""
    try:
        terminal = ownership.decoded_record(ownership.regular(session / 'terminal.json', 0)[0])
    except (OSError, json.JSONDecodeError, UnicodeError, ownership.Refused):
        raise ownership.Refused('guardian_invocation_journal_invalid') from None
    if (set(terminal) != {'leaseId', 'sessionId', 'reason', 'releasePending', 'desktopReady'}
            or terminal['leaseId'] != grant['leaseId'] or terminal['sessionId'] != grant['sessionId']
            or terminal['reason'] not in ('expired', 'revoked', 'child_exited')
            or terminal['releasePending'] is not True or terminal['desktopReady'] is not False):
        raise ownership.Refused('guardian_terminal_record_invalid')
    result = subprocess.run(
        ['/usr/bin/journalctl', '-b', '--no-pager', '-o', 'json',
         '_SYSTEMD_INVOCATION_ID=' + invocation_id],
        check=True, timeout=3, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    if len(result.stdout) > 1_048_576:
        raise ownership.Refused('guardian_invocation_journal_invalid')
    matched = 0
    for raw in result.stdout.splitlines():
        row = ownership.decoded_record(raw)
        message = row.get('MESSAGE')
        if row.get('_SYSTEMD_UNIT') == name and isinstance(message, str):
            try:
                if ownership.decoded_record(message.encode()) == terminal:
                    matched += 1
            except (json.JSONDecodeError, UnicodeError, ownership.Refused):
                pass
    if matched != 1:
        raise ownership.Refused('guardian_invocation_journal_invalid')


def observe_lease_stop(value, base=BASE, leases=None):
    """Read-only, VM-bound process teardown observation, not controller release.

    Requires the exact consumed grant and retained claim, even after expiry.
    Reboot, collected unit state or a different invocation remain a hold. The
    future broker must separately establish Hyprland/input release; this does
    not remove the active claim or enable another lease.
    """
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ownership.Refused('linux_root_required')
    grant = lease_grant(value)
    name = guardian_unit_name(grant)
    group = '/system.slice/' + name
    leases = leases if leases is not None else base.parent / 'omarchy-native-v3-leases'
    computer = leases / grant['binding']['computerId']
    session = computer / grant['leaseId']
    unit = Path('/etc/systemd/system') / name
    with ownership.operation_lock(base / grant['binding']['computerId'], 0) as guard:
        identities = {path: ownership.directory_evidence(path, 0) for path in (leases, computer, session)}
        consumed = ownership.regular(session / 'consumed.json', 0)[0]
        active = ownership.regular(computer / 'active.json', 0)[0]
        if ownership.decoded_record(consumed) != grant:
            raise ownership.Refused('guardian_consumed_grant_changed')
        claim = ownership.decoded_record(active)
        context = claim.get('context', {})
        if (set(claim) != {'leaseId', 'sessionId', 'context'}
                or claim['leaseId'] != grant['leaseId'] or claim['sessionId'] != grant['sessionId']
                or not isinstance(context, dict) or set(context) != {'unit', 'invocationId', 'controlGroup'}
                or context['unit'] != name or context['controlGroup'] != group
                or not isinstance(context['invocationId'], str) or not re.fullmatch('[0-9a-f]{32}', context['invocationId'])):
            raise ownership.Refused('guardian_stop_claim_mismatch')

        def original_evidence():
            guard()
            if Path('/proc/sys/kernel/random/boot_id').read_text().strip() != grant['guestBootId']:
                raise ownership.Refused('guardian_stop_boot_changed')
            for path, identity in identities.items():
                if ownership.directory_evidence(path, 0) != identity:
                    raise ownership.Refused('guardian_session_replaced')
            if (ownership.regular(session / 'consumed.json', 0)[0] != consumed
                    or ownership.regular(computer / 'active.json', 0)[0] != active
                    or hashlib.sha256(ownership.regular(unit, 0)[0]).hexdigest() != grant['unitSha256']):
                raise ownership.Refused('guardian_stop_identity_changed')

        original_evidence()
        before = read_guardian_stop_state(name)
        expected = {'Id': name, 'LoadState': 'loaded', 'MainPID': '0', 'Restart': 'no',
                    'FragmentPath': str(unit),
                    'DropInPaths': '', 'NeedDaemonReload': 'no'}
        if (any(before.get(key) != expected_value for key, expected_value in expected.items())
                or (before.get('ActiveState'), before.get('SubState')) not in (('inactive', 'dead'), ('failed', 'failed'))
                or before.get('ControlGroup') not in ('', group)
                or before.get('InvocationID') not in ('', context['invocationId'])):
            raise ownership.Refused('guardian_original_invocation_not_stopped')
        if before.get('InvocationID') == '':
            require_stopped_invocation_journal(name, context['invocationId'], session, grant)
        require_empty_guardian_cgroup(group)
        require_closed_guardian_listeners()
        if read_guardian_stop_state(name) != before:
            raise ownership.Refused('guardian_stop_state_changed')
        original_evidence()
        return {'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'],
                'guestBootId': grant['guestBootId'], 'invocationId': context['invocationId'],
                'ownedProcessBoundaryStopped': True, 'releasePending': True, 'desktopReady': False}


def release_stopped_lease(value, base=BASE, leases=None):
    """Atomically release the active claim after exact stop observation.

    The immutable unit and consumed grant remain as audit evidence. Moving the
    active claim into the lease directory is the single release transition, so
    interruption cannot both lose the claim and lose its identity.
    """
    grant = lease_grant(value)
    leases = leases if leases is not None else base.parent / 'omarchy-native-v3-leases'
    computer = leases / grant['binding']['computerId']
    if not os.path.lexists(computer / 'active.json'):
        return observe_released_lease(grant, base, leases)
    observed = observe_lease_stop(grant, base, leases)
    session = computer / grant['leaseId']
    active = computer / 'active.json'
    released_claim = session / 'released-claim.json'
    unit = Path('/etc/systemd/system') / guardian_unit_name(grant)
    group = '/system.slice/' + guardian_unit_name(grant)
    with ownership.operation_lock(base / grant['binding']['computerId'], 0) as guard:
        guard()
        consumed = ownership.regular(session / 'consumed.json', 0)[0]
        claim = ownership.regular(active, 0)[0]
        expected_claim = {'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'],
                          'context': {'unit': guardian_unit_name(grant),
                                      'invocationId': observed['invocationId'],
                                      'controlGroup': group}}
        if (ownership.decoded_record(consumed) != grant
                or ownership.decoded_record(claim) != expected_claim
                or hashlib.sha256(ownership.regular(unit, 0)[0]).hexdigest() != grant['unitSha256']
                or Path('/proc/sys/kernel/random/boot_id').read_text().strip() != grant['guestBootId']):
            raise ownership.Refused('guardian_release_identity_changed')
        state = read_guardian_stop_state(guardian_unit_name(grant))
        if (state.get('MainPID') != '0'
                or (state.get('ActiveState'), state.get('SubState')) not in (('inactive', 'dead'), ('failed', 'failed'))
                or state.get('Restart') != 'no'):
            raise ownership.Refused('guardian_release_process_changed')
        require_empty_guardian_cgroup(group)
        require_closed_guardian_listeners()
        guard()
        authorization = {'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'],
                         'guestBootId': observed['guestBootId'],
                         'invocationId': observed['invocationId'],
                         'ownedProcessBoundaryStopped': True, 'releasePending': True}
        ownership.write_new(session / 'release-authorized.json', ownership.encoded(authorization), 0o400)
        os.rename(active, released_claim)
        ownership.sync_dir(computer)
        ownership.sync_dir(session)
        released = {**authorization, 'releasePending': False, 'controllerReleased': True,
                    'desktopReady': False}
        ownership.write_new(session / 'released.json', ownership.encoded(released), 0o400)
        return released


def observe_released_lease(value, base=BASE, leases=None, owner=0):
    """Prove an already-released lease for idempotent stop recovery."""
    grant = lease_grant(value)
    leases = leases if leases is not None else base.parent / 'omarchy-native-v3-leases'
    root = base / grant['binding']['computerId']
    computer = leases / grant['binding']['computerId']
    session = computer / grant['leaseId']
    name = guardian_unit_name(grant)
    group = '/system.slice/' + name
    unit = Path('/etc/systemd/system') / name
    with ownership.operation_lock(root, owner) as guard:
        identities = {path: ownership.directory_evidence(path, owner)
                      for path in (root, leases, computer, session)}
        records = {name: ownership.regular(session / name, owner)[0] for name in (
            'consumed.json', 'released-claim.json', 'release-authorized.json', 'released.json')}
        released = ownership.decoded_record(records['released.json'])
        invocation = released.get('invocationId') if isinstance(released, dict) else None
        expected_claim = {'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'],
                          'context': {'unit': name, 'invocationId': invocation,
                                      'controlGroup': group}}
        authorization = {'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'],
                         'guestBootId': grant['guestBootId'], 'invocationId': invocation,
                         'ownedProcessBoundaryStopped': True, 'releasePending': True}
        expected = {**authorization, 'releasePending': False, 'controllerReleased': True,
                    'desktopReady': False}
        if (not isinstance(invocation, str) or not re.fullmatch('[0-9a-f]{32}', invocation)
                or ownership.decoded_record(records['consumed.json']) != grant
                or ownership.decoded_record(records['released-claim.json']) != expected_claim
                or ownership.decoded_record(records['release-authorized.json']) != authorization
                or released != expected
                or os.path.lexists(computer / 'active.json')
                or Path('/proc/sys/kernel/random/boot_id').read_text().strip() != grant['guestBootId']
                or hashlib.sha256(ownership.regular(unit, owner)[0]).hexdigest() != grant['unitSha256']):
            raise ownership.Refused('guardian_released_identity_changed')
        state = read_guardian_stop_state(name)
        if (state.get('MainPID') != '0'
                or (state.get('ActiveState'), state.get('SubState')) not in (('inactive', 'dead'), ('failed', 'failed'))
                or state.get('Restart') != 'no'):
            raise ownership.Refused('guardian_released_process_changed')
        require_empty_guardian_cgroup(group)
        require_closed_guardian_listeners()
        guard()
        if (any(ownership.directory_evidence(path, owner) != identity
                for path, identity in identities.items())
                or any(ownership.regular(session / key, owner)[0] != data
                       for key, data in records.items())
                or os.path.lexists(computer / 'active.json')
                or read_guardian_stop_state(name) != state):
            raise ownership.Refused('guardian_released_identity_changed')
        return expected


def systemd_duration_ns(value):
    if not isinstance(value, str) or not value:
        raise ownership.Refused('guardian_backstop_unverified')
    total, seen = 0, set()
    for token in value.split(' '):
        match = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)(us|ms|s|min)', token)
        if not match or match[2] in seen:
            raise ownership.Refused('guardian_backstop_unverified')
        seen.add(match[2])
        amount = Decimal(match[1]) * {'us': 1000, 'ms': 1_000_000, 's': 1_000_000_000, 'min': 60_000_000_000}[match[2]]
        if amount != int(amount):
            raise ownership.Refused('guardian_backstop_unverified')
        total += int(amount)
    if not 0 < total <= 240_000_000_000:
        raise ownership.Refused('guardian_backstop_unverified')
    return total


def systemd_notify(message):
    """Send one credential-bound notification from the service main process."""
    address = os.environ.get('NOTIFY_SOCKET', '')
    if not address or '\n' in address or '\x00' in address:
        raise ownership.Refused('guardian_notify_unavailable')
    if address.startswith('@'):
        address = '\x00' + address[1:]
    elif not address.startswith('/'):
        raise ownership.Refused('guardian_notify_unavailable')
    payload = message.encode('ascii')
    if not payload or len(payload) > 4096 or b'\x00' in payload:
        raise ownership.Refused('guardian_notify_invalid')
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_CLOEXEC) as channel:
        channel.settimeout(.5)
        channel.connect(address)
        if channel.send(payload) != len(payload):
            raise ownership.Refused('guardian_notify_failed')


def consume_next_renewal(session, grant, count, deadline, notify=systemd_notify, owner=0):
    """Apply only the next exact renewal and acknowledge it after notifying PID 1."""
    candidate = session / 'renewals/requested' / renewal_name(count + 1)
    try:
        raw = ownership.regular(candidate, owner)[0]
    except FileNotFoundError:
        return count, deadline, False
    renewal = lease_renewal(ownership.decoded_record(raw), grant)
    if renewal['renewalCount'] != count + 1 or renewal['deadlineBoottimeNs'] <= deadline:
        raise ownership.Refused('guardian_renewal_sequence')
    remaining_us = (renewal['deadlineBoottimeNs'] - boottime_ns()) // 1000
    if remaining_us <= 0:
        raise ownership.Refused('guardian_renewal_expired')
    notify('EXTEND_TIMEOUT_USEC=' + str(remaining_us))
    write_stable_record(session / 'renewals/applied', renewal_name(count + 1), renewal, owner,
                        'guardian_renewal_identity_changed')
    return count + 1, renewal['deadlineBoottimeNs'], True


def require_paired_client(root, grant, timeout):
    cert = ownership.regular(root / 'credentials/cert.pem', 0)[0].decode('ascii')
    expected_cert = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert)).digest()
    context = ssl.create_default_context(cadata=cert)
    context.check_hostname = False  # exact DER pin below, rather than loopback hostname
    secret = ownership.decoded_record(ownership.regular(root / 'admin-secret.json', 0)[0])
    credentials = base64.b64encode((secret['username'] + ':' + secret['password']).encode()).decode()
    connection = http.client.HTTPSConnection('127.0.0.1', 47990, timeout=timeout, context=context)
    try:
        connection.connect()
        if hashlib.sha256(connection.sock.getpeercert(binary_form=True)).digest() != expected_cert:
            raise ownership.Refused('guardian_admin_certificate_changed')
        connection.request('GET', '/api/clients/list', headers={'Authorization': 'Basic ' + credentials})
        response = connection.getresponse()
        raw = response.read(65537)
        if response.status != 200 or len(raw) > 65536:
            raise ownership.Refused('guardian_pairing_observation_failed')
        actual = ownership.decoded_record(raw)
        expected = {'status': True, 'named_certs': [
            {'name': grant['leaseId'], 'uuid': grant['clientId'], 'enabled': True}]}
        if actual != expected:
            raise ownership.Refused('guardian_pairing_changed')
    finally:
        connection.close()


def sunshine_ready_record(root, grant):
    """Return the public, grant-bound identity needed by a native client."""
    pem = ownership.regular(root / 'credentials/cert.pem', 0, 16384)[0].decode('ascii')
    try:
        fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
    except (ValueError, UnicodeError, binascii.Error):
        raise ownership.Refused('guardian_server_certificate_invalid') from None
    return {'sessionId': grant['sessionId'], 'leaseId': grant['leaseId'],
            'guestBootId': grant['guestBootId'],
            'capabilityGeneration': grant['capabilityGeneration'],
            'observedRevision': grant['observedRevision'],
            'serverId': grant['binding']['computerId'],
            'guestPrivateIpv4': grant['binding']['guestPrivateIpv4'],
            'serverCertificatePem': pem,
            'serverCertificateSha256': fingerprint,
            'pairingVerified': True, 'desktopReady': True}


def pairing_observation_may_retry(error, authenticated, now_ns, startup_deadline_ns):
    return (isinstance(error, ownership.Refused)
            and str(error) == 'guardian_pairing_observation_failed'
            and authenticated is False and now_ns < startup_deadline_ns)


def require_populated_guardian_cgroup(group):
    root = Path('/sys/fs/cgroup')
    (root / 'cgroup.controllers').read_text()
    ownership.directory(root / 'system.slice', 0)
    leaf = root / group.lstrip('/')
    ownership.directory(leaf, 0)
    fields = {}
    for line in (leaf / 'cgroup.events').read_text().splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[0] in fields:
            raise ownership.Refused('guardian_cgroup_observation_invalid')
        fields[parts[0]] = parts[1]
    if fields.get('populated') != '1':
        raise ownership.Refused('guardian_cgroup_not_populated')


def observe_lease_ready(value, base=BASE, leases=None):
    """Prove the exact active Sunshine lease is paired and currently ready."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ownership.Refused('linux_root_required')
    grant = lease_grant(value)
    check_grant_clock(grant)
    leases = leases if leases is not None else base.parent / 'omarchy-native-v3-leases'
    root = base / grant['binding']['computerId']
    computer = leases / grant['binding']['computerId']
    session = computer / grant['leaseId']
    readiness = session / 'readiness'
    marker = readiness / 'ready.json'
    name = guardian_unit_name(grant)
    group = '/system.slice/' + name
    unit = Path('/etc/systemd/system') / name
    # The lifecycle owns the preparation mutation lock for the duration of the
    # Sunshine process. A read observer must not contend for that lock; it
    # proves a stable snapshot by checking every identity before and after the
    # external systemd, cgroup and authenticated-admin observations instead.
    with contextlib.nullcontext(lambda: None) as guard:
        identities = {path: ownership.directory_evidence(path, 0)
                      for path in (leases, computer, session, readiness)}
        consumed = ownership.regular(session / 'consumed.json', 0)[0]
        active = ownership.regular(computer / 'active.json', 0)[0]
        ready = ownership.regular(marker, 0, 32768)[0]
        expected_ready = sunshine_ready_record(root, grant)
        claim = ownership.decoded_record(active)
        context = claim.get('context', {})
        if (ownership.decoded_record(consumed) != grant
                or ownership.decoded_record(ready) != expected_ready):
            raise ownership.Refused('guardian_readiness_identity_changed')
        if (set(claim) != {'leaseId', 'sessionId', 'context'}
                or claim['leaseId'] != grant['leaseId'] or claim['sessionId'] != grant['sessionId']
                or not isinstance(context, dict) or set(context) != {'unit', 'invocationId', 'controlGroup'}
                or context['unit'] != name or context['controlGroup'] != group
                or not isinstance(context['invocationId'], str)
                or not re.fullmatch('[0-9a-f]{32}', context['invocationId'])):
            raise ownership.Refused('guardian_readiness_claim_mismatch')
        verify_activation_sources(grant, base)
        if (hashlib.sha256(ownership.regular(unit, 0)[0]).hexdigest() != grant['unitSha256']
                or os.path.lexists(session / 'revoked.json')):
            raise ownership.Refused('guardian_readiness_boundary_changed')

        def original_evidence():
            guard()
            check_grant_clock(grant)
            if any(ownership.directory_evidence(path, 0) != identity
                   for path, identity in identities.items()):
                raise ownership.Refused('guardian_session_replaced')
            if (ownership.regular(session / 'consumed.json', 0)[0] != consumed
                    or ownership.regular(computer / 'active.json', 0)[0] != active
                    or ownership.regular(marker, 0, 32768)[0] != ready
                    or hashlib.sha256(ownership.regular(unit, 0)[0]).hexdigest() != grant['unitSha256']
                    or os.path.lexists(session / 'revoked.json')):
                raise ownership.Refused('guardian_readiness_identity_changed')

        original_evidence()
        state = read_guardian_stop_state(name)
        expected = {'Id': name, 'LoadState': 'loaded', 'ActiveState': 'active',
                    'SubState': 'running', 'Restart': 'no', 'InvocationID': context['invocationId'],
                    'ControlGroup': group, 'FragmentPath': str(unit), 'DropInPaths': '',
                    'NeedDaemonReload': 'no'}
        if (any(state.get(key) != expected_value for key, expected_value in expected.items())
                or not str(state.get('MainPID', '')).isdigit() or int(state['MainPID']) <= 0):
            raise ownership.Refused('guardian_readiness_process_mismatch')
        require_populated_guardian_cgroup(group)
        remaining = (grant['deadlineBoottimeNs'] - boottime_ns()) / 1_000_000_000
        require_paired_client(root, grant, min(.5, remaining))
        if read_guardian_stop_state(name) != state:
            raise ownership.Refused('guardian_readiness_process_changed')
        original_evidence()
        return expected_ready


def require_guardian_context(grant):
    """Require the installed root guardian's actual systemd boundary.

    No unit installer or CLI activation path exists yet. The lifecycle core
    below cannot be called from the existing prepare/observe commands.
    """
    name = guardian_unit_name(grant)
    unit_path = Path('/etc/systemd/system') / name
    data, _ = ownership.regular(unit_path, 0)
    if hashlib.sha256(data).hexdigest() != grant['unitSha256']:
        raise ownership.Refused('guardian_unit_changed')
    properties = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID',
                  'ControlGroup', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'User',
                  'Type', 'Restart', 'KillMode', 'KillSignal', 'SendSIGKILL', 'RuntimeMaxUSec', 'NoNewPrivileges',
                  'ActiveEnterTimestampMonotonic', 'RuntimeRandomizedExtraUSec', 'NotifyAccess', 'ExecStartPre', 'ExecStartPost',
                  'ExecStop', 'ExecStopPost', 'ExecReload']
    result = subprocess.run(['/usr/bin/systemctl', 'show', '--all', name,
                             '--property=' + ','.join(properties)], check=True, timeout=2,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    state = ownership.parse_unit_state(result.stdout.decode())
    expected = {'Id': name, 'LoadState': 'loaded', 'ActiveState': 'activating', 'SubState': 'start',
                'MainPID': str(os.getpid()), 'FragmentPath': str(unit_path), 'DropInPaths': '',
                'NeedDaemonReload': 'no', 'User': 'root', 'Type': 'notify', 'Restart': 'no',
                'KillMode': 'control-group', 'KillSignal': '9', 'SendSIGKILL': 'yes',
                'NoNewPrivileges': 'no',
                'RuntimeRandomizedExtraUSec': '0', 'NotifyAccess': 'main',
                'ExecStartPre': '', 'ExecStartPost': '', 'ExecStop': '', 'ExecStopPost': '', 'ExecReload': ''}
    if any(state.get(key) != value for key, value in expected.items()):
        raise ownership.Refused('guardian_systemd_boundary_mismatch')
    invocation = os.environ.get('INVOCATION_ID', '')
    if not re.fullmatch('[0-9a-f]{32}', invocation) or state.get('InvocationID') != invocation:
        raise ownership.Refused('guardian_invocation_mismatch')
    cgroup = state.get('ControlGroup', '')
    if (cgroup != '/system.slice/' + name
            or Path('/proc/self/cgroup').read_text().splitlines() != ['0::' + cgroup]):
        raise ownership.Refused('guardian_cgroup_mismatch')
    duration_ns = systemd_duration_ns(state.get('RuntimeMaxUSec', ''))
    if duration_ns != grant['runtimeMaxUsec'] * 1000:
        raise ownership.Refused('guardian_backstop_mismatch')
    remaining = check_grant_clock(grant)
    if duration_ns > remaining:
        raise ownership.Refused('guardian_backstop_exceeds_lease')
    return {'unit': name, 'invocationId': invocation, 'controlGroup': cgroup}


def supervise_lease(value, base=BASE, leases=None, context_check=require_guardian_context):
    """Internal lifecycle core. Admission/broker/unit installation is not wired.

    The context checker is a real systemd check in production; tests substitute
    that boundary explicitly. Never report controller release from this method:
    its durable active claim remains for a separate cgroup/listener observer.
    """
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ownership.Refused('linux_root_required')
    grant = lease_grant(value)
    request = grant['binding']
    gid = pwd.getpwuid(request['ownerUid']).pw_gid
    if gid == 0:
        raise ownership.Refused('owner_group_invalid')
    check_grant_clock(grant)
    leases = leases if leases is not None else base.parent / 'omarchy-native-v3-leases'
    ownership.directory(leases, 0)
    leases_identity = ownership.directory_evidence(leases, 0)
    ownership.require_service_traversal(leases, request['ownerUid'], gid)
    root = base / request['computerId']
    with ownership.operation_lock(root, 0) as original_guard:
        observe(request, base)
        def verify_sources():
            for path, key in [(Path(__file__), 'guardianSha256'), (HELPER, 'ownershipSha256'),
                              (root / 'prepared.json', 'preparedSha256')]:
                data, _ = ownership.regular(path, 0)
                if hashlib.sha256(data).hexdigest() != grant[key]:
                    raise ownership.Refused('guardian_runtime_identity_changed')
        verify_sources()
        executable, executable_info = ownership.regular(Path('/usr/bin/sunshine'), 0, 268435456)
        if hashlib.sha256(executable).hexdigest() != grant['sunshineSha256'] or not executable_info.st_mode & 0o111:
            raise ownership.Refused('guardian_sunshine_changed')
        context = context_check(grant)
        original_guard()
        check_grant_clock(grant)
        if ownership.directory_evidence(leases, 0) != leases_identity:
            raise ownership.Refused('guardian_lease_namespace_changed')
        computer = leases / request['computerId']
        if not computer.exists():
            computer.mkdir(mode=0o700)
            ownership.sync_dir(leases)
        ownership.directory(computer, 0)
        # Never replace this claim here, including after a clean child exit.
        # A later lease waits for separately verified controller release.
        active = ownership.encoded({'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'], 'context': context})
        ownership.write_new(computer / 'active.json', active, 0o400)
        session = computer / grant['leaseId']
        session.mkdir(mode=0o711)
        os.chmod(computer, 0o711)
        os.chmod(session, 0o711)
        ownership.sync_dir(computer)
        consumed = ownership.encoded(grant)
        ownership.write_new(session / 'consumed.json', consumed, 0o400)
        session_identity = ownership.directory_evidence(session, 0)
        computer_identity = ownership.directory_evidence(computer, 0)
        (session / 'state').mkdir(mode=0o711)
        os.chmod(session / 'state', 0o711)
        state_identity = ownership.directory_evidence(session / 'state', 0)
        (session / 'readiness').mkdir(mode=0o700)
        readiness = session / 'readiness/ready.json'
        (session / 'renewals').mkdir(mode=0o700)
        (session / 'renewals/requested').mkdir(mode=0o700)
        (session / 'renewals/applied').mkdir(mode=0o700)
        renewal_identities = {path: ownership.directory_evidence(path, 0) for path in (
            session / 'renewals', session / 'renewals/requested', session / 'renewals/applied')}
        (session / 'home').mkdir(mode=0o700)
        os.chown(session / 'home', request['ownerUid'], gid)
        state = session / 'state/sunshine_state.json'
        pairing = {'root': {'uniqueid': request['computerId'], 'named_devices': [{
            'name': grant['leaseId'], 'uuid': grant['clientId'],
            'cert': grant['clientCertificatePem'], 'enabled': True}]}}
        # The service can read its authorized public client certificate but
        # cannot replace or extend the pairing store. Logs remain separate.
        ownership.write_new(state, ownership.encoded(pairing), 0o444)
        ownership.sync_dir(state.parent)
        original_guard()
        context_check(grant)
        observe(request, base)
        verify_sources()
        check_grant_clock(grant)
        def check_session():
            original_guard()
            if (ownership.directory_evidence(leases, 0) != leases_identity
                    or ownership.directory_evidence(computer, 0) != computer_identity
                    or ownership.directory_evidence(session, 0) != session_identity
                    or ownership.directory_evidence(session / 'state', 0) != state_identity
                    or any(ownership.directory_evidence(path, 0) != identity
                           for path, identity in renewal_identities.items())):
                raise ownership.Refused('guardian_session_replaced')
            if (ownership.regular(session / 'consumed.json', 0)[0] != consumed
                    or ownership.regular(computer / 'active.json', 0)[0] != active):
                raise ownership.Refused('guardian_consumed_grant_changed')
            if ownership.decoded_record(ownership.regular(state, 0)[0]) != pairing:
                raise ownership.Refused('guardian_pairing_changed')
        check_session()
        if os.path.lexists(session / 'revoked.json'):
            raise ownership.Refused('guardian_grant_revoked_before_spawn')
        process = None
        ready_bytes = None
        reason = 'startup_failed'
        try:
            with os.fdopen(os.open(session / 'process.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as log, \
                    os.fdopen(os.open('/usr/bin/sunshine', os.O_RDONLY | os.O_NOFOLLOW), 'rb') as binary:
                now = os.fstat(binary.fileno())
                if any(getattr(now, key) != getattr(executable_info, key)
                       for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
                    raise ownership.Refused('guardian_sunshine_changed')
                check_session()
                check_grant_clock(grant)
                if os.path.lexists(session / 'revoked.json'):
                    raise ownership.Refused('guardian_grant_revoked_before_spawn')
                process = subprocess.Popen(['/usr/bin/sunshine', str(root / 'sunshine.conf'),
                    'file_state=' + str(state), 'log_path=' + str(session / 'home/sunshine.log')],
                    executable='/proc/self/fd/' + str(binary.fileno()), pass_fds=(binary.fileno(),),
                    user=request['ownerUid'], group=gid,
                    extra_groups=capture_service_groups(request['ownerUid'], gid),
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': str(session / 'home'),
                         'XDG_CONFIG_HOME': str(session / 'home'), 'XDG_RUNTIME_DIR': '/run/user/' + str(request['ownerUid']),
                         'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(request['ownerUid']) + '/bus',
                         'DISPLAY': ':0', 'XDG_SESSION_TYPE': 'wayland',
                         'XDG_CURRENT_DESKTOP': 'Hyprland', 'DESKTOP_SESSION': 'hyprland',
                         'WAYLAND_DISPLAY': request['waylandDisplay']})
                startup_deadline = min(grant['deadlineBoottimeNs'], boottime_ns() + 5_000_000_000)
                authenticated = False
                renewal_count = 0
                active_deadline = grant['deadlineBoottimeNs']
                next_notify_ns = 0
                while process.poll() is None:
                    check_session()
                    if os.path.lexists(session / 'revoked.json'):
                        reason = 'revoked'
                        break
                    if Path('/proc/sys/kernel/random/boot_id').read_text().strip() != grant['guestBootId']:
                        reason = 'guest_boot_changed'
                        break
                    renewal_count, active_deadline, renewed = consume_next_renewal(
                        session, grant, renewal_count, active_deadline)
                    now_ns = boottime_ns()
                    if renewed:
                        next_notify_ns = now_ns + 5_000_000_000
                    elif renewal_count > 0 and now_ns >= next_notify_ns:
                        remaining_us = (active_deadline - now_ns) // 1000
                        if remaining_us <= 0:
                            reason = 'expired'
                            break
                        systemd_notify('EXTEND_TIMEOUT_USEC=' + str(remaining_us))
                        next_notify_ns = now_ns + 5_000_000_000
                    if now_ns >= active_deadline:
                        reason = 'expired'
                        break
                    remaining = (active_deadline - now_ns) / 1_000_000_000
                    if remaining <= 0:
                        reason = 'expired'
                        break
                    try:
                        require_paired_client(root, grant, min(.5, remaining))
                        if not authenticated:
                            ready_bytes = ownership.encoded(sunshine_ready_record(root, grant))
                            ownership.write_new(readiness, ready_bytes, 0o400)
                            ownership.sync_dir(readiness.parent)
                            systemd_notify('READY=1\nSTATUS=Hivra Sunshine lease active')
                        authenticated = True
                    except (OSError, http.client.HTTPException):
                        if boottime_ns() >= active_deadline:
                            reason = 'expired'
                            break
                        if authenticated or boottime_ns() >= startup_deadline:
                            raise ownership.Refused('guardian_pairing_observation_failed') from None
                    except ownership.Refused as error:
                        # Sunshine binds its admin socket before the API is
                        # fully ready. Only that exact transient status gets a
                        # bounded startup grace; certificate and client-set
                        # mismatches remain immediate holds.
                        if not pairing_observation_may_retry(
                                error, authenticated, boottime_ns(), startup_deadline):
                            raise
                    if ready_bytes is not None and ownership.regular(readiness, 0)[0] != ready_bytes:
                        raise ownership.Refused('guardian_readiness_changed')
                    time.sleep(max(0, min(0.1, (active_deadline - boottime_ns()) / 1_000_000_000)))
                else:
                    reason = 'child_exited'
        except (OSError, ValueError, ownership.Refused, subprocess.SubprocessError):
            reason = 'runtime_hold'
            raise
        finally:
            if process is not None and process.poll() is None:
                # The leader is still our unreaped child, so its process group
                # cannot have been recycled. systemd is the independent cgroup
                # backstop; group exit is not controller-release evidence.
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            if ownership.directory_evidence(session, 0) == session_identity:
                ownership.write_new(session / 'terminal.json', ownership.encoded({
                    'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'], 'reason': reason,
                    'releasePending': True, 'desktopReady': False}), 0o400)
        return {'leaseId': grant['leaseId'], 'sessionId': grant['sessionId'], 'reason': reason,
                'releasePending': True, 'desktopReady': False}


def client_certificate(pem, expected_sha256):
    """Validate a future lease's single self-signed non-CA client certificate.

    Sunshine trusts certificate chains, not just exact paired fingerprints.
    Never admit an issuer certificate as the lease's isolated client identity.
    This is a prerequisite for the v3 guardian, not an activation API.
    """
    if (not isinstance(pem, str) or len(pem) > 16384
            or not re.fullmatch(r'-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?', pem)
            or not isinstance(expected_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_sha256)):
        raise ownership.Refused('client_certificate_shape')
    data = pem.encode('ascii')
    env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}

    def x509(*args):
        try:
            return subprocess.run(['/usr/bin/openssl', 'x509', *args], input=data,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=3, env=env).stdout
        except (OSError, subprocess.SubprocessError):
            raise ownership.Refused('client_certificate_invalid') from None

    der = x509('-outform', 'DER')
    if hashlib.sha256(der).hexdigest() != expected_sha256:
        raise ownership.Refused('client_certificate_fingerprint')
    extensions = x509('-noout', '-ext', 'basicConstraints,keyUsage').decode('ascii')
    if 'CA:TRUE' in extensions or 'Certificate Sign' in extensions:
        raise ownership.Refused('client_certificate_can_sign')
    # Missing basicConstraints is not explicit non-CA evidence: OpenSSL can
    # infer CA capability for v1 roots and legacy Netscape certificate types.
    if not re.search(r'^\s*CA:FALSE\s*$', extensions, re.MULTILINE):
        raise ownership.Refused('client_certificate_non_ca_required')
    names = x509('-noout', '-subject', '-issuer', '-nameopt', 'RFC2253').decode('ascii').splitlines()
    if (len(names) != 2 or not names[0].startswith('subject=') or not names[1].startswith('issuer=')
            or names[0][len('subject='):] != names[1][len('issuer='):]):
        raise ownership.Refused('client_certificate_not_self_signed')
    canonical = x509('-outform', 'PEM')
    # Check the self-signature as well as matching names. OpenSSL can otherwise
    # trust an explicitly supplied anchor without checking its own signature.
    # Sunshine itself ignores certificate clock validity; lease expiry is a
    # separate CLOCK_BOOTTIME requirement, not a certificate expiration timer.
    with tempfile.TemporaryDirectory(prefix='hivra-client-certificate-') as temporary:
        cert = Path(temporary) / 'client.pem'
        ownership.write_new(cert, canonical, 0o400)
        try:
            subprocess.run(['/usr/bin/openssl', 'verify', '-trusted', str(cert),
                '-check_ss_sig', '-no_check_time', str(cert)], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, check=True, timeout=3, env=env)
        except (OSError, subprocess.SubprocessError):
            raise ownership.Refused('client_certificate_not_self_signed') from None
    return canonical.decode('ascii')


def sunshine_password(password, salt):
    # Pinned httpcommon.cpp hashes password+salt. utility.h util::hex defaults
    # to reverse BYTE order and uppercase, not conventional SHA256 hexdigest.
    return hashlib.sha256((password + salt).encode('ascii')).digest()[::-1].hex().upper()


def file_owner(name, request, owner):
    return request['ownerUid'] if name in ('credentials/key.pem', 'credentials/admin.json') else owner


FILES = ('intent.json', 'credentials/key.pem', 'credentials/cert.pem',
         'credentials/admin.json', 'admin-secret.json', 'apps.json', 'sunshine.conf')


def prepare(value, base=BASE, owner=0):
    request = ownership.binding(value)
    ownership.directory(base, owner)
    gid = pwd.getpwuid(request['ownerUid']).pw_gid
    if gid == 0:
        raise ownership.Refused('owner_group_invalid')
    ownership.require_service_traversal(base, request['ownerUid'], gid)
    root = base / request['computerId']
    if root.exists():
        # A completed, inactive preparation is safe to retire before issuing a
        # fresh operation binding.  Do not adopt or overwrite an incomplete,
        # active, malformed, or same-operation namespace: those remain a hard
        # failure so a retry cannot destroy credentials or live leases.
        existing = ownership.decoded_record(ownership.regular(root / 'intent.json', owner)[0])
        existing_binding = ownership.binding(existing['binding'])
        if existing_binding == request:
            if not (root / 'prepared.json').is_file():
                raise FileExistsError(root)
            return observe(existing_binding, base, owner)
        if existing_binding['computerId'] != request['computerId']:
            raise ownership.Refused('guardian_preparation_mismatch')
        observe(existing_binding, base, owner)
        retired = base / (request['computerId'] + '.superseded-' + secrets.token_hex(8))
        os.rename(root, retired)
        ownership.sync_dir(base)
    # One exclusive namespace reservation. A failed preparation remains owned
    # incomplete state; retry must not regenerate/adopt its credentials.
    os.mkdir(root, 0o711)
    os.chmod(root, 0o711)
    original_root = ownership.directory_evidence(root, owner)
    ownership.sync_dir(base)
    intent = {'protocol': PROTOCOL, 'binding': request, 'sunshineSource': PIN,
              'activation': 'forbidden'}
    ownership.write_new(root / 'intent.json', ownership.encoded(intent))
    with ownership.operation_lock(root, owner, original_root) as guard:
        os.mkdir(root / 'credentials', 0o711)
        os.chmod(root / 'credentials', 0o711)
        os.mkdir(root / 'state', 0o700)
        os.chown(root / 'state', request['ownerUid'], gid)
        ownership.sync_dir(root)
        ownership.create_keys(request, root, gid, owner)
        username = 'hivra-' + request['computerId']
        password, salt = secrets.token_hex(32), secrets.token_hex(16)
        ownership.write_new(root / 'admin-secret.json',
                            ownership.encoded({'username': username, 'password': password}), 0o400)
        auth_path = root / 'credentials/admin.json'
        ownership.write_new(auth_path, ownership.encoded({
            'username': username, 'password': sunshine_password(password, salt), 'salt': salt,
        }), 0o400)
        os.chown(auth_path, request['ownerUid'], gid)
        with open(auth_path, 'rb') as stream:
            os.fsync(stream.fileno())
        ownership.sync_dir(auth_path.parent)
        # Sunshine's pinned parser requires both top-level nodes. Omitting the
        # otherwise empty env object throws ptree_bad_path before any listener
        # is opened instead of returning a useful configuration error.
        ownership.write_new(root / 'apps.json', ownership.encoded({
            'env': {}, 'apps': [{'name': 'Desktop'}],
        }), 0o644)
        config = '\n'.join([
            'origin_web_ui_allowed = pc', 'upnp = disabled', 'min_log_level = 2',
            # This VM exposes a virtual DRM display but no hardware encoder.
            # KMS avoids the corrupted wlroots DMA-BUF path; the low-latency
            # software preset keeps the supported fallback interactive.
            'capture = kms', 'encoder = software',
            'sw_preset = ultrafast', 'sw_tune = zerolatency',
            'address_family = ipv4', 'port = 47989',
            'file_apps = ' + str(root / 'apps.json'),
            'file_state = ' + str(root / 'state/sunshine_state.json'),
            'credentials_file = ' + str(auth_path),
            'pkey = ' + str(root / 'credentials/key.pem'),
            'cert = ' + str(root / 'credentials/cert.pem'),
            'log_path = ' + str(root / 'state/sunshine.log'), '',
        ])
        ownership.write_new(root / 'sunshine.conf', config.encode(), 0o644)
        guard()
        record = {'intent': intent,
                  'files': {name: ownership.evidence(root / name, file_owner(name, request, owner)) for name in FILES},
                  'directories': {name: ownership.directory_evidence(root / name, request['ownerUid'] if name == 'state' else owner)
                                  for name in ('.', 'credentials', 'state')}}
        ownership.write_new(root / 'prepared.json', ownership.encoded(record))
        result = observe(request, base, owner)
        guard()
        return result


def verify_resources(root, record, request, owner):
    for name, expected in record['directories'].items():
        if ownership.directory_evidence(root / name, request['ownerUid'] if name == 'state' else owner) != expected:
            raise ownership.Refused('owned_directory_replaced')
    if ({p.name for p in root.iterdir()} != {'intent.json', 'prepared.json', 'credentials', 'state',
                                           'admin-secret.json', 'apps.json', 'sunshine.conf'}
            or {p.name for p in (root / 'credentials').iterdir()} != {'key.pem', 'cert.pem', 'admin.json'}
            or list((root / 'state').iterdir())):
        raise ownership.Refused('guardian_preparation_not_inactive')
    for name, expected in record['files'].items():
        if ownership.evidence(root / name, file_owner(name, request, owner)) != expected:
            raise ownership.Refused('owned_file_replaced')


def observe(value, base=BASE, owner=0):
    request = ownership.binding(value)
    ownership.directory(base, owner)
    root = base / request['computerId']
    ownership.directory(root, owner)
    record_bytes = ownership.regular(root / 'prepared.json', owner)[0]
    record = ownership.decoded_record(record_bytes)
    intent = {'protocol': PROTOCOL, 'binding': request, 'sunshineSource': PIN, 'activation': 'forbidden'}
    if (set(record) != {'intent', 'files', 'directories'} or record['intent'] != intent
            or set(record['files']) != set(FILES) or set(record['directories']) != {'.', 'credentials', 'state'}):
        raise ownership.Refused('guardian_preparation_mismatch')
    verify_resources(root, record, request, owner)
    secret = ownership.decoded_record(ownership.regular(root / 'admin-secret.json', owner)[0])
    auth = ownership.decoded_record(ownership.regular(root / 'credentials/admin.json', request['ownerUid'])[0])
    if (set(secret) != {'username', 'password'} or set(auth) != {'username', 'password', 'salt'}
            or secret['username'] != 'hivra-' + request['computerId'] or auth['username'] != secret['username']
            or not isinstance(secret['password'], str) or len(secret['password']) != 64
            or not isinstance(auth['salt'], str) or len(auth['salt']) != 32
            or auth['password'] != sunshine_password(secret['password'], auth['salt'])):
        raise ownership.Refused('guardian_administration_mismatch')
    gid = pwd.getpwuid(request['ownerUid']).pw_gid
    ownership.require_service_traversal(root / 'credentials', request['ownerUid'], gid)
    # External identity probing must not publish a snapshot that became stale
    # during the probe. Carry the original evidence forward, never recapture it.
    if ownership.regular(root / 'prepared.json', owner)[0] != record_bytes:
        raise ownership.Refused('guardian_preparation_mismatch')
    verify_resources(root, record, request, owner)
    return {'protocol': PROTOCOL, 'binding': request, 'administrationPrepared': True,
            'activation': 'forbidden', 'desktopReady': False}


def main():
    if sys.platform != 'linux' or os.geteuid() != 0 or len(sys.argv) not in (2, 3):
        raise ownership.Refused('usage_linux_root_guardian_command')
    command = sys.argv[1]
    if command == 'run' and len(sys.argv) == 3:
        print(json.dumps(run_installed_grant(sys.argv[2]), sort_keys=True))
        return
    if len(sys.argv) != 2 or command not in ('prepare', 'observe', 'activate', 'observe-ready',
                                              'renew', 'observe-renew', 'revoke', 'observe-stop',
                                              'release-stop'):
        raise ownership.Refused('usage_linux_root_guardian_command')
    for ancestor in reversed((BASE, *BASE.parents)):
        ownership.directory(ancestor, 0)
    limit = 65536 if command in ('renew', 'observe-renew') else (
        32768 if command in ('activate', 'observe-ready', 'observe-stop', 'release-stop') else 8192)
    raw = sys.stdin.buffer.read(limit + 1)
    if len(raw) > limit:
        raise ownership.Refused('request_too_large')
    value = ownership.decoded_record(raw)
    handler = {'prepare': prepare, 'observe': observe, 'activate': activate_lease,
               'observe-ready': observe_lease_ready, 'renew': renew_lease,
               'observe-renew': observe_lease_renewal, 'revoke': revoke_lease,
               'observe-stop': observe_lease_stop, 'release-stop': release_stopped_lease}[command]
    print(json.dumps(handler(value), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ownership.Refused, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, ownership.Refused) else 'guardian_preparation_failed'}))
        sys.exit(1)
