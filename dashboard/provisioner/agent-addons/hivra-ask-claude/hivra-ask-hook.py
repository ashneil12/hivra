#!/usr/bin/env python3
"""Hivra "Ask me first" for Claude Code: a PreToolUse hook.

Installed by Hivra as root at /opt/hivra/ask/hivra-ask-hook.py and listed in
/etc/claude-code/managed-settings.json. It only acts when:

  * the owner turned "Ask me first" on in Manage (/etc/hivra/ask-first is "on"), and
  * Claude Code is running without its own permission prompts (bypassPermissions),
    which is how Hivra's chat runs it. In a terminal session Claude Code asks
    on its own, so this hook stays out of the way.

Then, before a shell command or a file change, it shows the request in the
owner's Hivra "Needs you" list and waits for the answer (up to WAIT_S). No answer
means no: Claude Code is told the owner didn't allow it.

Standard library only.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MODE_FILE = Path("/etc/hivra/ask-first")
ORIGIN_FILE = Path("/etc/hivra/control-origin")  # root-owned, so the agent cannot point it elsewhere
HOME = Path("/home/bux")
ENDPOINT_PATH = "/api/internal/agent-prompts"
WAIT_S = 540          # stays under the hook timeout Hivra sets (600 s)
POLL_S = 2.0
TIMEOUT_S = 5.0
COMMAND_MAX = 2000
TOOLS = {"Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"}

_SECRET_PATTERNS = [
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{16,}"), r"\1 ***"),
    (re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)\S+"), r"\1\2***"),
    (re.compile(r"\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|glpat|hf)[-_][A-Za-z0-9_\-]{12,}"), "***"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "***"),
    (re.compile(r"\b[A-Fa-f0-9]{40,}\b"), "***"),
]


def redact(text: str) -> str:
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def read_small(path: Path, limit: int = 512) -> str:
    try:
        with path.open("rb") as handle:
            return handle.read(limit).decode("utf-8", "replace").strip()
    except OSError:
        return ""


def valid_origin(value: str):
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return None
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return None
    return f"https://{parsed.netloc.lower()}"


def describe(tool: str, tool_input: dict) -> tuple[str, str]:
    """(summary, command) shown in Needs you."""
    if tool == "Bash":
        command = str(tool_input.get("command") or "")
        summary = str(tool_input.get("description") or "").strip() or "Claude Code wants to run a command."
        return summary, command
    path = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "a file")
    if tool == "Write":
        return "Claude Code wants to write a file.", f"Write {path}"
    if tool == "NotebookEdit":
        return "Claude Code wants to change a notebook.", f"Edit {path}"
    return "Claude Code wants to change a file.", f"Edit {path}"


def post(url: str, token: str, payload: dict):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                 "User-Agent": "hivra-ask-claude/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            if 200 <= response.status < 300:
                body = json.loads(response.read(65536) or b"{}")
                return body.get("data", body) if isinstance(body, dict) else None
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return None


def decide(decision: str, reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": reason}}))
    sys.exit(0)


def main() -> None:
    try:
        event = json.loads(sys.stdin.read(1_000_000) or "{}")
    except ValueError:
        sys.exit(0)
    if read_small(MODE_FILE, 16) != "on":
        sys.exit(0)
    if event.get("permission_mode") != "bypassPermissions":
        sys.exit(0)  # Claude Code asks on its own here
    tool = str(event.get("tool_name") or "")
    if tool not in TOOLS:
        sys.exit(0)
    token = read_small(HOME / ".hivra" / "api-token", 128)
    origin = valid_origin(read_small(ORIGIN_FILE, 300))
    if not re.fullmatch(r"[0-9a-f]{64}", token) or not origin:
        decide("deny", "Hivra could not reach the owner to ask, so this was not allowed. "
                       "Ask the owner to try again or turn off Ask me first.")
    url = origin + ENDPOINT_PATH
    summary, command = describe(tool, event.get("tool_input") or {})
    command = redact(command)
    complete = len(command) <= COMMAND_MAX
    prompt_id = re.sub(r"[^A-Za-z0-9_.:-]", "", str(event.get("tool_use_id") or ""))[:120] or f"cc-{int(time.time() * 1000)}"
    session_id = re.sub(r"[^A-Za-z0-9_.:-]", "", str(event.get("session_id") or ""))[:200]
    sent = post(url, token, {
        "event": "prompt.pending", "prompt_id": prompt_id, "kind": "approval", "tool": tool,
        "summary": summary[:500], "command": command[:COMMAND_MAX], "command_complete": complete,
        "choices": ["once", "session", "deny"], "session_id": session_id, "ttl_seconds": WAIT_S,
    })
    if sent is None:
        decide("deny", "Hivra could not reach the owner to ask, so this was not allowed.")
    auto = sent.get("answer") if isinstance(sent, dict) else None
    if isinstance(auto, dict) and auto.get("choice") in ("once", "session"):
        decide("allow", "The owner already allowed this for this chat in Hivra.")

    deadline = time.monotonic() + WAIT_S
    while time.monotonic() < deadline:
        time.sleep(POLL_S)
        reply = post(url, token, {"event": "prompt.poll", "prompt_ids": [prompt_id]})
        answers = reply.get("answers") if isinstance(reply, dict) else None
        answer = next((a for a in answers or [] if isinstance(a, dict) and a.get("prompt_id") == prompt_id), None)
        if not answer:
            continue
        choice = answer.get("choice")
        if choice in ("once", "session") and complete:
            post(url, token, {"event": "prompt.resolved", "prompt_id": prompt_id, "kind": "approval", "outcome": choice})
            decide("allow", "The owner allowed this in Hivra.")
        reason = str(answer.get("text") or "").strip()
        post(url, token, {"event": "prompt.resolved", "prompt_id": prompt_id, "kind": "approval", "outcome": "deny"})
        decide("deny", "The owner did not allow this in Hivra." + (f' Their reason: "{reason[:500]}"' if reason else ""))
    post(url, token, {"event": "prompt.resolved", "prompt_id": prompt_id, "kind": "approval", "outcome": "timeout"})
    decide("deny", "The owner did not answer in time, so this was not allowed. Ask them before trying again.")


if __name__ == "__main__":
    main()
