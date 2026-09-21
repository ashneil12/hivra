#!/usr/bin/env python3
"""Real pinned native protocol in an owned root Linux Docker fixture only."""
import json
import base64
import hashlib
import os
from pathlib import Path
import pwd
import signal
import socket
import struct
import subprocess
import time
import uuid

INSTALLATION = '00000000-0000-4000-8000-000000001004'
ACCOUNT = 'hva_1848dfdc7902485bbba8d4f9'
HOME = Path('/var/lib/hivra/agent-homes') / INSTALLATION
BINARY = Path('/opt/hivra/agent-installations') / INSTALLATION / 'codex'
SOCKET = HOME / ('s-' + uuid.uuid4().hex[:8] + '.sock')


def initialize():
    # Official app-server Unix transport is WebSocket-over-Unix, NOT JSONL.
    # Test-only minimal client: only upgrade plus one bounded unfragmented reply.
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(10)
        client.connect(str(SOCKET))
        key = base64.b64encode(os.urandom(16)).decode()
        client.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                       'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n\r\n').encode())
        headers = bytearray()
        while not headers.endswith(b'\r\n\r\n'):
            data = client.recv(1)
            assert data and len(headers) < 8192, 'invalid native upgrade'
            headers.extend(data)
        assert headers.startswith(b'HTTP/1.1 101 '), 'native upgrade refused'
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        accepts = [line.split(b':', 1)[1].strip() for line in bytes(headers).split(b'\r\n')
                   if line.lower().startswith(b'sec-websocket-accept:')]
        assert accepts == [accept], 'invalid native accept'
        payload = json.dumps({'id': 1, 'method': 'initialize', 'params': {
            'clientInfo': {'name': 'hivra_fixture', 'version': '1.0.0'}}}).encode()
        mask = os.urandom(4)
        length = bytes([0x80 | len(payload)]) if len(payload) < 126 else b'\xfe' + struct.pack('!H', len(payload))
        client.sendall(b'\x81' + length + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))
        def exact(size):
            value = bytearray()
            while len(value) < size:
                chunk = client.recv(size - len(value))
                assert chunk, 'native reply closed early'
                value.extend(chunk)
            return bytes(value)
        opcode, length = exact(2)
        assert opcode == 0x81 and length < 128, 'unexpected native frame'
        if length == 126:
            length = struct.unpack('!H', exact(2))[0]
        elif length == 127:
            length = struct.unpack('!Q', exact(8))[0]
        assert length <= 65536, 'oversized native reply'
        result = json.loads(exact(length))
        assert result.get('id') == 1 and 'result' in result and 'error' not in result, 'native initialization refused'
        return result


if __name__ == '__main__':
    assert os.geteuid() == 0 and Path('/.dockerenv').exists(), 'owned root Docker fixture required'
    assert not os.path.lexists(SOCKET), 'fixture collision'
    uid = pwd.getpwnam(ACCOUNT).pw_uid
    gid = pwd.getpwnam(ACCOUNT).pw_gid
    assert not (HOME / '.codex').is_symlink(), 'native home must not be a symlink'
    subprocess.run(['/usr/bin/mkdir', '-p', str(HOME / '.codex')], check=True, timeout=5,
                   user=uid, group=gid, extra_groups=[], umask=0o077)
    process = subprocess.Popen(['/usr/sbin/runuser', '-u', ACCOUNT, '--', '/usr/bin/env', '-i',
        'HOME=' + str(HOME), 'CODEX_HOME=' + str(HOME / '.codex'), 'PATH=/usr/bin:/bin',
        str(BINARY), '-c', 'analytics.enabled=false', 'app-server', '--listen', 'unix://' + str(SOCKET)],
        cwd=HOME, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True, umask=0o077)
    try:
        deadline = time.monotonic() + 20
        while not SOCKET.exists():
            assert process.poll() is None, 'native server exited before socket creation: ' + process.stderr.read(4096).decode(errors='replace')
            assert time.monotonic() < deadline, 'native startup deadline'
            time.sleep(0.05)
        info = SOCKET.stat()
        assert info.st_uid == uid and info.st_mode & 0o077 == 0, 'native socket is not private'
        first = initialize()
        second = initialize()
        assert process.poll() is None, 'disconnect stopped the native runtime'
        print(json.dumps({'state': 'native_protocol_available', 'reconnected': True,
                          'uid': uid, 'mode': oct(info.st_mode & 0o777),
                          'resultKeys': sorted(first['result']), 'secondResultKeys': sorted(second['result'])}))
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        # All remaining state stays in this disposable container. A normal
        # process exit is not, by itself, proof of descendant release.
        process.stderr.close()
        remaining = []
        for entry in Path('/proc').iterdir():
            if entry.name.isdigit():
                try:
                    if entry.stat().st_uid == uid:
                        remaining.append(entry.name)
                except FileNotFoundError:
                    pass
        assert not remaining, 'native account still has processes: ' + ','.join(remaining)
        print('PASS native account process inventory empty after stop')
