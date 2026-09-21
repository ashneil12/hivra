#!/usr/bin/env python3
"""One guest service-start attempt; caller must hold the DB/host dispatch fence.

No automatic retry, enable-on-boot, binding publication, model call or lease
release. An existing journal always refuses start; observation is separate.
"""
import base64
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

PREFLIGHT_SHA256 = '779c3041fffcae1802559ddf48b5f2a55759805773812121991f1033e2d67781'
ROOT = Path('/var/lib/hivra/attachment-activation')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C'}
EXEC_PROPERTIES = frozenset(('ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecCondition', 'ExecReload'))


def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > 131072:
        raise ValueError('oversized service start packet')
    packet = json.loads(raw)
    if (not isinstance(packet, dict) or set(packet) != {'version', 'preflight', 'packet'}
            or type(packet['version']) is not int or packet['version'] != 1):
        raise ValueError('invalid service start packet')
    source = base64.b64decode(packet['preflight'], validate=True)
    if hashlib.sha256(source).hexdigest() != PREFLIGHT_SHA256:
        raise ValueError('unreviewed activation preflight')
    verifier = {'__name__': 'hivra_activation_preflight'}
    exec(compile(source, '<pinned-activation-preflight>', 'exec'), verifier)
    encoded = json.dumps(packet['packet'], separators=(',', ':')).encode()
    verifier['preflight'](encoded)
    request = packet['packet']['request']
    return verifier, encoded, request, verifier['service_definition'](request['staged'])


def private_root(verifier):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(ROOT.parts[1:], 1):
            last = index == len(ROOT.parts) - 1
            created = False
            try:
                os.mkdir(part, mode=0o700 if last else 0o711, dir_fd=fd)
                os.fsync(fd)
                created = True
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            if created:
                os.fchmod(fd, 0o700 if last else 0o711)
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022 or (last and stat.S_IMODE(info.st_mode) != 0o700):
                raise ValueError('unsafe activation journal directory')
        current = verifier['directory'](str(ROOT), 0, mode=0o700)
        try:
            if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != (os.fstat(current).st_dev, os.fstat(current).st_ino):
                raise ValueError('activation journal namespace changed')
        finally:
            os.close(current)
        return fd
    except BaseException:
        os.close(fd)
        raise


def exclusive_file(root, name, content, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=root)
    with os.fdopen(fd, 'wb') as output:
        os.fchmod(output.fileno(), mode)
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
        info = os.fstat(output.fileno())
    os.fsync(root)
    return (info.st_dev, info.st_ino)


def publish(root, record, initial=False, check=lambda: None):
    check()
    content = json.dumps(record, separators=(',', ':')).encode()
    if initial:
        return exclusive_file(root, 'activation.json', content, 0o600)
    # Fixed private temp name is exclusive and never reused on uncertainty.
    identity = exclusive_file(root, '.activation-next', content, 0o600)
    check()
    info = os.stat('.activation-next', dir_fd=root, follow_symlinks=False)
    if identity != (info.st_dev, info.st_ino):
        raise ValueError('activation publication replaced')
    os.replace('.activation-next', 'activation.json', src_dir_fd=root, dst_dir_fd=root)
    os.fsync(root)
    return identity


class Journal:
    """Hold original namespace and lock; never adopt someone else's journal."""
    def __init__(self, verifier, root, lock):
        self.verifier, self.root, self.lock = verifier, root, lock
        self.root_identity = (os.fstat(root).st_dev, os.fstat(root).st_ino)
        self.lock_info = verifier['metadata'](os.fstat(lock))
        self.info, self.content = None, None
        self.check()

    def check(self):
        current = self.verifier['directory'](str(ROOT), 0, mode=0o700)
        try:
            if self.root_identity != (os.fstat(current).st_dev, os.fstat(current).st_ino):
                raise ValueError('activation root replaced')
        finally:
            os.close(current)
        metadata = self.verifier['metadata']
        if (metadata(os.fstat(self.lock)) != self.lock_info
                or metadata(os.stat('worker.lock', dir_fd=self.root, follow_symlinks=False)) != self.lock_info):
            raise ValueError('activation lock replaced')
        try:
            info = metadata(os.stat('activation.json', dir_fd=self.root, follow_symlinks=False))
        except FileNotFoundError:
            if self.info is None:
                return
            raise ValueError('activation journal disappeared') from None
        if self.info is None or info != self.info:
            raise ValueError('activation journal replaced')
        if self.verifier['checked_file'](self.root, 'activation.json', 0o600, maximum=131072) != self.content:
            raise ValueError('activation journal bytes changed')

    def write(self, record):
        self.check()
        identity = publish(self.root, record, initial=self.info is None, check=self.check)
        info = os.stat('activation.json', dir_fd=self.root, follow_symlinks=False)
        content = json.dumps(record, separators=(',', ':')).encode()
        if (identity != (info.st_dev, info.st_ino)
                or self.verifier['checked_file'](self.root, 'activation.json', 0o600, maximum=131072) != content):
            raise ValueError('activation publication not owned')
        self.info, self.content = self.verifier['metadata'](info), content
        self.check()


def command(args, timeout=20):
    result = subprocess.run(args, check=False, capture_output=True, text=True, timeout=timeout, env=ENV,
                            stdin=subprocess.DEVNULL)
    if result.returncode != 0 or len(result.stdout.encode()) > 16384:
        raise ValueError('service control did not confirm success')
    return result.stdout


def properties(unit):
    text = command(['/usr/bin/systemctl', 'show', unit,
        '--property=LoadState,FragmentPath,DropInPaths,User,Group,WorkingDirectory,Restart,KillMode,NoNewPrivileges,ProtectSystem,ProtectHome,UnitFileState,ActiveState,SubState,MainPID,NeedDaemonReload,Type,UMask,RuntimeDirectory,RuntimeDirectoryMode,RuntimeDirectoryPreserve,Environment,ReadWritePaths,CapabilityBoundingSet,AmbientCapabilities,PrivateTmp,ProtectControlGroups,ProtectKernelTunables,ProtectKernelModules,RestrictSUIDSGID,RestrictAddressFamilies,KillSignal,TimeoutStopUSec,SendSIGKILL,ExecStart,ExecStartPre,ExecStartPost,ExecStop,ExecStopPost,ExecCondition,ExecReload'])
    pairs = [line.split('=', 1) for line in text.splitlines()]
    if any(len(pair) != 2 for pair in pairs):
        raise ValueError('invalid service properties')
    # systemctl emits one line per Exec command and omits empty Exec arrays.
    # Preserve command order; duplicate scalar properties remain invalid.
    value = {key: '' for key in EXEC_PROPERTIES}
    for key, item in pairs:
        if key in EXEC_PROPERTIES:
            value[key] = (value[key] + ' ' + item).strip()
        elif key in value:
            raise ValueError('duplicate service property')
        else:
            value[key] = item
    return value


def command_definitions(text):
    """Parse each systemctl command object; never swallow an extra command."""
    result = []
    while text.strip():
        match = re.match(r'\s*\{([^{}]*)\}\s*', text)
        if not match:
            raise ValueError('invalid effective command encoding')
        pairs = [field.strip().split('=', 1) for field in match[1].split(';') if field.strip()]
        if any(len(pair) != 2 for pair in pairs) or len({pair[0] for pair in pairs}) != len(pairs):
            raise ValueError('invalid effective command fields')
        fields = dict(pairs)
        result.append((fields.get('path'), fields.get('argv[]'), fields.get('ignore_errors')))
        text = text[match.end():]
    return result


def checked_properties(value, request, service, before_start=False):
    receipt = request['staged']['receipt']
    expected = {'LoadState': 'loaded', 'FragmentPath': service['unitPath'], 'DropInPaths': '',
        'User': receipt['account'], 'Group': receipt['account'], 'WorkingDirectory': receipt['home'],
        'Restart': 'no', 'KillMode': 'control-group', 'NoNewPrivileges': 'yes',
        'ProtectSystem': 'strict', 'ProtectHome': 'yes', 'UnitFileState': 'disabled',
        'NeedDaemonReload': 'no', 'Type': 'exec', 'UMask': '0077',
        'RuntimeDirectory': service['unitName'].removesuffix('.service'),
        'RuntimeDirectoryMode': '0700', 'RuntimeDirectoryPreserve': 'no',
        'Environment': f"HOME={receipt['home']} CODEX_HOME={receipt['home']}/.codex PATH=/usr/bin:/bin",
        'ReadWritePaths': receipt['home'], 'CapabilityBoundingSet': '', 'AmbientCapabilities': '',
        'PrivateTmp': 'yes', 'ProtectControlGroups': 'yes', 'ProtectKernelTunables': 'yes',
        'ProtectKernelModules': 'yes', 'RestrictSUIDSGID': 'yes', 'KillSignal': '15',
        'TimeoutStopUSec': '15s', 'SendSIGKILL': 'yes',
        'ExecStartPost': '', 'ExecStop': '', 'ExecStopPost': '', 'ExecCondition': '', 'ExecReload': ''}
    if before_start:
        expected.update(ActiveState='inactive', SubState='dead', MainPID='0')
    if any(value.get(key) != wanted for key, wanted in expected.items()):
        raise ValueError('effective service definition differs from the owned policy')
    if set(value.get('RestrictAddressFamilies', '').split()) != {'AF_UNIX', 'AF_INET', 'AF_INET6'}:
        raise ValueError('effective address family policy differs')
    for key in ('ExecStart', 'ExecStartPre'):
        commands = [line.split('=', 1)[1] for line in service['content'].splitlines() if line.startswith(key + '=')]
        expected_commands = [(line.split(' ', 1)[0], line, 'no') for line in commands]
        if command_definitions(value.get(key, '')) != expected_commands:
            raise ValueError('effective service commands differ')


def checked_process(pid, request, service):
    receipt = request['staged']['receipt']
    process = Path('/proc') / str(pid)
    status = dict(line.split(':', 1) for line in (process / 'status').read_text().splitlines() if ':' in line)
    if ([int(value) for value in status.get('Uid', '').split()] != [receipt['uid']] * 4
            or [int(value) for value in status.get('Gid', '').split()] != [receipt['gid']] * 4
            or (process / 'exe').resolve() != Path(receipt['executable'])):
        raise ValueError('service process identity differs from the installation')
    expected = [receipt['executable'], '-c', 'analytics.enabled=false', 'app-server', '--listen', 'unix://' + service['socketPath']]
    actual = (process / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    if actual != [value.encode() for value in expected]:
        raise ValueError('service process arguments differ from policy')


def start(raw):
    verifier, encoded, request, service = decode(raw)
    with ExitStack() as handles:
        def keep(fd):
            handles.callback(os.close, fd)
            return fd
        root = keep(private_root(verifier))
        lock = keep(os.open('worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root))
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('unsafe activation lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal = Journal(verifier, root, lock)
        try:
            os.stat('activation.json', dir_fd=root, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError('activation already attempted; observe without starting again')
        units = keep(verifier['directory']('/etc/systemd/system'))
        for path in (service['unitPath'], service['unitPath'] + '.d',
                     '/run/systemd/system/' + service['unitName'], '/run/systemd/system/' + service['unitName'] + '.d'):
            if os.path.lexists(path):
                raise ValueError('existing service state requires reconciliation')
        # This query must confirm absence, not an arbitrary command failure.
        before = properties(service['unitName'])
        if before.get('LoadState') != 'not-found' or before.get('ActiveState') != 'inactive' or before.get('MainPID') != '0':
            raise ValueError('service identity is already known')
        verifier['preflight'](encoded)
        record = {'version': 1, 'request': request, 'phase': 'preparing'}
        journal.write(record)  # Durable before creating a unit or requesting start.
        owned = None
        start_sent = False
        def verify_owned():
            current = os.stat(service['unitName'], dir_fd=units, follow_symlinks=False)
            if owned != (current.st_dev, current.st_ino):
                raise ValueError('owned service inode changed')
            if verifier['checked_file'](units, service['unitName'], 0o644, maximum=16384, digest_only=True) != service['sha256']:
                raise ValueError('owned service bytes changed')
            resolved = keep(verifier['directory']('/etc/systemd/system'))
            if (os.fstat(resolved).st_dev, os.fstat(resolved).st_ino) != (os.fstat(units).st_dev, os.fstat(units).st_ino):
                raise ValueError('service namespace changed')
        try:
            journal.check()
            owned = exclusive_file(units, service['unitName'], service['content'].encode(), 0o644)
            command(['/usr/bin/systemd-analyze', 'verify', service['unitPath']])
            command(['/usr/bin/systemctl', 'daemon-reload'])
            verify_owned()
            checked_properties(properties(service['unitName']), request, service, before_start=True)
            record.update(phase='start_requested', unitIdentity=list(owned))
            journal.write(record)
            verify_owned()
            checked_properties(properties(service['unitName']), request, service, before_start=True)
            journal.check()
            start_sent = True
            command(['/usr/bin/systemctl', 'start', service['unitName']])
            verify_owned()
            observed = properties(service['unitName'])
            checked_properties(observed, request, service)
            if observed.get('ActiveState') != 'active' or observed.get('SubState') != 'running':
                raise ValueError('service not observed running')
            pid_text = observed.get('MainPID', '')
            if not pid_text.isdecimal() or not 1 < int(pid_text) < 2**31:
                raise ValueError('service process not observed')
            checked_process(int(pid_text), request, service)
            record.update(phase='service_started', mainPid=int(pid_text))
            journal.write(record)
            return record  # Process state only, NOT native-protocol or useful-work readiness.
        except BaseException:
            cleanup = 'not_started'
            if start_sent:
                cleanup = 'unconfirmed'
                try:
                    verify_owned()
                    checked_properties(properties(service['unitName']), request, service)
                    command(['/usr/bin/systemctl', 'stop', service['unitName']])
                    cleanup = 'stop_requested'  # Not descendant/socket/lease release evidence.
                except BaseException:
                    pass
            record.update(phase='start_failed', cleanup=cleanup)
            journal.write(record)
            raise


if __name__ == '__main__':
    try:
        print(json.dumps(start(sys.stdin.buffer.read(131073)), separators=(',', ':')))
    except Exception as error:
        raise SystemExit('Service start unconfirmed (' + type(error).__name__ + '); retain the operation and reconcile.')
