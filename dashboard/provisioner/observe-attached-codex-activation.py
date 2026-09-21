#!/usr/bin/env python3
"""Read an existing activation attempt. Never start, stop, repair or release it."""
import base64
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

STARTER_SHA256 = 'd06d92137ea69ff0339043176b9cf9631b105eea1c0d19083db9321d742fa314'
ROOT = Path('/var/lib/hivra/attachment-activation')


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate activation field')
        value[key] = item
    return value


def load_starter(source):
    if hashlib.sha256(source).hexdigest() != STARTER_SHA256:
        raise ValueError('unreviewed activation observer dependency')
    namespace = {'__name__': 'hivra_observed_starter'}
    exec(compile(source, '<pinned-starter>', 'exec'), namespace)
    return namespace


def checked_record(content, request):
    value = json.loads(content, object_pairs_hook=unique_object)
    base = {'version', 'request', 'phase'}
    if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1
            or json.dumps(value.get('request'), sort_keys=True) != json.dumps(request, sort_keys=True)):
        raise ValueError('activation journal request mismatch')
    phase = value.get('phase')
    if phase == 'preparing':
        allowed = base
    elif phase == 'start_requested':
        allowed = base | {'unitIdentity'}
    elif phase == 'service_started':
        allowed = base | {'unitIdentity', 'mainPid'}
    elif phase == 'start_failed':
        allowed = base | {'cleanup'} | (set(value) & {'unitIdentity', 'mainPid'})
        if value.get('cleanup') not in ('not_started', 'unconfirmed', 'stop_requested'):
            raise ValueError('invalid activation cleanup observation')
    else:
        raise ValueError('unknown activation journal phase')
    if set(value) != allowed:
        raise ValueError('invalid activation journal shape')
    if 'unitIdentity' in value and (not isinstance(value['unitIdentity'], list) or len(value['unitIdentity']) != 2
            or any(type(item) is not int or item < 0 for item in value['unitIdentity'])):
        raise ValueError('invalid activation unit identity')
    if 'mainPid' in value and ('unitIdentity' not in value or type(value['mainPid']) is not int or not 1 < value['mainPid'] < 2**31):
        raise ValueError('invalid activation process identity')
    return value


def observe(raw, probe=None):
    if not isinstance(raw, bytes) or len(raw) > 196608:
        raise ValueError('oversized activation observation packet')
    packet = json.loads(raw, object_pairs_hook=unique_object)
    if (not isinstance(packet, dict) or set(packet) != {'version', 'starter', 'packet'}
            or type(packet['version']) is not int or packet['version'] != 1):
        raise ValueError('invalid activation observation packet')
    starter = load_starter(base64.b64decode(packet['starter'], validate=True))
    verifier, encoded, request, service = starter['decode'](json.dumps(packet['packet']).encode())
    metadata = verifier['metadata']
    with ExitStack() as handles:
        def keep(fd):
            handles.callback(os.close, fd)
            return fd
        root = keep(verifier['directory'](str(ROOT), 0, mode=0o700))
        root_identity = (os.fstat(root).st_dev, os.fstat(root).st_ino)
        lock = keep(os.open('worker.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root))
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('unsafe activation observation lock')
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        lock_info = metadata(info)
        journal_info = metadata(os.stat('activation.json', dir_fd=root, follow_symlinks=False))
        content = verifier['checked_file'](root, 'activation.json', 0o600, maximum=131072)
        record = checked_record(content, request)

        def unchanged():
            current = verifier['directory'](str(ROOT), 0, mode=0o700)
            try:
                if root_identity != (os.fstat(current).st_dev, os.fstat(current).st_ino):
                    raise ValueError('activation observation namespace changed')
            finally:
                os.close(current)
            if (metadata(os.fstat(lock)) != lock_info
                    or metadata(os.stat('worker.lock', dir_fd=root, follow_symlinks=False)) != lock_info
                    or metadata(os.stat('activation.json', dir_fd=root, follow_symlinks=False)) != journal_info
                    or verifier['checked_file'](root, 'activation.json', 0o600, maximum=131072) != content):
                raise ValueError('activation changed during observation')

        result = {'version': 1, 'state': 'activation_unresolved', 'journalPhase': record['phase'],
            'operationId': request['operationId'], 'activationId': request['activationId'],
            'installationId': request['staged']['identity']['installationId'],
            'bootId': request['staged']['bootId'], 'serviceDefinitionSha256': service['sha256']}
        unchanged()
        if record['phase'] not in ('start_requested', 'service_started'):
            return result  # Failed/preparing is not permission to redispatch or release.

        units = keep(verifier['directory']('/etc/systemd/system'))
        units_identity = (os.fstat(units).st_dev, os.fstat(units).st_ino)
        unit_info = metadata(os.stat(service['unitName'], dir_fd=units, follow_symlinks=False))
        if list(unit_info[:2]) != record['unitIdentity']:
            raise ValueError('observed service inode differs from journal')

        def unit_unchanged():
            current = verifier['directory']('/etc/systemd/system')
            try:
                if units_identity != (os.fstat(current).st_dev, os.fstat(current).st_ino):
                    raise ValueError('observed service namespace changed')
            finally:
                os.close(current)
            if (metadata(os.stat(service['unitName'], dir_fd=units, follow_symlinks=False)) != unit_info
                    or verifier['checked_file'](units, service['unitName'], 0o644, maximum=16384, digest_only=True) != service['sha256']):
                raise ValueError('observed service definition changed')

        unit_unchanged()
        properties = starter['properties'](service['unitName'])
        starter['checked_properties'](properties, request, service)
        state = (properties.get('ActiveState'), properties.get('SubState'), properties.get('MainPID'))
        pid = None
        if state[:2] == ('active', 'running'):
            if not isinstance(state[2], str) or not state[2].isdecimal() or not 1 < int(state[2]) < 2**31:
                raise ValueError('invalid observed process')
            pid = int(state[2])
            if 'mainPid' in record and record['mainPid'] != pid:
                raise ValueError('observed process differs from recorded start')
            starter['checked_process'](pid, request, service)
            result.update(state='process_running', mainPid=pid)
        elif state == ('inactive', 'dead', '0'):
            result['state'] = 'service_inactive'  # No descendant/socket/session release claim.

        # Optional pinned internal protocol probe runs while the original
        # journal/lock/unit identities remain held. Revalidate all afterwards.
        # The ordinary CLI never supplies a callback or reports readiness.
        if pid is not None and probe is not None:
            probe(verifier, request, service, pid)
        verifier['preflight'](encoded)
        unit_unchanged()
        if starter['properties'](service['unitName']) != properties:
            raise ValueError('service changed during observation')
        if pid is not None:
            starter['checked_process'](pid, request, service)
        unit_unchanged()
        unchanged()
        return result  # Observation only; never native readiness, a dispatch grant or lease release.


if __name__ == '__main__':
    try:
        print(json.dumps(observe(sys.stdin.buffer.read(196609)), separators=(',', ':')))
    except Exception as error:
        raise SystemExit('Activation observation unconfirmed (' + type(error).__name__ + '); retain the operation and reconcile.')
