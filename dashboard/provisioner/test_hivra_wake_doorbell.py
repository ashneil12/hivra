"""Tests for the host wake doorbell (hivra-wake-doorbell.py).

Everything runs on loopback in a temporary tree: a fake IMAP server that
records every command it is sent, and a fake wake helper control socket.
Nothing here names a real host, mailbox or credential; the mailbox password is
made at run time.
"""
import asyncio
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "hivra-wake-doorbell.py"
spec = importlib.util.spec_from_file_location("hivra_wake_doorbell", SCRIPT)
doorbell = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doorbell)

LOGS = []
doorbell.log = lambda event, **fields: LOGS.append(json.dumps(dict(fields, event=event)))

VMID = 1234
ARM_ID = "00000000-0000-4fdd-85f4-f955ee4104e2"
MAILBOX = "agent@example.test"
OWNER = "owner@example.test"


def headers(sender, **extra):
    lines = ["From: %s" % sender]
    for key, value in extra.items():
        lines.append("%s: %s" % (key.replace("_", "-"), value))
    return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8")


class FakeImap(object):
    """A tiny IMAP server: one INBOX, IDLE optional, records every command verb it gets."""

    def __init__(self, loop, idle=True, password=None):
        self.loop = loop
        self.idle_capable = idle
        self.password = password
        self.uidvalidity = 7001
        self.next_uid = 40
        self.messages = []
        self.commands = []
        self.idlers = set()
        self.refuse_login = False
        self.down = False
        self.connections = 0
        self.writers = set()
        self.server = asyncio.run_coroutine_threadsafe(asyncio.start_server(self.serve, "127.0.0.1", 0), loop).result(5)
        self.port = self.server.sockets[0].getsockname()[1]

    def add(self, header_bytes):
        uid = self.next_uid
        self.next_uid += 1
        self.messages.append((uid, header_bytes))

        def notify():
            for writer in list(self.idlers):
                writer.write(b"* %d EXISTS\r\n" % len(self.messages))
        self.loop.call_soon_threadsafe(notify)
        return uid

    def drop_all(self):
        def close():
            for writer in list(self.writers):
                writer.close()
        self.loop.call_soon_threadsafe(close)

    async def serve(self, reader, writer):
        self.connections += 1
        if self.down:
            writer.close()
            return
        self.writers.add(writer)
        caps = "IMAP4rev1" + (" IDLE" if self.idle_capable else "")
        writer.write(("* OK [CAPABILITY %s] fake ready\r\n" % caps).encode())
        try:
            while True:
                line = await reader.readuntil(b"\r\n")
                text = line[:-2].decode("utf-8", "replace")
                literal = re.search(r"\{([0-9]+)\}$", text)
                while literal:
                    writer.write(b"+ go\r\n")
                    data = await reader.readexactly(int(literal.group(1)))
                    rest = (await reader.readuntil(b"\r\n"))[:-2].decode()
                    text = text[:literal.start()] + json.dumps(data.decode()) + rest
                    literal = re.search(r"\{([0-9]+)\}$", text)
                tag, _, rest = text.partition(" ")
                verb = rest.split(" ", 1)[0].upper()
                args = rest[len(verb):].strip()
                if verb == "UID":
                    verb = "UID " + args.split(" ", 1)[0].upper()
                    args = args.split(" ", 1)[1] if " " in args else ""
                self.commands.append(verb)
                if verb == "LOGIN":
                    ok = not self.refuse_login and (self.password is None or self.password in args)
                    writer.write(("%s %s LOGIN\r\n" % (tag, "OK" if ok else "NO")).encode())
                elif verb == "STATUS":
                    writer.write(("* STATUS INBOX (UIDNEXT %d UIDVALIDITY %d)\r\n%s OK STATUS\r\n"
                                  % (self.next_uid, self.uidvalidity, tag)).encode())
                elif verb == "EXAMINE":
                    writer.write(("* %d EXISTS\r\n* OK [UIDVALIDITY %d] v\r\n* OK [UIDNEXT %d] n\r\n%s OK [READ-ONLY] EXAMINE\r\n"
                                  % (len(self.messages), self.uidvalidity, self.next_uid, tag)).encode())
                elif verb == "UID FETCH":
                    first = int(args.split(":", 1)[0])
                    picked = [m for m in self.messages if m[0] >= first] or self.messages[-1:]
                    for seq, (uid, data) in enumerate(picked, 1):
                        writer.write(b"* %d FETCH (UID %d BODY[HEADER.FIELDS (FROM)] {%d}\r\n" % (seq, uid, len(data)) + data + b")\r\n")
                    writer.write(("%s OK FETCH\r\n" % tag).encode())
                elif verb == "IDLE":
                    writer.write(b"+ idling\r\n")
                    self.idlers.add(writer)
                    done = await reader.readuntil(b"\r\n")
                    self.idlers.discard(writer)
                    self.commands.append(done[:-2].decode())
                    writer.write(("%s OK IDLE\r\n" % tag).encode())
                elif verb in ("NOOP", "CAPABILITY"):
                    writer.write(("%s OK %s\r\n" % (tag, verb)).encode())
                elif verb == "LOGOUT":
                    writer.write(("* BYE\r\n%s OK LOGOUT\r\n" % tag).encode())
                    await writer.drain()
                    break
                else:
                    writer.write(("%s BAD unexpected\r\n" % tag).encode())
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            self.writers.discard(writer)
            self.idlers.discard(writer)
            writer.close()

    def close(self):
        self.server.get_loop().call_soon_threadsafe(self.server.close)


class FakeHelper(object):
    """The wake helper's control socket: health says a credential is present; requests are recorded."""

    def __init__(self, loop, path):
        self.requests = []
        self.credential = True
        self.state = "waking"
        self.refuse = None
        self.server = asyncio.run_coroutine_threadsafe(asyncio.start_unix_server(self.serve, path=path), loop).result(5)

    async def serve(self, reader, writer):
        request = json.loads((await reader.readline()).decode())
        if request.get("cmd") == "health":
            answer = {"ok": True, "credential": self.credential}
        else:
            self.requests.append(request)
            answer = ({"ok": False, "error": self.refuse} if self.refuse
                      else {"ok": True, "vmid": request.get("vmid"), "state": self.state})
        writer.write((json.dumps(answer) + "\n").encode())
        await writer.drain()
        writer.close()

    def close(self):
        self.server.get_loop().call_soon_threadsafe(self.server.close)


class Harness(object):
    def __init__(self, idle=True, **overrides):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.run_dir = str(root / "run")
        self.helper_path = str(root / "helper.sock")
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.password = secrets.token_urlsafe(18)
        self.imap = FakeImap(self.loop, idle=idle, password=self.password)
        self.helper = FakeHelper(self.loop, self.helper_path)
        options = dict(run_dir=self.run_dir, helper_ctl=self.helper_path, root_uids=(os.geteuid(),),
                       idle_seconds=0.3, poll_seconds=0.2, fire_retry=0.2, fire_max=30.0, watch_fail=1.0, allow_private_imap=True,
                       reconnect_backoff=(0.1,), arm_timeout=5.0, connect_timeout=2.0, command_timeout=3.0)
        options.update(overrides)
        self.cfg = doorbell.Config(**options)
        self.service = None

    def run(self, coro, timeout=20):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def start(self):
        self.service = doorbell.Doorbell(self.cfg)
        self.run(self.service.start())

    def restart(self):
        self.run(self.service.stop())
        self.service = doorbell.Doorbell(self.cfg)
        self.run(self.service.start())

    def ctl(self, request, timeout=10):
        return self.run(doorbell.unix_request(self.cfg.ctl_path, request, timeout), timeout + 5)

    def arm_request(self, **changes):
        request = {"cmd": "arm", "vmid": VMID, "arm_id": ARM_ID, "channel": "email",
                   "imap": {"host": "127.0.0.1", "port": self.imap.port, "security": "plain", "verify": True,
                            "user": MAILBOX, "password": self.password},
                   "self": MAILBOX, "allowed": [OWNER]}
        request.update(changes)
        return request

    def wait(self, predicate, timeout=8.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(0.05)
        return False

    def close(self):
        if self.service is not None:
            try:
                self.run(self.service.stop())
            except Exception:
                pass
        self.imap.drop_all()
        self.imap.close()
        self.helper.close()
        time.sleep(0.1)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()
        self.tmp.cleanup()


class DoorbellTestCase(unittest.TestCase):
    idle = True

    def setUp(self):
        LOGS.clear()
        self.h = Harness(idle=self.idle)
        self.h.start()

    def tearDown(self):
        self.h.close()

    def arm(self, **changes):
        answer = self.h.ctl(self.h.arm_request(**changes))
        self.assertTrue(answer["ok"], answer)
        return answer

    def assert_read_only(self):
        sent = set(self.h.imap.commands)
        self.assertFalse(sent & {"SELECT", "STORE", "EXPUNGE", "COPY", "MOVE", "APPEND", "DELETE", "CLOSE", "UID STORE"}, sent)


class ArmTests(DoorbellTestCase):
    def test_refuses_a_mail_server_on_a_private_address(self):
        # Host settings from inside a computer may not point the doorbell at the host or another guest.
        self.h.cfg.allow_private_imap = False
        answer = self.h.ctl(self.h.arm_request())
        self.assertEqual((answer["ok"], answer.get("error")), (False, "address_refused"))
        self.assertEqual(self.h.imap.commands, [])

    def test_resolves_to_a_global_address_only(self):
        cfg = doorbell.Config(allow_private_imap=False, connect_timeout=2.0)
        for host in ("127.0.0.1", "10.250.0.5", "169.254.1.1", "100.64.0.1", "::1"):
            with self.assertRaises(doorbell.ImapError) as caught:
                asyncio.run(doorbell.resolve_public(host, 993, cfg))
            self.assertEqual(caught.exception.reason, "address_refused")
        self.assertEqual(asyncio.run(doorbell.resolve_public("8.8.8.8", 993, cfg)), "8.8.8.8")

    def test_arm_records_status_baseline_then_examines(self):
        answer = self.arm()
        self.assertEqual(answer["uidvalidity"], 7001)
        self.assertEqual(answer["uidnext"], 40)
        commands = self.h.imap.commands
        self.assertLess(commands.index("STATUS"), commands.index("EXAMINE"))
        self.assertEqual(self.h.ctl({"cmd": "status", "vmid": VMID})["state"], "armed")
        self.assert_read_only()

    def test_state_file_holds_no_credential(self):
        self.arm()
        with open(self.h.cfg.state_path) as handle:
            text = handle.read()
        self.assertNotIn(self.h.password, text)
        self.assertEqual(json.loads(text), {"armed": [{"arm_id": ARM_ID, "vmid": VMID}]})
        self.assertEqual(os.stat(self.h.cfg.state_path).st_mode & 0o777, 0o600)

    def test_answers_and_logs_never_hold_the_password(self):
        self.arm()
        status = json.dumps(self.h.ctl({"cmd": "status"}))
        self.assertNotIn(self.h.password, status)
        self.assertFalse(any(self.h.password in line for line in LOGS))

    def test_wrong_password_refuses_the_arm(self):
        answer = self.h.ctl(self.h.arm_request(imap=dict(self.h.arm_request()["imap"], password="not-it")))
        self.assertEqual(answer, {"ok": False, "vmid": VMID, "error": "login_failed"})
        self.assertEqual(self.h.ctl({"cmd": "status", "vmid": VMID})["state"], "none")

    def test_helper_without_credential_refuses_the_arm(self):
        self.h.helper.credential = False
        answer = self.h.ctl(self.h.arm_request())
        self.assertEqual(answer["error"], "helper_unready")
        self.assertEqual(self.h.imap.connections, 0)

    def test_unreachable_mailbox_refuses_the_arm(self):
        self.h.imap.down = True
        self.assertEqual(self.h.ctl(self.h.arm_request())["error"], "connection_lost")

    def test_bad_requests(self):
        self.assertEqual(self.h.ctl(self.h.arm_request(vmid="12"))["error"], "bad_request")
        self.assertEqual(self.h.ctl(self.h.arm_request(arm_id="x"))["error"], "bad_request")
        self.assertEqual(self.h.ctl(self.h.arm_request(channel="discord"))["error"], "bad_request")
        bad_host = dict(self.h.arm_request()["imap"], host="bad host")
        self.assertEqual(self.h.ctl(self.h.arm_request(imap=bad_host))["error"], "bad_request")
        newline = dict(self.h.arm_request()["imap"], password="a\r\nb")
        self.assertEqual(self.h.ctl(self.h.arm_request(imap=newline))["error"], "bad_request")
        self.assertEqual(self.h.ctl({"cmd": "nope"})["error"], "unknown_command")

    def test_non_root_peer_is_refused(self):
        self.h.cfg.root_uids = (os.geteuid() + 1,)
        self.assertEqual(self.h.ctl({"cmd": "health"}), {"ok": False, "error": "forbidden"})

    def test_health(self):
        self.arm()
        health = self.h.ctl({"cmd": "health"})
        self.assertEqual((health["ok"], health["armed"], health["helper"], health["credential"]), (True, 1, True, True))

    def test_password_with_quotes_and_unicode_logs_in(self):
        self.h.password = 'p"w\\' + secrets.token_hex(4) + "é"
        self.h.imap.password = None
        self.arm()


class WatchTests(DoorbellTestCase):
    def test_allowed_sender_wakes_and_credentials_are_dropped(self):
        self.arm()
        self.h.imap.add(headers("Owner <%s>" % OWNER))
        self.assertTrue(self.h.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.h.helper.requests[0], {"cmd": "request", "vmid": VMID, "from": "doorbell"})
        watch = self.h.service.watches[VMID]
        self.assertEqual(watch.state, "fired")
        self.assertIsNone(watch.params)
        self.assert_read_only()

    def test_newsletter_and_strangers_do_not_wake(self):
        self.arm()
        self.h.imap.add(headers("News <%s>" % OWNER, List_Unsubscribe="<mailto:x@example.test>"))
        self.h.imap.add(headers("Stranger <someone@example.test>"))
        self.h.imap.add(headers("Robot <noreply@example.test>"))
        self.h.imap.add(headers("Me <%s>" % MAILBOX))
        self.h.imap.add(headers("Bulk <%s>" % OWNER, Precedence="bulk"))
        time.sleep(1.0)
        self.assertEqual(self.h.helper.requests, [])
        self.assertEqual(self.h.service.watches[VMID].next_uid, 45)
        self.h.imap.add(headers(OWNER))
        self.assertTrue(self.h.wait(lambda: self.h.helper.requests))
        self.assert_read_only()

    def test_mail_that_lands_during_the_stop_still_wakes(self):
        # The baseline is taken before the stop; a message arriving between the arm and the stop is above it.
        self.h.helper.state = "awake"
        self.arm()
        self.h.imap.add(headers(OWNER))
        self.assertTrue(self.h.wait(lambda: len(self.h.helper.requests) >= 1))
        # Hivra still sees it awake (going to sleep), so the doorbell keeps asking until the nap lets it wake.
        self.assertTrue(self.h.wait(lambda: len(self.h.helper.requests) >= 3))
        self.h.helper.state = "waking"
        self.assertEqual(self.h.ctl({"cmd": "disarm", "vmid": VMID})["was"], "fired")
        count = len(self.h.helper.requests)
        time.sleep(0.6)
        self.assertEqual(len(self.h.helper.requests), count)

    def test_message_already_there_before_the_arm_does_not_wake(self):
        self.h.imap.add(headers(OWNER))
        self.arm()
        time.sleep(0.8)
        self.assertEqual(self.h.helper.requests, [])

    def test_uidvalidity_change_wakes(self):
        self.arm()
        self.h.imap.uidvalidity = 9002
        self.h.imap.drop_all()
        self.assertTrue(self.h.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.h.service.watches[VMID].fired_reason, "uidvalidity")

    def test_lost_mailbox_wakes_after_watch_fail(self):
        self.arm()
        self.h.imap.down = True
        self.h.imap.drop_all()
        self.assertTrue(self.h.wait(lambda: self.h.helper.requests, timeout=10))
        self.assertEqual(self.h.service.watches[VMID].fired_reason, "watch_failed")

    def test_disarm_stops_watching_and_logs_out(self):
        self.arm()
        answer = self.h.ctl({"cmd": "disarm", "vmid": VMID, "arm_id": ARM_ID})
        self.assertEqual(answer, {"ok": True, "vmid": VMID, "was": "armed"})
        self.assertTrue(self.h.wait(lambda: "LOGOUT" in self.h.imap.commands))
        self.h.imap.add(headers(OWNER))
        time.sleep(0.6)
        self.assertEqual(self.h.helper.requests, [])
        with open(self.h.cfg.state_path) as handle:
            self.assertEqual(json.load(handle), {"armed": []})

    def test_disarm_of_an_older_arm_keeps_the_current_one(self):
        self.arm()
        answer = self.h.ctl({"cmd": "disarm", "vmid": VMID, "arm_id": "00000000-0000-4000-8000-000000000000"})
        self.assertEqual(answer["was"], "other_arm")
        self.assertEqual(self.h.ctl({"cmd": "status", "vmid": VMID})["state"], "armed")

    def test_rearm_replaces_the_watch(self):
        self.arm()
        self.arm()
        self.assertEqual(len(self.h.service.watches), 1)

    def test_ring_expires(self):
        self.h.cfg.fire_max = 0.5
        self.h.helper.state = "awake"
        self.arm()
        self.h.imap.add(headers(OWNER))
        self.assertTrue(self.h.wait(lambda: VMID not in self.h.service.watches))

    def test_ring_that_never_reaches_hivra_never_expires(self):
        self.h.cfg.fire_max = 0.3
        self.h.cfg.fire_slow = 0.2
        self.h.helper.refuse = "no_credential"
        self.arm()
        self.h.imap.add(headers(OWNER))
        self.assertTrue(self.h.wait(lambda: len(self.h.helper.requests) >= 5))
        self.assertIn(VMID, self.h.service.watches)
        self.assertEqual(self.h.ctl({"cmd": "status", "vmid": VMID})["state"], "fired")
        # Once Hivra answers that the computer is awake, it may stop.
        self.h.helper.refuse = None
        self.h.helper.state = "awake"
        self.assertTrue(self.h.wait(lambda: VMID not in self.h.service.watches))

    def test_restart_rings_for_every_lost_arm(self):
        self.arm()
        self.h.restart()
        self.assertTrue(self.h.wait(lambda: self.h.helper.requests))
        self.assertEqual(self.h.service.watches[VMID].fired_reason, "restart")


class PollTests(WatchTests):
    """The same rules for a server without IDLE (NOOP poll)."""
    idle = False

    def test_polls_with_noop(self):
        self.arm()
        self.assertTrue(self.h.wait(lambda: "NOOP" in self.h.imap.commands))
        self.assertNotIn("IDLE", self.h.imap.commands)


PROXY_SPEC = importlib.util.spec_from_file_location("hivra_wake_proxy_for_doorbell", HERE / "hivra-wake-proxy.py")
proxy = importlib.util.module_from_spec(PROXY_SPEC)
PROXY_SPEC.loader.exec_module(proxy)
proxy.log = lambda event, **fields: None


class HelperRoleTests(unittest.TestCase):
    """The wake helper lets the doorbell's user ask for a wake (always as "doorbell") and read health, nothing else."""

    def setUp(self):
        self.helper = proxy.Helper(proxy.Config(root_uids=(0,), forwarder_uid=5001, forwarder_user="hivra-no-such-user",
                                                doorbell_uid=5002, doorbell_user="hivra-no-such-user"))
        self.asked = []

        async def request_wake(vmid, reason):
            self.asked.append((vmid, reason))
            return {"ok": True, "vmid": vmid, "state": "waking"}
        self.helper.request_wake = request_wake

    def tearDown(self):
        self.helper.pool.shutdown(wait=False)

    def test_roles(self):
        self.assertEqual(self.helper.role(5002), "doorbell")
        self.assertEqual(self.helper.role(5001), "forwarder")
        self.assertIsNone(self.helper.role(5003))

    def test_doorbell_may_only_request_and_always_as_doorbell(self):
        answer = asyncio.run(self.helper.dispatch("doorbell", {"cmd": "request", "vmid": VMID, "from": "ctl"}))
        self.assertTrue(answer["ok"])
        self.assertEqual(self.asked, [(VMID, "doorbell")])
        for command in ("wake", "status", "drain", "undrain", "napped", "stats", "reload"):
            answer = asyncio.run(self.helper.dispatch("doorbell", {"cmd": command, "vmid": VMID}))
            self.assertEqual(answer, {"ok": False, "error": "forbidden"}, command)

    def test_doorbell_user_unknown_means_no_role(self):
        helper = proxy.Helper(proxy.Config(forwarder_user="hivra-no-such-user", doorbell_user="hivra-no-such-user"))
        try:
            self.assertIsNone(helper.role(5002))
        finally:
            helper.pool.shutdown(wait=False)


class PureTests(unittest.TestCase):
    def test_command_allowlist_refuses_mailbox_changes(self):
        imap = doorbell.Imap(doorbell.Config(), {})
        for verb in ("SELECT", "STORE", "UID STORE", "EXPUNGE", "CLOSE", "COPY", "MOVE", "APPEND", "DELETE"):
            with self.assertRaises(doorbell.ImapError) as caught:
                asyncio.run(imap.command(verb, "INBOX"))
            self.assertEqual(caught.exception.reason, "command_not_allowed")

    def test_sender_rules(self):
        allowed = frozenset([OWNER])
        self.assertTrue(doorbell.sender_wakes(headers("O <%s>" % OWNER.upper()), MAILBOX, allowed))
        self.assertFalse(doorbell.sender_wakes(headers("x <owner@example.test.evil>"), MAILBOX, allowed))
        self.assertFalse(doorbell.sender_wakes(headers(OWNER, Auto_Submitted="auto-replied"), MAILBOX, allowed))
        self.assertTrue(doorbell.sender_wakes(headers(OWNER, Auto_Submitted="no"), MAILBOX, allowed))
        self.assertTrue(doorbell.sender_wakes(headers("anyone@example.test"), MAILBOX, frozenset()))
        self.assertFalse(doorbell.sender_wakes(headers(MAILBOX), MAILBOX, frozenset()))
        self.assertFalse(doorbell.sender_wakes(b"", MAILBOX, frozenset()))

    def test_arm_request_from_guest(self):
        values = {"EMAIL_ADDRESS": MAILBOX, "EMAIL_PASSWORD": "pw-" + secrets.token_hex(4), "EMAIL_IMAP_HOST": "imap.example.test",
                  "EMAIL_ALLOWED_USERS": '["Owner@Example.test"]', "GATEWAY_ALLOWED_USERS": "b@example.test, c@example.test",
                  "EMAIL_IMAP_TLS_VERIFY": "false"}
        line = doorbell.CRED_PREFIX + json.dumps({"fp": "0123456789abcdef", "values": values})
        request, reason = doorbell.arm_request_from_guest(["noise", line], VMID, ARM_ID, "0123456789abcdef")
        self.assertIsNone(reason)
        self.assertEqual(request["imap"], {"host": "imap.example.test", "port": 993, "security": "tls", "verify": False,
                                           "user": MAILBOX, "password": values["EMAIL_PASSWORD"]})
        self.assertEqual(request["allowed"], [OWNER, "b@example.test", "c@example.test"])
        self.assertEqual(doorbell.arm_request_from_guest([line], VMID, ARM_ID, "fedcba9876543210"), (None, "credential_changed"))
        self.assertEqual(doorbell.arm_request_from_guest(["HIVRA_EMAIL_CRED_NONE no_env"], VMID, ARM_ID, "0123456789abcdef"),
                         (None, "no_env"))
        self.assertEqual(doorbell.arm_request_from_guest([line, line], VMID, ARM_ID, "0123456789abcdef"), (None, "no_answer"))

    def test_arm_from_guest_never_prints_the_password(self):
        secret_value = "pw-" + secrets.token_hex(6)
        values = {"EMAIL_ADDRESS": MAILBOX, "EMAIL_PASSWORD": secret_value, "EMAIL_IMAP_HOST": "imap.example.test"}
        line = doorbell.CRED_PREFIX + json.dumps({"fp": "0123456789abcdef", "values": values}) + "\n"
        with tempfile.TemporaryDirectory() as tmp:
            cfg = doorbell.Config(run_dir=tmp)
            stdin = mock.Mock()
            stdin.buffer = io.BytesIO(line.encode())
            out = io.StringIO()
            with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", out):
                code = doorbell.arm_from_guest_main([str(VMID), ARM_ID, "0123456789abcdef"], cfg)
        self.assertEqual(code, 2)
        self.assertNotIn(secret_value, out.getvalue())
        self.assertEqual(out.getvalue(), doorbell.ARM_PREFIX + '{"error":"doorbell_unreachable","ok":false,"vmid":1234}\n')

    def test_no_nul_bytes_and_no_forbidden_verbs_in_source(self):
        text = SCRIPT.read_bytes()
        self.assertNotIn(b"\x00", text)
        for verb in (b'"SELECT"', b'"STORE"', b'"EXPUNGE"'):
            self.assertNotIn(verb, text)


if __name__ == "__main__":
    unittest.main()
