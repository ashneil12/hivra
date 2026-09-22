#!/usr/bin/env python3
"""Report structural agent-run events from native Codex and Claude Code transcripts.

Contract: docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md

The transcripts stay in the guest. This process never serializes prompts,
replies, commands, tool inputs or tool outputs: it reads an allowlist of
envelope fields (record types, identifiers, tool names, status enums and
timestamps) and builds new OTLP/JSON log records from them.

  run                       (default) the service loop
  install --source-dir DIR  idempotent installer; one credential document on stdin
  scan --home DIR           parse local transcripts, send nothing, print aggregate counts only

Stdlib only; runs on the guest's Python 3.10 and on Python 3.9 for tests.
"""
from __future__ import annotations

import argparse
import collections
import copy
import datetime
import hashlib
import http.client
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

SERVICE_NAME = "hivra-agent-trace"
UNIT_NAME = "hivra-agent-trace.service"
SCRIPT_NAME = "hivra-agent-trace.py"
SCRIPT_PATH = "/opt/hivra/agent-trace/hivra-agent-trace.py"
UNIT_PATH = "/etc/systemd/system/hivra-agent-trace.service"
STATE_DIR = "/var/lib/hivra-agent-trace"
CREDENTIAL_PATH = STATE_DIR + "/credential.json"
STATE_PATH = STATE_DIR + "/state.json"
DEFAULT_HOME = "/home/bux"
SYSTEMCTL = "/usr/bin/systemctl"
INGEST_PATH = "/api/activity/ingest"
RENEW_PATH = "/api/activity/collector/renew"
CREDENTIAL_KEYS = frozenset({"endpoint", "resourceId", "token", "expiresAt"})

MAX_LINE = 8 * 1024 * 1024        # longer lines are skipped without parsing the body
ENVELOPE = 8 * 1024               # bounded prefix inspected on a skipped line
CODEX_HEAD = 1024                 # prefix used to pre-filter Codex records before parsing
CHUNK = 1024 * 1024
MAX_RECORDS = 400                 # log records per request (contract)
MAX_BODY = 900_000                # ingest accepts 1 MiB bodies
PASS_BYTES = 64 * 1024 * 1024     # transcript bytes read per collection pass
MAX_PASSES = 16                   # collection passes per loop while catching up
LOOP_SECONDS = 10
HEARTBEAT_SECONDS = 300
MAX_BACKOFF = 300
RENEW_BEFORE_SECONDS = 3.5 * 86400
RENEW_RETRY_SECONDS = 900
RENEW_RATE_LIMITED_SECONDS = 3600
PRUNE_SECONDS = 24 * 3600
PRUNE_INTERVAL_SECONDS = 600
QUIET_SECONDS = 30                # a Claude end is final once its file is this quiet
MAX_DURATION_MS = 604_800_000
MAX_KEY = 256                     # call/item ids are hashed, never sent; bound their size
MAX_OPEN_TOOLS = 1024             # per file
MAX_ITEM_CACHE = 256              # per file
MAX_CREDENTIAL_BYTES = 16384
MAX_SOURCE_BYTES = 1024 * 1024
MAX_STATE_BYTES = 64 * 1024 * 1024
MAX_RESPONSE_BYTES = 16384
REQUEST_TIMEOUT = 20

PRODUCERS = frozenset({"codex", "claude-code"})
ROLES = frozenset({"run.started", "run.completed", "run.failed", "run.stopped",
                   "tool.started", "tool.completed", "tool.failed"})
SEVERITY = {"run.failed": 17, "tool.failed": 13}

ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,119}", re.ASCII)
TOOL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", re.ASCII)
ERROR_RE = re.compile(r"[a-z0-9_]{1,40}", re.ASCII)
TOKEN_RE = re.compile(r"hvra_otlp_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", re.ASCII)
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.ASCII)
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
ENDPOINT_RE = re.compile(r"https://((?:" + _LABEL + r"\.)*" + _LABEL + r")(?::([0-9]{1,5}))?" + re.escape(INGEST_PATH),
                         re.ASCII)
ISO_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?"
                    r"(Z|[+-][0-9]{2}:[0-9]{2})", re.ASCII)
AGENT_FILE_RE = re.compile(r"agent-([A-Za-z0-9][A-Za-z0-9_.-]{0,100})\.jsonl", re.ASCII)
# Codex writes `{"timestamp":…,"ordinal":…,"type":…,"payload":{"type":…` first. Inside a
# JSON string every quote is escaped, so these byte patterns only match real keys.
CODEX_ENVELOPE_RE = re.compile(rb'\{"timestamp":"([^"\\]{1,40})",(?:"ordinal":([0-9]{1,15}),)?"type":"([a-z_]{1,40})"'
                               rb'(?:,"payload":\{"type":"([a-z_]{1,60})")?')
CALL_ID_RE = re.compile(rb'"call_id":"([A-Za-z0-9_.:@-]{1,256})"')

CODEX_CALLS = {"function_call": None, "custom_tool_call": None,
               "local_shell_call": "local_shell", "tool_search_call": "tool_search"}
CODEX_OUTPUTS = frozenset({"function_call_output", "custom_tool_call_output",
                           "local_shell_call_output", "tool_search_output"})
CODEX_EVENTS = frozenset({"task_started", "task_complete", "turn_aborted", "item_completed"})
CODEX_ITEMS = frozenset(CODEX_CALLS) | CODEX_OUTPUTS | {"web_search_call"}
CLAUDE_TERMINAL = frozenset({"end_turn", "stop_sequence", "max_tokens", "refusal"})

_EPOCH = datetime.datetime(1970, 1, 1)
_MIN_NS = 946684800 * 10**9    # 2000-01-01
_MAX_NS = 4102444800 * 10**9   # 2100-01-01


class InstallError(Exception):
    """A refusal whose message is safe to print (it never contains input values)."""


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_id(value) -> bool:
    return isinstance(value, str) and ID_RE.fullmatch(value) is not None


def _key(value):
    return value if isinstance(value, str) and 0 < len(value) <= MAX_KEY else None


def time_ns(value):
    """UTC nanoseconds for an ISO-8601 string with a zone, or integer epoch seconds/milliseconds."""
    if _is_int(value):
        ns = value * 10**9 if value < 10**11 else value * 10**6 if value < 10**14 else None
    elif isinstance(value, float) and value == value and 0 < value < 10**11:
        ns = int(value * 10**9)
    elif isinstance(value, str) and len(value) <= 40:
        match = ISO_RE.fullmatch(value)
        if not match:
            return None
        try:
            moment = datetime.datetime(*(int(match.group(index)) for index in range(1, 7)))
        except ValueError:
            return None
        zone = match.group(8)
        offset = 0
        if zone != "Z":
            hours, minutes = int(zone[1:3]), int(zone[4:6])
            if hours > 23 or minutes > 59:
                return None
            offset = (hours * 3600 + minutes * 60) * (1 if zone[0] == "+" else -1)
        seconds = (moment - _EPOCH) // datetime.timedelta(seconds=1) - offset
        ns = seconds * 10**9 + int((match.group(7) or "").ljust(9, "0"))
    else:
        return None
    return ns if ns is not None and _MIN_NS <= ns < _MAX_NS else None


def _refine(coarse, precise):
    # Codex writes started_at/completed_at as whole epoch seconds next to a
    # millisecond record timestamp for the same instant; keep the finer one.
    if coarse is None:
        return precise
    if precise is not None and 0 <= precise - coarse < 10**9:
        return precise
    return coarse


def _elapsed_ms(start, end):
    if start is None or end is None or end < start:
        return None
    return (end - start) // 10**6


def _digest(size, *parts):
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()[:size]


def _attr(key, value):
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    return {"key": key, "value": {"stringValue": value}}


def native_record(producer, conversation, run, role, at_ns, *, call=None, tool=None, success=None,
                  duration_ms=None, error_type=None):
    """One contract log record, or None when a required field is missing or invalid."""
    if at_ns is None or producer not in PRODUCERS or role not in ROLES:
        return None
    if not _is_id(conversation) or not _is_id(run):
        return None
    run_span = _digest(16, "run", producer, conversation, run)
    if role.startswith("tool."):
        if not _key(call):
            return None
        span = _digest(16, "tool", producer, conversation, call)
        identity = ("tool", call, "start" if role == "tool.started" else "end")
    else:
        span = run_span
        identity = ("run", run, "start" if role == "run.started" else "end")
    attributes = [
        _attr("event.name", role),
        # A run or tool has one start and one end identity whatever the outcome,
        # so a replay can never add a second end.
        _attr("event.id", _digest(32, "event", producer, conversation, *identity)),
        _attr("service.name", producer),
        _attr("conversation.id", conversation),
        _attr("session.id", run),
    ]
    if isinstance(tool, str) and TOOL_RE.fullmatch(tool):
        attributes.append(_attr("tool.name", tool))
    if role in ("tool.completed", "tool.failed") and isinstance(success, bool):
        attributes.append(_attr("success", success))
    if _is_int(duration_ms) and 0 <= duration_ms <= MAX_DURATION_MS and role != "run.started" and role != "tool.started":
        attributes.append(_attr("duration_ms", duration_ms))
    if role == "run.failed" and isinstance(error_type, str) and ERROR_RE.fullmatch(error_type):
        attributes.append(_attr("error.type", error_type))
    if span != run_span:
        attributes.append(_attr("parent.span.id", run_span))
    return {"timeUnixNano": str(at_ns), "severityNumber": SEVERITY.get(role, 9),
            "traceId": _digest(32, "trace", producer, conversation, run), "spanId": span,
            "attributes": attributes}


def heartbeat_record(at_ns):
    # No trace, span, run or conversation: a heartbeat is never an activity event.
    return {"timeUnixNano": str(at_ns), "severityNumber": 9, "attributes": [
        _attr("event.name", "collector.heartbeat"),
        _attr("event.id", _digest(32, "event", SERVICE_NAME, "heartbeat", str(at_ns))),
        _attr("service.name", SERVICE_NAME),
    ]}


def otlp_body(records):
    return json.dumps({"resourceLogs": [{
        "resource": {"attributes": [_attr("service.namespace", "hivra.native")]},
        "scopeLogs": [{"scope": {"name": SERVICE_NAME}, "logRecords": records}],
    }]}, separators=(",", ":")).encode("utf-8")


class Context:
    """Where the current line came from; used for ids of records without their own."""

    __slots__ = ("path", "agent", "offset", "stats")

    def __init__(self, path, agent, stats):
        self.path, self.agent, self.offset, self.stats = path, agent, 0, stats


# --- Codex rollouts (~/.codex/sessions/**/rollout-*.jsonl) -------------------
# Parser state per file: c conversation, m first session_meta seen, s fork-replay
# ordinal bound, r current run, R open runs {run: start ns}, T open tools
# {call: {r, n, t, i}}, A item-id aliases {id: call}, I item_completed joins.

def parse_codex(record, p, ctx):
    kind, payload = record.get("type"), record.get("payload")
    if not isinstance(payload, dict):
        return []
    if kind == "session_meta":
        # Only the first one is this thread's; a fork replays its parent's.
        if not p.get("m"):
            p["m"] = 1
            conversation = payload.get("session_id")
            if not _is_id(conversation):
                conversation = payload.get("id")
            p["c"] = conversation if _is_id(conversation) else None
            start = payload.get("subagent_history_start_ordinal")
            if _is_int(start) and start > 0:
                p["s"] = start
        return []
    ordinal = record.get("ordinal")
    if p.get("s") and _is_int(ordinal) and ordinal < p["s"]:
        ctx.stats["codex.replay_skipped"] += 1
        return []
    conversation = p.get("c")
    if not conversation:
        ctx.stats["codex.no_session"] += 1
        return []
    at = time_ns(record.get("timestamp"))
    sub = payload.get("type")
    if kind == "event_msg":
        if sub == "task_started":
            return _codex_start(payload, p, conversation, at, ctx)
        if sub in ("task_complete", "turn_aborted"):
            return _codex_end(sub, payload, p, conversation, at, ctx)
        if sub == "item_completed":
            _codex_item(payload, p)
        return []
    if kind != "response_item":
        return []
    if sub in CODEX_CALLS:
        return _codex_call(sub, payload, p, conversation, at, ctx)
    if sub in CODEX_OUTPUTS:
        return _codex_output(payload, p, conversation, at, ctx)
    if sub == "web_search_call":
        # No call id at all: one completed record, identified by its position.
        run = p.get("r")
        if not run:
            ctx.stats["codex.tool_without_run"] += 1
            return []
        call = "web_search:" + _digest(24, "web_search", ctx.path, str(ctx.offset))
        return [native_record("codex", conversation, run, "tool.completed", at, call=call, tool="web_search")]
    return []


def _codex_start(payload, p, conversation, at, ctx):
    run = payload.get("turn_id")
    if not _is_id(run):
        ctx.stats["codex.invalid_turn"] += 1
        return []
    ctx.stats["codex.task_started"] += 1
    at = _refine(time_ns(payload.get("started_at")), at)
    runs = p.setdefault("R", {})
    out = []
    current = p.get("r")
    if current and current != run and current in runs:
        # A new task replaced one that never recorded an end.
        out.append(native_record("codex", conversation, current, "run.stopped", at,
                                 duration_ms=_elapsed_ms(runs.get(current), at)))
        _codex_close(p, current)
    p["r"] = run
    if run in runs:
        return out
    runs[run] = at
    out.append(native_record("codex", conversation, run, "run.started", at))
    return out


def _codex_end(sub, payload, p, conversation, at, ctx):
    run = payload.get("turn_id")
    if not _is_id(run):
        run = p.get("r")
    if not run:
        return []
    ctx.stats["codex." + sub] += 1
    at = _refine(time_ns(payload.get("completed_at")), at)
    duration = payload.get("duration_ms")
    if not _is_int(duration):
        duration = _elapsed_ms((p.get("R") or {}).get(run), at)
    error_type = None
    if sub == "turn_aborted":
        role = "run.stopped"
    elif payload.get("error") is not None:
        # error.message is content; only the codex_error_info enum is kept.
        role = "run.failed"
        error = payload.get("error")
        info = error.get("codex_error_info") if isinstance(error, dict) else None
        error_type = info if isinstance(info, str) and ERROR_RE.fullmatch(info) else None
    else:
        role = "run.completed"
    _codex_close(p, run)
    return [native_record("codex", conversation, run, role, at, duration_ms=duration, error_type=error_type)]


def _codex_close(p, run):
    (p.get("R") or {}).pop(run, None)
    if p.get("r") == run:
        p["r"] = None
    tools = p.get("T") or {}
    for call in [call for call, tool in tools.items() if tool.get("r") == run]:
        _drop_tool(p, call)
    cache = p.get("I") or {}
    for key in [key for key, value in cache.items() if value[2] == run]:
        del cache[key]


def _drop_tool(p, call):
    tool = (p.get("T") or {}).pop(call, None)
    if tool and tool.get("i"):
        (p.get("A") or {}).pop(tool["i"], None)
    return tool


def _codex_tool_name(sub, payload):
    fixed = CODEX_CALLS.get(sub)
    if fixed:
        return fixed
    name = payload.get("name")
    if not isinstance(name, str):
        return None
    namespace = payload.get("namespace")
    if isinstance(namespace, str) and namespace:
        # mcp__memtrace__ + find_code; mcp__cua_repl + __ + js.
        name = namespace + name if namespace.endswith("__") else namespace + "__" + name
    return name if TOOL_RE.fullmatch(name) else None


def _codex_call(sub, payload, p, conversation, at, ctx):
    run = p.get("r")
    if not run:
        ctx.stats["codex.tool_without_run"] += 1
        return []
    call = _key(payload.get("call_id")) or _key(payload.get("id"))
    tools = p.setdefault("T", {})
    if not call or call in tools:
        return []
    item = _key(payload.get("id"))
    alias = item if item and item != call else None
    name = _codex_tool_name(sub, payload)
    tools[call] = {"r": run, "n": name, "t": at, "i": alias}
    if alias:
        p.setdefault("A", {})[alias] = call
    while len(tools) > MAX_OPEN_TOOLS:
        _drop_tool(p, next(iter(tools)))
    return [native_record("codex", conversation, run, "tool.started", at, call=call, tool=name)]


def _codex_item(payload, p):
    # event_msg item_completed is structured and content-free: item.id equals the
    # call id for MCP, command, file-change and collaboration items.
    item = payload.get("item")
    if not isinstance(item, dict):
        return
    key = _key(item.get("id"))
    tools = p.get("T") or {}
    if not key or (key not in tools and key not in (p.get("A") or {})):
        return
    status, code = item.get("status"), item.get("exit_code")
    if status == "failed" or (_is_int(code) and code != 0):
        ok = False
    elif status == "completed" and _is_int(code) and code == 0:
        ok = True
    else:
        ok = None
    started, completed = payload.get("started_at_ms"), payload.get("completed_at_ms")
    duration = completed - started if _is_int(started) and _is_int(completed) else None
    if duration is not None and not 0 <= duration <= MAX_DURATION_MS:
        duration = None
    if ok is None and duration is None:
        return
    cache = p.setdefault("I", {})
    cache[key] = [ok, duration, p.get("r")]
    while len(cache) > MAX_ITEM_CACHE:
        del cache[next(iter(cache))]


def _codex_output(payload, p, conversation, at, ctx):
    key = _key(payload.get("call_id")) or _key(payload.get("id"))
    tools = p.get("T") or {}
    call = key if key in tools else (p.get("A") or {}).get(key) if key else None
    if not call or call not in tools:
        ctx.stats["codex.output_unmatched"] += 1
        return []
    tool = _drop_tool(p, call)
    cache = p.get("I") or {}
    joined = cache.pop(call, None) or (cache.pop(tool["i"], None) if tool.get("i") else None)
    ok, duration = (joined[0], joined[1]) if joined else (None, None)
    if duration is None:
        duration = _elapsed_ms(tool.get("t"), at)
    if ok is False:
        ctx.stats["codex.tool_failed_item_completed"] += 1
    return [native_record("codex", conversation, tool["r"], "tool.failed" if ok is False else "tool.completed", at,
                          call=call, tool=tool.get("n"), success=ok, duration_ms=duration)]


def codex_envelope(head):
    """Rebuild the structural part of an over-long Codex tool output from its prefix."""
    match = CODEX_ENVELOPE_RE.match(head)
    if not match or match.group(3) != b"response_item" or not match.group(4):
        return None
    sub = match.group(4).decode("ascii")
    if sub not in CODEX_OUTPUTS:
        return None
    call = CALL_ID_RE.search(head, match.end())
    if not call:
        return None
    record = {"timestamp": match.group(1).decode("ascii", "replace"), "type": "response_item",
              "payload": {"type": sub, "call_id": call.group(1).decode("ascii")}}
    if match.group(2):
        record["ordinal"] = int(match.group(2))
    return record


# --- Claude Code transcripts (~/.claude/projects/**/*.jsonl) ------------------
# Parser state per file: r current run, c its conversation, t its start ns,
# o 1 while open, e pending end [ns, duration] until final, T open tools.

def parse_claude(record, p, ctx):
    kind = record.get("type")
    if kind not in ("user", "assistant", "system"):
        return []
    conversation = record.get("sessionId")
    if not _is_id(conversation):
        return []
    at = time_ns(record.get("timestamp"))
    # A subagent (…/subagents/**/agent-<agentId>.jsonl, isSidechain records) is
    # its own run, agent:<agentId>, in the parent's conversation: its records
    # reuse the parent's promptId, so that cannot be the run key. A sidechain
    # inline in a main transcript would interleave with the main run, so it is
    # not attributed (current Claude Code never writes one).
    agent = ctx.agent
    if not agent and record.get("isSidechain") is True:
        ctx.stats["claude.inline_sidechain"] += 1
        return []
    if kind == "user":
        return _claude_user(record, p, conversation, agent, at, ctx)
    if kind == "assistant":
        return _claude_assistant(record, p, conversation, at, ctx)
    if record.get("subtype") == "turn_duration":
        duration = record.get("durationMs")
        if p.get("e") and _is_int(duration) and 0 <= duration <= MAX_DURATION_MS:
            p["e"][1] = duration
            return claude_flush(p)
    return []


def _claude_blocks(record):
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


def _claude_user(record, p, conversation, agent, at, ctx):
    results = [block for block in _claude_blocks(record) if block.get("type") == "tool_result"]
    if results or "sourceToolAssistantUUID" in record or "toolUseResult" in record:
        out = []
        tools = p.get("T") or {}
        for block in results:
            call = _key(block.get("tool_use_id"))
            tool = tools.pop(call, None) if call else None
            if not tool:
                ctx.stats["claude.result_unmatched"] += 1
                continue
            flag = block.get("is_error")
            success = False if flag is True else True if flag is False else None
            out.append(native_record("claude-code", tool["c"], tool["r"],
                                     "tool.failed" if flag is True else "tool.completed", at, call=call,
                                     tool=tool.get("n"), success=success, duration_ms=_elapsed_ms(tool.get("t"), at)))
        return out
    if agent:
        # The whole subagent file is one run; its first prompt may be meta.
        run = agent
    elif record.get("isMeta") is True or record.get("isCompactSummary") is True:
        return []
    else:
        run = record.get("promptId")
        if not _is_id(run):
            run = record.get("uuid") if _is_id(record.get("uuid")) else None
    if not run or (run == p.get("r") and (agent or conversation == p.get("c"))):
        return []
    out = claude_close(p, at)
    p.update(r=run, c=conversation, t=at, o=1, e=None)
    ctx.stats["claude.prompt"] += 1
    out.append(native_record("claude-code", conversation, run, "run.started", at))
    return out


def _claude_assistant(record, p, conversation, at, ctx):
    run = p.get("r")
    if not run:
        ctx.stats["claude.assistant_without_run"] += 1
        return []
    out = []
    tools = p.setdefault("T", {})
    for block in _claude_blocks(record):
        if block.get("type") != "tool_use":
            continue
        call = _key(block.get("id"))
        if not call or call in tools:
            continue
        name = block.get("name")
        name = name if isinstance(name, str) and TOOL_RE.fullmatch(name) else None
        tools[call] = {"r": run, "c": p.get("c"), "n": name, "t": at}
        while len(tools) > MAX_OPEN_TOOLS:
            del tools[next(iter(tools))]
        p["e"] = None  # the task continues past an earlier end_turn
        out.append(native_record("claude-code", p.get("c"), run, "tool.started", at, call=call, tool=name))
    if record.get("isApiErrorMessage") is True:
        if p.get("o"):
            error = record.get("error")
            out.append(native_record("claude-code", p.get("c"), run, "run.failed", at,
                                     duration_ms=_elapsed_ms(p.get("t"), at),
                                     error_type=error if isinstance(error, str) else None))
            p["o"], p["e"] = 0, None
        return out
    message = record.get("message")
    stop = message.get("stop_reason") if isinstance(message, dict) else None
    if stop in CLAUDE_TERMINAL and p.get("o") and not any(tool.get("r") == run for tool in tools.values()):
        # Held until a turn_duration record, the next prompt, or a quiet file
        # makes it final, so the end carries the producer's own duration.
        pending = p.get("e")
        p["e"] = [at if at is not None else (pending[0] if pending else None), pending[1] if pending else None]
    return out


def claude_flush(p):
    """Emit the held end of the current run, if any."""
    pending = p.get("e")
    if not pending or not p.get("o"):
        p["e"] = None
        return []
    at, duration = pending
    p["o"], p["e"] = 0, None
    if duration is None:
        duration = _elapsed_ms(p.get("t"), at)
    return [native_record("claude-code", p.get("c"), p.get("r"), "run.completed", at, duration_ms=duration)]


def claude_close(p, at):
    """Close the current run because another began: completed if it had ended, else stopped."""
    if not p.get("r") or not p.get("o"):
        return []
    if p.get("e"):
        return claude_flush(p)
    p["o"] = 0
    return [native_record("claude-code", p.get("c"), p.get("r"), "run.stopped", at,
                          duration_ms=_elapsed_ms(p.get("t"), at))]


def prune_parser(kind, p, now_ns):
    """Forget open runs and tools that started more than 24 h before now_ns."""
    cutoff = now_ns - PRUNE_SECONDS * 10**9
    for call in [call for call, tool in (p.get("T") or {}).items() if (tool.get("t") or 0) < cutoff]:
        _drop_tool(p, call)
    if kind == "codex":
        runs = p.get("R") or {}
        for run in [run for run, start in runs.items() if (start or 0) < cutoff]:
            _codex_close(p, run)
        cache = p.get("I") or {}
        for key in [key for key, value in cache.items() if value[2] not in runs]:
            del cache[key]
        aliases = p.get("A") or {}
        for alias in [alias for alias, call in aliases.items() if call not in (p.get("T") or {})]:
            del aliases[alias]
    elif p.get("o") and (p.get("t") or 0) < cutoff:
        p["o"], p["e"] = 0, None


def parser_idle(kind, p):
    if kind == "codex":
        return not p.get("R") and not p.get("T")
    return not p.get("o") and not p.get("T") and not p.get("e")


# --- Files ---------------------------------------------------------------------

def iter_lines(stream, offset):
    """Yield (start, end, line, head) for each complete line from offset.

    line is None for a line longer than MAX_LINE; only its first ENVELOPE
    bytes (head) are kept and the rest is discarded unread by the parser. A
    trailing line without a newline is left for the next pass: the producer
    may still be writing it.
    """
    stream.seek(offset)
    base = start = offset
    parts, size, head = [], 0, None
    while True:
        chunk = stream.read(CHUNK)
        if not chunk:
            return
        position = 0
        while position < len(chunk):
            newline = chunk.find(b"\n", position)
            stop = len(chunk) if newline < 0 else newline
            piece = chunk[position:stop]
            size += len(piece)
            if head is None:
                if size > MAX_LINE:
                    head = (b"".join(parts) + piece[:ENVELOPE])[:ENVELOPE]
                    parts = []
                else:
                    parts.append(piece)
            if newline < 0:
                break
            end = base + newline + 1
            yield (start, end, b"".join(parts), None) if head is None else (start, end, None, head)
            start, parts, size, head = end, [], 0, None
            position = newline + 1
        base += len(chunk)


def _open_regular(path, expected=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or (expected is not None and (info.st_ino, info.st_dev) != expected):
        os.close(fd)
        raise OSError("not the expected regular file")
    return fd, info


class Tracker:
    """Discovers transcripts and turns their new complete lines into records.

    files is the committed per-file state {path: {k, i, o, p}}. collect()
    works on copies and returns them; commit() applies them only after the
    records they produced were delivered, so offsets never pass undelivered
    events.
    """

    def __init__(self, home, files, *, backfill_before=None, stats=None):
        self.home = home
        self.files = files
        self.backfill_before = backfill_before
        self.stats = stats if stats is not None else collections.Counter()
        self.current = None  # the file whose records are being emitted

    def discover(self):
        found = []
        try:
            home = os.lstat(self.home)
        except OSError:
            return found
        if not stat.S_ISDIR(home.st_mode):
            return found
        for kind, parts in (("codex", (".codex", "sessions")), ("claude", (".claude", "projects"))):
            base = self.home
            for part in parts:
                base = os.path.join(base, part)
                try:
                    info = os.lstat(base)
                except OSError:
                    info = None
                if info is None or not stat.S_ISDIR(info.st_mode):  # symlinks are not followed
                    break
            else:
                found.extend(self._walk(kind, base, home.st_uid))
        return found

    def _walk(self, kind, base, owner):
        for directory, dirnames, filenames in os.walk(base):
            dirnames.sort()
            subagent = kind == "claude" and "subagents" in os.path.relpath(directory, base).split(os.sep)
            for name in sorted(filenames):
                if not name.endswith(".jsonl") or (kind == "codex" and not name.startswith("rollout-")):
                    continue
                agent = None
                if kind == "claude":
                    if name == "journal.jsonl":
                        continue
                    if subagent:
                        match = AGENT_FILE_RE.fullmatch(name)
                        if not match or not _is_id("agent:" + match.group(1)):
                            continue
                        agent = "agent:" + match.group(1)
                path = os.path.join(directory, name)
                try:
                    info = os.lstat(path)
                except OSError:
                    continue
                # Only the transcript owner's regular files; never through a link.
                if stat.S_ISREG(info.st_mode) and info.st_uid == owner:
                    yield path, kind, agent, info

    def collect(self, sink, *, max_records, max_bytes, now, quiet_seconds=QUIET_SECONDS):
        """Feed new records to sink; return (working copies, whether every file was read to its end)."""
        working, seen = {}, set()
        emitted = used = 0
        visited = True
        for path, kind, agent, info in self.discover():
            if emitted >= max_records or used >= max_bytes:
                visited = False
                break
            seen.add(path)
            entry = self.files.get(path)
            fresh = entry is None
            if fresh or entry.get("i") != info.st_ino or info.st_size < entry.get("o", 0) or entry.get("k") != kind:
                # New, replaced or truncated: start over with fresh parser state.
                entry = {"k": kind, "i": info.st_ino, "o": 0, "p": {}}
                self.stats["files.new" if fresh else "files.reset"] += 1
                if fresh and self.backfill_before is not None and info.st_mtime < self.backfill_before:
                    entry["o"] = info.st_size  # no historical backfill
                    self.stats["files.skipped_history"] += 1
                    if kind == "codex":
                        self._seed(path, info, entry)
                working[path] = entry
            quiet = now - info.st_mtime >= quiet_seconds
            held = kind == "claude" and entry["p"].get("e")
            if info.st_size == entry["o"] and not (held and quiet):
                continue
            if path not in working:
                entry = working[path] = copy.deepcopy(entry)
            self.current = path
            at_end = True
            if info.st_size > entry["o"]:
                count, size, at_end = self._read(path, info, entry, Context(path, agent, self.stats), sink,
                                                 max_records - emitted, max_bytes - used)
                emitted += count
                used += size
            if at_end and quiet and kind == "claude" and entry["p"].get("e"):
                for record in claude_flush(entry["p"]):
                    if record is not None:
                        sink(record)
                        emitted += 1
        if visited:
            for path in self.files:
                if path not in seen:
                    working[path] = None  # deleted transcript: drop its state
        return working, visited and emitted < max_records and used < max_bytes

    def commit(self, working):
        for path, entry in working.items():
            if entry is None:
                self.files.pop(path, None)
            else:
                self.files[path] = entry

    def _seed(self, path, info, entry):
        # A skipped Codex rollout can still be resumed later; keep its session.
        try:
            fd, _ = _open_regular(path, (info.st_ino, info.st_dev))
        except OSError:
            return
        try:
            with os.fdopen(fd, "rb", buffering=0, closefd=False) as stream:
                for _, _, line, _ in iter_lines(stream, 0):
                    if line is not None:
                        record = json.loads(line)
                        if isinstance(record, dict) and record.get("type") == "session_meta":
                            parse_codex(record, entry["p"], Context(path, None, self.stats))
                    break
        except (OSError, ValueError, RecursionError):
            pass
        finally:
            os.close(fd)

    def _read(self, path, info, entry, ctx, sink, record_budget, byte_budget):
        try:
            fd, _ = _open_regular(path, (info.st_ino, info.st_dev))
        except OSError:
            self.stats["files.unreadable"] += 1
            return 0, 0, False
        emitted = used = 0
        try:
            with os.fdopen(fd, "rb", buffering=0, closefd=False) as stream:
                for start, end, line, head in iter_lines(stream, entry["o"]):
                    ctx.offset = start
                    for record in self._line(entry["k"], line, head, entry["p"], ctx):
                        sink(record)
                        emitted += 1
                    used += end - start
                    self.stats["bytes.read"] += end - start
                    entry["o"] = end
                    if emitted >= record_budget or used >= byte_budget:
                        return emitted, used, False
        except OSError:
            self.stats["files.read_error"] += 1
            return emitted, used, False
        finally:
            os.close(fd)
        return emitted, used, True

    def _line(self, kind, line, head, p, ctx):
        stats = ctx.stats
        stats["lines"] += 1
        try:
            if line is None:
                stats["lines.oversize"] += 1
                record = codex_envelope(head) if kind == "codex" else None
                if record is None:
                    return []
                stats["lines.oversize_recovered"] += 1
                out = parse_codex(record, p, ctx)
            else:
                if kind == "codex" and self._skip_codex(line, p, stats):
                    return []
                try:
                    record = json.loads(line)
                except (ValueError, RecursionError):
                    stats["lines.invalid"] += 1
                    return []
                if not isinstance(record, dict):
                    return []
                out = (parse_codex if kind == "codex" else parse_claude)(record, p, ctx)
        except Exception:  # never let one record stop the reporter
            stats["errors.parser"] += 1
            return []
        records = [record for record in out if record is not None]
        stats["records.dropped_invalid"] += len(out) - len(records)
        return records

    @staticmethod
    def _skip_codex(line, p, stats):
        # Most rollout bytes are content (messages, reasoning, compaction,
        # token usage); recognise them from the fixed envelope and never parse
        # them. Anything the envelope does not describe is parsed normally.
        match = CODEX_ENVELOPE_RE.match(line, 0, CODEX_HEAD)
        if not match:
            return False
        kind, sub, ordinal = match.group(3), match.group(4), match.group(2)
        if kind == b"session_meta":
            skip = bool(p.get("m"))
        elif kind == b"event_msg":
            skip = sub is not None and sub.decode("ascii") not in CODEX_EVENTS
        elif kind == b"response_item":
            skip = sub is not None and sub.decode("ascii") not in CODEX_ITEMS
        else:
            skip = True
        if not skip and ordinal and p.get("s") and int(ordinal) < p["s"]:
            stats["codex.replay_skipped"] += 1
            skip = True
        if skip:
            stats["lines.prefiltered"] += 1
        return skip


# --- Credential and state files ------------------------------------------------

def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def validate_credential(document):
    """Return the credential as a new dict or raise InstallError naming the bad field only."""
    if not isinstance(document, dict) or set(document) != CREDENTIAL_KEYS:
        raise InstallError("credential must have exactly endpoint, resourceId, token and expiresAt")
    endpoint, resource, token, expires = (document[key] for key in ("endpoint", "resourceId", "token", "expiresAt"))
    match = ENDPOINT_RE.fullmatch(endpoint) if isinstance(endpoint, str) and len(endpoint) <= 512 else None
    if not match or (match.group(2) is not None and not 0 < int(match.group(2)) < 65536):
        raise InstallError("credential endpoint must be https://<origin>/api/activity/ingest")
    if not isinstance(resource, str) or not UUID_RE.fullmatch(resource):
        raise InstallError("credential resourceId must be a lower-case UUID")
    if not isinstance(token, str) or len(token.encode("utf-8")) > 4096 or not TOKEN_RE.fullmatch(token):
        raise InstallError("credential token is malformed")
    if not isinstance(expires, str) or time_ns(expires) is None or not (expires.endswith("Z") or expires.endswith("+00:00")):
        raise InstallError("credential expiresAt must be an ISO-8601 UTC timestamp")
    return {"endpoint": endpoint, "resourceId": resource, "token": token, "expiresAt": expires}


def _origin(endpoint):
    return endpoint[: -len(INGEST_PATH)]


def _fingerprint(credential):
    return _digest(16, "credential", credential["token"], credential["expiresAt"])


def _read_private(path, limit):
    fd, info = _open_regular(path)
    try:
        if info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > limit:
            raise OSError("unsafe private file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read(limit + 1)
    finally:
        os.close(fd)


def read_credential(path):
    try:
        data = _read_private(path, MAX_CREDENTIAL_BYTES)
        return validate_credential(json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object))
    except (OSError, ValueError, RecursionError, InstallError):
        return None


def _valid_entry(entry):
    return (isinstance(entry, dict) and entry.get("k") in ("codex", "claude") and _is_int(entry.get("i"))
            and _is_int(entry.get("o")) and entry["o"] >= 0 and isinstance(entry.get("p"), dict))


def write_atomic(path, data, mode):
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".hivra-agent-trace-", dir=directory)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    finally:
        os.close(fd)
    try:
        directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(directory_fd)
    except OSError:
        pass
    finally:
        os.close(directory_fd)


def credential_bytes(credential):
    return (json.dumps(credential, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def _rooted(root, path):
    return os.path.join(root, path.lstrip("/")) if root not in ("", "/") else path


# --- Delivery ------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # never forward the bearer credential to another location


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def urllib_transport(url, headers, body, timeout):
    """POST body and return (status, bounded response body); network errors raise."""
    request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return response.status, response.read(MAX_RESPONSE_BYTES + 1)[:MAX_RESPONSE_BYTES]
    except urllib.error.HTTPError as error:
        try:
            return error.code, b""
        finally:
            error.close()


def _headers(credential):
    return {"Authorization": "Bearer " + credential["token"], "X-Hivra-Resource-Id": credential["resourceId"],
            "Content-Type": "application/json", "User-Agent": "hivra-agent-trace/2"}


def _chunks(records):
    for index in range(0, len(records), MAX_RECORDS):
        pending = [records[index:index + MAX_RECORDS]]
        while pending:
            chunk = pending.pop(0)
            body = otlp_body(chunk)
            if len(body) > MAX_BODY and len(chunk) > 1:
                half = len(chunk) // 2
                pending[:0] = [chunk[:half], chunk[half:]]
                continue
            yield body


class Reporter:
    """The service loop: parse, deliver, and only then advance offsets."""

    def __init__(self, *, root="/", home=DEFAULT_HOME, transport=None, clock=time.time, log=None):
        self.credential_path = _rooted(root, CREDENTIAL_PATH)
        self.state_path = _rooted(root, STATE_PATH)
        self.transport = transport or urllib_transport
        self.clock = clock
        self.log = log or (lambda message: print(SERVICE_NAME + ": " + message, file=sys.stderr, flush=True))
        self.state = self._load_state()
        self.tracker = Tracker(_rooted(root, home), self.state["files"],
                               backfill_before=max(self.state["firstStart"], self.state.get("idleBefore", 0)))
        self.fingerprint = None
        self.failures = 0
        self.blocked_until = 0.0
        self.renew_after = 0.0
        self.renew_tried = None
        self.last_heartbeat = None
        self.last_prune = self.clock()
        self.last_note = None

    def note(self, message):
        if message != self.last_note:
            self.last_note = message
            self.log(message)

    def _load_state(self):
        now = self.clock()
        try:
            state = json.loads(_read_private(self.state_path, MAX_STATE_BYTES).decode("utf-8"))
            if (isinstance(state, dict) and state.get("v") == 1 and isinstance(state.get("files"), dict)
                    and all(isinstance(state.get(key, 0), (int, float)) and not isinstance(state.get(key), bool)
                            for key in ("firstStart", "idleBefore")) and "firstStart" in state):
                state["files"] = {path: entry for path, entry in state["files"].items() if _valid_entry(entry)}
                return state
        except (OSError, ValueError, RecursionError):
            pass
        # First start, or unreadable state: never backfill what already exists.
        state = {"v": 1, "firstStart": now, "files": {}}
        try:
            self._save_state(state)
        except OSError:
            pass
        return state

    def _save_state(self, state=None):
        write_atomic(self.state_path, json.dumps(state or self.state, separators=(",", ":")).encode("utf-8"), 0o600)

    def _credential(self):
        credential = read_credential(self.credential_path)
        if credential is None:
            self.note("waiting for a valid credential")
            return None
        fingerprint = _fingerprint(credential)
        if fingerprint != self.fingerprint:
            # A replacement (pushed on start, or renewed) clears expiry and backoff.
            self.fingerprint = fingerprint
            self.failures, self.blocked_until, self.renew_after, self.renew_tried = 0, 0.0, 0.0, None
            if self.state.get("credential") == "expired":
                self.state.pop("credential", None)
        return credential

    def step(self):
        """One loop iteration; returns the number of seconds to wait."""
        now = self.clock()
        credential = self._credential()
        if credential is None:
            return LOOP_SECONDS
        if now < self.blocked_until:
            return max(1.0, min(LOOP_SECONDS, self.blocked_until - now))
        credential = self._maybe_renew(credential, now)
        if self.last_heartbeat is None or now - self.last_heartbeat >= HEARTBEAT_SECONDS:
            outcome, credential = self._deliver(credential, [heartbeat_record(int(now * 10**9))], now)
            if outcome != "ok":
                return self._wait(now)
            self.last_heartbeat = now
        complete = False
        for _ in range(MAX_PASSES):
            records = []
            working, complete = self.tracker.collect(records.append, max_records=MAX_RECORDS, max_bytes=PASS_BYTES,
                                                     now=now)
            if records:
                outcome, credential = self._deliver(credential, records, now)
                if outcome != "ok":
                    return self._wait(now)
            if working:
                self.tracker.commit(working)
                self._save_state()
            if complete:
                break
        if complete and now - self.last_prune >= PRUNE_INTERVAL_SECONDS:
            self.last_prune = now
            self._prune(now)
        self.note("delivering")
        return LOOP_SECONDS

    def _prune(self, now):
        """Bound state: forget day-old open runs/tools, and fully read files idle for a day.

        Runs only right after a pass that read and committed every file, so a
        forgotten file is exactly one whose content was delivered; the idle
        floor makes its rediscovery skip to EOF instead of replaying it.
        """
        cutoff = now - PRUNE_SECONDS
        files = self.state["files"]
        for path, entry in list(files.items()):
            prune_parser(entry["k"], entry["p"], int(now * 10**9))
            try:
                info = os.lstat(path)
            except OSError:
                continue  # the next pass drops deleted files
            if (info.st_mtime < cutoff and info.st_ino == entry["i"] and info.st_size == entry["o"]
                    and parser_idle(entry["k"], entry["p"])):
                del files[path]
        self.state["idleBefore"] = max(self.state.get("idleBefore", 0), cutoff)
        self.tracker.backfill_before = max(self.state["firstStart"], self.state["idleBefore"])
        self._save_state()

    def _wait(self, now):
        return max(1.0, min(LOOP_SECONDS, self.blocked_until - now))

    def _maybe_renew(self, credential, now):
        expires = time_ns(credential["expiresAt"]) / 10**9
        if expires - now < RENEW_BEFORE_SECONDS and now >= self.renew_after:
            return self._renew(credential, now) or credential
        return credential

    def _renew(self, credential, now):
        if time_ns(credential["expiresAt"]) <= now * 10**9:
            return None  # renewal requires an unexpired credential; wait for a pushed one
        try:
            status, body = self.transport(_origin(credential["endpoint"]) + RENEW_PATH, _headers(credential), b"{}",
                                          REQUEST_TIMEOUT)
        except (OSError, http.client.HTTPException, ValueError) as error:
            self.renew_after = now + RENEW_RETRY_SECONDS
            self.note("credential renewal failed: " + type(error).__name__)
            return None
        if status == 200:
            try:
                answer = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_object)
                renewed = validate_credential({"endpoint": credential["endpoint"],
                                               "resourceId": credential["resourceId"],
                                               "token": answer.get("token"), "expiresAt": answer.get("expiresAt")})
                if time_ns(renewed["expiresAt"]) <= now * 10**9:
                    raise InstallError("renewed credential already expired")
                write_atomic(self.credential_path, credential_bytes(renewed), 0o600)
            except (ValueError, AttributeError, InstallError, OSError):
                self.renew_after = now + RENEW_RETRY_SECONDS
                self.note("credential renewal returned an unusable credential")
                return None
            self.fingerprint = _fingerprint(renewed)
            self.renew_after, self.renew_tried = 0.0, None
            self.state.pop("credential", None)
            self.note("credential renewed")
            return renewed
        self.renew_after = now + (RENEW_RATE_LIMITED_SECONDS if status == 429 else RENEW_RETRY_SECONDS)
        self.note("credential renewal refused: status=%d" % status)
        return None

    def _post(self, credential, body):
        try:
            status, _ = self.transport(credential["endpoint"], _headers(credential), body, REQUEST_TIMEOUT)
            return status
        except (OSError, http.client.HTTPException, ValueError) as error:
            self.note("delivery failed: " + type(error).__name__)
            return None

    def _deliver(self, credential, records, now):
        """Send records; return ("ok" | "retry" | "blocked", credential in use)."""
        for body in _chunks(records):
            status = self._post(credential, body)
            if status == 401 and self.renew_tried != self.fingerprint:
                self.renew_tried = self.fingerprint
                renewed = self._renew(credential, now)
                if renewed is not None:
                    credential = renewed
                    self.renew_tried = self.fingerprint
                    status = self._post(credential, body)
            if status is not None and 200 <= status < 300:
                continue
            if status in (400, 413):
                self.note("ingest rejected a batch: status=%d; dropped" % status)
                continue
            if status == 401:
                # Record expiry locally and wait; each loop re-reads the credential
                # file, so a pushed replacement resumes delivery immediately.
                self.state["credential"] = "expired"
                try:
                    self._save_state()
                except OSError:
                    pass
                self.blocked_until = now + MAX_BACKOFF
                self.note("credential expired or refused; waiting for a replacement")
                return "blocked", credential
            if status in (403, 404):
                self.blocked_until = now + MAX_BACKOFF
                self.note("ingest refused this computer: status=%d" % status)
                return "blocked", credential
            self.failures += 1
            self.blocked_until = now + min(MAX_BACKOFF, LOOP_SECONDS * 2 ** min(self.failures - 1, 8))
            if status is not None:
                self.note("delivery failed: status=%d" % status)
            return "retry", credential
        self.failures = 0
        return "ok", credential

    def run_forever(self, sleep=time.sleep):
        while True:
            try:
                delay = self.step()
            except Exception as error:  # the loop never exits on its own
                self.note("loop error: " + type(error).__name__)
                delay = LOOP_SECONDS
            sleep(delay)


# --- Commands ------------------------------------------------------------------

def _systemctl(*arguments, timeout=15, capture=False):
    return subprocess.run([SYSTEMCTL, *arguments], timeout=timeout, check=False,
                          env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL)


def _read_source(path):
    fd, info = _open_regular(path)
    try:
        if info.st_size > MAX_SOURCE_BYTES:
            raise InstallError("reporter source is too large")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read(MAX_SOURCE_BYTES + 1)
    finally:
        os.close(fd)


def _ensure_directory(path, mode, owner, own=True):
    # Create missing components explicitly (never subject to the caller's
    # umask), then refuse a leaf or parent that is a link, foreign-owned or
    # writable by others. Only the reporter's own directories are re-moded.
    missing = []
    probe = path
    while not os.path.lexists(probe):
        missing.append(probe)
        probe = os.path.dirname(probe)
    checks = ((probe, (0, owner)),) if missing else ()
    checks += ((os.path.dirname(path), (0, owner)), (path, (owner,)))
    for index, (directory, owners) in enumerate(checks):
        info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o022:
            raise InstallError("unsafe reporter directory")
        if index == 0:
            for created in reversed(missing):  # only below a checked ancestor
                os.mkdir(created, 0o700)
                os.chmod(created, mode if created == path else 0o755)
    if own and stat.S_IMODE(os.lstat(path).st_mode) != mode:
        os.chmod(path, mode)


def install(source_dir, raw, *, root="/", systemctl=True, settle=2.0):
    """Install or replace the reporter, unit and credential; return a status line."""
    if len(raw) > MAX_CREDENTIAL_BYTES:
        raise InstallError("credential document is too large")
    try:
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise InstallError("credential document is not a single JSON object") from None
    credential = validate_credential(document)
    if not os.path.isabs(root):
        raise InstallError("root must be an absolute path")
    if root == "/" and os.geteuid() != 0:
        raise InstallError("install must run as root")
    owner = os.geteuid()
    try:
        script = _read_source(os.path.join(source_dir, SCRIPT_NAME))
        unit = _read_source(os.path.join(source_dir, UNIT_NAME))
    except OSError:
        raise InstallError("reporter source files are missing or not regular files") from None
    for directory, mode, own in ((os.path.dirname(SCRIPT_PATH), 0o755, True),
                                 (os.path.dirname(UNIT_PATH), 0o755, False), (STATE_DIR, 0o700, True)):
        _ensure_directory(_rooted(root, directory), mode, owner, own)
    write_atomic(_rooted(root, SCRIPT_PATH), script, 0o644)
    write_atomic(_rooted(root, UNIT_PATH), unit, 0o644)
    write_atomic(_rooted(root, CREDENTIAL_PATH), credential_bytes(credential), 0o600)
    if not systemctl:
        return "installed; service not started (--no-systemctl)"
    for arguments in (("daemon-reload",), ("enable", UNIT_NAME)):
        if _systemctl(*arguments).returncode != 0:
            raise InstallError("systemctl %s failed" % arguments[0])
    shown = _systemctl("show", "--property=FragmentPath", "--property=DropInPaths", UNIT_NAME, capture=True)
    expected = {b"FragmentPath=" + os.fsencode(UNIT_PATH), b"DropInPaths="}
    if shown.returncode != 0 or set(shown.stdout.splitlines()) != expected:
        raise InstallError("an override of the reporter unit requires explicit repair")
    if _systemctl("restart", UNIT_NAME, timeout=30).returncode != 0:
        raise InstallError("systemctl restart failed")
    time.sleep(settle)  # a reporter that fails at startup has left "active" by now
    if _systemctl("is-active", "--quiet", UNIT_NAME).returncode != 0:
        raise InstallError("service is not active")
    return "installed and active"


def install_command(args, stdin=None, stderr=None):
    stdin = stdin if stdin is not None else sys.stdin.buffer
    stderr = stderr if stderr is not None else sys.stderr
    try:
        status = install(args.source_dir, stdin.read(MAX_CREDENTIAL_BYTES + 1), root=args.root,
                         systemctl=not args.no_systemctl)
    except InstallError as error:
        print("%s: install failed: %s" % (SERVICE_NAME, error), file=stderr)
        return 1
    except Exception as error:
        # Exception text can carry paths or command output; the type is enough.
        print("%s: install failed: %s" % (SERVICE_NAME, type(error).__name__), file=stderr)
        return 1
    print("%s: %s" % (SERVICE_NAME, status), file=stderr)
    return 0


def scan(home, *, all_history, now=None):
    """Parse every transcript under home without sending; return aggregate counts only."""
    started = time.time()
    now = started if now is None else now
    stats = collections.Counter()
    files = {}
    tracker = Tracker(home, files, backfill_before=None if all_history else now - PRUNE_SECONDS, stats=stats)
    event_ids = {}
    files_seen = {}

    def sink(record):
        values = {item["key"]: next(iter(item["value"].values())) for item in record["attributes"]}
        producer, role = values["service.name"], values["event.name"]
        stats["records.total"] += 1
        stats["records.%s.%s" % (producer, role)] += 1
        if role in ("tool.completed", "tool.failed"):
            stats["tool.success.%s.%s" % (producer, {True: "true", False: "false"}.get(values.get("success"), "absent"))] += 1
        if "duration_ms" in values:
            stats["records.with_duration.%s" % role] += 1
        if "error.type" in values:
            stats["records.with_error_type"] += 1
        # The same id from one file is a parser bug; from two files it is one
        # logical run continued elsewhere (a resumed subagent), deduped by ingest.
        source = files_seen.setdefault(tracker.current, len(files_seen))
        if values["event.id"] in event_ids:
            stats["event_ids.duplicate" if event_ids[values["event.id"]] == source
                  else "event_ids.duplicate_cross_file"] += 1
        else:
            event_ids[values["event.id"]] = source

    working, _ = tracker.collect(sink, max_records=float("inf"), max_bytes=float("inf"), now=now,
                                 quiet_seconds=float("-inf"))
    tracker.commit(working)
    for path, entry in files.items():
        producer = "codex" if entry["k"] == "codex" else "claude-code"
        p = entry["p"]
        stats["files.%s" % producer] += 1
        stats["runs.open_at_eof.%s" % producer] += len(p.get("R") or {}) if entry["k"] == "codex" else int(bool(p.get("o")))
        stats["tools.open_at_eof.%s" % producer] += len(p.get("T") or {})
    try:
        import resource
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        stats["max_rss_mb"] = rss // (1024 * 1024) if sys.platform == "darwin" else rss // 1024
    except (ImportError, OSError):
        pass
    stats["elapsed_s"] = int(time.time() - started)
    stats["event_ids.unique"] = len(event_ids)
    return dict(sorted(stats.items()))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("run", "install", "scan", "-h", "--help"):
        argv.insert(0, "run")
    parser = argparse.ArgumentParser(prog=SERVICE_NAME, description="Hivra agent-run reporter")
    commands = parser.add_subparsers(dest="command")
    run = commands.add_parser("run", help="the service loop")
    run.add_argument("--root", default="/", help="path prefix for every absolute path (testing)")
    run.add_argument("--home", default=DEFAULT_HOME)
    setup = commands.add_parser("install", help="install or replace the reporter; credential on stdin")
    setup.add_argument("--source-dir", required=True)
    setup.add_argument("--root", default="/", help="path prefix for every absolute path (testing)")
    setup.add_argument("--no-systemctl", action="store_true")
    census = commands.add_parser("scan", help="parse local transcripts and print aggregate counts only")
    census.add_argument("--home", required=True)
    census.add_argument("--all-history", action="store_true")
    census.add_argument("--stats", action="store_true", help="print every counter, not just the totals")
    args = parser.parse_args(argv)
    if args.command == "install":
        return install_command(args)
    if args.command == "scan":
        stats = scan(os.path.abspath(os.path.expanduser(args.home)), all_history=args.all_history)
        if args.stats:
            print(json.dumps(stats, indent=1, sort_keys=True))
        else:
            print("files=%d lines=%d records=%d duplicate_event_ids=%d parser_errors=%d" % (
                stats.get("files.codex", 0) + stats.get("files.claude-code", 0), stats.get("lines", 0),
                stats.get("records.total", 0), stats.get("event_ids.duplicate", 0), stats.get("errors.parser", 0)))
        return 0
    if not os.path.isabs(args.root):
        parser.error("--root must be an absolute path")
    Reporter(root=args.root, home=args.home).run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
