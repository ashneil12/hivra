#!/usr/bin/env python3
"""Fetch one fixed public Codex archive into a private guest cache; never install.

No caller-selected URLs, proxy credentials, package manager or execution. Invoke
only on the bound Linux guest before dispatch, with its independently read boot.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import stat
import urllib.parse
import urllib.request

ROOT = Path('/var/lib/hivra/attachment-artifacts')
ARTIFACTS = {
    'x86_64': ('codex-x86_64-unknown-linux-musl.tar.gz', 'e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278', 99479490),
    'aarch64': ('codex-aarch64-unknown-linux-musl.tar.gz', '14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0', 91899352),
}
ALLOWED_HOSTS = {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')


def checked_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS or parsed.port not in (None, 443)
            or parsed.username is not None or parsed.password is not None or parsed.fragment):
        raise ValueError('unapproved artifact redirect')
    return url


class PinnedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, checked_url(newurl))


def private_root(create=True):
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(ROOT.parts[1:]):
            mode = 0o700 if index == len(ROOT.parts) - 2 else 0o711
            created = False
            if create:
                try:
                    os.mkdir(part, mode=mode, dir_fd=parent)
                    created = True
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                if created:
                    os.fchmod(child, mode)
                    os.fsync(child)
                    os.fsync(parent)
                info = os.fstat(child)
                if info.st_uid != 0 or info.st_mode & 0o022 or (mode == 0o700 and stat.S_IMODE(info.st_mode) != mode):
                    raise ValueError('unsafe artifact directory')
            except BaseException:
                os.close(child)
                raise
            os.close(parent)
            parent = child
        result, parent = parent, None
        return result
    finally:
        if parent is not None:
            os.close(parent)


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_uid, info.st_gid, info.st_mode, info.st_nlink)


def verify_cached(root, name, digest, size):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != size):
            raise ValueError('unsafe existing artifact')
        actual = hashlib.sha256()
        for block in iter(lambda: source.read(65536), b''):
            actual.update(block)
        if actual.hexdigest() != digest:
            raise ValueError('existing artifact digest mismatch')
        if file_identity(info) != file_identity(os.fstat(source.fileno())):
            raise ValueError('artifact changed during verification')
        return file_identity(info)


def verify_public_path(root, name, verified_file):
    current = private_root(create=False)
    try:
        original, resolved = os.fstat(root), os.fstat(current)
        if (original.st_dev, original.st_ino) != (resolved.st_dev, resolved.st_ino):
            raise ValueError('artifact cache namespace changed')
        if file_identity(os.stat(name, dir_fd=current, follow_symlinks=False)) != verified_file:
            raise ValueError('artifact cache entry changed')
    finally:
        os.close(current)


def deadline(signum, frame):
    raise TimeoutError('artifact acquisition deadline')


def acquire(architecture, expected_boot_id):
    if os.geteuid() != 0 or platform.system() != 'Linux' or architecture not in ARTIFACTS or platform.machine() != architecture:
        raise ValueError('requires the bound Linux guest architecture')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if not isinstance(expected_boot_id, str) or not UUID.fullmatch(expected_boot_id) or boot != expected_boot_id:
        raise ValueError('guest boot changed before artifact acquisition')
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise ValueError('artifact acquisition requires its own process deadline')
    previous_handler = signal.signal(signal.SIGALRM, deadline)
    signal.setitimer(signal.ITIMER_REAL, 180)
    root = lock = None
    temporary = None
    try:
        root = private_root()
        lock = os.open('download.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('unsafe artifact download lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        filename, digest, size = ARTIFACTS[architecture]
        cached = digest + '.tar.gz'
        try:
            os.stat(cached, dir_fd=root, follow_symlinks=False)
        except FileNotFoundError:
            candidate = '.download-' + secrets.token_hex(16)
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
            temporary = candidate
            with os.fdopen(fd, 'wb') as output:
                os.fchmod(output.fileno(), 0o600)
                url = checked_url('https://github.com/openai/codex/releases/download/rust-v0.149.1/' + filename)
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), PinnedRedirect())
                request = urllib.request.Request(url, headers={'User-Agent': 'Hivra-Pinned-Artifact/1', 'Accept-Encoding': 'identity'})
                with opener.open(request, timeout=20) as response:
                    checked_url(response.geturl())
                    if response.status != 200:
                        raise ValueError('unexpected artifact HTTP status')
                    length = response.headers.get('Content-Length')
                    if length is not None and length != str(size):
                        raise ValueError('unexpected artifact HTTP size')
                    count, actual = 0, hashlib.sha256()
                    while True:
                        block = response.read(min(65536, size - count + 1))
                        if not block:
                            break
                        count += len(block)
                        if count > size:
                            raise ValueError('artifact exceeds pinned size')
                        output.write(block)
                        actual.update(block)
                    if count != size or actual.hexdigest() != digest:
                        raise ValueError('downloaded artifact pin mismatch')
                output.flush()
                os.fsync(output.fileno())
            # Exclusive publication: never replace an existing file. A crash
            # between link/unlink may leave a multi-link file; verification then
            # fails closed for explicit reconciliation rather than overwriting.
            os.link(temporary, cached, src_dir_fd=root, dst_dir_fd=root, follow_symlinks=False)
            os.fsync(root)
            os.unlink(temporary, dir_fd=root)
            temporary = None
            os.fsync(root)
        verified = verify_cached(root, cached, digest, size)
        verify_public_path(root, cached, verified)
        return {'version': 1, 'state': 'available', 'architecture': architecture, 'bootId': boot,
                'archiveSha256': digest, 'size': size, 'path': str(ROOT / cached)}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        try:
            if temporary is not None and root is not None:
                os.unlink(temporary, dir_fd=root)  # Only this invocation's exclusive temporary file.
        finally:
            if lock is not None:
                os.close(lock)
            if root is not None:
                os.close(root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--architecture', required=True, choices=tuple(ARTIFACTS))
    parser.add_argument('--expected-boot-id', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(acquire(args.architecture, args.expected_boot_id), separators=(',', ':')))
    except Exception as error:
        raise SystemExit('Artifact acquisition refused (' + type(error).__name__ + '); no installer was run.')
