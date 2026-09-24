#!/usr/bin/env python3
"""Hivra connector: lets hosted Hivra reach this machine without inbound ports.

It keeps one outbound WebSocket to Hivra's relay. When Hivra needs SSH, the
relay sends {"type": "open", "stream": <id>}; the connector opens a second
WebSocket for that stream and joins it to this machine's SSH server on
127.0.0.1. The relay and this program only copy bytes: SSH, and the host key
Hivra pinned when you confirmed "Is this your server?", stay end to end.

Standard library only (Python 3.8+). Configuration lives in a root-owned file
(see --config); nothing the relay sends can change where this program dials.

Exit status 3 means Hivra revoked this machine's connector; systemd does not
restart it (RestartPreventExitStatus=3).
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import socket
import ssl
import struct
import sys
import threading
import time
import urllib.parse

VERSION = "2026.09.24.1"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_STREAMS = 8
MAX_FRAME_BYTES = 1024 * 1024
KEEPALIVE_SECONDS = 30
READ_CHUNK = 64 * 1024
EXIT_REVOKED = 3
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ConnectorError(Exception):
    pass


def log(message):
    sys.stderr.write("hivra-connector: %s\n" % message)
    sys.stderr.flush()


# --- configuration --------------------------------------------------------


def load_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    relay = str(raw.get("relay", ""))
    parsed = urllib.parse.urlparse(relay)
    if parsed.scheme not in ("wss", "ws") or not parsed.hostname:
        raise ConnectorError("relay must be a wss:// URL")
    if parsed.scheme == "ws" and parsed.hostname not in LOOPBACK_HOSTS:
        raise ConnectorError("relay must use wss:// (ws:// is only for local tests)")
    connection_id = str(raw.get("connectionId", ""))
    if len(connection_id) != 36 or not all(c in "0123456789abcdef-" for c in connection_id):
        raise ConnectorError("connectionId is not a Hivra connection id")
    generation = raw.get("generation")
    if not isinstance(generation, int) or generation < 1:
        raise ConnectorError("generation must be a positive integer")
    secret = str(raw.get("secret", ""))
    if len(secret) != 64 or not all(c in "0123456789abcdef" for c in secret):
        raise ConnectorError("secret must be 64 hex characters")
    port = int((raw.get("target") or {}).get("port", 22))
    if not 1 <= port <= 65535:
        raise ConnectorError("target port is out of range")
    return {
        "relay": relay.rstrip("/"),
        "connectionId": connection_id,
        "generation": generation,
        "secret": secret,
        # Always this machine's loopback: the relay can never pick the address.
        "target": ("127.0.0.1", port),
    }


def signature(secret, kind, connection_id, stream_id, timestamp):
    message = "%s|%s|%s|%d" % (kind, connection_id, stream_id, timestamp)
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def connector_headers(config, kind, stream_id=""):
    timestamp = int(time.time())
    return {
        "X-Hivra-Generation": str(config["generation"]),
        "X-Hivra-Timestamp": str(timestamp),
        "X-Hivra-Signature": signature(config["secret"], kind, config["connectionId"], stream_id, timestamp),
        "User-Agent": "hivra-connector/%s" % VERSION,
    }


# --- minimal RFC 6455 client ----------------------------------------------


def accept_key(key):
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def apply_mask(data, key):
    """XOR with the 4-byte key; done as one big-integer XOR so bulk copies stay fast."""
    if not data:
        return b""
    repeated = (key * (len(data) // 4 + 1))[: len(data)]
    return (int.from_bytes(data, "big") ^ int.from_bytes(repeated, "big")).to_bytes(len(data), "big")


def encode_frame(opcode, payload, mask_key=None):
    """One final client frame; client-to-server frames are always masked."""
    mask_key = mask_key if mask_key is not None else os.urandom(4)
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(0x80 | length)
    elif length < 1 << 16:
        header.append(0x80 | 126)
        header += struct.pack("!H", length)
    else:
        header.append(0x80 | 127)
        header += struct.pack("!Q", length)
    return bytes(header) + mask_key + apply_mask(payload, mask_key)


class WebSocket:
    def __init__(self, url, headers, timeout=15):
        parsed = urllib.parse.urlparse(url)
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        raw = socket.create_connection((parsed.hostname, port), timeout=timeout)
        if parsed.scheme == "wss":
            raw = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname)
        self.sock = raw
        self.buffer = b""
        self.send_lock = threading.Lock()
        self.closed = False
        key = base64.b64encode(os.urandom(16)).decode()
        path = parsed.path or "/"
        host = parsed.hostname if parsed.port is None else "%s:%d" % (parsed.hostname, parsed.port)
        lines = [
            "GET %s HTTP/1.1" % path,
            "Host: %s" % host,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: %s" % key,
            "Sec-WebSocket-Version: 13",
        ] + ["%s: %s" % (name, value) for name, value in headers.items()]
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        response = self._read_until(b"\r\n\r\n", limit=16 * 1024)
        head = response.decode("latin-1").split("\r\n")
        status = head[0].split(" ")
        if len(status) < 2 or status[1] != "101":
            code = status[1] if len(status) > 1 else "?"
            self.sock.close()
            raise ConnectorError("relay refused the connection (HTTP %s)" % code)
        fields = {}
        for line in head[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                fields[name.strip().lower()] = value.strip()
        if fields.get("sec-websocket-accept") != accept_key(key):
            self.sock.close()
            raise ConnectorError("relay handshake did not verify")
        self.sock.settimeout(None)

    def _read_until(self, marker, limit):
        while marker not in self.buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectorError("connection closed during handshake")
            self.buffer += chunk
            if len(self.buffer) > limit:
                raise ConnectorError("handshake response too large")
        head, self.buffer = self.buffer.split(marker, 1)
        return head

    def _read_exact(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(READ_CHUNK)
            if not chunk:
                raise ConnectorError("connection closed")
            self.buffer += chunk
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def send(self, opcode, payload):
        with self.send_lock:
            if self.closed:
                raise ConnectorError("socket closed")
            self.sock.sendall(encode_frame(opcode, payload))

    def send_text(self, text):
        self.send(0x1, text.encode())

    def send_binary(self, data):
        self.send(0x2, data)

    def receive(self):
        """Return (opcode, payload) for the next data message; None when closed."""
        message = b""
        message_opcode = None
        while True:
            first, second = self._read_exact(2)
            fin = first & 0x80
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            if length > MAX_FRAME_BYTES:
                raise ConnectorError("frame too large")
            mask = self._read_exact(4) if second & 0x80 else None
            payload = self._read_exact(length)
            if mask:
                payload = apply_mask(payload, mask)
            if opcode == 0x8:
                self.close()
                return None
            if opcode == 0x9:
                self.send(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                message_opcode = opcode
                message = payload
            elif opcode == 0x0:
                message += payload
                if len(message) > MAX_FRAME_BYTES:
                    raise ConnectorError("message too large")
            if fin and message_opcode is not None:
                return message_opcode, message

    def close(self):
        with self.send_lock:
            if self.closed:
                return
            self.closed = True
            try:
                self.sock.sendall(encode_frame(0x8, struct.pack("!H", 1000)))
            except OSError:
                pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


# --- streams and the control loop -------------------------------------------


class Connector:
    def __init__(self, config):
        self.config = config
        self.streams = threading.BoundedSemaphore(MAX_STREAMS)

    def url(self, suffix):
        return "%s/v1/hosts/%s/%s" % (self.config["relay"], self.config["connectionId"], suffix)

    def run_stream(self, stream_id):
        try:
            try:
                tunnel = WebSocket(self.url("stream/" + stream_id), connector_headers(self.config, "stream", stream_id))
            except (OSError, ConnectorError) as error:
                log("stream %s did not open: %s" % (stream_id[:8], error))
                return
            try:
                local = socket.create_connection(self.config["target"], timeout=10)
                local.settimeout(None)
            except OSError as error:
                log("could not reach the local SSH server: %s" % error)
                tunnel.close()
                return

            def upstream():
                try:
                    while True:
                        chunk = local.recv(READ_CHUNK)
                        if not chunk:
                            break
                        tunnel.send_binary(chunk)
                except (OSError, ConnectorError):
                    pass
                finally:
                    tunnel.close()

            reader = threading.Thread(target=upstream, daemon=True)
            reader.start()
            try:
                while True:
                    message = tunnel.receive()
                    if message is None:
                        break
                    local.sendall(message[1])
            except (OSError, ConnectorError):
                pass
            finally:
                try:
                    local.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                local.close()
                tunnel.close()
                reader.join(timeout=5)
        finally:
            self.streams.release()

    def open_stream(self, stream_id):
        if not isinstance(stream_id, str) or not 16 <= len(stream_id) <= 64:
            return
        if not all(c.isalnum() or c in "-_" for c in stream_id):
            return
        if not self.streams.acquire(blocking=False):
            log("too many sessions; ignoring a new one")
            return
        threading.Thread(target=self.run_stream, args=(stream_id,), daemon=True).start()

    def control_session(self):
        """Hold one control socket until it drops. Returns 'revoked' or 'reconnect'."""
        control = WebSocket(self.url("agent"), connector_headers(self.config, "agent"))
        log("connected to Hivra")
        stop = threading.Event()

        def keepalive():
            while not stop.wait(KEEPALIVE_SECONDS):
                try:
                    control.send_text('{"type":"ping"}')
                except (OSError, ConnectorError):
                    return

        threading.Thread(target=keepalive, daemon=True).start()
        try:
            while True:
                message = control.receive()
                if message is None:
                    return "reconnect"
                if message[0] != 0x1:
                    continue
                try:
                    body = json.loads(message[1].decode())
                except ValueError:
                    continue
                kind = body.get("type")
                if kind == "open":
                    self.open_stream(body.get("stream"))
                elif kind == "closing":
                    return "revoked" if body.get("reason") == "revoked" else "reconnect"
        except (OSError, ConnectorError):
            return "reconnect"
        finally:
            stop.set()
            control.close()

    def run(self):
        delay = 1.0
        while True:
            started = time.monotonic()
            ceiling = 60.0
            try:
                outcome = self.control_session()
            except (OSError, ConnectorError) as error:
                if "HTTP 401" in str(error):
                    # Also what a wrong clock looks like, so keep trying, slowly.
                    log("Hivra refused this connector. Check this machine's clock, or reconnect it from Hivra.")
                    ceiling = 600.0
                else:
                    log("relay unavailable: %s" % error)
                outcome = "reconnect"
            if outcome == "revoked":
                log("Hivra revoked this connector.")
                return EXIT_REVOKED
            if time.monotonic() - started > 60:
                delay = 1.0
            time.sleep(delay + random.uniform(0, delay / 2))
            delay = min(delay * 2, ceiling)

    def check(self):
        """Connect once, confirm the relay accepts this machine, and disconnect."""
        control = WebSocket(self.url("agent"), connector_headers(self.config, "agent"))
        control.close()
        return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hivra-connector", description="Outbound relay so hosted Hivra can reach this machine's SSH server.")
    parser.add_argument("command", choices=["run", "check", "version"])
    parser.add_argument("--config", default="/etc/hivra-connector/config.json")
    args = parser.parse_args(argv)
    if args.command == "version":
        print(VERSION)
        return 0
    try:
        connector = Connector(load_config(args.config))
        return connector.check() if args.command == "check" else connector.run()
    except (OSError, ValueError, ConnectorError) as error:
        log(str(error))
        return 2


if __name__ == "__main__":
    sys.exit(main())
