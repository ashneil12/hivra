#!/usr/bin/env python3
"""Unit tests for provisioner/agent-addons/hivra-ask-claude/hivra-ask-hook.py.

Run: python3 scripts/test-hivra-ask-hook.py
"""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "provisioner" / "agent-addons" / "hivra-ask-claude" / "hivra-ask-hook.py"
TOKEN = "a" * 64


def load():
    spec = importlib.util.spec_from_file_location("hivra_ask_hook", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        (base / "home" / ".hivra").mkdir(parents=True)
        (base / "home" / ".hivra" / "api-token").write_text(TOKEN)
        (base / "origin").write_text("https://canary.example.com")
        (base / "mode").write_text("on\n")
        self.hook = load()
        self.hook.HOME = base / "home"
        self.hook.ORIGIN_FILE = base / "origin"
        self.hook.MODE_FILE = base / "mode"
        self.hook.time.sleep = lambda _s: None
        self.sent = []
        self.replies = []

        def fake_post(url, token, payload):
            self.sent.append((url, token, payload))
            return self.replies.pop(0) if self.replies else {"recorded": True}

        self.hook.post = fake_post

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, event):
        out = io.StringIO()
        sys.stdin = io.StringIO(json.dumps(event))
        try:
            with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
                self.hook.main()
        finally:
            sys.stdin = sys.__stdin__
        text = out.getvalue().strip()
        return json.loads(text)["hookSpecificOutput"] if text else None

    def event(self, **extra):
        base = {"permission_mode": "bypassPermissions", "tool_name": "Bash", "tool_use_id": "toolu_1",
                "session_id": "sess-1", "tool_input": {"command": "rm -rf ~/test-delete", "description": "Delete the test folder"}}
        base.update(extra)
        return base

    def test_off_does_nothing(self):
        self.hook.MODE_FILE.write_text("off\n")
        self.assertIsNone(self.run_hook(self.event()))
        self.assertEqual(self.sent, [])

    def test_terminal_sessions_are_left_to_claude_code(self):
        self.assertIsNone(self.run_hook(self.event(permission_mode="default")))
        self.assertIsNone(self.run_hook(self.event(tool_name="Read")))
        self.assertEqual(self.sent, [])

    def test_allow_once(self):
        self.replies = [{"recorded": True}, {"answers": []}, {"answers": [{"prompt_id": "toolu_1", "choice": "once"}]}]
        out = self.run_hook(self.event())
        self.assertEqual(out["permissionDecision"], "allow")
        pending = self.sent[0][2]
        self.assertEqual(self.sent[0][0], "https://canary.example.com/api/internal/agent-prompts")
        self.assertEqual(self.sent[0][1], TOKEN)
        self.assertEqual(pending["event"], "prompt.pending")
        self.assertEqual(pending["tool"], "Bash")
        self.assertEqual(pending["choices"], ["once", "session", "deny"])
        self.assertEqual(pending["command"], "rm -rf ~/test-delete")
        self.assertTrue(pending["command_complete"])
        self.assertEqual(self.sent[-1][2]["event"], "prompt.resolved")

    def test_deny_passes_the_reason(self):
        self.replies = [{"recorded": True}, {"answers": [{"prompt_id": "toolu_1", "choice": "deny", "text": "use the trash"}]}]
        out = self.run_hook(self.event())
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("use the trash", out["permissionDecisionReason"])

    def test_allowed_for_this_chat_answers_at_once(self):
        self.replies = [{"recorded": True, "answer": {"choice": "session"}}]
        out = self.run_hook(self.event())
        self.assertEqual(out["permissionDecision"], "allow")
        self.assertEqual(len(self.sent), 1)

    def test_unreachable_or_unanswered_means_no(self):
        self.replies = [None]
        self.assertEqual(self.run_hook(self.event())["permissionDecision"], "deny")
        self.sent.clear()
        self.hook.WAIT_S = 0
        self.assertEqual(self.run_hook(self.event())["permissionDecision"], "deny")
        self.assertEqual(self.sent[-1][2]["outcome"], "timeout")

    def test_bad_origin_means_no(self):
        self.hook.ORIGIN_FILE.write_text("http://evil.example.com")
        self.assertEqual(self.run_hook(self.event())["permissionDecision"], "deny")
        self.assertEqual(self.sent, [])

    def test_long_command_cannot_be_allowed(self):
        self.replies = [{"recorded": True}, {"answers": [{"prompt_id": "toolu_1", "choice": "once"}]}]
        out = self.run_hook(self.event(tool_input={"command": "echo " + "x" * 3000}))
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertFalse(self.sent[0][2]["command_complete"])

    def test_file_changes_show_the_path(self):
        self.replies = [{"recorded": True, "answer": {"choice": "session"}}]
        self.run_hook(self.event(tool_name="Write", tool_input={"file_path": "/home/bux/a.txt", "content": "secret"}))
        self.assertEqual(self.sent[0][2]["command"], "Write /home/bux/a.txt")

    def test_redacts_secrets(self):
        text = self.hook.redact("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' TOKEN=hunter2 ghp_abcdefghijklmnopqrstu " + "f" * 40)
        for secret in ("abcdefghijklmnopqrstuvwxyz", "hunter2", "ghp_abcdefghijklmnopqrstu", "f" * 40):
            self.assertNotIn(secret, text)


if __name__ == "__main__":
    unittest.main()
