"""Tests for the host wake proxy (hivra-wake-proxy.py).

Everything runs in a temporary tree: a fake QMP socket and guest agent, a
fake guest web server on loopback, temporary route, state and lock folders.
Nothing here names a real host, address or key; ticket keys are made at run
time.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import fcntl
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "hivra-wake-proxy.py"
spec = importlib.util.spec_from_file_location("hivra_wake_proxy", SCRIPT)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

LOGS = []
proxy.log = lambda event, **fields: LOGS.append(json.dumps(dict(fields, event=event)))

VMID = 1234
OTHER_VMID = 1235
TAG = "hivra-binding-test"
HOSTNAME = "agent-one.example.test"
OTHER_HOSTNAME = "agent-two.example.test"


class FakeQemu(object):
    """QMP on <qemu_dir>/<vmid>.qmp and a guest agent on <vmid>.qga, one thread each."""

    def __init__(self, qemu_dir, vmid, status="running"):
        self.status = status
        self.conts = 0
        self.connections = 0
        self.guest_commands = []
        self.lock = threading.Lock()
        self.qmp_path = os.path.join(qemu_dir, "%d.qmp" % vmid)
        self.qga_path = os.path.join(qemu_dir, "%d.qga" % vmid)
        self.pid_path = os.path.join(qemu_dir, "%d.pid" % vmid)
        with open(self.pid_path, "w") as handle:
            handle.write("%d\n" % os.getpid())
        self.socks = []
        for path, serve in ((self.qmp_path, self.serve_qmp), (self.qga_path, self.serve_qga)):
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.bind(path)
            sock.listen(64)
            self.socks.append(sock)
            threading.Thread(target=self.accept, args=(sock, serve), daemon=True).start()

    def close(self):
        for sock in self.socks:
            sock.close()

    def accept(self, sock, serve):
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            threading.Thread(target=serve, args=(conn,), daemon=True).start()

    @staticmethod
    def lines(conn):
        buf = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, _, buf = buf.partition(b"\n")
                if line.strip():
                    yield json.loads(line)

    def serve_qmp(self, conn):
        with conn:
            with self.lock:
                self.connections += 1
            conn.sendall(b'{"QMP": {"version": {}, "capabilities": []}}\n')
            for msg in self.lines(conn):
                command, ident = msg.get("execute"), msg.get("id")
                with self.lock:
                    if command == "cont":
                        self.conts += 1
                        self.status = "running"
                    elif command == "stop":
                        self.status = "paused"
                    ret = {"status": self.status, "running": self.status == "running"} if command == "query-status" else {}
                # an async event first, which the client must skip
                conn.sendall(b'{"event": "RESUME", "timestamp": {}}\n' if command == "cont" else b"")
                conn.sendall((json.dumps({"return": ret, "id": ident}) + "\n").encode())

    def serve_qga(self, conn):
        with conn:
            for msg in self.lines(conn):
                command = msg.get("execute")
                if command == "guest-sync-delimited":
                    conn.sendall(b"\xff" + (json.dumps({"return": msg["arguments"]["id"]}) + "\n").encode())
                elif command == "guest-exec":
                    with self.lock:
                        self.guest_commands.append(msg["arguments"]["arg"][-1])
                    conn.sendall(b'{"return": {"pid": 42}}\n')
                elif command == "guest-exec-status":
                    conn.sendall(b'{"return": {"exited": true, "exitcode": 0}}\n')


class FakeGuest(object):
    """The guest forwarder on loopback: /healthz, /echo (returns the head it got), /sse, /ws, /slow."""

    def __init__(self, loop):
        self.loop = loop
        self.heads = []
        self.healthy = True
        self.release = None
        self.server = asyncio.run_coroutine_threadsafe(self.start(), loop).result(5)
        self.port = self.server.sockets[0].getsockname()[1]

    async def start(self):
        self.release = asyncio.Event()
        return await asyncio.start_server(self.handle, "127.0.0.1", 0)

    def close(self):
        async def stop():
            self.server.close()
        asyncio.run_coroutine_threadsafe(stop(), self.loop).result(5)

    async def handle(self, reader, writer):
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            self.heads.append(head)
            path = head.split(b" ")[1]
            if path == b"/healthz":
                if self.healthy:
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                else:
                    writer.write(b"HTTP/1.1 503 Nope\r\nContent-Length: 4\r\n\r\nnope")
            elif path == b"/echo":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(head) + head)
            elif path == b"/sse":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: one\n\n")
                await writer.drain()
                await self.release.wait()
                writer.write(b"data: two\n\n")
            elif path == b"/ws":
                writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
                await writer.drain()
                while True:
                    data = await reader.read(1024)
                    if not data:
                        break
                    writer.write(b"echo:" + data)
                    await writer.drain()
            elif path == b"/slow":
                await asyncio.sleep(0.6)
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nslow")
            else:
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
        except (OSError, asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()


class Harness(object):
    def __init__(self, **overrides):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        dirs = {}
        for name in ("routes", "run", "fwd", "state", "qemu", "pve", "lock"):
            (root / name).mkdir()
            dirs[name] = str(root / name)
        self.dirs = dirs
        options = dict(routes_dir=dirs["routes"], run_dir=dirs["run"], fwd_dir=dirs["fwd"], state_dir=dirs["state"],
                       qemu_dir=dirs["qemu"], pve_dir=dirs["pve"], lock_dir=dirs["lock"],
                       listen=[("127.0.0.1", 0)], root_uids=(os.geteuid(),), forwarder_uid=None,
                       forwarder_user="hivra-no-such-user", allow_loopback_guests=True, head_timeout=1.0)
        options.update(overrides)
        self.cfg = proxy.Config(**options)
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.guest = FakeGuest(self.loop)
        self.qemu = {}
        self.keys = {}
        self.helper = None
        self.forwarder = None

    def add_vm(self, vmid, hostname, status="running", tag=TAG, conf_tag=TAG):
        self.qemu[vmid] = FakeQemu(self.dirs["qemu"], vmid, status)
        self.keys[vmid] = secrets.token_hex(32)
        with open(os.path.join(self.dirs["pve"], "%d.conf" % vmid), "w") as handle:
            handle.write("name: test\ntags: other;%s\n\n[snap]\ntags: %s\n" % (conf_tag, "snapshot-only"))
        route = {"version": 1, "vmid": vmid, "hostname": hostname, "binding_tag": tag, "guest_ip": "127.0.0.1",
                 "guest_port": self.guest.port, "ticket_key": self.keys[vmid], "generation": 1,
                 "bearer_sha256": "0" * 64, "guest_mac": "02:00:00:00:00:01"}
        with open(os.path.join(self.dirs["routes"], "%d.json" % vmid), "w") as handle:
            json.dump(route, handle)

    def nap(self, vmid, pid=None):
        self.qemu[vmid].status = "paused"
        with open(self.cfg.marker_path(vmid), "w") as handle:
            handle.write("%d\n" % (os.getpid() if pid is None else pid))

    def run(self, coro, timeout=20):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def start(self):
        self.helper = proxy.Helper(self.cfg)
        self.forwarder = proxy.Forwarder(self.cfg)
        self.run(self.forwarder.start())
        self.run(self.helper.start())
        self.port = self.forwarder.bound[0][1]

    def restart_helper(self):
        self.run(self.helper.stop())
        self.helper = proxy.Helper(self.cfg)
        self.run(self.helper.start())

    def close(self):
        for service in (self.helper, self.forwarder):
            if service is not None:
                try:
                    self.run(service.stop())
                except Exception:
                    pass
        for qemu in self.qemu.values():
            qemu.close()
        self.guest.close()
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()
        self.tmp.cleanup()

    def ctl(self, request, path=None, timeout=10):
        return self.run(proxy.unix_request(path or self.cfg.ctl_path, request, timeout), timeout + 5)

    def ticket(self, vmid, exp=None, nonce=None, key=None):
        return proxy.mint_ticket(key or self.keys[vmid], vmid, int(time.time()) + 60 if exp is None else exp,
                                 nonce or secrets.token_hex(12))

    def raw(self, data, timeout=10, read=True):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=timeout)
        try:
            sock.sendall(data)
            if not read:
                return sock
            chunks = []
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            if read:
                sock.close()

    def get(self, path, host=HOSTNAME, extra=b"", method=b"GET"):
        return self.raw(method + b" " + path.encode() + b" HTTP/1.1\r\nHost: " + host.encode() + b"\r\n" + extra + b"\r\n")

    def wake(self, vmid=VMID, ticket=None, host=HOSTNAME):
        ticket = self.ticket(vmid) if ticket is None else ticket
        return self.get("/__hivra/wake", host=host, method=b"POST",
                        extra=b"X-Hivra-Wake: " + ticket.encode() + b"\r\nContent-Length: 0\r\n")


def status_of(response):
    return int(response.split(b" ", 2)[1])


def body_of(response):
    return response.partition(b"\r\n\r\n")[2]


class ProxyTestCase(unittest.TestCase):
    def setUp(self):
        self.h = Harness(**self.overrides())
        self.h.add_vm(VMID, HOSTNAME)
        self.h.start()

    def overrides(self):
        return {}

    def tearDown(self):
        self.h.close()


class RoutingTests(ProxyTestCase):
    def test_routes_by_host_header_and_strips_wake_header(self):
        response = self.h.get("/echo", host=HOSTNAME + ":443", extra=b"X-Hivra-Wake: v1.1.x.y\r\nCf-Ray: abc\r\n")
        self.assertEqual(status_of(response), 200)
        forwarded = body_of(response)
        self.assertNotIn(b"x-hivra-wake", forwarded.lower())
        self.assertIn(b"Cf-Ray: abc", forwarded)
        self.assertIn(b"Host: " + HOSTNAME.encode(), forwarded)

    def test_unknown_host_is_503_not_404(self):
        response = self.h.get("/echo", host="nobody.example.test")
        self.assertEqual(status_of(response), 503)
        self.assertEqual(self.h.guest.heads, [])

    def test_binding_mismatch_drops_route(self):
        self.h.add_vm(OTHER_VMID, OTHER_HOSTNAME, conf_tag="someone-else")
        answer = self.h.ctl({"cmd": "reload"})
        self.assertTrue(answer["ok"])
        self.assertEqual(answer["dropped"], 1)
        self.assertEqual(status_of(self.h.get("/echo", host=OTHER_HOSTNAME)), 503)
        self.assertEqual(status_of(self.h.get("/echo")), 200)

    def test_snapshot_tags_do_not_bind(self):
        self.assertEqual(proxy.conf_tags("tags: a;b\n[snap]\ntags: c\n"), ["a", "b"])

    def test_public_route_table_has_no_keys(self):
        text = Path(self.h.cfg.public_routes_path).read_text()
        self.assertIn(HOSTNAME, text)
        self.assertNotIn(self.h.keys[VMID], text)
        self.assertNotIn("ticket_key", text)
        self.assertNotIn(TAG, text)

    def test_keep_alive_request_gets_connection_close(self):
        response = self.h.get("/echo", extra=b"Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n")
        forwarded = body_of(response)
        self.assertIn(b"Connection: close", forwarded)
        self.assertNotIn(b"keep-alive", forwarded.lower())

    def test_internal_paths_are_never_forwarded(self):
        for path in ("/__hivra/other", "/__HIVRA/x", "/%5F%5Fhivra/wake2", "/__hivra"):
            self.assertEqual(status_of(self.h.get(path)), 404, path)
        self.assertEqual(status_of(self.h.get("/__hivra/wake")), 405)
        self.assertEqual(self.h.guest.heads, [])

    def test_websocket_upgrade_splices_both_ways(self):
        sock = self.h.raw(b"GET /ws HTTP/1.1\r\nHost: " + HOSTNAME.encode() +
                          b"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", read=False)
        try:
            head = b""
            while b"\r\n\r\n" not in head:
                head += sock.recv(4096)
            self.assertTrue(head.startswith(b"HTTP/1.1 101"))
            sock.sendall(b"hello")
            self.assertEqual(sock.recv(4096), b"echo:hello")
            stats = self.h.ctl({"cmd": "stats", "vmid": VMID})
            self.assertEqual(stats["streams"], 1)
            self.assertFalse(self.h.ctl({"cmd": "drain", "vmid": VMID, "ms": 200})["ok"])
        finally:
            sock.close()
        self.assertIn(b"Upgrade: websocket", self.h.guest.heads[-1])

    def test_sse_streams_and_makes_drain_busy(self):
        sock = self.h.raw(b"GET /sse HTTP/1.1\r\nHost: " + HOSTNAME.encode() + b"\r\n\r\n", read=False)
        try:
            data = b""
            while b"data: one" not in data:
                data += sock.recv(4096)
            answer = self.h.ctl({"cmd": "drain", "vmid": VMID, "ms": 200})
            self.assertEqual(answer["error"], "busy")
            self.assertEqual(answer["streams"], 1)
            # A busy drain is undone at once: new requests still go through.
            self.assertEqual(status_of(self.h.get("/echo")), 200)
            self.h.loop.call_soon_threadsafe(self.h.guest.release.set)
            while b"data: two" not in data:
                data += sock.recv(4096)
        finally:
            sock.close()

    def test_header_limit(self):
        big = b"X-Pad: " + b"a" * (33 * 1024) + b"\r\n"
        self.assertEqual(status_of(self.h.get("/echo", extra=big)), 431)

    def test_slow_header_times_out(self):
        sock = self.h.raw(b"GET /echo HTTP/1.1\r\nHost: ", read=False)
        try:
            t0 = time.monotonic()
            data = sock.recv(4096)
            self.assertEqual(status_of(data), 408)
            self.assertLess(time.monotonic() - t0, 3)
        finally:
            sock.close()

    def test_malformed_requests(self):
        self.assertEqual(status_of(self.h.raw(b"GET /echo HTTP/1.1\r\n folded: x\r\nHost: a\r\n\r\n")), 400)
        self.assertEqual(status_of(self.h.raw(b"GET http://x/ HTTP/1.1\r\nHost: " + HOSTNAME.encode() + b"\r\n\r\n")), 400)
        self.assertEqual(status_of(self.h.raw(b"GET /echo HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n")), 400)

    def test_unreachable_guest_is_503_within_a_second(self):
        self.h.guest.close()
        t0 = time.monotonic()
        self.assertEqual(status_of(self.h.get("/echo")), 503)
        self.assertLess(time.monotonic() - t0, 1.5)


class NapTests(ProxyTestCase):
    def test_napped_vm_gets_asleep_page_and_no_cont(self):
        self.h.nap(VMID)
        response = self.h.get("/echo", extra=b"Accept: text/html\r\n")
        self.assertEqual(status_of(response), 503)
        self.assertIn(b"Retry-After: 5", response)
        self.assertIn(b"text/html", response)
        self.assertEqual(self.h.qemu[VMID].conts, 0)
        self.assertEqual(self.h.guest.heads, [])

    def test_ticket_wake_resumes_and_checks_guest_health(self):
        self.h.nap(VMID)
        response = self.h.wake()
        self.assertEqual(status_of(response), 200, response)
        receipt = json.loads(body_of(response))
        self.assertEqual(receipt["vmid"], VMID)
        self.assertEqual(receipt["woke"], "nap")
        for field in ("ms", "cont_ms", "guest_ms"):
            self.assertIsInstance(receipt[field], int)
        self.assertEqual(self.h.qemu[VMID].conts, 1)
        self.assertFalse(os.path.exists(self.h.cfg.marker_path(VMID)))
        self.assertTrue(any(head.startswith(b"GET /healthz") for head in self.h.guest.heads))
        self.assertEqual(status_of(self.h.get("/echo")), 200)
        stats = self.h.ctl({"cmd": "stats", "vmid": VMID})
        self.assertEqual(stats["wakes"][-1]["from"], "ticket")
        self.assertIsNotNone(stats["last_authed_at"])
        # The background fixup sets the clock and drops :443, and never touches the guest tunnel.
        deadline = time.monotonic() + 5
        while not self.h.qemu[VMID].guest_commands and time.monotonic() < deadline:
            time.sleep(0.05)
        command = self.h.qemu[VMID].guest_commands[0]
        self.assertIn("date -s @", command)
        self.assertIn("ss -K", command)
        self.assertNotIn("hivra-cf-tunnel", command)

    def test_ticket_wake_of_awake_vm_is_already(self):
        response = self.h.wake()
        self.assertEqual(status_of(response), 200)
        self.assertEqual(json.loads(body_of(response))["woke"], "already")
        self.assertEqual(self.h.qemu[VMID].conts, 0)

    def test_unhealthy_guest_is_504(self):
        self.h.cfg.health_deadline = 0.3
        self.h.guest.healthy = False
        self.h.nap(VMID)
        self.assertEqual(status_of(self.h.wake()), 504)

    def test_bad_tickets_are_403_without_cont(self):
        self.h.nap(VMID)
        now = int(time.time())
        bad = [
            self.h.ticket(VMID, exp=now - 1),                     # expired
            self.h.ticket(VMID, exp=now + 600),                   # too far ahead
            self.h.ticket(VMID, key=secrets.token_hex(32)),        # wrong key
            "v1.%d.short.%s" % (now + 30, "0" * 64),               # malformed
        ]
        for ticket in bad:
            self.assertEqual(status_of(self.h.wake(ticket=ticket)), 403, ticket[:12])
        self.assertEqual(status_of(self.h.wake(ticket="")), 403)
        replay = self.h.ticket(VMID)
        self.assertEqual(status_of(self.h.wake(ticket=replay)), 200)
        self.h.nap(VMID)
        self.assertEqual(status_of(self.h.wake(ticket=replay)), 403)
        self.assertEqual(self.h.qemu[VMID].conts, 1)
        # Logs never carry a ticket or a key.
        joined = "\n".join(LOGS)
        self.assertNotIn(replay, joined)
        self.assertNotIn(self.h.keys[VMID], joined)
        self.assertIn("ticket_refused", joined)

    def test_bad_tickets_are_rate_limited(self):
        wrong = secrets.token_hex(32)
        codes = [status_of(self.h.wake(ticket=self.h.ticket(VMID, key=wrong))) for _ in range(proxy.BAD_TICKET_LIMIT + 2)]
        self.assertEqual(codes[:proxy.BAD_TICKET_LIMIT], [403] * proxy.BAD_TICKET_LIMIT)
        self.assertEqual(codes[-1], 429)

    def test_ticket_for_another_vm_is_refused(self):
        self.h.add_vm(OTHER_VMID, OTHER_HOSTNAME)
        self.h.ctl({"cmd": "reload"})
        self.h.nap(VMID)
        self.assertEqual(status_of(self.h.wake(ticket=self.h.ticket(OTHER_VMID), host=HOSTNAME)), 403)
        self.assertEqual(self.h.qemu[VMID].conts, 0)

    def test_paused_vm_without_marker_is_never_resumed(self):
        self.h.qemu[VMID].status = "paused"
        # A paused guest does not answer; the request is not held, it gets 503 inside a second.
        self.h.guest.close()
        t0 = time.monotonic()
        self.assertEqual(status_of(self.h.get("/echo")), 503)
        self.assertLess(time.monotonic() - t0, 1.5)
        response = self.h.wake()
        self.assertEqual(status_of(response), 503)
        self.assertEqual(json.loads(body_of(response))["error"], "not_napped")
        self.assertEqual(self.h.qemu[VMID].conts, 0)

    def test_stale_marker_with_wrong_pid_is_ignored(self):
        self.h.nap(VMID, pid=os.getpid() + 100000)
        self.assertFalse(self.h.ctl({"cmd": "status", "vmid": VMID})["napped"])
        response = self.h.wake()
        self.assertEqual(status_of(response), 503)
        self.assertEqual(self.h.qemu[VMID].conts, 0)
        self.assertFalse(os.path.exists(self.h.cfg.marker_path(VMID)))

    def test_fifty_parallel_wakes_one_cont(self):
        self.h.nap(VMID)
        results = []

        def one():
            results.append(status_of(self.h.wake()))

        threads = [threading.Thread(target=one) for _ in range(50)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        self.assertEqual(results, [200] * 50)
        self.assertEqual(self.h.qemu[VMID].conts, 1)

    def test_restart_keeps_markers(self):
        self.h.nap(VMID)
        self.h.restart_helper()
        self.assertTrue(self.h.ctl({"cmd": "status", "vmid": VMID})["napped"])
        self.assertEqual(status_of(self.h.wake()), 200)
        self.assertEqual(self.h.qemu[VMID].conts, 1)

    def test_wake_waits_on_vm_lock_and_loop_stays_live(self):
        self.h.cfg.vm_lock_wait = 8.0
        self.h.add_vm(OTHER_VMID, OTHER_HOSTNAME)
        self.h.ctl({"cmd": "reload"})
        self.h.nap(VMID)
        fd = os.open(os.path.join(self.h.dirs["lock"], "hivra-vm-%d.lock" % VMID), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        result = []
        waker = threading.Thread(target=lambda: result.append(self.h.wake()))
        waker.start()
        worst = 0.0
        end = time.monotonic() + 5
        while time.monotonic() < end:
            t0 = time.monotonic()
            self.assertEqual(status_of(self.h.get("/echo", host=OTHER_HOSTNAME)), 200)
            worst = max(worst, time.monotonic() - t0)
            time.sleep(0.05)
        self.assertEqual(self.h.qemu[VMID].conts, 0)
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
        waker.join(15)
        self.assertLess(worst, 0.5)
        self.assertEqual(status_of(result[0]), 200)
        self.assertEqual(self.h.qemu[VMID].conts, 1)

    def test_vm_lock_timeout_is_503_busy(self):
        self.h.cfg.vm_lock_wait = 0.3
        self.h.nap(VMID)
        fd = os.open(os.path.join(self.h.dirs["lock"], "hivra-vm-%d.lock" % VMID), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            response = self.h.wake()
        finally:
            os.close(fd)
        self.assertEqual(status_of(response), 503)
        self.assertEqual(json.loads(body_of(response))["error"], "vm_busy")
        self.assertEqual(self.h.qemu[VMID].conts, 0)


class DrainTests(ProxyTestCase):
    def test_drain_rejects_new_requests_then_napped_and_undrain(self):
        answer = self.h.ctl({"cmd": "drain", "vmid": VMID, "ms": 500})
        self.assertTrue(answer["ok"])
        self.assertEqual(status_of(self.h.get("/echo")), 503)
        self.assertTrue(self.h.ctl({"cmd": "undrain", "vmid": VMID})["ok"])
        self.assertEqual(status_of(self.h.get("/echo")), 200)
        self.assertTrue(self.h.ctl({"cmd": "drain", "vmid": VMID, "ms": 500})["ok"])
        self.h.nap(VMID)
        self.assertTrue(self.h.ctl({"cmd": "napped", "vmid": VMID})["ok"])
        self.assertEqual(status_of(self.h.get("/echo")), 503)
        self.assertEqual(status_of(self.h.wake()), 200)
        self.assertEqual(status_of(self.h.get("/echo")), 200)

    def test_drain_waits_for_inflight_request(self):
        result = []
        slow = threading.Thread(target=lambda: result.append(self.h.get("/slow")))
        slow.start()
        time.sleep(0.2)
        t0 = time.monotonic()
        answer = self.h.ctl({"cmd": "drain", "vmid": VMID, "ms": 3000})
        self.assertTrue(answer["ok"])
        self.assertGreater(time.monotonic() - t0, 0.2)
        slow.join(5)
        self.assertEqual(status_of(result[0]), 200)

    def test_drain_timeout_is_busy_and_undone(self):
        slow = threading.Thread(target=lambda: self.h.get("/slow"))
        slow.start()
        time.sleep(0.2)
        answer = self.h.ctl({"cmd": "drain", "vmid": VMID, "ms": 50})
        self.assertEqual(answer["error"], "busy")
        slow.join(5)
        self.assertEqual(status_of(self.h.get("/echo")), 200)

    def test_unfinished_drain_expires(self):
        self.h.cfg.drain_lease = 0.3
        self.assertTrue(self.h.ctl({"cmd": "drain", "vmid": VMID, "ms": 100})["ok"])
        self.assertEqual(status_of(self.h.get("/echo")), 503)
        time.sleep(0.5)
        self.assertEqual(status_of(self.h.get("/echo")), 200)

    def test_health_and_stats_for_all(self):
        health = self.h.ctl({"cmd": "health"})
        self.assertTrue(health["ok"])
        self.assertTrue(health["forwarder"])
        self.h.get("/echo")
        stats = self.h.ctl({"cmd": "stats"})
        self.assertIsNotNone(stats["vms"][str(VMID)]["last_any_at"])

    def test_forwarder_down_means_drain_fails(self):
        self.h.run(self.h.forwarder.stop())
        answer = self.h.ctl({"cmd": "drain", "vmid": VMID, "ms": 100})
        self.assertEqual(answer["error"], "forwarder_down")
        self.h.forwarder = None


class PeerTests(unittest.TestCase):
    def test_stranger_is_refused(self):
        h = Harness(root_uids=(), forwarder_uid=os.geteuid() + 1)
        try:
            h.add_vm(VMID, HOSTNAME)
            h.start()
            self.assertEqual(h.ctl({"cmd": "health"}), {"ok": False, "error": "forbidden"})
            # The forwarder's socket only takes root, too.
            self.assertIsNone(h.ctl({"cmd": "stats"}, path=h.cfg.fwd_path, timeout=2))
        finally:
            h.close()

    def test_forwarder_role_is_limited(self):
        h = Harness(root_uids=(), forwarder_uid=os.geteuid())
        try:
            h.add_vm(VMID, HOSTNAME)
            h.start()
            self.assertTrue(h.ctl({"cmd": "health"})["ok"])
            for command in ("drain", "undrain", "napped", "stats", "reload"):
                self.assertEqual(h.ctl({"cmd": command, "vmid": VMID})["error"], "forbidden", command)
            # A forwarder wake needs a ticket.
            self.assertEqual(h.ctl({"cmd": "wake", "vmid": VMID})["error"], "ticket_malformed")
            self.assertTrue(h.ctl({"cmd": "wake", "vmid": VMID, "ticket": h.ticket(VMID)})["ok"])
        finally:
            h.close()


class UnitTests(unittest.TestCase):
    def test_ticket_round_trip(self):
        key = secrets.token_hex(32)
        now = int(time.time())
        ticket = proxy.mint_ticket(key, VMID, now + 60, "nonce-abcdefghijkl")
        self.assertEqual(proxy.check_ticket(ticket, key, VMID, now)[:2], (True, "ok"))
        self.assertEqual(proxy.check_ticket(ticket, key, OTHER_VMID, now)[1], "bad_mac")
        self.assertEqual(proxy.check_ticket(ticket, key, VMID, now + 61)[1], "expired")
        replay = proxy.ReplaySet(limit=2)
        self.assertEqual(replay.claim(VMID, "a", now + 10, now), "ok")
        self.assertEqual(replay.claim(VMID, "a", now + 10, now), "replayed")
        self.assertEqual(replay.claim(VMID, "b", now + 10, now), "ok")
        self.assertEqual(replay.claim(VMID, "c", now + 10, now), "replay_full")

    def test_route_validation(self):
        cfg = proxy.Config(allow_loopback_guests=False)
        good = {"vmid": 300, "hostname": "a.example.test", "binding_tag": TAG, "guest_ip": "10.1.2.3",
                "ticket_key": "ab" * 32}
        self.assertEqual(proxy.parse_route(cfg, good, 300)["guest_port"], 18080)
        for field, value in (("guest_ip", "127.0.0.1"), ("guest_ip", "8.8.8.8"), ("guest_ip", "10.0.0.x"),
                             ("hostname", "Bad Host"), ("ticket_key", "short"), ("binding_tag", "a b"), ("vmid", 301)):
            with self.assertRaises(ValueError):
                proxy.parse_route(cfg, dict(good, **{field: value}), 300)

    def test_ctl_cli_unreachable_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = proxy.Config(run_dir=tmp)
            self.assertEqual(proxy.ctl_main(["health"], cfg), 2)
            self.assertEqual(proxy.ctl_main(["bogus"], cfg), 2)

    def test_script_compiles_and_has_no_nul_or_host_specifics(self):
        raw = SCRIPT.read_bytes()
        self.assertNotIn(b"\x00", raw)
        compile(raw, str(SCRIPT), "exec")
        result = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT)], capture_output=True)
        self.assertEqual(result.returncode, 2)

    def test_units_keep_token_out_of_argv_and_use_http2(self):
        unit = (HERE / "hivra-cf-template.service").read_text()
        exec_start = [line for line in unit.splitlines() if line.startswith("ExecStart=")]
        self.assertEqual(exec_start, ["ExecStart=/usr/local/bin/hivra-cloudflared tunnel --no-autoupdate --protocol http2 run"])
        self.assertIn("EnvironmentFile=/etc/hivra/ingress/%i.env", unit)
        self.assertNotIn("--token", unit)
        proxy_unit = (HERE / "hivra-wake-proxy.service").read_text()
        self.assertIn("User=hivra-ingress", proxy_unit)
        self.assertIn("CapabilityBoundingSet=\n", proxy_unit)
        helper_unit = (HERE / "hivra-wake-helper.service").read_text()
        self.assertIn("RestrictAddressFamilies=AF_UNIX\n", helper_unit)
        tmpfiles = (HERE / "hivra-ingress.tmpfiles.conf").read_text()
        for directory in ("/run/hivra-ingress ", "/run/hivra-ingress-fwd ", "/run/hivra-ingress-state ", "/etc/hivra/ingress/routes "):
            self.assertIn("d " + directory, tmpfiles)


if __name__ == "__main__":
    unittest.main()
