#!/usr/bin/env python3
"""Read-only guest activation preflight. Never installs, starts, or grants work.

A future bound worker must retain its operation fence through the actual start.
This observation alone cannot authorize activation or release a database lease.
"""
import base64
from contextlib import ExitStack
import grp
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import stat
import subprocess
import sys

POLICY = '66f89162530b682aa66d8a59250f385530726a162def8902ffb7bc953eee9428'
PINS = {
    'worker': '2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab',
    'observer': 'ec5760568541f03024a10c62c884638b3ba2a0bbca26c18b91260c8130111fb3',
}
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')


def service_definition(staged):
    """Independent rendering of the pinned TS policy; cross-contract tested."""
    installation = staged['identity']['installationId']
    receipt = staged['receipt']
    account, home, executable = (receipt[key] for key in ('account', 'home', 'executable'))
    name = 'hivra-attached-' + installation
    sock = '/run/' + name + '/app.sock'
    content = f'''[Unit]
Description=Hivra attached Codex {installation}
After=network.target

[Service]
Type=exec
User={account}
Group={account}
WorkingDirectory={home}
Environment=HOME={home}
Environment=CODEX_HOME={home}/.codex
Environment=PATH=/usr/bin:/bin
UMask=0077
RuntimeDirectory={name}
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=no
ExecStartPre=/usr/bin/test ! -L {home}/.codex
ExecStartPre=/usr/bin/mkdir -p {home}/.codex
ExecStart=/usr/bin/env -i HOME={home} CODEX_HOME={home}/.codex PATH=/usr/bin:/bin {executable} -c analytics.enabled=false app-server --listen unix://{sock}
Restart=no
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=15
SendSIGKILL=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths={home}
PrivateTmp=yes
ProtectControlGroups=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
'''
    unit = name + '.service'
    return {'unitName': unit, 'unitPath': '/etc/systemd/system/' + unit, 'socketPath': sock,
            'content': content, 'sha256': hashlib.sha256(content.encode()).hexdigest()}


def decode(raw):
    if not isinstance(raw, bytes) or len(raw) > 65536:
        raise ValueError('oversized activation preflight')
    packet = json.loads(raw)
    if (not isinstance(packet, dict) or set(packet) != {'version', 'request', 'assets'}
            or type(packet['version']) is not int or packet['version'] != 1
            or not isinstance(packet['assets'], dict) or set(packet['assets']) != set(PINS)):
        raise ValueError('invalid activation preflight shape')
    sources = {}
    for name, pin in PINS.items():
        source = base64.b64decode(packet['assets'][name], validate=True)
        if hashlib.sha256(source).hexdigest() != pin:
            raise ValueError('unreviewed activation verifier')
        sources[name] = source
    request = packet['request']
    if (not isinstance(request, dict) or set(request) != {'version', 'operationId', 'activationId', 'generation',
            'servicePolicySha256', 'serviceDefinitionSha256', 'staged'}
            or type(request['version']) is not int or request['version'] != 1
            or request['servicePolicySha256'] != POLICY
            or not isinstance(request['generation'], str)
            or not re.fullmatch(r'[1-9][0-9]{0,18}', request['generation'])
            or not 2 <= int(request['generation']) <= 9223372036854775807
            or any(not isinstance(request[key], str) or not UUID.fullmatch(request[key])
                   for key in ('operationId', 'activationId'))):
        raise ValueError('invalid activation request')
    return request, sources


def load_verified(name, source):
    if hashlib.sha256(source).hexdigest() != PINS[name]:
        raise ValueError('unreviewed activation verifier')
    namespace = {'__name__': 'hivra_activation_' + name}
    exec(compile(source, '<pinned-' + name + '>', 'exec'), namespace)
    return namespace


def directory(path, uid=0, gid=None, mode=None):
    """Walk every component by no-follow FD; create/chmod nothing."""
    parts = Path(path).parts
    if not parts or parts[0] != '/' or any(part in ('.', '..') for part in parts):
        raise ValueError('invalid activation directory')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(parts[1:], 1):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            last = index == len(parts) - 1
            if (info.st_uid != (uid if last else 0) or info.st_mode & 0o022
                    or (last and gid is not None and info.st_gid != gid)
                    or (last and mode is not None and stat.S_IMODE(info.st_mode) != mode)):
                raise ValueError('unsafe activation directory')
        return fd
    except BaseException:
        os.close(fd)
        raise


def metadata(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def checked_file(parent, name, mode, gid=None, maximum=16384, digest_only=False):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1
                or stat.S_IMODE(before.st_mode) != mode or before.st_size > maximum
                or (gid is not None and before.st_gid != gid)):
            raise ValueError('unsafe activation file')
        digest = hashlib.sha256()
        content = bytearray()
        size = 0
        while True:
            block = source.read(min(1024 * 1024, maximum + 1 - size))
            if not block:
                break
            size += len(block)
            if size > maximum:
                raise ValueError('oversized activation file')
            digest.update(block)
            if not digest_only:
                content.extend(block)
        if (metadata(before) != metadata(os.fstat(source.fileno()))
                or metadata(before) != metadata(os.stat(name, dir_fd=parent, follow_symlinks=False))):
            raise ValueError('activation file changed during observation')
        return digest.hexdigest() if digest_only else bytes(content)


def preflight(raw):
    request, sources = decode(raw)
    if os.geteuid() != 0 or platform.system() != 'Linux':
        raise ValueError('requires bound Linux guest root')
    staged = request['staged']
    if (not isinstance(staged, dict) or set(staged) != {'version', 'identity', 'bootId', 'phase', 'receipt'}
            or type(staged['version']) is not int or staged['version'] != 1 or staged['phase'] != 'staged'
            or not isinstance(staged['bootId'], str) or not UUID.fullmatch(staged['bootId'])
            or staged['bootId'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip()):
        raise ValueError('staging identity or boot changed')
    worker = load_verified('worker', sources['worker'])
    identity = worker['checked_identity'](staged['identity'])
    receipt = worker['checked_receipt'](staged['receipt'], identity)
    if request['operationId'] != identity['operationId']:
        raise ValueError('activation operation mismatch')
    service = service_definition(staged)
    if request['serviceDefinitionSha256'] != service['sha256']:
        raise ValueError('activation service policy mismatch')
    observer = load_verified('observer', sources['observer'])
    if observer['observe_staged'](identity, staged['bootId'], worker) != staged:
        raise ValueError('guest staging journal mismatch')
    user = pwd.getpwnam(receipt['account'])
    group = grp.getgrnam(receipt['account'])
    if ((user.pw_uid, user.pw_gid, user.pw_dir, user.pw_shell)
            != (receipt['uid'], receipt['gid'], receipt['home'], '/usr/sbin/nologin')
            or group.gr_gid != receipt['gid']
            or set(os.getgrouplist(receipt['account'], receipt['gid'])) != {receipt['gid']}):
        raise ValueError('activation account changed')
    with ExitStack() as handles:
        def keep(fd):
            handles.callback(os.close, fd)
            return fd
        home = keep(directory(receipt['home'], receipt['uid'], receipt['gid'], 0o700))
        home_info = metadata(os.fstat(home))
        install_path = str(Path(receipt['executable']).parent)
        install = keep(directory(install_path, 0, receipt['gid'], 0o750))
        install_info = metadata(os.fstat(install))
        journal = keep(directory('/var/lib/hivra/attachment-staging', 0, mode=0o700))
        journal_info = metadata(os.fstat(journal))
        entries = [(install, 'installation.json'), (install, 'codex'),
                   (journal, 'staging.json'), (journal, 'installer.lock')]
        before = [metadata(os.stat(name, dir_fd=parent, follow_symlinks=False)) for parent, name in entries]
        recorded = json.loads(checked_file(install, 'installation.json', 0o600))
        worker['checked_receipt'](recorded, identity)
        if recorded != receipt:
            raise ValueError('installed receipt changed')
        binary = checked_file(install, 'codex', 0o550, receipt['gid'], 512 * 1024 * 1024, True)
        if binary != receipt['binarySha256']:
            raise ValueError('installed binary changed')
        # Root opens do not prove service-account access through ancestor ACLs.
        # A fixed, read-only child asks the kernel under the exact service IDs;
        # it does not execute Codex, create files, or start a service.
        probe = """import os,sys
os.chdir(sys.argv[1])
assert os.access('.',os.R_OK|os.W_OK|os.X_OK,effective_ids=True)
assert os.access(sys.argv[2],os.R_OK|os.X_OK,effective_ids=True)
"""
        result = subprocess.run(['/usr/bin/python3', '-I', '-B', '-S', '-c', probe, receipt['home'], receipt['executable']],
            user=receipt['uid'], group=receipt['gid'], extra_groups=[], timeout=5,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/bin:/bin', 'HOME': receipt['home'], 'LANG': 'C'})
        if result.returncode != 0:
            raise ValueError('service account cannot access its installation')
        # Compare original evidence after hashing/probing. Never adopt a later
        # replacement or silently rebase this observation onto changed state.
        for pathname, uid, gid, mode, saved in (
                (receipt['home'], receipt['uid'], receipt['gid'], 0o700, home_info),
                (install_path, 0, receipt['gid'], 0o750, install_info),
                ('/var/lib/hivra/attachment-staging', 0, None, 0o700, journal_info)):
            current = keep(directory(pathname, uid, gid, mode))
            if metadata(os.fstat(current)) != saved:
                raise ValueError('activation namespace changed')
        for (parent, name), saved in zip(entries, before):
            if metadata(os.stat(name, dir_fd=parent, follow_symlinks=False)) != saved:
                raise ValueError('activation evidence changed')
        if (pwd.getpwnam(receipt['account']) != user or grp.getgrnam(receipt['account']) != group
                or set(os.getgrouplist(receipt['account'], receipt['gid'])) != {receipt['gid']}
                or observer['observe_staged'](identity, staged['bootId'], worker) != staged):
            raise ValueError('activation account or journal changed')
    return {'version': 1, 'state': 'preflight_verified', 'activationId': request['activationId'],
            'operationId': request['operationId'], 'installationId': identity['installationId'],
            'bootId': staged['bootId'], 'serviceDefinitionSha256': service['sha256'],
            'uid': receipt['uid'], 'gid': receipt['gid'], 'binarySha256': binary}


if __name__ == '__main__':
    try:
        print(json.dumps(preflight(sys.stdin.buffer.read(65537)), separators=(',', ':')))
    except Exception as error:
        raise SystemExit('Activation preflight refused (' + type(error).__name__ + '); preserve the operation.')
