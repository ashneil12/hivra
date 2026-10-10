#!/usr/bin/python3 -IBS
"""DNS for one attached agent, without a hole in its network (design 5.3, T36).

systemd binds 127.0.0.53:53 (UDP and TCP) inside the agent's own network
namespace and passes the listening sockets here. This process runs in the
computer's namespace as a DynamicUser and relays each query's bytes, unparsed
beyond length framing, to systemd-resolved on 127.0.0.53:53. It connects
nowhere else: the destination is fixed in code, the unit allows only
127.0.0.53/32, and an nftables rule on its cgroup allows only port 53 there.
Oversized datagrams are dropped; TCP messages and concurrency are capped;
queries are rate limited.
"""
import os
import selectors
import socket
import sys
import threading
import time

UPSTREAM = ("127.0.0.53", 53)
MAX_DATAGRAM = 4096
MAX_TCP_MESSAGE = 16384
MAX_TCP_CONNECTIONS = 16
MAX_INFLIGHT = 256
QUERIES_PER_SECOND = 200
TIMEOUT = 5.0
LISTEN_FDS_START = 3


class Bucket:
    def __init__(self, rate):
        self.rate, self.tokens, self.stamp = rate, float(rate), time.monotonic()
        self.lock = threading.Lock()

    def take(self):
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.rate, self.tokens + (now - self.stamp) * self.rate)
            self.stamp = now
            if self.tokens < 1:
                return False
            self.tokens -= 1
            return True


def inherited():
    if os.environ.get("LISTEN_PID") != str(os.getpid()):
        raise SystemExit("attached-dns-relay runs only under its socket unit")
    count = int(os.environ.get("LISTEN_FDS", "0"))
    if not 1 <= count <= 2:
        raise SystemExit("attached-dns-relay expects its datagram and stream sockets")
    datagram = stream = None
    for fd in range(LISTEN_FDS_START, LISTEN_FDS_START + count):
        sock = socket.socket(fileno=fd)
        if sock.type == socket.SOCK_DGRAM and datagram is None:
            datagram = sock
        elif sock.type == socket.SOCK_STREAM and stream is None:
            stream = sock
        else:
            raise SystemExit("unexpected inherited socket")
    return datagram, stream


def recv_exact(conn, size):
    data = b""
    while len(data) < size:
        chunk = conn.recv(size - len(data))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


def relay_tcp(client, bucket, slots):
    try:
        client.settimeout(TIMEOUT)
        while True:
            header = client.recv(2)
            if not header:
                return
            if len(header) == 1:
                header += recv_exact(client, 1)
            length = int.from_bytes(header, "big")
            if length == 0 or length > MAX_TCP_MESSAGE or not bucket.take():
                return
            query = recv_exact(client, length)
            with socket.create_connection(UPSTREAM, timeout=TIMEOUT) as upstream:
                upstream.sendall(header + query)
                reply_length = int.from_bytes(recv_exact(upstream, 2), "big")
                if reply_length == 0:
                    return
                client.sendall(reply_length.to_bytes(2, "big") + recv_exact(upstream, reply_length))
    except (OSError, ConnectionError):
        return
    finally:
        client.close()
        slots.release()


def serve_tcp(stream, bucket):
    slots = threading.BoundedSemaphore(MAX_TCP_CONNECTIONS)
    while True:
        client, _ = stream.accept()
        if not slots.acquire(blocking=False):
            client.close()
            continue
        threading.Thread(target=relay_tcp, args=(client, bucket, slots), daemon=True).start()


def serve_udp(listener, bucket):
    selector = selectors.DefaultSelector()
    listener.setblocking(False)
    selector.register(listener, selectors.EVENT_READ, None)
    inflight = {}
    while True:
        now = time.monotonic()
        for upstream, (client, deadline) in list(inflight.items()):
            if deadline < now:
                selector.unregister(upstream)
                upstream.close()
                inflight.pop(upstream)
        for key, _ in selector.select(timeout=1.0):
            if key.data is None:
                try:
                    query, flags_client = listener.recvfrom(MAX_DATAGRAM + 1)
                except (BlockingIOError, InterruptedError):
                    continue
                if len(query) > MAX_DATAGRAM or len(inflight) >= MAX_INFLIGHT or not bucket.take():
                    continue  # Oversized, flooded or over rate: dropped, never truncated.
                upstream = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                upstream.setblocking(False)
                try:
                    upstream.connect(UPSTREAM)
                    upstream.send(query)
                except OSError:
                    upstream.close()
                    continue
                inflight[upstream] = (flags_client, time.monotonic() + TIMEOUT)
                selector.register(upstream, selectors.EVENT_READ, upstream)
            else:
                upstream = key.data
                client, _ = inflight.pop(upstream, (None, 0))
                selector.unregister(upstream)
                try:
                    reply = upstream.recv(MAX_DATAGRAM + 1)
                    if client is not None and len(reply) <= MAX_DATAGRAM:
                        listener.sendto(reply, client)
                except OSError:
                    pass
                upstream.close()


def main():
    datagram, stream = inherited()
    bucket = Bucket(QUERIES_PER_SECOND)
    if stream is not None:
        threading.Thread(target=serve_tcp, args=(stream, bucket), daemon=True).start()
    if datagram is not None:
        serve_udp(datagram, bucket)
    else:
        threading.Event().wait()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        raise SystemExit("attached-dns-relay stopped (" + type(error).__name__ + ")")
    sys.exit(0)
