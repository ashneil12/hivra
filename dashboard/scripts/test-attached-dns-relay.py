#!/usr/bin/env python3
"""attached-dns-relay.py behaviour in an owned root Linux container (T36).

Run: docker run --rm -v "$PWD":/src:ro python:3.12-slim python3 /src/scripts/test-attached-dns-relay.py
A fake resolver takes 127.0.0.53:53 inside the container. The relay gets its two
listening sockets the way systemd passes them (LISTEN_FDS / LISTEN_PID).
"""
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time

SRC = Path(os.environ.get("HIVRA_SRC", "/src"))
RELAY = SRC / "provisioner" / "attached-dns-relay.py"
LISTEN = ("127.0.0.2", 5353)
seen = []


def fake_resolver():
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("127.0.0.53", 53))
    tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    tcp.bind(("127.0.0.53", 53))
    tcp.listen(8)

    def serve_udp():
        while True:
            data, peer = udp.recvfrom(65535)
            seen.append(("udp", data))
            udp.sendto(b"answer:" + data, peer)

    def serve_tcp():
        while True:
            conn, _ = tcp.accept()
            header = conn.recv(2)
            length = int.from_bytes(header, "big")
            data = b""
            while len(data) < length:
                data += conn.recv(length - len(data))
            seen.append(("tcp", data))
            reply = b"answer:" + data
            conn.sendall(len(reply).to_bytes(2, "big") + reply)
            conn.close()

    threading.Thread(target=serve_udp, daemon=True).start()
    threading.Thread(target=serve_tcp, daemon=True).start()


def start_relay():
    datagram = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    datagram.bind(LISTEN)
    stream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    stream.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    stream.bind(LISTEN)
    stream.listen(32)
    # In the child only: move the two sockets to fds 3 and 4, as systemd does, then exec the relay.
    shim = ("import os,sys; os.dup2(int(sys.argv[2]),3); os.dup2(int(sys.argv[3]),4); "
            "os.environ['LISTEN_PID']=str(os.getpid()); os.environ['LISTEN_FDS']='2'; "
            "os.execv(sys.executable, [sys.executable, '-IBS', sys.argv[1]])")
    process = subprocess.Popen([sys.executable, "-c", shim, str(RELAY), str(datagram.fileno()), str(stream.fileno())],
                               pass_fds=(datagram.fileno(), stream.fileno()), env={"PATH": "/usr/bin:/bin"})
    time.sleep(0.5)
    return process


def udp_query(payload, timeout=1.5):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.settimeout(timeout)
        client.sendto(payload, LISTEN)
        try:
            return client.recvfrom(65535)[0]
        except socket.timeout:
            return None


def tcp_query(payload, declared=None):
    with socket.create_connection(LISTEN, timeout=2) as client:
        length = len(payload) if declared is None else declared
        client.sendall(length.to_bytes(2, "big") + payload)
        try:
            header = client.recv(2)
        except (socket.timeout, ConnectionResetError):
            return None  # Refused: the relay closed the connection without an answer.
        if len(header) < 2:
            return None
        size = int.from_bytes(header, "big")
        data = b""
        while len(data) < size:
            chunk = client.recv(size - len(data))
            if not chunk:
                break
            data += chunk
        return data


def main():
    assert os.geteuid() == 0 and Path("/.dockerenv").exists(), "owned root Docker fixture required"
    fake_resolver()
    relay = start_relay()
    try:
        assert udp_query(b"query-1") == b"answer:query-1", "a normal query is relayed unchanged"
        assert ("udp", b"query-1") in seen, "the fixed upstream received the exact bytes"
        assert udp_query(b"x" * 5000) is None, "an oversized datagram is dropped, not truncated"
        assert not any(len(data) >= 4096 for _, data in seen), "nothing oversized reached the resolver"
        assert tcp_query(b"query-tcp") == b"answer:query-tcp", "TCP length framing is relayed"
        assert tcp_query(b"y" * 32, declared=20000) is None, "a TCP message over the cap is refused"
        assert relay.poll() is None, "the relay keeps serving after refusals"
    finally:
        relay.terminate()
        relay.wait(5)
    # Without systemd's handoff the relay refuses to start.
    refused = subprocess.run([sys.executable, "-IBS", str(RELAY)], capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
    assert refused.returncode != 0
    # Its only upstream is fixed in code: no other address, port or name resolution.
    source = RELAY.read_text()
    assert re.findall(r"UPSTREAM = \(.*\)", source) == ['UPSTREAM = ("127.0.0.53", 53)']
    for forbidden in ("getaddrinfo", "gethostbyname", "subprocess", "os.system", "shell=True", "sys.argv"):
        assert forbidden not in source, forbidden
    assert source.count("connect(") == 1 and "create_connection(UPSTREAM" in source
    print('{"result": "PASS"}')


if __name__ == "__main__":
    main()
