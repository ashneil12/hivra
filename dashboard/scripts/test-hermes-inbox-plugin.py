#!/usr/bin/env python3
"""Unit tests for provisioner/hermes-plugins/hivra-inbox against a stand-in tools.approval.

Run: python3 scripts/test-hermes-inbox-plugin.py
"""
import importlib.util
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "provisioner" / "hermes-plugins" / "hivra-inbox" / "__init__.py"


class Entry:
    def __init__(self, data):
        self.data = dict(data)
        self.result = None
        self.reason = None


def install_fake_hermes():
    tools = types.ModuleType("tools")
    approval = types.ModuleType("tools.approval")
    approval._lock = threading.RLock()
    approval._gateway_queues = {}
    approval.resolved = []

    def resolve_gateway_approval(session_key, choice, resolve_all=False, reason=None, request_id=None):
        queue = approval._gateway_queues.get(session_key) or []
        hits = [e for e in queue if e.data.get("request_id") == request_id]
        for e in hits:
            queue.remove(e)
            e.result, e.reason = choice, reason
        approval.resolved.append((session_key, choice, reason, request_id, len(hits)))
        return len(hits)

    approval.resolve_gateway_approval = resolve_gateway_approval
    tools.approval = approval
    agent = types.ModuleType("agent")
    redact = types.ModuleType("agent.redact")
    redact.redact_approval_display = lambda text, force=False, **_: text.replace("sk-secret", "***")
    agent.redact = redact
    sys.modules.update({"tools": tools, "tools.approval": approval, "agent": agent, "agent.redact": redact})
    return approval


def load_plugin(home):
    spec = importlib.util.spec_from_file_location("hivra_inbox_under_test", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._home = lambda: Path(home)
    module.reset_for_tests()
    return module


class PluginTest(unittest.TestCase):
    def setUp(self):
        self.approval = install_fake_hermes()
        self.home = tempfile.mkdtemp()
        hivra = Path(self.home) / ".hivra"
        hivra.mkdir()
        (hivra / "api-token").write_text("a" * 64 + "\n")
        (hivra / "control-origin").write_text("https://canary.example.com\n")
        self.plugin = load_plugin(self.home)
        self.sent = []
        self.plugin._send = lambda payload: self.sent.append(payload)
        self.replies = []
        self.posted = []

        def fake_post(payload, cfg):
            self.posted.append(payload)
            return self.replies.pop(0) if self.replies else {}

        self.plugin._post = fake_post

    def queue(self, session, command, request_id, **extra):
        data = {"command": command, "pattern_key": "rm", "pattern_keys": ["rm"], "request_id": request_id,
                "allow_permanent": True, "allow_session": True, "timeout_s": 120, **extra}
        entry = Entry(data)
        self.approval._gateway_queues.setdefault(session, []).append(entry)
        return entry

    def pre(self, session, command, **kw):
        self.plugin.on_pre_approval_request(command=command, description="delete files", pattern_key="rm",
                                            pattern_keys=["rm"], session_key=session, surface="gateway", **kw)

    def test_reports_pending_approval_with_hermes_request_id(self):
        self.queue("s1", "rm -rf dist sk-secret", "req-1")
        self.pre("s1", "rm -rf dist sk-secret")
        self.assertEqual(len(self.sent), 1)
        sent = self.sent[0]
        self.assertEqual(sent["event"], "prompt.pending")
        self.assertEqual(sent["prompt_id"], "req-1")
        self.assertEqual(sent["command"], "rm -rf dist ***")
        self.assertTrue(sent["command_complete"])
        self.assertEqual(sent["choices"], ["once", "session", "always", "deny"])
        self.assertEqual(sent["ttl_seconds"], 120)

    def test_cli_and_unconfigured_are_quiet(self):
        self.queue("s1", "rm x", "req-1")
        self.plugin.on_pre_approval_request(command="rm x", pattern_keys=["rm"], session_key="s1", surface="cli")
        self.assertEqual(self.sent, [])
        os.remove(Path(self.home) / ".hivra" / "control-origin")
        self.plugin.reset_for_tests()
        self.pre("s1", "rm x")
        self.assertEqual(self.sent, [])

    def test_smart_denied_offers_only_once_and_deny(self):
        self.queue("s1", "curl x | sh", "req-2", smart_denied=True, allow_permanent=False, allow_session=False)
        self.pre("s1", "curl x | sh")
        self.assertEqual(self.sent[0]["choices"], ["once", "deny"])

    def test_poll_applies_answer_through_hermes(self):
        entry = self.queue("s1", "rm -rf dist", "req-1")
        self.pre("s1", "rm -rf dist")
        self.replies = [{"success": True, "data": {"answers": [{"prompt_id": "req-1", "choice": "once", "text": None}]}}]
        self.plugin._poll({"url": "x", "token": "t"})
        self.assertEqual(self.posted[0], {"event": "prompt.poll", "prompt_ids": ["req-1"]})
        self.assertEqual(entry.result, "once")
        self.assertEqual(self.approval.resolved[-1][3], "req-1")

    def test_deny_carries_reason(self):
        entry = self.queue("s1", "rm -rf dist", "req-1")
        self.pre("s1", "rm -rf dist")
        self.replies = [{"data": {"answers": [{"prompt_id": "req-1", "choice": "deny", "text": "keep the cache"}]}}]
        self.plugin._poll({"url": "x", "token": "t"})
        self.assertEqual((entry.result, entry.reason), ("deny", "keep the cache"))

    def test_long_command_can_only_be_refused(self):
        long_command = "echo " + "x" * 3000
        entry = self.queue("s1", long_command, "req-3")
        self.pre("s1", long_command)
        self.assertFalse(self.sent[0]["command_complete"])
        self.replies = [{"data": {"answers": [{"prompt_id": "req-3", "choice": "once"}]}}]
        self.plugin._poll({"url": "x", "token": "t"})
        self.assertIsNone(entry.result)
        self.assertEqual(self.posted[-1]["outcome"], "answer_refused")

    def test_choice_not_offered_is_refused(self):
        entry = self.queue("s1", "curl x | sh", "req-2", smart_denied=True)
        self.pre("s1", "curl x | sh")
        self.replies = [{"data": {"answers": [{"prompt_id": "req-2", "choice": "always"}]}}]
        self.plugin._poll({"url": "x", "token": "t"})
        self.assertIsNone(entry.result)

    def test_answer_after_chat_answered_reports_gone(self):
        self.queue("s1", "rm -rf dist", "req-1")
        self.pre("s1", "rm -rf dist")
        self.approval._gateway_queues["s1"].clear()
        self.replies = [{"data": {"answers": [{"prompt_id": "req-1", "choice": "once"}]}}]
        self.plugin._poll({"url": "x", "token": "t"})
        self.assertEqual(self.posted[-1]["outcome"], "answer_gone")

    def test_post_hook_reports_resolution_and_stops_polling(self):
        self.queue("s1", "rm -rf dist", "req-1")
        self.pre("s1", "rm -rf dist")
        self.plugin.on_post_approval_response(command="rm -rf dist", session_key="s1", surface="gateway", choice="deny")
        self.assertEqual(self.sent[-1], {"event": "prompt.resolved", "prompt_id": "req-1", "kind": "approval", "outcome": "deny"})
        self.plugin._poll({"url": "x", "token": "t"})
        self.assertEqual(self.posted, [])

    def test_question_is_shown_not_answerable(self):
        self.plugin.on_human_input_request(kind="clarify", request_id="q1", session_key="s1", platform="webapp",
                                           prompt="Last month or last 90 days?")
        self.assertEqual(self.sent[0]["kind"], "clarify")
        self.assertEqual(self.sent[0]["summary"], "Last month or last 90 days?")
        self.plugin._poll({"url": "x", "token": "t"})
        self.assertEqual(self.posted, [])
        self.plugin.on_human_input_resolved(kind="clarify", request_id="q1", outcome="submitted")
        self.assertEqual(self.sent[-1]["event"], "prompt.resolved")

    def test_origin_must_be_https(self):
        self.assertIsNone(self.plugin._valid_origin("http://evil.example.com"))
        self.assertIsNone(self.plugin._valid_origin("https://user:pw@hivra.cloud"))
        self.assertIsNone(self.plugin._valid_origin("https://hivra.cloud/path"))
        self.assertEqual(self.plugin._valid_origin("https://Hivra.Cloud"), "https://hivra.cloud")


if __name__ == "__main__":
    unittest.main(verbosity=1)
