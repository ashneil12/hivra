#!/usr/bin/env python3
"""The free pool's turn gate: an HTTPS CONNECT proxy on each pool server that every free sandbox's traffic leaves
through. It enforces two of the free settings where they can be enforced, on the server itself:

- maxConcurrentTurns: how many replies run at once on this server. A reply is a connection to one of the free AI's
  hosts (`turnHosts`); one past the limit waits in line (oldest first) up to `queueWaitSeconds`, then is refused.
- dailyReplySecondsCap: a sandbox's reply time per UTC day, the time its connections to the free AI's hosts carry
  bytes. Once used, new connections to those hosts are refused until the next UTC day.

0 (or a missing cap) is off for both. Every other host is either allowed (`allowHosts`, for packages) or refused, and
only port 443 is ever opened. A sandbox is known by its address (`sandboxes`, written by the adapter): an address the
gate doesn't know is refused. The gate sees host names and byte counts only, never what is said.

The config is JSON, read again when its file changes; usage is kept per UTC day in `stateFile`.
This file does not force sandboxes through the gate: the pool's firewall must (only the gate may reach the internet).

Usage: free-turn-gate.py CONFIG.json
"""
import asyncio
import json
import os
import re
import signal
import sys
import time
from collections import deque
from datetime import datetime, timezone

HOST = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
REQUEST_LINE_MAX = 1024
HEADERS_MAX = 8192
CHUNK = 65536


def utc_day(now=None):
    return datetime.fromtimestamp(now if now is not None else time.time(), tz=timezone.utc).strftime("%Y-%m-%d")


def host_matches(host, patterns):
    """`api.example.com` matches `example.com` and `api.example.com`; never a lookalike such as `badexample.com`."""
    return any(host == p or host.endswith("." + p) for p in patterns)


class Config:
    def __init__(self, raw):
        self.listen_host = raw.get("listenHost", "127.0.0.1")
        self.listen_port = int(raw.get("listenPort", 3128))
        self.turn_hosts = [str(h).lower() for h in raw.get("turnHosts", [])]
        self.allow_hosts = [str(h).lower() for h in raw.get("allowHosts", [])]
        self.max_concurrent = max(0, int(raw.get("maxConcurrentTurns", 0)))
        cap = raw.get("dailyReplySecondsCap")
        self.daily_cap = max(0, int(cap)) if cap is not None else 0
        self.queue_wait = float(raw.get("queueWaitSeconds", 60))
        self.idle_close = float(raw.get("idleCloseSeconds", 120))
        self.sandboxes = {str(ip): str(sid) for ip, sid in raw.get("sandboxes", {}).items()}
        self.state_file = raw.get("stateFile")
        for h in self.turn_hosts + self.allow_hosts:
            if not HOST.match(h):
                raise ValueError("not a host name: %r" % h)

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls(json.load(f))


class Usage:
    """Reply seconds per sandbox for the current UTC day; a new day starts at zero."""

    def __init__(self, path=None, clock=time.time):
        self.path = path
        self.clock = clock
        self.day = utc_day(clock())
        self.seconds = {}
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    saved = json.load(f)
                if saved.get("day") == self.day:
                    self.seconds = {k: float(v) for k, v in saved.get("seconds", {}).items()}
            except (OSError, ValueError, TypeError):
                self.seconds = {}

    def _roll(self):
        today = utc_day(self.clock())
        if today != self.day:
            self.day, self.seconds = today, {}

    def used(self, sandbox):
        self._roll()
        return self.seconds.get(sandbox, 0.0)

    def add(self, sandbox, seconds):
        self._roll()
        self.seconds[sandbox] = self.seconds.get(sandbox, 0.0) + max(0.0, seconds)
        self.save()

    def save(self):
        if not self.path:
            return
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"day": self.day, "seconds": self.seconds}, f)
        os.replace(tmp, self.path)


class TurnLine:
    """At most `limit` turns at once (0: no limit); the rest wait oldest first, each up to its own deadline."""

    def __init__(self):
        self.running = 0
        self.waiting = deque()

    async def acquire(self, limit, wait):
        if limit <= 0:
            self.running += 1
            return True
        if self.running < limit and not self.waiting:
            self.running += 1
            return True
        future = asyncio.get_running_loop().create_future()
        self.waiting.append(future)
        try:
            await asyncio.wait_for(asyncio.shield(future), wait)
            return True
        except asyncio.TimeoutError:
            if future.done() and not future.cancelled():
                return True  # granted just as the wait ran out: it holds the slot
            future.cancel()
            return False
        finally:
            if future in self.waiting:
                self.waiting.remove(future)

    def release(self, limit):
        while self.waiting:
            nxt = self.waiting.popleft()
            if not nxt.done():
                nxt.set_result(True)  # the slot passes straight to the next in line
                return
        self.running = max(0, self.running - 1)


class Gate:
    def __init__(self, config_path=None, config=None, clock=time.time, open_connection=asyncio.open_connection):
        self.config_path = config_path
        self.config = config or Config.load(config_path)
        self.config_mtime = os.path.getmtime(config_path) if config_path else None
        self.clock = clock
        self.usage = Usage(self.config.state_file, clock)
        self.line = TurnLine()
        self.open_connection = open_connection
        self.log = lambda event, **fields: print(json.dumps({"event": event, **fields}), file=sys.stderr, flush=True)

    def reload(self):
        if not self.config_path:
            return
        try:
            mtime = os.path.getmtime(self.config_path)
            if mtime != self.config_mtime:
                self.config = Config.load(self.config_path)
                self.config_mtime = mtime
        except (OSError, ValueError) as err:
            self.log("config_unreadable", error=type(err).__name__)  # keep the last good one

    async def handle(self, reader, writer):
        peer = writer.get_extra_info("peername")
        try:
            await self._handle(reader, writer, peer[0] if peer else None)
        except (ConnectionError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _reply(self, writer, status, reason):
        writer.write(("HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" % (status, reason)).encode())
        await writer.drain()

    async def _handle(self, reader, writer, peer):
        self.reload()
        cfg = self.config
        line = await asyncio.wait_for(reader.readuntil(b"\r\n"), 10)
        if len(line) > REQUEST_LINE_MAX:
            return await self._reply(writer, 400, "Bad Request")
        headers = 0
        while True:
            h = await asyncio.wait_for(reader.readuntil(b"\r\n"), 10)
            headers += len(h)
            if h == b"\r\n":
                break
            if headers > HEADERS_MAX:
                return await self._reply(writer, 400, "Bad Request")
        parts = line.decode("ascii", "replace").strip().split(" ")
        if len(parts) != 3 or parts[0] != "CONNECT":
            return await self._reply(writer, 405, "Method Not Allowed")
        host, _, port = parts[1].rpartition(":")
        host = host.lower()
        sandbox = cfg.sandboxes.get(peer or "")
        if sandbox is None:
            return await self._reply(writer, 403, "Forbidden")
        if port != "443" or not HOST.match(host):
            return await self._reply(writer, 403, "Forbidden")
        turn = host_matches(host, cfg.turn_hosts)
        if not turn and not host_matches(host, cfg.allow_hosts):
            self.log("refused_host", sandbox=sandbox, host=host)
            return await self._reply(writer, 403, "Forbidden")
        if turn and cfg.daily_cap and self.usage.used(sandbox) >= cfg.daily_cap:
            self.log("daily_cap", sandbox=sandbox)
            return await self._reply(writer, 429, "Too Many Requests")
        if turn and not await self.line.acquire(cfg.max_concurrent, cfg.queue_wait):
            self.log("line_full", sandbox=sandbox)
            return await self._reply(writer, 503, "Service Unavailable")
        try:
            try:
                up_reader, up_writer = await asyncio.wait_for(self.open_connection(host, 443), 15)
            except (OSError, asyncio.TimeoutError):
                return await self._reply(writer, 502, "Bad Gateway")
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            active = await self._pump(reader, writer, up_reader, up_writer, cfg.idle_close if turn else None)
            if turn:
                self.usage.add(sandbox, active)
        finally:
            if turn:
                self.line.release(cfg.max_concurrent)

    async def _pump(self, reader, writer, up_reader, up_writer, idle_close):
        """Copies both ways until either side ends; with `idle_close`, a connection quiet that long is closed (a kept-
        alive connection between replies must not hold a turn's slot). Returns the seconds it carried bytes."""
        last = [self.clock()]
        first = [None]

        async def copy(src, dst):
            try:
                while True:
                    data = await src.read(CHUNK)
                    if not data:
                        break
                    now = self.clock()
                    if first[0] is None:
                        first[0] = now
                    last[0] = now
                    dst.write(data)
                    await dst.drain()
            except (ConnectionError, OSError):
                pass
            finally:
                try:
                    dst.close()
                except Exception:
                    pass

        tasks = [asyncio.ensure_future(copy(reader, up_writer)), asyncio.ensure_future(copy(up_reader, writer))]
        try:
            while True:
                done, _ = await asyncio.wait(tasks, timeout=1 if idle_close else None,
                                             return_when=asyncio.FIRST_COMPLETED)
                if done:
                    break
                if idle_close and self.clock() - last[0] >= idle_close:
                    break
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                up_writer.close()
            except Exception:
                pass
        return 0.0 if first[0] is None else max(0.0, last[0] - first[0])

    async def serve(self):
        server = await asyncio.start_server(self.handle, self.config.listen_host, self.config.listen_port)
        async with server:
            await server.serve_forever()


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 64
    gate = Gate(argv[1])
    loop = asyncio.new_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, loop.stop)
    loop.create_task(gate.serve())
    loop.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
