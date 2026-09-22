#!/usr/bin/env python3
"""Export redacted structural events from native Codex and Claude transcripts.

The transcript stays in the guest.  This process never serializes message bodies,
tool arguments, command text, or tool output; it constructs a new OTLP/JSON log
record from a small allowlist of identifiers, names, status, and timestamps.
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

CONFIG = Path("/etc/hivra/agent-trace.json")
STATE = Path("/var/lib/hivra-agent-trace/state.json")
MAX_LINE = 1024 * 1024


def _hex(value: str, length: int) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _time_ns(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(int(time.mktime(time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S"))) * 1_000_000_000)
    except (ValueError, OverflowError):
        return None


def _event(source: str, session: str, run: str, role: str, timestamp: object,
           *, tool: str | None = None, event_id: str = "", success: bool | None = None,
           duration_ms: int | None = None, parent: str | None = None) -> dict | None:
    at = _time_ns(timestamp)
    if not at or not session or not run:
        return None
    attributes = {
        "event.name": role,
        "service.name": source,
        "conversation.id": session,
        "session.id": run,
        "event.id": event_id or _hex(f"{source}:{session}:{run}:{role}:{at}:{tool or ''}", 32),
    }
    if tool and len(tool) <= 120 and tool.replace("_", "").replace("-", "").replace(".", "").isalnum():
        attributes["tool.name"] = tool
    if success is not None:
        attributes["success"] = success
    if duration_ms is not None and 0 <= duration_ms <= 7 * 24 * 60 * 60 * 1000:
        attributes["duration_ms"] = duration_ms
    trace_id = _hex(f"trace:{source}:{session}:{run}", 32)
    span_id = _hex(f"span:{source}:{session}:{run}:{event_id or role}", 16)
    return {"timeUnixNano": at, "traceId": trace_id, "spanId": span_id,
            "attributes": [{"key": key, "value": ({"boolValue": value} if isinstance(value, bool)
                else {"intValue": str(value)} if isinstance(value, int) else {"stringValue": value})}
                for key, value in attributes.items()] + ([{"key": "parent.span.id", "value": {"stringValue": parent}}] if parent else [])}


def parse_codex(record: dict, state: dict) -> list[dict]:
    """Parse the observed Codex rollout JSONL protocol without reading content."""
    kind, payload = record.get("type"), record.get("payload")
    if not isinstance(payload, dict):
        return []
    timestamp = record.get("timestamp")
    if kind == "session_meta":
        session = payload.get("session_id") or payload.get("id")
        if isinstance(session, str):
            state["session"] = session
        return []
    session = state.get("session")
    if not isinstance(session, str):
        return []
    if kind == "event_msg" and payload.get("type") == "task_started":
        run = payload.get("turn_id")
        if not isinstance(run, str):
            return []
        state["run"] = run
        started = payload.get("started_at") or timestamp
        state.setdefault("runs", {})[run] = started
        item = _event("codex", session, run, "run.started", started, event_id=f"run:{run}:start")
        return [item] if item else []
    run = payload.get("turn_id") or state.get("run")
    if not isinstance(run, str):
        return []
    if kind == "event_msg" and payload.get("type") in ("task_complete", "turn_aborted"):
        failed = payload.get("type") == "turn_aborted"
        start = state.get("runs", {}).pop(run, None)
        end = timestamp
        duration = None
        if _time_ns(start) and _time_ns(end):
            duration = (int(_time_ns(end)) - int(_time_ns(start))) // 1_000_000
        role = "run.failed" if failed else "run.completed"
        item = _event("codex", session, run, role, end, event_id=f"run:{run}:end", success=not failed, duration_ms=duration)
        return [item] if item else []
    if kind != "response_item":
        return []
    item_type = payload.get("type")
    if item_type in ("function_call", "custom_tool_call", "tool_search_call", "web_search_call"):
        call_id, tool = payload.get("call_id") or payload.get("id"), payload.get("name") or item_type.removesuffix("_call")
        if not isinstance(call_id, str) or not isinstance(tool, str):
            return []
        state.setdefault("tools", {})[call_id] = {"at": timestamp, "tool": tool}
        item = _event("codex", session, run, "tool.started", timestamp, tool=tool, event_id=f"tool:{call_id}:start")
        return [item] if item else []
    if item_type in ("function_call_output", "custom_tool_call_output", "tool_search_output"):
        call_id = payload.get("call_id") or payload.get("id")
        prior = state.setdefault("tools", {}).pop(call_id, None) if isinstance(call_id, str) else None
        if not prior:
            return []
        duration = None
        if _time_ns(prior.get("at")) and _time_ns(timestamp):
            duration = (int(_time_ns(timestamp)) - int(_time_ns(prior["at"]))) // 1_000_000
        item = _event("codex", session, run, "tool.completed", timestamp, tool=prior["tool"],
                      event_id=f"tool:{call_id}:end", duration_ms=duration)
        return [item] if item else []
    return []


def parse_claude(record: dict, state: dict) -> list[dict]:
    """Parse Claude Code JSONL message envelopes, discarding all content bodies."""
    session = record.get("sessionId")
    timestamp = record.get("timestamp")
    if not isinstance(session, str):
        return []
    state["session"] = session
    kind = record.get("type")
    if kind == "user" and not record.get("sourceToolAssistantUUID"):
        run = record.get("promptId") or record.get("uuid")
        if not isinstance(run, str):
            return []
        state["run"] = run
        state.setdefault("runs", {})[run] = timestamp
        item = _event("claude-code", session, run, "run.started", timestamp, event_id=f"run:{run}:start")
        return [item] if item else []
    run = state.get("run")
    if not isinstance(run, str):
        return []
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return []
    result = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if kind == "assistant" and block.get("type") == "tool_use":
            call_id, tool = block.get("id"), block.get("name")
            if isinstance(call_id, str) and isinstance(tool, str):
                state.setdefault("tools", {})[call_id] = {"at": timestamp, "tool": tool}
                item = _event("claude-code", session, run, "tool.started", timestamp, tool=tool, event_id=f"tool:{call_id}:start")
                if item: result.append(item)
        elif kind == "user" and block.get("type") == "tool_result":
            call_id = block.get("tool_use_id")
            prior = state.setdefault("tools", {}).pop(call_id, None) if isinstance(call_id, str) else None
            if prior:
                failed = block.get("is_error") is True
                duration = None
                if _time_ns(prior.get("at")) and _time_ns(timestamp):
                    duration = (int(_time_ns(timestamp)) - int(_time_ns(prior["at"]))) // 1_000_000
                item = _event("claude-code", session, run, "tool.failed" if failed else "tool.completed",
                              timestamp, tool=prior["tool"], event_id=f"tool:{call_id}:end",
                              success=not failed, duration_ms=duration)
                if item: result.append(item)
    return result


def _load(path: Path, default: dict) -> dict:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else default
    except (OSError, ValueError):
        return default


def _post(config: dict, records: list[dict]) -> None:
    body = json.dumps({"resourceLogs": [{"resource": {"attributes": [{"key": "service.namespace", "value": {"stringValue": "hivra.native"}}]},
        "scopeLogs": [{"scope": {"name": "hivra-agent-trace"}, "logRecords": records}]}]}).encode()
    request = urllib.request.Request(config["endpoint"], data=body, method="POST", headers={
        "Authorization": "Bearer " + config["token"], "X-Hivra-Resource-Id": config["resourceId"],
        "Content-Type": "application/json", "User-Agent": "hivra-agent-trace/1"})
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError("collector rejected telemetry")


def run_once(config: dict, state: dict) -> bool:
    records = []
    parsers = (("codex", "/home/bux/.codex/sessions/**/*.jsonl", parse_codex),
               ("claude", "/home/bux/.claude/projects/**/*.jsonl", parse_claude))
    for source, pattern, parser in parsers:
        source_state = state.setdefault(source, {})
        for name in sorted(glob.glob(pattern, recursive=True)):
            file_state = source_state.setdefault(name, {"offset": 0, "parser": {}})
            try:
                with open(name, "rb") as stream:
                    stream.seek(file_state["offset"])
                    while len(records) < 400:
                        line = stream.readline(MAX_LINE + 1)
                        if not line: break
                        if len(line) > MAX_LINE or not line.endswith(b"\n"): break
                        file_state["offset"] = stream.tell()
                        try: value = json.loads(line)
                        except (ValueError, UnicodeError): continue
                        if isinstance(value, dict): records.extend(parser(value, file_state["parser"]))
            except OSError:
                continue
    now = time.time()
    if now - float(state.get("heartbeat", 0)) >= 300:
        heartbeat = _event("hivra-agent-trace", config["resourceId"], "collector", "collector.heartbeat",
                           time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), event_id=f"heartbeat:{int(now // 300)}")
        if heartbeat: records.append(heartbeat)
        state["heartbeat"] = now
    if not records:
        return False
    _post(config, records)
    return True


def main() -> None:
    config = _load(CONFIG, {})
    if set(config) != {"endpoint", "resourceId", "token", "expiresAt"}:
        raise SystemExit("invalid trace configuration")
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    state = _load(STATE, {})
    while True:
        candidate = json.loads(json.dumps(state))
        try:
            changed = run_once(config, candidate)
            if changed:
                temporary = STATE.with_suffix(".tmp")
                temporary.write_text(json.dumps(candidate, separators=(",", ":")))
                os.chmod(temporary, 0o600)
                os.replace(temporary, STATE)
                state = candidate
        except (OSError, RuntimeError, urllib.error.URLError):
            pass
        time.sleep(10)


if __name__ == "__main__":
    main()
