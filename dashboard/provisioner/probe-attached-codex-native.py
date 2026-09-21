"""Observe a pinned activation's private native protocol; never grant work."""
import base64
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import struct
import sys
import time

PINS = {
    'observer': '7ec5e67ee169d97033e2eb3cdc43e51e1153d74ff3c863ca92984811432fd0f3',
    'protocol': '60cef5e61a6445410915bac17e78cb36f0784584ac4d81d483757b3560142569',
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate native probe field')
        result[key] = value
    return result


def load(name, encoded):
    source = base64.b64decode(encoded, validate=True)
    if len(source) > 65536 or hashlib.sha256(source).hexdigest() != PINS[name]:
        raise ValueError('unreviewed native probe dependency')
    result = {'__name__': 'hivra_native_' + name}
    exec(compile(source, '<pinned-' + name + '>', 'exec'), result)
    return result


@contextmanager
def check_native(verifier, request, service, pid, protocol):
    receipt = request['staged']['receipt']
    uid, gid = receipt['uid'], receipt['gid']
    path = Path(service['socketPath'])
    metadata = verifier['metadata']
    with ExitStack() as handles:
        def keep(fd):
            handles.callback(os.close, fd)
            return fd
        directory = keep(verifier['directory'](str(path.parent), uid, gid, 0o700))
        directory_identity = metadata(os.fstat(directory))
        info = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != uid or info.st_gid != gid
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ValueError('unsafe native socket')
        socket_identity = metadata(info)
        process = keep(os.open('/proc/' + str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        process_identity = (os.fstat(process).st_dev, os.fstat(process).st_ino)

        def process_start():
            fd = os.open('stat', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=process)
            with os.fdopen(fd, 'rb') as source:
                content = source.read(8193)
            if len(content) > 8192:
                raise ValueError('oversized native process observation')
            # comm may contain spaces/parentheses. Fields after its last ')' start
            # at state (field 3), making starttime (field 22) index 19.
            fields = content.rsplit(b')', 1)
            tail = fields[-1].split()
            if len(fields) != 2 or len(tail) < 20 or tail[0] in (b'Z', b'X', b'x') or not tail[19].isdigit():
                raise ValueError('native process is unavailable')
            return tail[19]

        started = process_start()
        def unchanged():
            current = verifier['directory'](str(path.parent), uid, gid, 0o700)
            try:
                if metadata(os.fstat(current)) != directory_identity:
                    raise ValueError('native socket directory changed')
            finally:
                os.close(current)
            current_process = os.stat('/proc/' + str(pid), follow_symlinks=False)
            if ((current_process.st_dev, current_process.st_ino) != process_identity
                    or process_start() != started
                    or metadata(os.stat(path.name, dir_fd=directory, follow_symlinks=False)) != socket_identity):
                raise ValueError('native process or socket changed')

        unchanged()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            deadline = time.monotonic() + 5
            protocol['budget'](client, deadline)
            # Retain the validated directory even if its public name is replaced.
            client.connect('/proc/self/fd/' + str(directory) + '/' + path.name)
            peer = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer != (pid, uid, gid):
                raise ValueError('native peer does not match activation')
            unchanged()
            protocol['initialize'](client, receipt['home'] + '/.codex', deadline)
            unchanged()
            yield
            # Keep socket/process descriptors alive through the enclosing
            # activation observer's final unit/journal/process validation.
            unchanged()


def probe(raw):
    if not isinstance(raw, bytes) or len(raw) > 262144:
        raise ValueError('oversized native probe packet')
    packet = json.loads(raw, object_pairs_hook=unique_object)
    if (not isinstance(packet, dict) or set(packet) != {'version', 'observer', 'protocol', 'packet'}
            or type(packet['version']) is not int or packet['version'] != 1):
        raise ValueError('invalid native probe packet')
    observer = load('observer', packet['observer'])
    protocol = load('protocol', packet['protocol'])
    with ExitStack() as checks:
        checked = False
        def callback(verifier, request, service, pid):
            nonlocal checked
            checks.enter_context(check_native(verifier, request, service, pid, protocol))
            checked = True
        observation = observer['observe'](json.dumps(packet['packet']).encode(), callback)
        if not checked or observation['state'] != 'process_running':
            raise ValueError('native protocol not observed')
        result = dict(observation, state='native_protocol_available')
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(probe(sys.stdin.buffer.read(262145)), separators=(',', ':')))
    except Exception as error:
        raise SystemExit('Native protocol unconfirmed (' + type(error).__name__ + '); retain the operation and reconcile.')
