"""Unit tests for hivra_bridge (standard library only): python3 -m unittest -v"""

import base64
import hashlib
import hmac
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest

import hivra_bridge as hb
import hivra_connector as hc
from test_hivra_connector import CONNECTION, MASTER, SECRET, connected_pair

# The bridge key is random, made by the control plane at enroll; it is NOT derived from the relay secret.
BRIDGE_KEY = "9f" * 32
RELAY_DERIVED_KEYS = [
    hmac.new(MASTER.encode(), label.encode(), hashlib.sha256).hexdigest()
    for label in ("bridge-ticket|v1|%s" % CONNECTION, "client-ticket|v1", "admin|v1", "connector|%s|1" % CONNECTION)
]
ARGV_HASH_VECTOR = hashlib.sha256(b"uname\0-s").hexdigest()
OWNER = "user_owner"
AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def b64url(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def make_ticket(argv, cwd=None, key=BRIDGE_KEY, now=None, ttl=60, jti=None, timeout=30, cap=262144, **overrides):
    now = int(now if now is not None else time.time())
    claims = {"v": 1, "aud": CONNECTION, "owner": OWNER, "agent": AGENT, "computer": CONNECTION,
              "argv": hb.argv_hash(argv), "cwd": cwd or "", "timeoutSeconds": timeout, "maxOutputBytes": cap, "jti": jti or b64url(os.urandom(18)), "iat": now, "exp": now + ttl}
    claims.update(overrides)
    body = b64url(json.dumps(claims).encode())
    return "%s.%s" % (body, b64url(hmac.new(key.encode(), body.encode(), hashlib.sha256).digest()))


class BridgeCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = os.path.realpath(self.dir.name)
        self.work = os.path.join(self.root, "work")
        self.other = os.path.join(self.root, "other")
        os.mkdir(self.work)
        os.mkdir(self.other)
        self.config = {
            "relay": "wss://relay.example.test", "connectionId": CONNECTION, "generation": 1, "secret": SECRET,
            "bridgeKey": BRIDGE_KEY, "ownerId": OWNER, "computerId": CONNECTION,
            "allowedFolders": [self.work], "logPath": os.path.join(self.root, "log.jsonl"),
        }
        self.bridge = hb.Bridge(self.config)

    def exec(self, argv, cwd=None, ticket=None, **extra):
        request = {"argv": argv, **({"cwd": cwd} if cwd else {}), **extra}
        message = {"type": "exec", "id": "req1", "ticket": ticket or make_ticket(argv, cwd, timeout=extra.get("timeoutSeconds", 30), cap=extra.get("maxOutputBytes", 262144)), "request": request}
        return self.bridge.handle_exec(message)

    def log_lines(self):
        with open(self.config["logPath"]) as handle:
            return [json.loads(line) for line in handle]


class ExecTests(BridgeCase):
    def test_uname_runs_without_a_shell_and_is_logged(self):
        reply = self.exec(["uname", "-s"])
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["stdout"].strip(), os.uname().sysname)
        self.assertEqual(reply["exitCode"], 0)
        self.assertFalse(reply["truncated"])
        entry = self.log_lines()[-1]
        self.assertEqual((entry["decision"], entry["exitCode"], entry["agent"], entry["argv"]), ("approved", 0, AGENT, ["uname", "-s"]))
        self.assertEqual(entry["computer"], CONNECTION)

    def test_shell_metacharacters_are_plain_arguments(self):
        reply = self.exec(["echo", "a; touch pwned && $(id)"])
        self.assertEqual(reply["stdout"], "a; touch pwned && $(id)\n")
        self.assertFalse(os.path.exists(os.path.join(self.work, "pwned")))

    def test_a_missing_program_is_127(self):
        self.assertEqual(self.exec(["definitely-not-a-program-xyz"])["exitCode"], 127)

    def test_nonzero_exit_and_stderr_come_back(self):
        reply = self.exec(["sh", "-c", "echo oops >&2; exit 7"])
        self.assertEqual((reply["exitCode"], reply["stderr"].strip()), (7, "oops"))

    def test_runs_in_the_first_allowed_folder_when_cwd_is_omitted(self):
        self.assertEqual(self.exec(["pwd"])["stdout"].strip(), self.work)

    def test_has_no_stdin(self):
        self.assertEqual(self.exec(["cat"])["stdout"], "")

    def test_timeout_kills_the_command(self):
        started = time.monotonic()
        reply = self.exec(["sleep", "30"], timeoutSeconds=1)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(reply["exitCode"], 124)

    def test_output_is_capped_and_marked_truncated(self):
        reply = self.exec(["head", "-c", "100000", "/dev/zero"], maxOutputBytes=1000)
        self.assertTrue(reply["truncated"])
        self.assertLessEqual(len(reply["stdout"]) + len(reply["stderr"]), 1000)

    def test_limits_are_enforced(self):
        for extra in ({"timeoutSeconds": 121}, {"timeoutSeconds": 0}, {"maxOutputBytes": 1024 * 1024 + 1}, {"maxOutputBytes": 0}):
            self.assertEqual(self.exec(["true"], **extra)["error"], "invalid_request", extra)

    def test_bad_argv_is_refused(self):
        for argv in ("uname -s", [], [""], ["a", 3], ["a\0b"], ["x"] * 65):
            message = {"type": "exec", "id": "r", "ticket": "x.y", "request": {"argv": argv}}
            self.assertEqual(self.bridge.handle_exec(message)["error"], "invalid_request")

    @staticmethod
    def alive(pid):
        try:
            with open("/proc/%d/stat" % pid) as handle:
                return handle.read().rsplit(")", 1)[1].split()[0] != "Z"
        except (OSError, IndexError):
            return False

    def test_a_backgrounded_child_cannot_hold_the_reply_or_survive(self):
        started = time.monotonic()
        reply = self.exec(["sh", "-c", "sleep 20 & echo $!; echo hi"], timeoutSeconds=3)
        self.assertLess(time.monotonic() - started, 3.5)
        pid = int(reply["stdout"].split()[0])
        self.assertEqual((reply["exitCode"], reply["stdout"].split()[1]), (0, "hi"))
        time.sleep(0.3)
        if os.path.isdir("/proc"):
            self.assertFalse(self.alive(pid), "the background process should have been killed with its group")
        # The bridge is not wedged: the next command runs at once.
        self.assertTrue(self.exec(["true"])["ok"])

    def test_a_background_child_that_keeps_writing_is_stopped_at_the_wall_clock(self):
        started = time.monotonic()
        reply = self.exec(["sh", "-c", "yes > /dev/null & while true; do echo x; sleep 0.05; done"], timeoutSeconds=2)
        self.assertLess(time.monotonic() - started, 3.5)
        self.assertEqual(reply["exitCode"], 124)

    def test_lone_surrogates_are_refused_without_crashing(self):
        for request in ({"argv": ["echo", "\ud800"]}, {"argv": ["echo"], "cwd": "/tmp/\udfff"}):
            message = {"type": "exec", "id": "r", "ticket": "x.y", "request": request}
            self.assertEqual(self.bridge.handle_exec(message)["error"], "invalid_request")
        self.assertEqual(self.log_lines()[-1]["decision"], "denied")

    def test_a_ticket_for_other_limits_is_refused(self):
        argv = ["true"]
        message = {"type": "exec", "id": "r", "ticket": make_ticket(argv, timeout=5), "request": {"argv": argv, "timeoutSeconds": 120}}
        self.assertEqual(self.bridge.handle_exec(message)["error"], "ticket_argv_mismatch")
        message = {"type": "exec", "id": "r", "ticket": make_ticket(argv, cap=10), "request": {"argv": argv}}
        self.assertEqual(self.bridge.handle_exec(message)["error"], "ticket_argv_mismatch")

    def test_a_ticket_from_before_this_bridge_started_is_refused(self):
        argv = ["true"]
        old = make_ticket(argv, now=time.time() - 30, ttl=60)
        self.assertEqual(self.bridge.handle_exec({"type": "exec", "id": "r", "ticket": old, "request": {"argv": argv}})["error"], "ticket_invalid")

    def test_stop_running_kills_the_group(self):
        process = subprocess.Popen(["sh", "-c", "sleep 30 & wait"], start_new_session=True)
        self.bridge.current = process
        self.bridge.stop_running()
        process.wait(timeout=5)

    def test_only_one_command_at_a_time(self):
        self.assertTrue(self.bridge.running.acquire(blocking=False))
        try:
            self.assertEqual(self.exec(["true"])["error"], "busy")
        finally:
            self.bridge.running.release()


class CwdTests(BridgeCase):
    def test_inside_the_allowed_folder_is_fine(self):
        sub = os.path.join(self.work, "sub")
        os.mkdir(sub)
        self.assertEqual(self.exec(["pwd"], cwd=sub)["stdout"].strip(), sub)

    def test_outside_is_refused_and_logged_denied(self):
        self.assertEqual(self.exec(["pwd"], cwd=self.other)["error"], "cwd_not_allowed")
        self.assertEqual(self.log_lines()[-1]["decision"], "denied")

    def test_dotdot_and_relative_paths_are_refused(self):
        self.assertEqual(self.exec(["pwd"], cwd=self.work + "/../other")["error"], "cwd_not_allowed")
        self.assertEqual(self.exec(["pwd"], cwd="work")["error"], "cwd_not_allowed")

    def test_a_symlink_cannot_lead_out(self):
        link = os.path.join(self.work, "escape")
        os.symlink(self.other, link)
        self.assertEqual(self.exec(["pwd"], cwd=link)["error"], "cwd_not_allowed")

    def test_a_sibling_with_the_same_prefix_is_refused(self):
        sibling = self.work + "-evil"
        os.mkdir(sibling)
        self.assertEqual(self.exec(["pwd"], cwd=sibling)["error"], "cwd_not_allowed")


class TicketTests(BridgeCase):
    def verify(self, ticket, argv=("uname", "-s"), cwd=None):
        return self.bridge.verifier.verify(ticket, {"argv": list(argv), "cwd": cwd, "timeoutSeconds": 30, "maxOutputBytes": 262144})

    def assertRefused(self, code, ticket, **kwargs):
        with self.assertRaises(hb.BridgeError) as raised:
            self.verify(ticket, **kwargs)
        self.assertEqual(raised.exception.code, code)

    def test_a_good_ticket_names_its_agent(self):
        self.assertEqual(self.verify(make_ticket(["uname", "-s"]))["agent"], AGENT)

    def test_expired(self):
        self.assertRefused("ticket_expired", make_ticket(["uname", "-s"], now=time.time() - 200, ttl=60))

    def test_too_long_lived(self):
        self.assertRefused("ticket_invalid", make_ticket(["uname", "-s"], ttl=600))

    def test_replay(self):
        ticket = make_ticket(["uname", "-s"])
        self.verify(ticket)
        self.assertRefused("ticket_replayed", ticket)

    def test_replay_through_exec(self):
        ticket = make_ticket(["true"])
        self.assertTrue(self.exec(["true"], ticket=ticket)["ok"])
        self.assertEqual(self.exec(["true"], ticket=ticket)["error"], "ticket_replayed")

    def test_argv_mismatch(self):
        self.assertRefused("ticket_argv_mismatch", make_ticket(["uname", "-s"]), argv=["rm", "-rf", "x"])
        self.assertRefused("ticket_argv_mismatch", make_ticket(["uname", "-s"]), argv=["uname", "-s", "-a"])

    def test_cwd_mismatch(self):
        self.assertRefused("ticket_argv_mismatch", make_ticket(["uname"], cwd=self.work), argv=["uname"], cwd=self.other)

    def test_wrong_key(self):
        self.assertRefused("ticket_invalid", make_ticket(["uname", "-s"], key="0" * 64))

    def test_a_ticket_signed_with_a_relay_derived_key_is_rejected(self):
        for key in RELAY_DERIVED_KEYS + [SECRET]:
            self.assertRefused("ticket_invalid", make_ticket(["uname", "-s"], key=key))
        marker = os.path.join(self.work, "ran")
        reply = self.exec(["touch", marker], ticket=make_ticket(["touch", marker], key=RELAY_DERIVED_KEYS[0]))
        self.assertEqual(reply["error"], "ticket_invalid")
        self.assertFalse(os.path.exists(marker))

    def test_tampered_or_garbage(self):
        _, signature = make_ticket(["uname", "-s"]).split(".")
        forged = b64url(json.dumps({"v": 1, "agent": "x"}).encode())
        self.assertRefused("ticket_invalid", "%s.%s" % (forged, signature))
        self.assertRefused("ticket_invalid", "garbage")
        self.assertRefused("ticket_invalid", None)

    def test_wrong_owner_computer_or_audience(self):
        other = "22222222-2222-4222-8222-222222222222"
        self.assertRefused("ticket_wrong_owner", make_ticket(["uname", "-s"], owner="user_other"))
        self.assertRefused("ticket_wrong_computer", make_ticket(["uname", "-s"], computer=other))
        self.assertRefused("ticket_wrong_computer", make_ticket(["uname", "-s"], aud=other))

    def test_exec_without_a_valid_ticket_runs_nothing(self):
        marker = os.path.join(self.work, "ran")
        reply = self.exec(["touch", marker], ticket="x.y")
        self.assertFalse(reply["ok"])
        self.assertFalse(os.path.exists(marker))
        self.assertEqual(self.log_lines()[-1]["decision"], "denied")

    def test_argv_hash_is_nul_joined_sha256(self):
        self.assertEqual(hb.argv_hash(["uname", "-s"]), ARGV_HASH_VECTOR)


class ConfigTests(unittest.TestCase):
    def write(self, mode=0o600, **overrides):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        folder = os.path.join(tmp.name, "allowed")
        os.mkdir(folder)
        config = {"relay": "wss://relay.example.test", "connectionId": CONNECTION, "generation": 1, "secret": SECRET,
                  "bridgeKey": BRIDGE_KEY, "ownerId": OWNER, "computerId": CONNECTION, "allowedFolders": [folder]}
        config.update(overrides)
        path = os.path.join(tmp.name, "config.json")
        with open(path, "w") as handle:
            json.dump(config, handle)
        os.chmod(path, mode)
        return path

    def test_loads_a_valid_config(self):
        config = hb.load_bridge_config(self.write())
        self.assertEqual(config["ownerId"], OWNER)
        self.assertTrue(config["logPath"].endswith("log.jsonl"))

    def test_folders_are_required_and_home_is_not_allowed(self):
        for folders in ([], None, [os.path.expanduser("~")], ["/"], ["relative/dir"]):
            with self.assertRaises(hc.ConnectorError, msg=str(folders)):
                hb.load_bridge_config(self.write(allowedFolders=folders))

    def test_parents_of_home_and_secret_folders_are_refused(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        real_home = os.path.realpath(home.name)
        for name in (".ssh", ".gnupg", os.path.join("Library", "Keychains"), os.path.join(".ssh", "sub")):
            os.makedirs(os.path.join(real_home, name), exist_ok=True)
        os.makedirs(os.path.join(real_home, "projects"), exist_ok=True)
        old = os.environ.get("HOME")
        os.environ["HOME"] = real_home
        try:
            for folder in (os.path.dirname(real_home), os.path.join(real_home, ".ssh"), os.path.join(real_home, ".ssh", "sub"),
                           os.path.join(real_home, ".gnupg"), os.path.join(real_home, "Library", "Keychains")):
                with self.assertRaises(hc.ConnectorError, msg=folder):
                    hb.load_bridge_config(self.write(allowedFolders=[folder]))
            hb.load_bridge_config(self.write(allowedFolders=[os.path.join(real_home, "projects")]))
        finally:
            if old is None:
                del os.environ["HOME"]
            else:
                os.environ["HOME"] = old

    def test_a_config_others_can_read_is_refused(self):
        with self.assertRaises(hc.ConnectorError):
            hb.load_bridge_config(self.write(mode=0o644))

    def test_computer_id_must_match_the_connection(self):
        with self.assertRaises(hc.ConnectorError):
            hb.load_bridge_config(self.write(computerId="22222222-2222-4222-8222-222222222222"))


class ControlSocketTests(BridgeCase):
    def test_revoked_exits_with_status_3(self):
        client, server, _ = connected_pair()
        server.send_frame(0x1, json.dumps({"type": "closing", "reason": "revoked"}).encode())
        original = hc.WebSocket
        hc.WebSocket = lambda *args, **kwargs: client
        try:
            self.assertEqual(self.bridge.run(), hb.EXIT_REVOKED)
        finally:
            hc.WebSocket = original

    def test_an_exec_over_the_socket_gets_a_reply(self):
        client, server, _ = connected_pair()
        ticket = make_ticket(["uname", "-s"])
        server.send_frame(0x1, json.dumps({"type": "exec", "id": "abc", "ticket": ticket, "request": {"argv": ["uname", "-s"]}}).encode())
        result = {}
        original = hc.WebSocket
        hc.WebSocket = lambda *args, **kwargs: client
        runner = threading.Thread(target=lambda: result.update(outcome=self.bridge.control_session()))
        runner.start()
        try:
            while True:
                opcode, payload = server.read_frame()
                if opcode == 0x1 and b"exec_result" in payload:
                    break
            reply = json.loads(payload)
            self.assertEqual((reply["id"], reply["ok"], reply["exitCode"]), ("abc", True, 0))
            self.assertEqual(reply["stdout"].strip(), os.uname().sysname)
            server.send_frame(0x1, json.dumps({"type": "closing", "reason": "revoked"}).encode())
            runner.join(5)
            self.assertEqual(result["outcome"], "revoked")
        finally:
            hc.WebSocket = original

    def test_revoke_stops_a_running_command(self):
        process = subprocess.Popen(["sleep", "30"], start_new_session=True)
        self.bridge.current = process
        self.bridge.stop_running()
        self.assertIsNotNone(process.wait(timeout=5))


if __name__ == "__main__":
    unittest.main()
