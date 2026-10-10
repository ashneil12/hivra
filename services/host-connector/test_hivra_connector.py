"""Unit tests for hivra_connector (standard library only): python3 -m unittest -v"""

import base64
import hashlib
import json
import os
import socket
import struct
import tempfile
import threading
import unittest

import hmac

import hivra_connector as hc

CONNECTION = "11111111-1111-4111-8111-111111111111"
MASTER = "test-relay-secret-with-at-least-32-characters"
SECRET = hmac.new(MASTER.encode(), ("connector|%s|1" % CONNECTION).encode(), hashlib.sha256).hexdigest()
# Cross-language vectors, computed with node:crypto using the relay's formulas:
# HMAC(master, "connector|<id>|<generation>") and HMAC(that, "<kind>|<id>|<stream>|<ts>").
CONNECTOR_DIGEST_VECTOR = "f37ab79c2822f6764f09fdf14d8ec5cab0f99a329926c97cbc7db7e26acd0de1"
STREAM_HMAC_VECTOR = "1b562b49f0777c76884b5d4bced901609a0f811ef82d340fbdb7beec280005ba"


def write_config(**overrides):
    config = {"relay": "wss://relay.example.test", "connectionId": CONNECTION, "generation": 1, "secret": SECRET}
    config.update(overrides)
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(config, handle)
    handle.close()
    return handle.name


class ServerSide:
    """Just enough of a WebSocket server to test the client against a socketpair."""

    def __init__(self, sock):
        self.sock = sock
        self.buffer = b""

    def read_exact(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError
            self.buffer += chunk
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def handshake(self, accept_override=None, status="101 Switching Protocols"):
        while b"\r\n\r\n" not in self.buffer:
            self.buffer += self.sock.recv(4096)
        head, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
        lines = head.decode().split("\r\n")
        headers = {line.split(":", 1)[0].lower(): line.split(":", 1)[1].strip() for line in lines[1:]}
        accept = accept_override or hc.accept_key(headers["sec-websocket-key"])
        self.sock.sendall(("HTTP/1.1 %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % (status, accept)).encode())
        return lines[0], headers

    def read_frame(self):
        first, second = self.read_exact(2)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self.read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self.read_exact(8))[0]
        assert second & 0x80, "client frames must be masked"
        mask = self.read_exact(4)
        return first & 0x0F, hc.apply_mask(self.read_exact(length), mask)

    def send_frame(self, opcode, payload, fin=True):
        header = bytes([(0x80 if fin else 0) | opcode])
        if len(payload) < 126:
            header += bytes([len(payload)])
        elif len(payload) < 65536:
            header += bytes([126]) + struct.pack("!H", len(payload))
        else:
            header += bytes([127]) + struct.pack("!Q", len(payload))
        self.sock.sendall(header + payload)


def connected_pair():
    """A WebSocket client over a socketpair, plus the server end after the handshake."""
    client_sock, server_sock = socket.socketpair()
    server = ServerSide(server_sock)
    result = {}

    def serve():
        result["request"] = server.handshake()

    thread = threading.Thread(target=serve)
    thread.start()
    original = socket.create_connection
    socket.create_connection = lambda *args, **kwargs: client_sock
    try:
        client = hc.WebSocket("ws://127.0.0.1:1/v1/hosts/%s/agent" % CONNECTION, {"X-Test": "yes"})
    finally:
        socket.create_connection = original
    thread.join()
    return client, server, result["request"]


class SignatureTests(unittest.TestCase):
    def test_matches_the_relay_formula(self):
        self.assertEqual(SECRET, CONNECTOR_DIGEST_VECTOR)
        self.assertEqual(hc.signature(SECRET, "stream", CONNECTION, "abcdefghijklmnop", 1790000000), STREAM_HMAC_VECTOR)

    def test_headers_carry_generation_timestamp_and_signature(self):
        headers = hc.connector_headers({"generation": 4, "secret": SECRET, "connectionId": CONNECTION}, "agent")
        self.assertEqual(headers["X-Hivra-Generation"], "4")
        expected = hc.signature(SECRET, "agent", CONNECTION, "", int(headers["X-Hivra-Timestamp"]))
        self.assertEqual(headers["X-Hivra-Signature"], expected)


class ConfigTests(unittest.TestCase):
    def test_accepts_a_valid_config_and_always_targets_loopback(self):
        path = write_config(target={"host": "192.0.2.9", "port": 2222})
        config = hc.load_config(path)
        os.unlink(path)
        self.assertEqual(config["target"], ("127.0.0.1", 2222))
        self.assertEqual(config["relay"], "wss://relay.example.test")

    def test_refuses_unsafe_or_malformed_configs(self):
        for overrides in [
            {"relay": "ws://relay.example.test"},
            {"relay": "https://relay.example.test"},
            {"connectionId": "not-a-connection"},
            {"generation": 0},
            {"secret": "short"},
            {"target": {"port": 70000}},
        ]:
            path = write_config(**overrides)
            with self.assertRaises(hc.ConnectorError, msg=str(overrides)):
                hc.load_config(path)
            os.unlink(path)

    def test_allows_plain_ws_only_on_loopback_for_local_tests(self):
        path = write_config(relay="ws://127.0.0.1:8787")
        self.assertEqual(hc.load_config(path)["relay"], "ws://127.0.0.1:8787")
        os.unlink(path)


class FramingTests(unittest.TestCase):
    def test_mask_round_trips(self):
        key = os.urandom(4)
        data = os.urandom(70001)
        self.assertEqual(hc.apply_mask(hc.apply_mask(data, key), key), data)
        self.assertEqual(hc.apply_mask(b"", key), b"")
        self.assertEqual(hc.apply_mask(b"\x00\x01", b"\xff\x00\xff\x00"), b"\xff\x01")

    def test_handshake_sends_custom_headers_and_verifies_the_accept_key(self):
        client, server, (request_line, headers) = connected_pair()
        self.assertEqual(request_line, "GET /v1/hosts/%s/agent HTTP/1.1" % CONNECTION)
        self.assertEqual(headers["x-test"], "yes")
        self.assertEqual(headers["sec-websocket-version"], "13")
        client.close()

    def test_rejects_a_bad_accept_key_and_a_refused_upgrade(self):
        for kwargs in [{"accept_override": base64.b64encode(b"x" * 20).decode()}, {"status": "401 Unauthorized"}]:
            client_sock, server_sock = socket.socketpair()
            server = ServerSide(server_sock)
            thread = threading.Thread(target=lambda: server.handshake(**kwargs))
            thread.start()
            original = socket.create_connection
            socket.create_connection = lambda *args, **kw: client_sock
            try:
                with self.assertRaises(hc.ConnectorError):
                    hc.WebSocket("ws://127.0.0.1:1/x", {})
            finally:
                socket.create_connection = original
            thread.join()
            server_sock.close()

    def test_exchanges_masked_client_frames_and_reassembles_fragments(self):
        client, server, _ = connected_pair()
        received = {}
        reader = threading.Thread(target=lambda: received.update(frame=server.read_frame()))
        reader.start()
        client.send_binary(b"\x00" * 70000)
        reader.join(5)
        opcode, payload = received["frame"]
        self.assertEqual((opcode, len(payload)), (0x2, 70000))
        server.send_frame(0x1, b'{"type":', fin=False)
        server.send_frame(0x0, b'"open"}', fin=True)
        self.assertEqual(client.receive(), (0x1, b'{"type":"open"}'))
        server.send_frame(0x9, b"hi")
        server.send_frame(0x2, b"data")
        self.assertEqual(client.receive(), (0x2, b"data"))
        self.assertEqual(server.read_frame(), (0xA, b"hi"))
        server.send_frame(0x8, struct.pack("!H", 1000))
        self.assertIsNone(client.receive())

    def test_refuses_oversized_frames(self):
        client, server, _ = connected_pair()
        server.sock.sendall(bytes([0x82, 127]) + struct.pack("!Q", hc.MAX_FRAME_BYTES + 1))
        with self.assertRaises(hc.ConnectorError):
            client.receive()


class StreamRequestTests(unittest.TestCase):
    def test_ignores_malformed_stream_ids_and_caps_concurrency(self):
        connector = hc.Connector({"relay": "wss://relay.example.test", "connectionId": CONNECTION, "generation": 1, "secret": SECRET, "target": ("127.0.0.1", 22)})
        started = []
        connector.run_stream = lambda stream_id: started.append(stream_id)
        for bad in [None, 12, "short", "has spaces in it!!", "x" * 65, "../../etc/passwd"]:
            connector.open_stream(bad)
        self.assertEqual(started, [])
        for index in range(hc.MAX_STREAMS + 2):
            connector.open_stream("stream%010d" % index)
        # run_stream is replaced, so slots are never released: only MAX_STREAMS start.
        threading.Event().wait(0.2)
        self.assertEqual(len(started), hc.MAX_STREAMS)


if __name__ == "__main__":
    unittest.main()
