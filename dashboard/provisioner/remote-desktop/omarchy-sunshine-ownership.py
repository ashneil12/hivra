#!/usr/bin/env python3
"""Private, inactive Omarchy native-service preparation. No pairing/start API.

Run as root inside the exact VM through the existing VM-bound execution path.
The caller supplies the original computer/VM/operation binding on stdin. This
script cannot independently authenticate a control-plane owner or a VM number.
Neither its receipt nor its files are native desktop capability evidence.
"""

import hashlib
import fcntl
from contextlib import contextmanager
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import ssl
import stat
import subprocess
import sys

BASE = Path('/var/lib/hivra/omarchy-native')
UNITS = Path('/etc/systemd/system')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
STANDARD_UNIT = 'app-dev.lizardbyte.app.Sunshine.service'


class Refused(Exception):
    pass


def binding(value):
    keys = {'computerId', 'operationId', 'vmid', 'ownerUid', 'guestPrivateIpv4', 'waylandDisplay'}
    if not isinstance(value, dict) or set(value) != keys:
        raise Refused('binding_shape')
    if any(not isinstance(value[k], str) or not UUID.fullmatch(value[k]) for k in ('computerId', 'operationId')):
        raise Refused('binding_uuid')
    if any(type(value[k]) is not int or not 100 <= value[k] <= 2147483647 for k in ('vmid', 'ownerUid')):
        raise Refused('binding_identity')
    try:
        address = ipaddress.IPv4Address(value['guestPrivateIpv4'])
    except (ValueError, TypeError):
        raise Refused('binding_address') from None
    if not any(address in ipaddress.ip_network(cidr) for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise Refused('binding_address')
    if not isinstance(value['waylandDisplay'], str) or not re.fullmatch(r'wayland-[0-9]{1,3}', value['waylandDisplay']):
        raise Refused('binding_wayland')
    return dict(value)


def regular(path, owner, limit=1048576):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or info.st_size > limit or info.st_mode & 0o022:
            raise Refused('unsafe_file')
        data = os.read(fd, limit + 1)
        after = os.fstat(fd)
        if len(data) != info.st_size or (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise Refused('file_changed')
        return data, info
    finally:
        os.close(fd)


def directory(path, owner):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
        raise Refused('unsafe_directory')
    return info


def directory_evidence(path, owner):
    info = directory(path, owner)
    return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
            'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def service_groups(uid, gid):
    return os.getgrouplist(pwd.getpwuid(uid).pw_name, gid)


def require_service_traversal(path, uid, gid):
    # Root can inspect files the service cannot reach. Check the entire path,
    # not only the new namespace's 0711 mode. Never chmod existing parents.
    for parent in reversed((path, *path.parents)):
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode):
            raise Refused('service_path_not_directory')
    # Let the kernel evaluate supplementary groups and ACLs. Other-execute
    # does not grant access when a matching group or named-user ACL denies it.
    if os.geteuid() == 0:
        result = subprocess.run(
            [sys.executable, '-I', '-S', '-c', 'import os,sys; sys.exit(0 if os.access(sys.argv[1], os.X_OK) else 1)', str(path)],
            user=uid, group=gid, extra_groups=service_groups(uid, gid),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=5, check=False, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        allowed = result.returncode == 0
    else:
        # Supports same-identity local tests, never a different unprobed user.
        allowed = os.geteuid() == uid and os.getegid() == gid and os.access(path, os.X_OK)
    if not allowed:
        raise Refused('service_path_not_traversable')


def write_new(path, data, mode=0o600, gid=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        if gid is not None:
            os.fchown(fd, -1, gid)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(path.parent)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def decoded_record(data):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise Refused('ownership_record_duplicate_key')
            result[key] = value
        return result
    value = json.loads(data, object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise Refused('ownership_record_invalid')
    return value


def evidence(path, owner):
    data, info = regular(path, owner)
    return {'sha256': hashlib.sha256(data).hexdigest(), 'device': info.st_dev,
            'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'size': len(data)}


def run(args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=15, check=False, umask=0o077,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    if result.returncode:
        raise Refused('guest_command_failed')
    return result.stdout.decode('utf-8')


def unit_properties(request, gid):
    root, unit = names(request, BASE, UNITS)
    return {
        'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead', 'MainPID': '0',
        'FragmentPath': str(unit), 'SourcePath': '', 'DropInPaths': '', 'NeedDaemonReload': 'no',
        'Type': 'simple', 'User': str(request['ownerUid']), 'Group': str(gid),
        'Restart': 'no', 'KillMode': 'control-group', 'TimeoutStopUSec': '5s', 'RuntimeMaxUSec': '4min',
        'ExecStartPre': '', 'ExecStartPost': '', 'ExecStop': '', 'ExecStopPost': '', 'ExecReload': '',
        'RootDirectory': '', 'RootImage': '',
        'Environment': ' '.join([
            'HOME=' + str(root / 'state'), 'XDG_CONFIG_HOME=' + str(root / 'state/config'),
            'XDG_RUNTIME_DIR=/run/user/' + str(request['ownerUid']),
            'WAYLAND_DISPLAY=' + request['waylandDisplay'],
        ]),
        'ExecStart': ('{ path=/usr/bin/sunshine ; argv[]=/usr/bin/sunshine ' + str(root / 'sunshine.conf')
                      + ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }'),
    }


def check_unit_state(state, request, gid, fresh):
    if fresh:
        if state.get('LoadState') != 'not-found':
            raise Refused('unit_already_known')
        return
    # Deliberately strict for an installed but never-started unit. Unknown
    # systemd serialization refuses; it must not weaken the admission gate.
    expected = unit_properties(request, gid)
    for key, value in expected.items():
        observed = state.get(key)
        if key == 'Environment' and observed is not None:
            if sorted(shlex.split(observed)) == sorted(shlex.split(value)):
                continue
        if observed != value:
            raise Refused('owned_unit_effective_definition_mismatch')


def parse_unit_state(output):
    # systemd's Exec array printer emits no line for an empty array, including
    # with --all. Other required properties must actually be present.
    state = {key: '' for key in ('ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload')}
    seen = set()
    for line in output.splitlines():
        if '=' not in line:
            raise Refused('unit_property_shape')
        key, value = line.split('=', 1)
        # Multiple Exec commands produce repeated keys: never accept only the
        # final safe-looking command after a preceding additional command.
        if key in seen:
            raise Refused('unit_property_duplicate')
        seen.add(key)
        state[key] = value
    return state


def preflight(request, fresh):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise Refused('linux_root_required')
    owner = pwd.getpwuid(request['ownerUid'])
    if owner.pw_gid == 0:
        raise Refused('owner_group_invalid')
    unit_name = 'hivra-omarchy-native-' + request['computerId'] + '.service'
    unit_state = run(['/usr/bin/systemctl', 'show', '--all', unit_name,
                      '--property=' + ','.join(unit_properties(request, owner.pw_gid))])
    state = parse_unit_state(unit_state)
    check_unit_state(state, request, owner.pw_gid, fresh)
    for name, version in [('omarchy', '4.0.2-1'), ('sunshine', '2026.516.143833-4')]:
        if run(['/usr/bin/pacman', '-Q', name]).strip() != name + ' ' + version:
            raise Refused('package_pin_mismatch')
    executable, info = regular(Path('/usr/bin/sunshine'), 0, 268435456)
    if info.st_mode & 0o022 or not info.st_mode & 0o111:
        raise Refused('sunshine_executable_unsafe')
    socket = Path('/run/user') / str(owner.pw_uid) / request['waylandDisplay']
    socket_info = os.lstat(socket)
    if not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != owner.pw_uid:
        raise Refused('wayland_socket_mismatch')
    addresses = json.loads(run(['/usr/bin/ip', '-j', '-4', 'address', 'show', 'up', 'scope', 'global']))
    observed = [a.get('local') for interface in addresses for a in interface.get('addr_info', []) if a.get('family') == 'inet']
    if observed.count(request['guestPrivateIpv4']) != 1:
        raise Refused('guest_address_mismatch')
    # Read-only. Refuse port conflicts; never stop the standard owner service.
    for line in run(['/usr/bin/ss', '-H', '-lntu']).splitlines():
        fields = line.split()
        if len(fields) < 6:
            raise Refused('listener_shape')
        port = fields[4].rsplit(':', 1)[-1]
        if port in {'47984', '47989', '47990', '48010', '47998', '47999', '48000', '48002'}:
            raise Refused('sunshine_port_conflict')
    return {'ownerGid': owner.pw_gid, 'sunshineSha256': hashlib.sha256(executable).hexdigest()}


def names(request, base, units):
    root = base / request['computerId']
    unit = units / ('hivra-omarchy-native-' + request['computerId'] + '.service')
    return root, unit


@contextmanager
def operation_lock(root, owner, original_root=None):
    original_root = original_root if original_root is not None else directory_evidence(root, owner)
    path = root / 'intent.json'
    _, expected = regular(path, owner)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        actual = os.fstat(fd)
        if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            raise Refused('ownership_lock_replaced')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('ownership_operation_busy') from None
        def guard():
            if directory_evidence(root, owner) != original_root:
                raise Refused('owned_directory_replaced')
            current = os.lstat(path)
            if (current.st_dev, current.st_ino) != (actual.st_dev, actual.st_ino):
                raise Refused('ownership_lock_replaced')
        guard()
        yield guard
    finally:
        os.close(fd)


def checkpoint_layout(phase):
    files = ['intent.json']
    directories = ['.']
    if phase >= 1:
        directories.append('state')
    if phase >= 2:
        directories.append('credentials')
    if phase >= 3:
        files.extend(['credentials/key.pem', 'credentials/cert.pem'])
    if phase >= 4:
        files.append('apps.json')
    if phase >= 5:
        files.append('sunshine.conf')
    if phase >= 7:
        files.append('prepared.json')
    return files, directories


def checkpoint(root, unit, intent, phase, owner):
    files, directories = checkpoint_layout(phase)
    uid = intent['binding']['ownerUid']
    previous = regular(root / ('checkpoint-' + str(phase - 1) + '.json'), owner)[0] if phase else None
    prior = {'files': {}, 'directories': {}, 'unit': None}
    if previous is not None:
        prior = decoded_record(previous)
        check_record_resources(root, unit, prior, intent, owner)
    record = {
        'phase': phase, 'intent': intent,
        'previousSha256': hashlib.sha256(previous).hexdigest() if previous is not None else None,
        'files': {name: prior['files'][name] if name in prior['files']
                  else evidence(root / name, uid if name == 'credentials/key.pem' else owner) for name in files},
        'directories': {name: prior['directories'][name] if name in prior['directories']
                        else directory_evidence(root / name, uid if name == 'state' else owner) for name in directories},
        'unit': prior['unit'] if prior['unit'] is not None else evidence(unit, owner) if phase >= 6 else None,
    }
    # Never recapture and thereby bless changed prior bytes during a later
    # step. Carry their original identity forward, then check before sealing.
    check_record_resources(root, unit, record, intent, owner)
    write_new(root / ('checkpoint-' + str(phase) + '.json'), encoded(record))


def check_record_resources(root, unit, record, intent, owner):
    phase = record.get('phase')
    if type(phase) is not int or not 0 <= phase <= 7:
        raise Refused('checkpoint_record_invalid')
    files, directories = checkpoint_layout(phase)
    if (not isinstance(record.get('files'), dict) or set(record['files']) != set(files)
            or not isinstance(record.get('directories'), dict) or set(record['directories']) != set(directories)):
        raise Refused('checkpoint_record_invalid')
    uid = intent['binding']['ownerUid']
    # Paths come only from the fixed recipe, never from a journal's keys.
    for name in directories:
        if directory_evidence(root / name, uid if name == 'state' else owner) != record['directories'][name]:
            raise Refused('owned_directory_replaced')
    for name in files:
        if evidence(root / name, uid if name == 'credentials/key.pem' else owner) != record['files'][name]:
            raise Refused('owned_file_replaced')
    if record['unit'] is not None and evidence(unit, owner) != record['unit']:
        raise Refused('owned_unit_replaced')


def checked_checkpoint(root, unit, intent, owner):
    # Immutable cumulative checkpoints prove completed steps only. An artifact
    # created before a crash but not sealed by its checkpoint is never adopted.
    previous = None
    record = None
    phase = -1
    for index in range(8):
        path = root / ('checkpoint-' + str(index) + '.json')
        if not os.path.lexists(path):
            break
        data = regular(path, owner)[0]
        current = decoded_record(data)
        files, directories = checkpoint_layout(index)
        if (set(current) != {'phase', 'intent', 'previousSha256', 'files', 'directories', 'unit'}
                or type(current['phase']) is not int or current['phase'] != index
                or current['intent'] != intent or current['previousSha256'] != previous
                or not isinstance(current['files'], dict) or set(current['files']) != set(files)
                or not isinstance(current['directories'], dict) or set(current['directories']) != set(directories)
                or (index < 6 and current['unit'] is not None)):
            raise Refused('checkpoint_record_invalid')
        if record is not None and (any(current['files'].get(k) != v for k, v in record['files'].items())
                                   or any(current['directories'].get(k) != v for k, v in record['directories'].items())
                                   or (record['unit'] is not None and current['unit'] != record['unit'])):
            raise Refused('checkpoint_evidence_changed')
        previous = hashlib.sha256(data).hexdigest()
        record, phase = current, index
    if record is None:
        raise Refused('preparation_incomplete_do_not_adopt')
    files, directories = checkpoint_layout(phase)
    expected_root = {name.split('/')[0] for name in files + directories if name != '.'}
    expected_root.update('checkpoint-' + str(index) + '.json' for index in range(phase + 1))
    if {path.name for path in root.iterdir()} != expected_root or os.path.lexists(str(unit) + '.d'):
        raise Refused('uncheckpointed_resource_do_not_adopt')
    check_record_resources(root, unit, record, intent, owner)
    if phase >= 1 and list((root / 'state').iterdir()):
        raise Refused('preparation_no_longer_inactive')
    if phase >= 2 and {path.name for path in (root / 'credentials').iterdir()} != ({'key.pem', 'cert.pem'} if phase >= 3 else set()):
        raise Refused('uncheckpointed_resource_do_not_adopt')
    if phase < 6 and os.path.lexists(unit):
        raise Refused('uncheckpointed_resource_do_not_adopt')
    return phase


def prepare(value, base=BASE, units=UNITS, owner=0, probe=preflight):
    request = binding(value)
    directory(base, owner)
    directory(units, owner)
    root, unit = names(request, base, units)
    # Do not adopt even an identical old file or an interrupted old operation.
    if any(os.path.lexists(p) for p in (root, unit, Path(str(unit) + '.d'))):
        raise Refused('ownership_conflict')
    installed = probe(request, True)
    if set(installed) != {'ownerGid', 'sunshineSha256'} or type(installed['ownerGid']) is not int or installed['ownerGid'] < 1 or not re.fullmatch('[a-f0-9]{64}', installed['sunshineSha256']):
        raise Refused('installed_identity_invalid')
    require_service_traversal(base, request['ownerUid'], installed['ownerGid'])
    # The exclusive directory reserves this computer. Intent is durable before
    # certificates, configuration, user state, or a unit are created. A crash
    # leaves inspectable intent, not permission to adopt/retry existing bytes.
    os.mkdir(root, 0o711)
    os.chmod(root, 0o711)
    original_root = directory_evidence(root, owner)
    sync_dir(base)
    intent = {'protocol': 'hivra-omarchy-native-ownership-v2', 'binding': request,
              'installed': installed, 'unit': unit.name, 'activation': 'forbidden'}
    write_new(root / 'intent.json', encoded(intent))
    with operation_lock(root, owner, original_root) as guard:
        checkpoint(root, unit, intent, 0, owner)
        return continue_preparation(request, root, unit, intent, base, units, owner, probe, guard)


def resume(value, base=BASE, units=UNITS, owner=0, probe=preflight):
    request = binding(value)
    directory(base, owner)
    directory(units, owner)
    root, unit = names(request, base, units)
    with operation_lock(root, owner) as guard:
        intent = decoded_record(regular(root / 'intent.json', owner)[0])
        if (set(intent) != {'protocol', 'binding', 'installed', 'unit', 'activation'}
                or intent.get('binding') != request or intent.get('activation') != 'forbidden'
                or intent.get('unit') != unit.name):
            raise Refused('ownership_binding_mismatch')
        if intent.get('protocol') != 'hivra-omarchy-native-ownership-v2':
            raise Refused('legacy_preparation_not_resumable')
        return continue_preparation(request, root, unit, intent, base, units, owner, probe, guard)


def continue_preparation(request, root, unit, intent, base, units, owner, probe, guard):
    while True:
        guard()
        phase = checked_checkpoint(root, unit, intent, owner)
        if probe(request, phase < 6) != intent['installed']:
            raise Refused('installed_identity_changed')
        require_service_traversal(base, request['ownerUid'], intent['installed']['ownerGid'])
        guard()
        # Probing external state must not turn a previously checked path into
        # an implicit adoption window before the next owned write.
        if checked_checkpoint(root, unit, intent, owner) != phase:
            raise Refused('checkpoint_changed')
        if phase == 7:
            result = observe(request, base, units, owner, probe)
            guard()
            if checked_checkpoint(root, unit, intent, owner) != 7:
                raise Refused('checkpoint_changed')
            return result
        create_step(phase + 1, request, root, unit, intent, owner)
        guard()
        checkpoint(root, unit, intent, phase + 1, owner)


def create_step(phase, request, root, unit, intent, owner):
    gid = intent['installed']['ownerGid']
    if phase == 1:
        os.mkdir(root / 'state', 0o700)
        os.chown(root / 'state', request['ownerUid'], gid)
        sync_dir(root / 'state')
        sync_dir(root)
        return
    if phase == 2:
        os.mkdir(root / 'credentials', 0o711)
        os.chmod(root / 'credentials', 0o711)
        sync_dir(root / 'credentials')
        sync_dir(root)
        return
    if phase == 3:
        create_keys(request, root, gid, owner)
        return
    if phase == 4:
        write_new(root / 'apps.json', encoded({'env': {}, 'apps': [{'name': 'Desktop'}]}), 0o644)
        return
    if phase == 5:
        write_config(root)
        return
    if phase == 6:
        write_unit(request, root, unit, gid)
        return
    if phase == 7:
        seal_prepared(request, root, unit, intent, owner)
        return
    raise Refused('checkpoint_phase_invalid')


def create_keys(request, root, gid, owner):
    # Openssl generates only in this new private directory. No key in argv/logs.
    run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
         '-keyout', str(root / 'credentials/key.pem'), '-out', str(root / 'credentials/cert.pem'),
         '-days', '365', '-subj', '/CN=hivra-' + request['computerId']])
    for filename in ('key.pem', 'cert.pem'):
        path = root / 'credentials' / filename
        regular(path, owner)
        # Primary groups can be shared. Only the exact service UID can read
        # the private key; the root-controlled directory prevents replacement.
        os.chown(path, request['ownerUid'] if filename == 'key.pem' else owner, gid)
        os.chmod(path, 0o400 if filename == 'key.pem' else 0o644)
        with open(path, 'rb') as stream:
            os.fsync(stream.fileno())
    sync_dir(root / 'credentials')


def write_config(root):
    config = '\n'.join([
        'origin_web_ui_allowed = pc', 'upnp = disabled', 'min_log_level = 2',
        'address_family = ipv4', 'port = 47989',
        'file_apps = ' + str(root / 'apps.json'),
        'file_state = ' + str(root / 'state/sunshine_state.json'),
        'credentials_file = ' + str(root / 'state/sunshine_state.json'),
        'pkey = ' + str(root / 'credentials/key.pem'),
        'cert = ' + str(root / 'credentials/cert.pem'),
        'log_path = ' + str(root / 'state/sunshine.log'), '',
    ])
    write_new(root / 'sunshine.conf', config.encode(), 0o644)


def write_unit(request, root, unit, gid):
    unit_text = '\n'.join([
        '[Unit]', 'Description=Hivra private Omarchy native desktop',
        # No component creates this marker yet. This file is not a lease API.
        'ConditionPathExists=' + str(root / 'lease-authorized'),
        '[Service]', 'Type=simple', 'User=' + str(request['ownerUid']), 'Group=' + str(gid),
        'Environment=HOME=' + str(root / 'state'),
        'Environment=XDG_CONFIG_HOME=' + str(root / 'state/config'),
        'Environment=XDG_RUNTIME_DIR=/run/user/' + str(request['ownerUid']),
        'Environment=WAYLAND_DISPLAY=' + request['waylandDisplay'],
        'ExecStart=/usr/bin/sunshine ' + str(root / 'sunshine.conf'),
        'Restart=no', 'KillMode=control-group', 'TimeoutStopSec=5', 'RuntimeMaxSec=240', '',
    ])
    write_new(unit, unit_text.encode(), 0o644)


def seal_prepared(request, root, unit, intent, owner):
    files = ['intent.json', 'sunshine.conf', 'apps.json', 'credentials/key.pem', 'credentials/cert.pem']
    record = {'intent': intent, 'files': {
                  name: evidence(root / name, request['ownerUid'] if name == 'credentials/key.pem' else owner)
                  for name in files},
              'unit': evidence(unit, owner), 'directories': {
                  '.': directory_evidence(root, owner),
                  'credentials': directory_evidence(root / 'credentials', owner),
                  'state': directory_evidence(root / 'state', request['ownerUid']),
              }}
    write_new(root / 'prepared.json', encoded(record))


def observe(value, base=BASE, units=UNITS, owner=0, probe=preflight):
    request = binding(value)
    directory(base, owner)
    directory(units, owner)
    root, unit = names(request, base, units)
    directory(root, owner)
    intent = json.loads(regular(root / 'intent.json', owner)[0])
    if intent.get('binding') != request or intent.get('activation') != 'forbidden':
        raise Refused('ownership_binding_mismatch')
    if not (root / 'prepared.json').exists():
        raise Refused('preparation_incomplete_do_not_adopt')
    record = json.loads(regular(root / 'prepared.json', owner)[0])
    expected_files = {'intent.json', 'sunshine.conf', 'apps.json', 'credentials/key.pem', 'credentials/cert.pem'}
    if record.get('intent') != intent or set(record.get('files', {})) != expected_files or set(record.get('directories', {})) != {'.', 'credentials', 'state'}:
        raise Refused('ownership_record_invalid')
    for name, expected in record['directories'].items():
        if directory_evidence(root / name, request['ownerUid'] if name == 'state' else owner) != expected:
            raise Refused('owned_directory_replaced')
    if list((root / 'state').iterdir()) or os.path.lexists(root / 'lease-authorized') or os.path.lexists(str(unit) + '.d'):
        raise Refused('preparation_no_longer_inactive')
    for name, expected in record['files'].items():
        if evidence(root / name, request['ownerUid'] if name == 'credentials/key.pem' else owner) != expected:
            raise Refused('owned_file_replaced')
    if evidence(unit, owner) != record.get('unit'):
        raise Refused('owned_unit_replaced')
    if probe(request, False) != intent.get('installed'):
        raise Refused('installed_identity_changed')
    require_service_traversal(base, request['ownerUid'], intent['installed']['ownerGid'])
    cert = regular(root / 'credentials/cert.pem', owner)[0].decode('ascii')
    return {'protocol': 'hivra-omarchy-native-owned-preparation-v1', 'binding': request,
            'unit': unit.name, 'certificateSha256': hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert)).hexdigest(),
            'activation': 'forbidden', 'desktopReady': False}


def main():
    if sys.platform != 'linux' or os.geteuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in ('prepare', 'observe', 'resume'):
        raise Refused('usage_linux_root_prepare_observe_or_resume')
    for target in (BASE, UNITS):
        for ancestor in reversed((target, *target.parents)):
            directory(ancestor, 0)
    # Caller must provision and validate root-owned base parents separately.
    # No mkdir -p, recursive cleanup, path overrides, or activation command.
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise Refused('request_too_large')
    value = json.loads(raw)
    result = {'prepare': prepare, 'observe': observe, 'resume': resume}[sys.argv[1]](value)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (Refused, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # Do not return subprocess output, filesystem content or private paths.
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, Refused) else 'ownership_operation_failed'}))
        sys.exit(1)
