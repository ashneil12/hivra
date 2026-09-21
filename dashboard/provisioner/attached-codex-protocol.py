"""Fixed initialize exchange on an already authenticated private socket.

Internal transport only. The caller must bind the socket to the expected Linux
process and reobserve activation afterwards. This module never reports ready.
"""
import base64
import hashlib
import json
import os
import struct
import time


def budget(client, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('native initialize deadline')
    client.settimeout(remaining)


def exact(client, size, deadline):
    result = bytearray()
    while len(result) < size:
        budget(client, deadline)
        chunk = client.recv(size - len(result))
        if not chunk:
            raise ValueError('native connection closed')
        result.extend(chunk)
    return bytes(result)


def send_frame(client, opcode, payload, deadline):
    if len(payload) > 65535 or (opcode >= 8 and len(payload) > 125):
        raise ValueError('oversized native request')
    mask = os.urandom(4)
    length = bytes([128 | len(payload)]) if len(payload) < 126 else b'\xfe' + struct.pack('!H', len(payload))
    budget(client, deadline)
    client.sendall(bytes([128 | opcode]) + length + mask
                   + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate native field')
        result[key] = value
    return result


def invalid_constant(_value):
    raise ValueError('invalid native JSON constant')


def read_reply(client, deadline):
    # Pinned initialize response is one text frame. Refuse fragmentation rather
    # than treating an incomplete message as readiness. Control traffic is bounded.
    for _ in range(9):
        opcode, length = exact(client, 2, deadline)
        if opcode not in (0x81, 0x89, 0x8a) or length & 128:
            raise ValueError('unsupported native frame')
        marker = length
        if length == 126:
            length = struct.unpack('!H', exact(client, 2, deadline))[0]
        elif length == 127:
            length = struct.unpack('!Q', exact(client, 8, deadline))[0]
        if (length > 65536 or (marker == 126 and length < 126)
                or (marker == 127 and length < 65536)
                or (opcode != 0x81 and length > 125)):
            raise ValueError('invalid native frame length')
        payload = exact(client, length, deadline)
        if opcode == 0x81:
            return json.loads(payload.decode('utf-8'), object_pairs_hook=unique_object,
                              parse_constant=invalid_constant)
        if opcode == 0x89:
            send_frame(client, 10, payload, deadline)
    raise ValueError('excessive native control traffic')


def accept_key(key):
    return base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())


def check_upgrade(raw, key):
    if len(raw) > 8192 or not raw.endswith(b'\r\n\r\n'):
        raise ValueError('invalid native upgrade size')
    lines = raw[:-4].split(b'\r\n')
    if not lines[0].startswith(b'HTTP/1.1 101 '):
        raise ValueError('native upgrade refused')
    headers = {}
    for line in lines[1:]:
        name, separator, value = line.partition(b':')
        name = name.lower()
        if not separator or not name or name in headers or name.strip() != name:
            raise ValueError('invalid native upgrade header')
        headers[name] = value.strip()
    if (headers.get(b'upgrade', b'').lower() != b'websocket'
            or b'upgrade' not in [v.strip().lower() for v in headers.get(b'connection', b'').split(b',')]
            or headers.get(b'sec-websocket-accept') != accept_key(key)
            or b'sec-websocket-extensions' in headers or b'sec-websocket-protocol' in headers):
        raise ValueError('native upgrade mismatch')


def initialize(client, expected_home, deadline):
    key = base64.b64encode(os.urandom(16)).decode()
    budget(client, deadline)
    client.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                    'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                    'Sec-WebSocket-Key: ' + key + '\r\n\r\n').encode())
    headers = bytearray()
    while not headers.endswith(b'\r\n\r\n'):
        if len(headers) >= 8192:
            raise ValueError('oversized native upgrade')
        headers.extend(exact(client, 1, deadline))
    check_upgrade(bytes(headers), key)
    request = {'id': 1, 'method': 'initialize', 'params': {
        'clientInfo': {'name': 'hivra_readiness', 'version': '1.0.0'}}}
    send_frame(client, 1, json.dumps(request, separators=(',', ':')).encode(), deadline)
    reply = read_reply(client, deadline)
    if (not isinstance(reply, dict) or type(reply.get('id')) is not int or reply['id'] != 1
            or 'error' in reply or not isinstance(reply.get('result'), dict)
            or reply['result'].get('codexHome') != expected_home):
        raise ValueError('native initialize identity mismatch')
    budget(client, deadline)
    return None  # No credentials, server text, model request or readiness claim.
