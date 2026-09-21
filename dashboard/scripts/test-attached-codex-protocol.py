"""Bounded protocol parser tests; socket ownership is a separate integration gate."""
import importlib.util
import json
from pathlib import Path
import struct
import unittest

SPEC = importlib.util.spec_from_file_location('protocol', Path(__file__).resolve().parents[1] / 'provisioner/attached-codex-protocol.py')
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)


class Wire:
    def __init__(self, data):
        self.data = bytearray(data)
        self.sent = []
    def settimeout(self, value):
        if value <= 0:
            raise AssertionError('nonpositive timeout')
    def recv(self, size):
        value = bytes(self.data[:min(size, 3)])
        del self.data[:len(value)]
        return value
    def sendall(self, value):
        self.sent.append(value)


class ProtocolTests(unittest.TestCase):
    def exchange(self, reply):
        class Exchange(Wire):
            def sendall(self, value):
                super().sendall(value)
                if value.startswith(b'GET '):
                    key = value.split(b'Sec-WebSocket-Key: ')[1].split(b'\r\n')[0].decode()
                    self.data.extend(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + P.accept_key(key) + b'\r\n\r\n')
                else:
                    payload = json.dumps(reply).encode()
                    self.data.extend(b'\x81' + bytes([len(payload)]) + payload)
        return Exchange(b'')
    def test_fixed_initialize_and_home_binding(self):
        wire = self.exchange({'id': 1, 'result': {'codexHome': '/private/.codex'}})
        self.assertIsNone(P.initialize(wire, '/private/.codex', P.time.monotonic() + 1))
        frame = wire.sent[1]
        offset = 4 if frame[1] == 254 else 2
        mask = frame[offset:offset + 4]
        request = json.loads(bytes(v ^ mask[i % 4] for i, v in enumerate(frame[offset + 4:])))
        self.assertEqual(request, {'id': 1, 'method': 'initialize', 'params': {
            'clientInfo': {'name': 'hivra_readiness', 'version': '1.0.0'}}})
        self.assertEqual(len(wire.sent), 2)
    def test_initialize_rejects_wrong_identity_and_errors(self):
        for reply in ({'id': True, 'result': {'codexHome': '/private/.codex'}},
                      {'id': 2, 'result': {'codexHome': '/private/.codex'}},
                      {'id': 1, 'result': {'codexHome': '/elsewhere'}},
                      {'id': 1, 'result': None}, {'id': 1, 'error': {}}, [],
                      {'id': 1, 'result': {'codexHome': '/private/.codex'}, 'error': None}):
            with self.subTest(reply=reply), self.assertRaises(ValueError):
                P.initialize(self.exchange(reply), '/private/.codex', P.time.monotonic() + 1)
    def test_text_and_partial_reads(self):
        self.assertEqual(P.read_reply(Wire(b'\x81\x02{}'), P.time.monotonic() + 1), {})
    def test_ping_is_answered_with_masked_pong(self):
        wire = Wire(b'\x89\x01a\x81\x02{}')
        self.assertEqual(P.read_reply(wire, P.time.monotonic() + 1), {})
        self.assertEqual(wire.sent[0][:2], b'\x8a\x81')
        self.assertEqual(wire.sent[0][6] ^ wire.sent[0][2], ord('a'))
    def test_rejects_invalid_frames_and_json(self):
        for raw in (b'\x81\x82', b'\xc1\x00', b'\x01\x00', b'\x82\x00',
                    b'\x88\x00', b'\x81\x7f' + struct.pack('!Q', 65537),
                    b'\x81\x7e\x00\x02{}', b'\x81\x01\xff',
                    b'\x81\x0d{"a":1,"a":2}', b'\x81\x03NaN', b'\x81\x02{'):
            with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                P.read_reply(Wire(raw), P.time.monotonic() + 1)
    def test_control_flood_is_bounded(self):
        with self.assertRaises(ValueError):
            P.read_reply(Wire(b'\x8a\x00' * 9), P.time.monotonic() + 1)
    def test_absolute_deadline(self):
        with self.assertRaises(TimeoutError):
            P.read_reply(Wire(b'\x81\x02{}'), P.time.monotonic() - 1)
    def test_upgrade_validation(self):
        key = 'test'
        accept = P.accept_key(key)
        good = b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n'
        P.check_upgrade(good, key)
        for bad in (good.replace(b'101', b'200'), good.replace(b'websocket', b'other'),
                    good.replace(b'Connection: Upgrade', b'Connection: close'),
                    good.replace(accept, b'wrong'), good[:-2] + b'Upgrade: websocket\r\n\r\n',
                    good[:-2] + b'Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                P.check_upgrade(bad, key)


if __name__ == '__main__':
    unittest.main()
