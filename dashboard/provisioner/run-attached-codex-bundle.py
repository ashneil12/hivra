#!/usr/bin/env python3
"""Consume one bounded pinned attachment bundle from the VMID-scoped channel.

Fetch and stage are distinct internal actions, not dispatch authorization. The
host orchestrator must retain the exact shared lease and obtain dispatch before
requesting stage. No caller commands, URLs, file destinations or extra assets.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import stat
import sys

PINS = {
    'fetcher': '252f4037e8bdc3ba4f3cfe68633031cb4abe1e2f1215ab72eda5510067b9b1b3',
    'worker': '2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab',
    'stager': '77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375',
}
MAX_BUNDLE_BYTES = 65536


def decode_bundle(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BUNDLE_BYTES:
        raise ValueError('oversized attachment bundle')
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'version', 'action', 'identity', 'bootId', 'assets'}
            or type(value['version']) is not int or value['version'] != 1 or value['action'] not in ('fetch', 'stage', 'observe')
            or not isinstance(value['assets'], dict) or set(value['assets']) != set(PINS)):
        raise ValueError('invalid attachment bundle')
    sources = {}
    for name, digest in PINS.items():
        encoded = value['assets'][name]
        if not isinstance(encoded, str):
            raise ValueError('invalid attachment asset')
        source = base64.b64decode(encoded, validate=True)
        if hashlib.sha256(source).hexdigest() != digest:
            raise ValueError('unreviewed attachment asset')
        sources[name] = source
    return value, sources


def load_reviewed(name, source):
    if name not in PINS or hashlib.sha256(source).hexdigest() != PINS[name]:
        raise ValueError('unreviewed attachment module')
    namespace = {'__name__': 'hivra_attachment_' + name}
    exec(compile(source, '<pinned-attachment-' + name + '>', 'exec'), namespace)
    return namespace


def journal_root():
    """Open the existing private journal namespace without creating anything."""
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in ('var', 'lib', 'hivra', 'attachment-staging'):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if (info.st_uid != 0 or info.st_mode & 0o022
                    or (part == 'attachment-staging' and stat.S_IMODE(info.st_mode) != 0o700)):
                raise ValueError('unsafe attachment observation directory')
        return fd
    except BaseException:
        os.close(fd)
        raise


def private_file(info):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600):
        raise ValueError('unsafe attachment observation file')


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_uid, info.st_gid, info.st_mode, info.st_nlink)


def observe_staged(identity, boot, worker):
    """Recover only an exact staged receipt. Absence is NOT permission to retry.

    No create, chmod, download, subprocess, installer or journal publication.
    Missing/started/changed/busy/old-boot state stays unresolved with its lease.
    """
    root = journal_root()
    try:
        root_info = os.fstat(root)
        lock = os.open('installer.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        try:
            lock_info = os.fstat(lock)
            private_file(lock_info)
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            fd = os.open('staging.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
            with os.fdopen(fd, 'rb') as source:
                before = os.fstat(source.fileno())
                private_file(before)
                if before.st_size > 16384:
                    raise ValueError('oversized attachment observation')
                raw = source.read(16385)
                if len(raw) > 16384 or file_identity(before) != file_identity(os.fstat(source.fileno())):
                    raise ValueError('attachment journal changed during observation')
            record = json.loads(raw)
            if (not isinstance(record, dict) or set(record) != {'version', 'identity', 'bootId', 'phase', 'receipt'}
                    or type(record['version']) is not int or record['version'] != 1
                    or record['identity'] != identity or record['bootId'] != boot or record['phase'] != 'staged'):
                raise ValueError('attachment remains unresolved; never redispatch')
            worker['checked_receipt'](record['receipt'], identity)
            current = journal_root()
            try:
                resolved = os.fstat(current)
                if (root_info.st_dev, root_info.st_ino) != (resolved.st_dev, resolved.st_ino):
                    raise ValueError('attachment journal namespace changed')
                for name, saved in (('installer.lock', lock_info), ('staging.json', before)):
                    if file_identity(os.stat(name, dir_fd=current, follow_symlinks=False)) != file_identity(saved):
                        raise ValueError('attachment observation entry changed')
            finally:
                os.close(current)
            return record
        finally:
            os.close(lock)
    finally:
        os.close(root)


def execute_bundle(raw):
    value, sources = decode_bundle(raw)  # Verify every asset before loading any.
    if os.geteuid() != 0 or platform.system() != 'Linux':
        raise ValueError('requires the bound Linux guest')
    worker = load_reviewed('worker', sources['worker'])
    identity = worker['checked_identity'](value['identity'])
    boot = value['bootId']
    if (not isinstance(boot, str) or not worker['UUID'].fullmatch(boot)
            or boot != Path('/proc/sys/kernel/random/boot_id').read_text().strip()):
        raise ValueError('guest boot changed before bundle execution')
    if value['action'] == 'observe':
        return observe_staged(identity, boot, worker)
    fetcher = load_reviewed('fetcher', sources['fetcher'])
    if value['action'] == 'fetch':
        return fetcher['acquire'](identity['architecture'], boot)
    # Stage never downloads, even if its cache entry is absent or corrupt.
    root = fetcher['private_root'](create=False)
    try:
        _, digest, size = fetcher['ARTIFACTS'][identity['architecture']]
        cached = digest + '.tar.gz'
        verified = fetcher['verify_cached'](root, cached, digest, size)
        fetcher['verify_public_path'](root, cached, verified)
    finally:
        os.close(root)
    # Only the small stager needs a pathname. Use an exclusive root-owned file
    # in /run; the pinned worker reopens and hashes it before execution.
    run = os.open('/run', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None
    try:
        info = os.fstat(run)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe attachment temporary directory')
        name = 'hivra-attachment-stager-' + secrets.token_hex(16) + '.py'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=run)
        temporary = name
        created = os.fstat(fd)
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(sources['stager'])
            output.flush()
            os.fsync(output.fileno())
        current = os.open('/run', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            resolved = os.fstat(current)
            if (info.st_dev, info.st_ino) != (resolved.st_dev, resolved.st_ino):
                raise ValueError('attachment temporary namespace changed')
            entry = os.stat(name, dir_fd=current, follow_symlinks=False)
            if (entry.st_dev, entry.st_ino) != (created.st_dev, created.st_ino):
                raise ValueError('attachment temporary entry changed')
        finally:
            os.close(current)
        return worker['run'](identity, '/run/' + name, fetcher['ROOT'] / cached, boot)
    finally:
        try:
            if temporary is not None:
                try:
                    entry = os.stat(temporary, dir_fd=run, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    if (entry.st_dev, entry.st_ino) != (created.st_dev, created.st_ino):
                        raise ValueError('preserve replaced attachment temporary entry')
                    os.unlink(temporary, dir_fd=run)
        finally:
            os.close(run)


if __name__ == '__main__':
    try:
        print(json.dumps(execute_bundle(sys.stdin.buffer.read(MAX_BUNDLE_BYTES + 1)), separators=(',', ':')))
    except Exception as error:
        raise SystemExit('Attachment bundle refused (' + type(error).__name__ + '); retain the operation for reconciliation.')
