"""Tests for the host wake doorbell's Discord watch (hivra-wake-doorbell.py).

A fake Discord runs on loopback: the REST calls the doorbell makes
(GET /gateway/bot, POST /channels/{id}/typing) and a gateway websocket that
records every op it is sent. Nothing here names a real bot, server or token;
the bot token is made at run time.
"""
import asyncio
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import struct
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_hivra_wake_doorbell as base  # noqa: E402  (loads the doorbell module and the email harness)

doorbell = base.doorbell
LOGS = base.LOGS
VMID = base.VMID
ARM_ID = base.ARM_ID
BOT = "100000000000000001"
OWNER = "200000000000000002"
OTHER_BOT = "300000000000000003"
GUILD = "400000000000000004"
DM_CHANNEL = "500000000000000005"
GENERAL = "600000000000000006"
FREE = "700000000000000007"
THREAD = "800000000000000008"


def message(channel=DM_CHANNEL, author=OWNER, guild=None, bot=False, **extra):
    data = {"id": str(int(time.time() * 1000)), "type": 0, "channel_id": channel, "author": {"id": author, "bot": bot},
            "content": "", "mentions": []}
    if guild:
        data["guild_id"] = guild
    data.update(extra)
    return data


class FakeDiscord(object):
    """REST and gateway on one loopback port."""

    def __init__(self, loop, token):
        self.loop = loop
        self.token = token
        self.remaining = 900
        self.sessions = []
        self.ops = []
        self.http = []
        self.resumable = True
        self.ack = True
        self.down = False
        self.close_codes = []
        self.server = asyncio.run_coroutine_threadsafe(asyncio.start_server(self.serve, "127.0.0.1", 0), loop).result(5)
        self.port = self.server.sockets[0].getsockname()[1]
        self.url = "ws://127.0.0.1:%d" % self.port

    @property
    def api(self):
        return "http://127.0.0.1:%d/api/v10" % self.port

    def identifies(self):
        return [op for op in self.ops if op["op"] == 2]

    def resumes(self):
        return [op for op in self.ops if op["op"] == 6]

    async def serve(self, reader, writer):
        if self.down:
            writer.close()
            return
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1")
            lines = head.split("\r\n")
            method, path, _ = lines[0].split(" ", 2)
            headers = {}
            for line in lines[1:]:
                name, _, value = line.partition(":")
                if name:
                    headers[name.strip().lower()] = value.strip()
            if headers.get("upgrade", "").lower() == "websocket":
                await self.gateway(reader, writer, headers)
                return
            length = int(headers.get("content-length") or 0)
            if length:
                await reader.readexactly(length)
            self.http.append((method, path, headers.get("authorization") == "Bot " + self.token))
            if headers.get("authorization") != "Bot " + self.token:
                status, body = 401, {"message": "401: Unauthorized"}
            elif method == "GET" and path == "/api/v10/gateway/bot":
                status, body = 200, {"url": self.url, "shards": 1,
                                     "session_start_limit": {"total": 1000, "remaining": self.remaining,
                                                             "reset_after": 1000, "max_concurrency": 1}}
            elif method == "POST" and path.endswith("/typing"):
                status, body = 204, None
            else:
                status, body = 404, {"message": "nope"}
            data = b"" if body is None else json.dumps(body).encode()
            # Chunked, as Discord's edge may answer.
            chunked = (b"%x\r\n" % len(data) + data + b"\r\n" if data else b"") + b"0\r\n\r\n"
            writer.write(b"HTTP/1.1 %d X\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" % status + chunked)
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, OSError, ValueError):
            pass
        finally:
            writer.close()

    @staticmethod
    def frame(opcode, payload):
        size = len(payload)
        if size < 126:
            head = struct.pack("!BB", 0x80 | opcode, size)
        elif size < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 126, size)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 127, size)
        return head + payload

    async def read_frame(self, reader):
        first, second = struct.unpack("!BB", await reader.readexactly(2))
        size = second & 0x7F
        if size == 126:
            size = struct.unpack("!H", await reader.readexactly(2))[0]
        elif size == 127:
            size = struct.unpack("!Q", await reader.readexactly(8))[0]
        assert second & 0x80, "client frames must be masked"
        mask = await reader.readexactly(4)
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(await reader.readexactly(size)))
        return first & 0x0F, data

    async def gateway(self, reader, writer, headers):
        accept = base64.b64encode(hashlib.sha1(headers["sec-websocket-key"].encode() + doorbell.WS_GUID).digest())
        writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                     + accept + b"\r\n\r\n")
        session = {"writer": writer, "seq": 0}
        self.sessions.append(session)

        def send(payload):
            writer.write(self.frame(0x1, json.dumps(payload).encode()))

        session["send"] = send
        send({"op": 10, "d": {"heartbeat_interval": 200}})
        try:
            while True:
                opcode, data = await self.read_frame(reader)
                if opcode == 0x8:
                    self.close_codes.append(struct.unpack("!H", data[:2])[0] if len(data) >= 2 else None)
                    break
                if opcode != 0x1:
                    continue
                payload = json.loads(data.decode())
                self.ops.append(payload)
                if payload["op"] == 1 and self.ack:
                    send({"op": 11})
                elif payload["op"] == 2:
                    session["seq"] += 1
                    send({"op": 0, "t": "READY", "s": session["seq"],
                          "d": {"session_id": "sess-%d" % len(self.sessions), "resume_gateway_url": self.url,
                                "user": {"id": BOT, "bot": True}}})
                elif payload["op"] == 6:
                    if self.resumable:
                        session["seq"] += 1
                        send({"op": 0, "t": "RESUMED", "s": session["seq"], "d": {}})
                    else:
                        send({"op": 9, "d": False})
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, OSError, AssertionError):
            pass
        finally:
            if session in self.sessions:
                self.sessions.remove(session)
            writer.close()

    def dispatch(self, event, data):
        def go():
            for session in list(self.sessions):
                session["seq"] += 1
                session["send"]({"op": 0, "t": event, "s": session["seq"], "d": data})
        self.loop.call_soon_threadsafe(go)

    def close_all(self, code):
        def go():
            for session in list(self.sessions):
                session["writer"].write(self.frame(0x8, struct.pack("!H", code)))
                session["writer"].close()
        self.loop.call_soon_threadsafe(go)

    def close(self):
        self.close_all(1001)
        self.loop.call_soon_threadsafe(self.server.close)


class DiscordTestCase(unittest.TestCase):
    def setUp(self):
        LOGS.clear()
        self.h = base.Harness(discord_linger=0.4, test_any_gateway=True, discord_min_logins=100, discord_max_identifies=3)
        self.token = "bot." + secrets.token_urlsafe(30)
        self.discord = FakeDiscord(self.h.loop, self.token)
        self.h.cfg.discord_rest = self.discord.api
        self.h.start()

    def tearDown(self):
        try:
            self.discord.close()
        finally:
            self.h.close()

    def arm_request(self, **rules):
        values = {"token": self.token, "require_mention": True, "thread_require_mention": False, "allow_bots": "none",
                  "free_channels": [FREE, "#Help-Desk"], "wake_all_guild": False}
        values.update(rules)
        return {"cmd": "arm", "vmid": VMID, "arm_id": ARM_ID, "channel": "discord", "discord": values}

    def arm(self, **rules):
        answer = self.h.ctl(self.arm_request(**rules))
        self.assertTrue(answer["ok"], answer)
        return answer

    def watch(self):
        return self.h.service.watches[VMID]

    def wait(self, predicate, timeout=8.0):
        return self.h.wait(predicate, timeout)

    def assert_never_posted(self):
        for method, path, _ in self.discord.http:
            self.assertFalse(method == "POST" and not path.endswith("/typing"), path)


class ArmTests(DiscordTestCase):
    def test_arm_answers_after_ready_with_the_budget(self):
        answer = self.arm()
        self.assertEqual(answer, {"ok": True, "vmid": VMID, "arm_id": ARM_ID, "channel": "discord", "login_remaining": 900})
        self.assertEqual(len(self.discord.identifies()), 1)
        identify = self.discord.identifies()[0]["d"]
        self.assertEqual(identify["token"], self.token)
        self.assertEqual(identify["intents"], 4609)
        self.assertFalse(identify["intents"] & (1 << 15), "never MESSAGE_CONTENT")
        self.assertEqual(self.watch().state, "armed")
        self.assertEqual(self.watch().bot_id, BOT)
        self.assertEqual(self.discord.http[0][:2], ("GET", "/api/v10/gateway/bot"))

    def test_low_login_budget_refuses_the_arm(self):
        self.discord.remaining = 99
        answer = self.h.ctl(self.arm_request())
        self.assertEqual(answer, {"ok": False, "vmid": VMID, "error": "login_budget"})
        self.assertEqual(self.discord.identifies(), [])
        self.assertNotIn(VMID, self.h.service.watches)

    def test_refused_token_refuses_the_arm(self):
        answer = self.h.ctl(self.arm_request(token="bot." + secrets.token_urlsafe(30)))
        self.assertEqual(answer["error"], "token_refused")

    def test_gateway_down_refuses_the_arm(self):
        self.h.cfg.discord_rest = "http://127.0.0.1:1/api/v10"
        self.assertEqual(self.h.ctl(self.arm_request())["error"], "connect_failed")

    def test_helper_without_credential_refuses_the_arm(self):
        self.h.helper.credential = False
        self.assertEqual(self.h.ctl(self.arm_request())["error"], "helper_unready")
        self.assertEqual(self.discord.http, [])

    def test_bad_requests(self):
        for rules in ({"token": "short"}, {"token": self.token + "\n"}, {"allow_bots": "some"}, {"require_mention": "yes"},
                      {"free_channels": "x"}, {"wake_all_guild": None}):
            self.assertEqual(self.h.ctl(self.arm_request(**rules))["error"], "bad_request", rules)
        request = self.arm_request()
        del request["discord"]
        self.assertEqual(self.h.ctl(request)["error"], "bad_request")

    def test_token_never_in_answers_state_or_logs(self):
        self.arm()
        status = self.h.ctl({"cmd": "status"})
        self.assertNotIn(self.token, json.dumps(status))
        with open(self.h.cfg.state_path) as handle:
            text = handle.read()
        self.assertNotIn(self.token, text)
        self.assertEqual(json.loads(text), {"armed": [{"vmid": VMID, "arm_id": ARM_ID}]})
        self.discord.dispatch("MESSAGE_CREATE", message())
        self.assertTrue(self.wait(lambda: self.h.helper.requests))
        self.assertNotIn(self.token, "\n".join(LOGS))

    def test_health_counts_discord_arms(self):
        self.arm()
        health = self.h.ctl({"cmd": "health"})
        self.assertEqual((health["armed"], health["fired"], health["lingering"]), (1, 0, 0))


class WakeTests(DiscordTestCase):
    def test_dm_wakes_then_one_typing_indicator_and_no_message(self):
        self.arm()
        self.discord.dispatch("MESSAGE_CREATE", message())
        self.assertTrue(self.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.h.helper.requests[0], {"cmd": "request", "vmid": VMID, "from": "doorbell"})
        self.assertTrue(self.wait(lambda: any(path.endswith("/typing") for _, path, _ in self.discord.http)))
        typing = [path for method, path, _ in self.discord.http if path.endswith("/typing")]
        self.assertEqual(typing, ["/api/v10/channels/%s/typing" % DM_CHANNEL])
        self.assertEqual(self.watch().state, "fired")
        self.assertEqual(self.watch().fired_reason, "message")
        time.sleep(0.6)
        self.assertEqual(len([p for _, p, _ in self.discord.http if p.endswith("/typing")]), 1)
        self.assert_never_posted()

    def test_guild_rules(self):
        self.arm()
        quiet = [
            message(GENERAL, guild=GUILD),
            message(GENERAL, author=BOT, guild=GUILD),
            message(DM_CHANNEL, author=BOT),
            message(DM_CHANNEL, author=OTHER_BOT, bot=True),
            message(GENERAL, guild=GUILD, type=7),
            message(GENERAL, guild=GUILD, mentions=[{"id": OWNER}]),
        ]
        for item in quiet:
            self.discord.dispatch("MESSAGE_CREATE", item)
        time.sleep(0.6)
        self.assertEqual(self.h.helper.requests, [])
        self.assertEqual(self.watch().state, "armed")
        self.discord.dispatch("MESSAGE_CREATE", message(GENERAL, guild=GUILD, mentions=[{"id": BOT}]))
        self.assertTrue(self.wait(lambda: self.h.helper.requests))

    def test_message_sent_during_the_stop_keeps_asking(self):
        self.h.helper.state = "awake"
        self.arm()
        self.discord.dispatch("MESSAGE_CREATE", message())
        self.assertTrue(self.wait(lambda: len(self.h.helper.requests) >= 3))
        self.assertEqual(self.h.ctl({"cmd": "disarm", "vmid": VMID, "arm_id": ARM_ID})["was"], "fired")
        count = len(self.h.helper.requests)
        time.sleep(0.6)
        self.assertEqual(len(self.h.helper.requests), count)

    def test_free_channel_by_name_and_bot_thread(self):
        self.arm()
        self.discord.dispatch("GUILD_CREATE", {"id": GUILD, "channels": [{"id": GENERAL, "name": "general"},
                                                                          {"id": "910000000000000009", "name": "help-desk"}],
                                               "threads": [{"id": THREAD, "parent_id": GENERAL, "owner_id": BOT}]})
        time.sleep(0.2)
        self.discord.dispatch("MESSAGE_CREATE", message("910000000000000009", guild=GUILD))
        self.assertTrue(self.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.watch().threads[THREAD], (GENERAL, BOT))


class SessionTests(DiscordTestCase):
    def test_dropped_session_resumes_without_a_new_login(self):
        self.arm()
        self.discord.close_all(1006)
        self.assertTrue(self.wait(lambda: self.discord.resumes()))
        self.assertEqual(self.discord.resumes()[0]["d"]["session_id"], "sess-1")
        self.assertEqual(len(self.discord.identifies()), 1)
        self.assertTrue(self.wait(lambda: len(self.discord.sessions) == 1))
        time.sleep(0.2)
        self.discord.dispatch("MESSAGE_CREATE", message())
        self.assertTrue(self.wait(lambda: self.h.helper.requests))

    def test_expired_session_logs_in_afresh_within_the_cap(self):
        self.arm()
        self.discord.resumable = False
        self.discord.close_all(4009)
        self.assertTrue(self.wait(lambda: len(self.discord.identifies()) == 2))
        self.assertEqual(self.watch().state, "armed")
        self.assertEqual(self.discord.resumes(), [])

    def test_identify_cap_rings(self):
        self.arm()
        for count in (2, 3):
            self.discord.close_all(4009)
            self.assertTrue(self.wait(lambda: len(self.discord.identifies()) == count))
            time.sleep(0.2)
        self.discord.close_all(4009)
        self.assertTrue(self.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.watch().fired_reason, "login_budget")

    def test_spent_budget_rings_instead_of_logging_in(self):
        self.arm()
        self.discord.remaining = 10
        self.discord.close_all(4007)
        self.assertTrue(self.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.watch().fired_reason, "login_budget")
        self.assertEqual(len(self.discord.identifies()), 1)

    def test_refused_token_after_the_arm_rings(self):
        self.arm()
        self.discord.close_all(4004)
        self.assertTrue(self.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.watch().fired_reason, "token_refused")

    def test_unreachable_gateway_rings_after_watch_fail(self):
        self.arm()
        self.discord.down = True
        self.discord.close_all(1006)
        self.assertTrue(self.wait(lambda: self.h.helper.requests, timeout=10))
        self.assertEqual(self.watch().fired_reason, "watch_failed")

    def test_unacknowledged_heartbeat_drops_and_resumes(self):
        self.arm()
        self.discord.ack = False
        self.assertTrue(self.wait(lambda: self.discord.resumes()))
        self.assertTrue(any(json.loads(line)["event"] == "discord_zombie" for line in LOGS))

    def test_disarm_lingers_then_closes_cleanly(self):
        self.arm()
        answer = self.h.ctl({"cmd": "disarm", "vmid": VMID, "arm_id": ARM_ID})
        self.assertEqual(answer, {"ok": True, "vmid": VMID, "was": "armed"})
        self.assertEqual(self.h.ctl({"cmd": "status", "vmid": VMID})["state"], "lingering")
        self.assertEqual(self.h.ctl({"cmd": "health"})["armed"], 0)
        self.discord.dispatch("MESSAGE_CREATE", message())
        self.assertTrue(self.wait(lambda: 1000 in self.discord.close_codes))
        self.assertEqual(self.h.helper.requests, [])
        self.assertEqual(self.h.service.lingering, {})
        with open(self.h.cfg.state_path) as handle:
            self.assertEqual(json.load(handle), {"armed": []})

    def test_rearm_closes_the_lingering_session_first(self):
        self.arm()
        self.h.cfg.discord_linger = 30.0
        self.h.ctl({"cmd": "disarm", "vmid": VMID})
        self.arm()
        self.assertTrue(self.wait(lambda: 1000 in self.discord.close_codes))
        self.assertEqual(self.h.service.lingering, {})
        self.assertEqual(len(self.discord.sessions), 1)

    def test_ring_expires_and_closes(self):
        self.h.cfg.fire_max = 0.5
        self.h.helper.state = "awake"
        self.arm()
        self.discord.dispatch("MESSAGE_CREATE", message())
        self.assertTrue(self.wait(lambda: VMID not in self.h.service.watches))
        self.assertTrue(self.wait(lambda: 1000 in self.discord.close_codes))

    def test_ring_that_never_reaches_hivra_keeps_watching(self):
        self.h.cfg.fire_max = 0.3
        self.h.cfg.fire_slow = 0.2
        self.h.helper.refuse = "no_credential"
        self.arm()
        self.discord.dispatch("MESSAGE_CREATE", message())
        self.assertTrue(self.wait(lambda: len(self.h.helper.requests) >= 4))
        self.assertIn(VMID, self.h.service.watches)
        self.assertEqual(self.watch().state, "fired")

    def test_restart_rings_for_a_lost_discord_arm(self):
        self.arm()
        self.h.restart()
        self.assertTrue(self.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.watch().fired_reason, "restart")


RULES = {"require_mention": True, "thread_require_mention": False, "allow_bots": "none",
         "free_channels": frozenset([FREE, "help-desk"]), "wake_all_guild": False}


class PureTests(unittest.TestCase):
    def wakes(self, data, threads=None, names=None, **rules):
        return doorbell.discord_message_wakes(data, BOT, dict(RULES, **rules), threads or {}, names or {})

    def test_wake_filter(self):
        self.assertTrue(self.wakes(message()))
        self.assertFalse(self.wakes(message(author=BOT)))
        self.assertFalse(self.wakes(message(GENERAL, guild=GUILD)))
        self.assertTrue(self.wakes(message(GENERAL, guild=GUILD, content="hi <@%s>" % BOT)))
        self.assertTrue(self.wakes(message(GENERAL, guild=GUILD, content="hi <@!%s>" % BOT)))
        self.assertTrue(self.wakes(message(GENERAL, guild=GUILD, mentions=[{"id": BOT}])))
        self.assertTrue(self.wakes(message(GENERAL, guild=GUILD, type=19, referenced_message={"author": {"id": BOT}})))
        self.assertFalse(self.wakes(message(GENERAL, guild=GUILD, type=19, referenced_message={"author": {"id": OWNER}})))
        self.assertTrue(self.wakes(message(FREE, guild=GUILD)))
        self.assertTrue(self.wakes(message(GENERAL, guild=GUILD), names={GENERAL: "help-desk"}))
        self.assertTrue(self.wakes(message(THREAD, guild=GUILD), threads={THREAD: (FREE, OWNER)}))
        self.assertTrue(self.wakes(message(THREAD, guild=GUILD), threads={THREAD: (GENERAL, BOT)}))
        self.assertFalse(self.wakes(message(THREAD, guild=GUILD), threads={THREAD: (GENERAL, BOT)}, thread_require_mention=True))
        self.assertFalse(self.wakes(message(THREAD, guild=GUILD), threads={THREAD: (GENERAL, OWNER)}))
        self.assertTrue(self.wakes(message(GENERAL, guild=GUILD), require_mention=False))
        self.assertTrue(self.wakes(message(GENERAL, guild=GUILD), wake_all_guild=True))
        self.assertTrue(self.wakes(message(GENERAL, guild=GUILD), free_channels=frozenset(["*"])))
        self.assertFalse(self.wakes(message(GENERAL, guild=GUILD, type=7, mentions=[{"id": BOT}])))
        self.assertFalse(self.wakes(message(webhook_id="1")))
        bot_dm = message(author=OTHER_BOT, bot=True)
        self.assertFalse(self.wakes(bot_dm))
        self.assertFalse(self.wakes(bot_dm, allow_bots="mentions"))
        self.assertTrue(self.wakes(dict(bot_dm, mentions=[{"id": BOT}]), allow_bots="mentions"))
        self.assertTrue(self.wakes(bot_dm, allow_bots="all"))
        self.assertFalse(self.wakes(None))
        self.assertFalse(doorbell.discord_message_wakes(message(), None, RULES, {}, {}))

    def test_arm_request_from_guest(self):
        token = "bot." + secrets.token_urlsafe(30)
        values = {"DISCORD_BOT_TOKEN": token, "DISCORD_FREE_RESPONSE_CHANNELS": "%s, #Help-Desk" % FREE,
                  "DISCORD_REQUIRE_MENTION": "false", "DISCORD_ALLOW_BOTS": "Mentions", "_yaml_gates": "1"}
        line = doorbell.DISCORD_CRED_PREFIX + json.dumps({"fp": "0123456789abcdef", "values": values})
        request, reason = doorbell.arm_request_from_guest(["noise", line], VMID, ARM_ID, "0123456789abcdef", "discord")
        self.assertIsNone(reason)
        self.assertEqual(request["discord"], {"token": token, "require_mention": False, "thread_require_mention": False,
                                              "allow_bots": "mentions", "free_channels": [FREE, "#help-desk"],
                                              "wake_all_guild": True})
        parsed = doorbell.parse_arm(request)
        self.assertEqual(parsed["rules"]["free_channels"], frozenset([FREE, "help-desk"]))
        defaults, _ = doorbell.arm_request_from_guest([doorbell.DISCORD_CRED_PREFIX + json.dumps(
            {"fp": "0123456789abcdef", "values": {"DISCORD_BOT_TOKEN": token, "DISCORD_ALLOW_BOTS": "sometimes"}})],
            VMID, ARM_ID, "0123456789abcdef", "discord")
        self.assertEqual((defaults["discord"]["require_mention"], defaults["discord"]["allow_bots"],
                          defaults["discord"]["wake_all_guild"]), (True, "none", False))
        self.assertEqual(doorbell.arm_request_from_guest([line], VMID, ARM_ID, "fedcba9876543210", "discord"),
                         (None, "credential_changed"))
        self.assertEqual(doorbell.arm_request_from_guest(["HIVRA_DISCORD_CRED_NONE missing"], VMID, ARM_ID,
                                                         "0123456789abcdef", "discord"), (None, "missing"))
        # An email answer is never read as a Discord one.
        self.assertEqual(doorbell.arm_request_from_guest([doorbell.CRED_PREFIX + "{}"], VMID, ARM_ID,
                                                         "0123456789abcdef", "discord"), (None, "no_answer"))
        bad = doorbell.DISCORD_CRED_PREFIX + json.dumps({"fp": "0123456789abcdef", "values": {"DISCORD_BOT_TOKEN": "x"}})
        self.assertEqual(doorbell.arm_request_from_guest([bad], VMID, ARM_ID, "0123456789abcdef", "discord"),
                         (None, "bad_settings"))

    def test_arm_from_guest_takes_the_channel_and_never_prints_the_token(self):
        token = "bot." + secrets.token_urlsafe(30)
        line = doorbell.DISCORD_CRED_PREFIX + json.dumps({"fp": "0123456789abcdef", "values": {"DISCORD_BOT_TOKEN": token}}) + "\n"
        with tempfile.TemporaryDirectory() as tmp:
            cfg = doorbell.Config(run_dir=tmp)
            for argv, code, expected in (
                ([str(VMID), ARM_ID, "0123456789abcdef", "discord"], 2,
                 '{"error":"doorbell_unreachable","ok":false,"vmid":1234}'),
                ([str(VMID), ARM_ID, "0123456789abcdef", "slack"], 2, '{"error":"bad_arguments","ok":false}'),
            ):
                stdin = mock.Mock()
                stdin.buffer = io.BytesIO(line.encode())
                out = io.StringIO()
                with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", out):
                    self.assertEqual(doorbell.arm_from_guest_main(argv, cfg), code)
                self.assertNotIn(token, out.getvalue())
                self.assertEqual(out.getvalue(), doorbell.ARM_PREFIX + expected + "\n")

    def test_gateway_addresses_must_be_discord(self):
        watch = doorbell.DiscordWatch(mock.Mock(cfg=doorbell.Config()), {
            "vmid": VMID, "arm_id": ARM_ID, "token": "t", "rules": RULES})
        self.assertTrue(watch.gateway_ok("wss://gateway.discord.gg"))
        self.assertTrue(watch.gateway_ok("wss://gateway-us-east1-b.discord.gg/"))
        for url in ("ws://gateway.discord.gg", "wss://gateway.discord.gg.evil.test", "wss://evil.test/x.discord.gg",
                    "wss://user@gateway.discord.gg", "wss://gateway.discord.gg:bad", None, "x" * 600):
            self.assertFalse(watch.gateway_ok(url), url)

    def test_websocket_masking_round_trip(self):
        payload = os.urandom(300)
        mask = os.urandom(4)
        self.assertEqual(doorbell.mask_bytes(doorbell.mask_bytes(payload, mask), mask), payload)
        self.assertEqual(doorbell.mask_bytes(b"", mask), b"")

    def test_intents_and_public_defaults(self):
        self.assertEqual(doorbell.DISCORD_INTENTS, 4609)
        self.assertEqual(doorbell.Config().discord_rest, "https://discord.com/api/v10")
        self.assertFalse(doorbell.Config().test_any_gateway)

    def test_no_nul_bytes_and_no_message_posting_in_source(self):
        text = base.SCRIPT.read_bytes()
        self.assertNotIn(b"\x00", text)
        self.assertNotIn(b"/messages", text)


if __name__ == "__main__":
    unittest.main()
