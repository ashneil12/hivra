import asyncio
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("free-turn-gate.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def config(**over):
    raw = {"listenHost": "127.0.0.1", "listenPort": 0, "turnHosts": ["ai.example"], "allowHosts": ["pkgs.example"],
           "maxConcurrentTurns": 1, "dailyReplySecondsCap": 0, "queueWaitSeconds": 0.3, "idleCloseSeconds": 30,
           "sandboxes": {"127.0.0.1": "sb-1"}}
    raw.update(over)
    return gate.Config(raw)


class GateHarness:
    """A gate on a free port, whose upstream for every host is a local echo server that holds each connection."""

    def __init__(self, cfg, clock=None):
        self.cfg = cfg
        self.clock = clock or Clock()
        self.opened = []

    async def __aenter__(self):
        async def echo(reader, writer):
            try:
                while True:
                    data = await reader.read(1024)
                    if not data:
                        break
                    writer.write(data)
                    await writer.drain()
            finally:
                writer.close()

        self.upstream = await asyncio.start_server(echo, "127.0.0.1", 0)
        up_port = self.upstream.sockets[0].getsockname()[1]

        async def open_connection(host, port):
            self.opened.append((host, port))
            return await asyncio.open_connection("127.0.0.1", up_port)

        self.gate = gate.Gate(config=self.cfg, clock=self.clock, open_connection=open_connection)
        self.gate.log = lambda event, **fields: None
        self.server = await asyncio.start_server(self.gate.handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self.server.close()
        self.upstream.close()

    async def connect(self, target):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" % (target, target)).encode())
        await writer.drain()
        status = await asyncio.wait_for(reader.readuntil(b"\r\n"), 5)
        await reader.readuntil(b"\r\n\r\n") if not status.startswith(b"HTTP/1.1 200") else await reader.readuntil(b"\r\n")
        return int(status.split()[1]), reader, writer


def run(coro):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
        for t in pending:
            t.cancel()
        loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        loop.close()


class GateTests(unittest.TestCase):
    def test_opens_allowed_hosts_on_443_only_and_refuses_the_rest(self):
        async def go():
            async with GateHarness(config()) as h:
                self.assertEqual((await h.connect("pkgs.example:443"))[0], 200)
                self.assertEqual((await h.connect("cdn.pkgs.example:443"))[0], 200)
                self.assertEqual((await h.connect("badpkgs.example:443"))[0], 403)
                self.assertEqual((await h.connect("pkgs.example:22"))[0], 403)
                self.assertEqual((await h.connect("evil.example:443"))[0], 403)
                self.assertEqual(h.opened, [("pkgs.example", 443), ("cdn.pkgs.example", 443)])
        run(go())

    def test_refuses_an_address_it_does_not_know(self):
        async def go():
            async with GateHarness(config(sandboxes={})) as h:
                self.assertEqual((await h.connect("pkgs.example:443"))[0], 403)
        run(go())

    def test_one_turn_at_a_time_the_next_waits_then_is_refused_past_its_wait(self):
        async def go():
            async with GateHarness(config(maxConcurrentTurns=1, queueWaitSeconds=0.3)) as h:
                status, _, first = await h.connect("ai.example:443")
                self.assertEqual(status, 200)
                self.assertEqual((await h.connect("ai.example:443"))[0], 503)
                # Package hosts never wait for a turn's slot.
                self.assertEqual((await h.connect("pkgs.example:443"))[0], 200)
                first.close()
                await asyncio.sleep(0.2)
                self.assertEqual((await h.connect("ai.example:443"))[0], 200)
        run(go())

    def test_a_waiting_turn_gets_the_slot_the_moment_one_ends(self):
        async def go():
            async with GateHarness(config(maxConcurrentTurns=1, queueWaitSeconds=3)) as h:
                _, _, first = await h.connect("ai.example:443")
                second = asyncio.ensure_future(h.connect("ai.example:443"))
                await asyncio.sleep(0.2)
                self.assertFalse(second.done())
                first.close()
                self.assertEqual((await asyncio.wait_for(second, 3))[0], 200)
        run(go())

    def test_zero_means_no_turn_limit(self):
        async def go():
            async with GateHarness(config(maxConcurrentTurns=0)) as h:
                for _ in range(4):
                    self.assertEqual((await h.connect("ai.example:443"))[0], 200)
        run(go())

    def test_counts_reply_time_while_bytes_flow_and_refuses_past_the_daily_cap(self):
        clock = Clock()

        async def go():
            async with GateHarness(config(dailyReplySecondsCap=60, maxConcurrentTurns=0), clock) as h:
                status, reader, writer = await h.connect("ai.example:443")
                writer.write(b"hello")
                await writer.drain()
                await reader.readexactly(5)
                clock.t += 61
                writer.write(b"again")
                await writer.drain()
                await reader.readexactly(5)
                writer.close()
                await asyncio.sleep(0.2)
                self.assertGreaterEqual(h.gate.usage.used("sb-1"), 60)
                self.assertEqual((await h.connect("ai.example:443"))[0], 429)
                # Packages are not reply time.
                self.assertEqual((await h.connect("pkgs.example:443"))[0], 200)
                # A new UTC day starts at zero.
                clock.t += 86_400
                self.assertEqual((await h.connect("ai.example:443"))[0], 200)
        run(go())

    def test_zero_or_missing_cap_is_off(self):
        self.assertEqual(config(dailyReplySecondsCap=None).daily_cap, 0)
        self.assertEqual(config(dailyReplySecondsCap=0).daily_cap, 0)

    def test_closes_a_quiet_turn_connection_so_it_frees_its_slot(self):
        clock = Clock()

        async def go():
            async with GateHarness(config(idleCloseSeconds=5, maxConcurrentTurns=1, queueWaitSeconds=3), clock) as h:
                _, reader, _ = await h.connect("ai.example:443")
                clock.t += 6
                self.assertEqual(await asyncio.wait_for(reader.read(), 3), b"")
                self.assertEqual((await h.connect("ai.example:443"))[0], 200)
        run(go())

    def test_keeps_the_days_usage_across_a_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "usage.json")
            clock = Clock()
            u = gate.Usage(path, clock)
            u.add("sb-1", 12.5)
            self.assertEqual(gate.Usage(path, clock).used("sb-1"), 12.5)
            clock.t += 86_400
            self.assertEqual(gate.Usage(path, clock).used("sb-1"), 0)

    def test_refuses_a_config_with_a_host_that_is_not_a_name(self):
        with self.assertRaises(ValueError):
            config(allowHosts=["*.example"])

    def test_not_connect_is_refused(self):
        async def go():
            async with GateHarness(config()) as h:
                reader, writer = await asyncio.open_connection("127.0.0.1", h.port)
                writer.write(b"GET http://pkgs.example/ HTTP/1.1\r\n\r\n")
                await writer.drain()
                self.assertIn(b" 405 ", await reader.readuntil(b"\r\n"))
        run(go())


if __name__ == "__main__":
    unittest.main()
