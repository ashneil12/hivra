"""Tests for the guest agent-run reporter (hivra-agent-trace.py).

Fixtures follow the real Codex rollout and Claude Code transcript shapes
measured on real machines: integer Codex started_at, fork replay ordinals,
item_completed joins, one Claude record per content block, subagent files.
Every content field carries SECRET, which must never leave the guest.
"""
import calendar
import collections
import http.client
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "hivra-agent-trace.py"
spec = importlib.util.spec_from_file_location("hivra_agent_trace", SCRIPT)
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)

SECRET = "SENTINEL-content-4d1e9a"
SENTINEL_ENUM = "sentinel_enum_4d1e9a"  # shaped like an error enum, so only field choice keeps it out
RESOURCE = "00000000-0000-4000-8000-000a00000004"
TOKEN = ".".join(("hvra_otlp_v1", "eyJ2IjoxfQ", "c2lnbmF0dXJlLW9uZQ"))  # built at runtime: synthetic, never a literal credential
NEW_TOKEN = ".".join(("hvra_otlp_v1", "eyJ2IjoxfQ", "c2lnbmF0dXJlLXR3bw"))
ENDPOINT = "https://dashboard.test/api/activity/ingest"
T0 = 1789934400  # 2026-09-20T20:00:00Z


def iso(seconds, ms=0):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(seconds)) + ".%03dZ" % ms


def ns(seconds, ms=0):
    return (seconds * 1000 + ms) * 10**6


def attrs(record):
    out = {}
    for item in record["attributes"]:
        kind, value = next(iter(item["value"].items()))
        out[item["key"]] = int(value) if kind == "intValue" else value
    return out


def roles(records):
    return [attrs(record)["event.name"] for record in records]


def context(path="/home/bux/.codex/sessions/rollout-a.jsonl", agent=None):
    return trace.Context(path, agent, collections.Counter())


def feed(parser, records, state=None, ctx=None):
    state = {} if state is None else state
    ctx = ctx or context()
    out = []
    for index, record in enumerate(records):
        ctx.offset = index * 100
        out.extend(item for item in parser(record, state, ctx) if item is not None)
    return out, state


# --- Codex fixtures ------------------------------------------------------------

def codex_meta(session="019a-session-root", thread=None, ordinal=0, **extra):
    payload = {"id": thread or session, "session_id": session, "cwd": "/home/bux/" + SECRET,
               "base_instructions": {"text": SECRET}, "git": {"branch": SECRET}}
    payload.update(extra)
    return {"timestamp": iso(T0), "ordinal": ordinal, "type": "session_meta", "payload": payload}


def codex(kind, seconds, payload, ms=0, ordinal=None):
    record = {"timestamp": iso(seconds, ms), "type": kind, "payload": payload}
    if ordinal is not None:
        record["ordinal"] = ordinal
    return record


def codex_turn(turn="turn-1", start=T0 + 1, calls=1, error=None):
    records = [codex("event_msg", start, {"type": "task_started", "turn_id": turn, "started_at": start}, ms=250),
               codex("event_msg", start, {"type": "user_message", "message": SECRET})]
    for index in range(calls):
        call = "call-%s-%d" % (turn, index)
        records.append(codex("response_item", start + 1, {"type": "function_call", "id": "fc-" + call,
                                                          "call_id": call, "name": "exec_command",
                                                          "arguments": json.dumps({"cmd": SECRET})}))
        records.append(codex("response_item", start + 2, {"type": "function_call_output", "call_id": call,
                                                          "output": SECRET}))
    complete = {"type": "task_complete", "turn_id": turn, "started_at": start, "completed_at": start + 5,
                "duration_ms": 5234, "last_agent_message": SECRET}
    if error is not None:
        complete["error"] = error
    records.append(codex("event_msg", start + 5, complete, ms=500))
    return records


# --- Claude fixtures -----------------------------------------------------------

def claude(kind, seconds, session="5a1c-session", ms=0, **fields):
    record = {"type": kind, "sessionId": session, "timestamp": iso(seconds, ms), "uuid": "u-%d-%d" % (seconds, ms),
              "cwd": "/home/bux/" + SECRET, "gitBranch": SECRET}
    record.update(fields)
    return record


def prompt(seconds, prompt_id, **fields):
    return claude("user", seconds, promptId=prompt_id, message={"role": "user", "content": SECRET}, **fields)


def tool_use(seconds, call, name="Bash", stop="tool_use", **fields):
    return claude("assistant", seconds, message={"id": "msg-1", "stop_reason": stop, "content": [
        {"type": "tool_use", "id": call, "name": name, "input": {"command": SECRET}}]}, **fields)


def tool_result(seconds, call, prompt_id, is_error="absent", **fields):
    block = {"type": "tool_result", "tool_use_id": call, "content": SECRET}
    if is_error != "absent":
        block["is_error"] = is_error
    return claude("user", seconds, promptId=prompt_id, sourceToolAssistantUUID="a-1",
                  toolUseResult={"stdout": SECRET, "agentId": "a1"}, message={"role": "user", "content": [block]},
                  **fields)


def text(seconds, stop="end_turn", ms=0, **fields):
    return claude("assistant", seconds, ms=ms, message={"id": "msg-2", "stop_reason": stop, "content": [
        {"type": "text", "text": SECRET}]}, **fields)


def result_line(seconds, call, prompt_id, content, result=None, is_error="absent", order="first", sidechain=False):
    """A Claude Code tool-result line byte for byte as written (compact, real key order)."""
    block = {"tool_use_id": call, "type": "tool_result"} if order == "first" else {"type": "tool_result"}
    block["content"] = content
    if is_error != "absent":
        block["is_error"] = is_error
    if order == "last":
        block["tool_use_id"] = call
    record = {"parentUuid": "a-1", "isSidechain": sidechain, "promptId": prompt_id, "type": "user",
              "message": {"role": "user", "content": [block]}, "uuid": "00000000-0000-4000-8000-000a00000001",
              "timestamp": iso(seconds)}
    if result is not None:
        record["toolUseResult"] = result
    record.update({"sourceToolAssistantUUID": "a-1", "userType": "external", "entrypoint": "cli",
                   "cwd": "/home/bux/" + SECRET, "sessionId": "5a1c-session", "version": "2.1.0", "gitBranch": SECRET})
    return json.dumps(record, separators=(",", ":"))


class ProcessKilled(BaseException):
    """Stands in for the OOM killer: nothing in the reporter may catch it or clean up after it."""


class ParseSpy:
    """Replaces the json module inside the reporter: counts parses of long lines and can kill one."""

    def __init__(self, kill_on=None):
        self.kill_on, self.long_parses = kill_on, 0

    def loads(self, data, **kwargs):
        if len(data) > 100_000:
            self.long_parses += 1
            if self.kill_on is not None and self.kill_on in data:
                raise ProcessKilled()
        return json.loads(data, **kwargs)

    def __getattr__(self, name):
        return getattr(json, name)


def spy_on_parses(test, **kwargs):
    spy = ParseSpy(**kwargs)
    trace.json = spy
    test.addCleanup(setattr, trace, "json", json)
    return spy


class TimeParsingTest(unittest.TestCase):
    def check_times(self):
        self.assertEqual(trace.time_ns("2026-09-20T20:00:00.123Z"), ns(T0, 123))
        self.assertEqual(trace.time_ns("2026-09-20T22:00:00.5+02:00"), ns(T0, 500))
        self.assertEqual(trace.time_ns("2026-09-20T15:00:00-05:00"), ns(T0))
        self.assertEqual(trace.time_ns("2026-09-20T20:00:00.000000007Z"), ns(T0) + 7)
        self.assertEqual(trace.time_ns(T0), ns(T0))                 # Codex epoch seconds
        self.assertEqual(trace.time_ns(T0 * 1000 + 42), ns(T0, 42))  # epoch milliseconds
        for bad in (True, None, "2026-09-20T20:00:00", "2026-02-30T00:00:00Z", "yesterday", 12, [T0], "2026-09-20 20:00:00Z"):
            self.assertIsNone(trace.time_ns(bad), bad)

    def test_utc_parsing_keeps_subsecond_precision(self):
        self.check_times()

    def test_local_timezone_never_shifts_times(self):
        previous = os.environ.get("TZ")
        try:
            for zone in ("America/New_York", "Asia/Kolkata"):
                os.environ["TZ"] = zone
                time.tzset()
                self.check_times()
                records, _ = feed(trace.parse_codex, [codex_meta(), *codex_turn()])
                self.assertEqual(records[0]["timeUnixNano"], str(ns(T0 + 1, 250)))
        finally:
            if previous is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = previous
            time.tzset()


class CodexParserTest(unittest.TestCase):
    def test_run_tools_identifiers_and_durations(self):
        records = [
            codex_meta(),
            codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "turn-1", "started_at": T0 + 1}, ms=250),
            codex("response_item", T0 + 2, {"type": "function_call", "id": "fc-1", "call_id": "call-1", "name": "js",
                                            "namespace": "mcp__cua_repl", "arguments": SECRET}),
            codex("event_msg", T0 + 4, {"type": "item_completed", "turn_id": "turn-1", "started_at_ms": ns(T0 + 2) // 10**6,
                                        "completed_at_ms": ns(T0 + 3, 700) // 10**6,
                                        "item": {"type": "CommandExecution", "id": "call-1", "status": "failed",
                                                 "exit_code": 2, "aggregated_output": SECRET}}),
            codex("response_item", T0 + 4, {"type": "function_call_output", "call_id": "call-1", "output": SECRET}),
            codex("response_item", T0 + 5, {"type": "function_call", "call_id": "call-2", "name": "find_code",
                                            "namespace": "mcp__memtrace__", "arguments": SECRET}),
            codex("event_msg", T0 + 6, {"type": "item_completed", "item": {"type": "CommandExecution", "id": "call-2",
                                                                           "status": "completed", "exit_code": 0}}),
            codex("response_item", T0 + 6, {"type": "function_call_output", "call_id": "call-2", "output": SECRET}),
            codex("response_item", T0 + 7, {"type": "custom_tool_call", "id": "ctc-3", "call_id": "call-3",
                                            "name": "exec", "status": "completed", "input": SECRET}),
            codex("response_item", T0 + 9, {"type": "custom_tool_call_output", "call_id": "call-3", "output": SECRET},
                  ms=120),
            codex("event_msg", T0 + 10, {"type": "task_complete", "turn_id": "turn-1", "started_at": T0 + 1,
                                         "completed_at": T0 + 10, "duration_ms": 9321, "last_agent_message": SECRET},
                  ms=400),
        ]
        out, state = feed(trace.parse_codex, records)
        self.assertEqual(roles(out), ["run.started", "tool.started", "tool.failed", "tool.started", "tool.completed",
                                      "tool.started", "tool.completed", "run.completed"])
        values = [attrs(record) for record in out]
        self.assertEqual({v["conversation.id"] for v in values}, {"019a-session-root"})
        self.assertEqual({v["session.id"] for v in values}, {"turn-1"})
        self.assertEqual({v["service.name"] for v in values}, {"codex"})
        # Integer started_at is refined to the record's millisecond timestamp.
        self.assertEqual(out[0]["timeUnixNano"], str(ns(T0 + 1, 250)))
        self.assertEqual(out[-1]["timeUnixNano"], str(ns(T0 + 10, 400)))
        self.assertEqual(values[-1]["duration_ms"], 9321)
        self.assertEqual(values[1]["tool.name"], "mcp__cua_repl__js")
        self.assertEqual(values[3]["tool.name"], "mcp__memtrace__find_code")
        # item_completed is the structured result and timing source.
        self.assertEqual((values[2]["success"], values[2]["duration_ms"]), (False, 1700))
        self.assertEqual(out[2]["severityNumber"], 13)
        self.assertIs(values[4]["success"], True)
        self.assertNotIn("success", values[6])  # no structured result joins code-mode exec
        self.assertEqual(values[6]["duration_ms"], 2120)
        # Identifiers: one trace per run, run span on run records, one span per tool.
        self.assertEqual(len({record["traceId"] for record in out}), 1)
        run_span = out[0]["spanId"]
        self.assertEqual(out[-1]["spanId"], run_span)
        self.assertEqual(out[1]["spanId"], out[2]["spanId"])
        self.assertNotEqual(out[1]["spanId"], out[3]["spanId"])
        self.assertTrue(all(v["parent.span.id"] == run_span for v in values[1:-1]))
        self.assertNotIn("parent.span.id", values[0])
        ids = [v["event.id"] for v in values]
        self.assertEqual(len(set(ids)), len(ids))
        for record, value in zip(out, values):
            self.assertRegex(record["traceId"], r"^[0-9a-f]{32}$")
            self.assertRegex(record["spanId"], r"^[0-9a-f]{16}$")
            self.assertRegex(value["event.id"], r"^[0-9a-f]{32}$")
        self.assertEqual(state.get("T"), {})
        self.assertEqual(state.get("R"), {})
        again, _ = feed(trace.parse_codex, records)
        self.assertEqual(again, out)  # stable across restarts and replays
        self.assertNotIn(SECRET, json.dumps(out))

    def test_error_end_uses_enum_only_and_abort_is_stopped(self):
        out, _ = feed(trace.parse_codex, [
            codex_meta(),
            *codex_turn("turn-1", error={"message": SENTINEL_ENUM, "codex_error_info": "server_overloaded"}),
            *codex_turn("turn-2", start=T0 + 20, error={"message": SECRET, "codex_error_info": "Not An Enum"}),
            codex("event_msg", T0 + 30, {"type": "task_started", "turn_id": "turn-3", "started_at": T0 + 30}),
            codex("event_msg", T0 + 33, {"type": "turn_aborted", "turn_id": "turn-3", "reason": SECRET,
                                         "duration_ms": 3000}),
        ])
        ends = [attrs(record) for record in out if attrs(record)["event.name"].startswith("run.") and
                attrs(record)["event.name"] != "run.started"]
        self.assertEqual([end["event.name"] for end in ends], ["run.failed", "run.failed", "run.stopped"])
        self.assertEqual(ends[0]["error.type"], "server_overloaded")
        self.assertNotIn("error.type", ends[1])
        self.assertEqual(ends[2]["duration_ms"], 3000)
        self.assertEqual([r["severityNumber"] for r in out if attrs(r)["event.name"] == "run.failed"], [17, 17])
        self.assertNotIn(SENTINEL_ENUM, json.dumps(out))

    def test_new_task_stops_a_run_that_never_ended(self):
        out, _ = feed(trace.parse_codex, [
            codex_meta(),
            codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "turn-1", "started_at": T0 + 1}),
            *codex_turn("turn-2", start=T0 + 60),
        ])
        self.assertEqual(roles(out)[:3], ["run.started", "run.stopped", "run.started"])
        self.assertEqual(attrs(out[1])["session.id"], "turn-1")
        self.assertEqual(attrs(out[1])["duration_ms"], 59250)  # to the refined start of turn-2

    def test_fork_replay_is_skipped(self):
        records = [
            codex_meta(session="root-session", thread="child-thread", subagent_history_start_ordinal=4,
                       forked_from_id="parent-thread"),
            codex_meta(session="other-session", thread="parent-thread", ordinal=1),
            codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "parent-turn", "started_at": T0}, ordinal=2),
            codex("response_item", T0 + 1, {"type": "function_call", "call_id": "parent-call", "name": "x"}, ordinal=3),
            codex("event_msg", T0 + 2, {"type": "task_started", "turn_id": "child-turn", "started_at": T0 + 2}, ordinal=4),
            codex("response_item", T0 + 3, {"type": "function_call_output", "call_id": "parent-call"}, ordinal=5),
            codex("event_msg", T0 + 4, {"type": "task_complete", "turn_id": "child-turn", "duration_ms": 2000}, ordinal=6),
        ]
        ctx = context()
        out, _ = feed(trace.parse_codex, records, ctx=ctx)
        self.assertEqual(roles(out), ["run.started", "run.completed"])
        self.assertEqual({attrs(r)["session.id"] for r in out}, {"child-turn"})
        self.assertEqual({attrs(r)["conversation.id"] for r in out}, {"root-session"})
        self.assertEqual(ctx.stats["codex.replay_skipped"], 2)

    def test_web_search_and_outputs_keyed_by_item_id(self):
        records = [
            codex_meta(),
            codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "turn-1", "started_at": T0 + 1}),
            codex("response_item", T0 + 2, {"type": "web_search_call", "status": "completed",
                                            "action": {"type": "search", "query": SECRET}}),
            codex("response_item", T0 + 3, {"type": "function_call", "id": "fc-9", "call_id": "call-9", "name": "a"}),
            codex("response_item", T0 + 4, {"type": "function_call_output", "id": "fc-9", "output": SECRET}),
            codex("response_item", T0 + 4, {"type": "local_shell_call", "call_id": "ls-1", "action": SECRET}),
            codex("response_item", T0 + 5, {"type": "tool_search_call", "call_id": "ts-1", "execution": SECRET}),
            codex("response_item", T0 + 5, {"type": "tool_search_output", "call_id": "ts-1", "tools": SECRET}),
        ]
        out, _ = feed(trace.parse_codex, records)
        self.assertEqual(roles(out), ["run.started", "tool.completed", "tool.started", "tool.completed",
                                      "tool.started", "tool.started", "tool.completed"])
        search = attrs(out[1])
        self.assertEqual(search["tool.name"], "web_search")
        self.assertNotIn("success", search)
        self.assertEqual(out[2]["spanId"], out[3]["spanId"])
        self.assertEqual([attrs(out[i])["tool.name"] for i in (4, 5)], ["local_shell", "tool_search"])
        same, _ = feed(trace.parse_codex, records)
        moved, _ = feed(trace.parse_codex, records, ctx=context("/home/bux/.codex/sessions/rollout-b.jsonl"))
        self.assertEqual(attrs(same[1])["event.id"], search["event.id"])
        self.assertNotEqual(attrs(moved[1])["event.id"], search["event.id"])

    def test_invalid_names_are_omitted_and_sessionless_records_dropped(self):
        out, _ = feed(trace.parse_codex, [
            codex("event_msg", T0, {"type": "task_started", "turn_id": "turn-0", "started_at": T0}),
            codex_meta(),
            codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "turn-1", "started_at": T0 + 1}),
            codex("response_item", T0 + 2, {"type": "function_call", "call_id": "c1", "name": "exec ünicode"}),
            codex("event_msg", T0 + 3, {"type": "task_started", "turn_id": "bad turn!", "started_at": T0 + 3}),
        ])
        self.assertEqual(roles(out), ["run.started", "tool.started"])
        self.assertNotIn("tool.name", attrs(out[1]))


class ClaudeParserTest(unittest.TestCase):
    def test_run_lifecycle_tools_and_held_end(self):
        records = [
            prompt(T0, "p-1"),
            prompt(T0, "p-1", isMeta=True),
            prompt(T0 + 1, "p-new", isMeta=True),
            prompt(T0 + 1, "p-compact", isCompactSummary=True),
            tool_use(T0 + 2, "toolu-1", name="Read"),
            tool_use(T0 + 2, "toolu-2", name="Grep"),
            tool_use(T0 + 2, "toolu-3", name="Bash"),
            tool_result(T0 + 3, "toolu-1", "p-1"),
            tool_result(T0 + 4, "toolu-2", "p-1", is_error=False),
            tool_result(T0 + 5, "toolu-3", "p-1", is_error=True),
            claude("assistant", T0 + 6, message={"stop_reason": "end_turn", "content": [{"type": "thinking",
                                                                                         "thinking": SECRET}]}),
            text(T0 + 6, ms=900),
        ]
        out, state = feed(trace.parse_claude, records, ctx=context("/p/s.jsonl"))
        self.assertEqual(roles(out), ["run.started", "tool.started", "tool.started", "tool.started", "tool.completed",
                                      "tool.completed", "tool.failed"])
        values = [attrs(r) for r in out]
        self.assertEqual({v["session.id"] for v in values}, {"p-1"})
        self.assertEqual({v["conversation.id"] for v in values}, {"5a1c-session"})
        self.assertNotIn("success", values[4])
        self.assertIs(values[5]["success"], True)
        self.assertIs(values[6]["success"], False)
        self.assertEqual([values[i]["duration_ms"] for i in (4, 5, 6)], [1000, 2000, 3000])
        self.assertEqual(out[1]["spanId"], out[4]["spanId"])
        self.assertEqual(values[4]["parent.span.id"], out[0]["spanId"])
        # The end is held for turn_duration / the next prompt / a quiet file.
        end = trace.claude_flush(state)
        self.assertEqual(roles(end), ["run.completed"])
        self.assertEqual(end[0]["timeUnixNano"], str(ns(T0 + 6, 900)))
        self.assertEqual(attrs(end[0])["duration_ms"], 6900)
        self.assertEqual(end[0]["spanId"], out[0]["spanId"])
        self.assertEqual(trace.claude_flush(state), [])  # once
        self.assertNotIn(SECRET, json.dumps(out + end))

    def test_turn_duration_is_the_run_duration(self):
        out, _ = feed(trace.parse_claude, [
            prompt(T0, "p-1"), text(T0 + 3),
            claude("system", T0 + 3, subtype="turn_duration", durationMs=2750, messageCount=3),
        ])
        self.assertEqual(roles(out), ["run.started", "run.completed"])
        self.assertEqual(attrs(out[1])["duration_ms"], 2750)

    def test_end_turn_with_open_tool_does_not_complete(self):
        out, state = feed(trace.parse_claude, [prompt(T0, "p-1"), tool_use(T0 + 1, "toolu-1"), text(T0 + 2)])
        self.assertEqual(roles(out), ["run.started", "tool.started"])
        self.assertEqual(trace.claude_flush(state), [])

    def test_new_prompt_stops_open_run_or_finalises_held_end(self):
        out, _ = feed(trace.parse_claude, [
            prompt(T0, "p-1"), tool_use(T0 + 1, "toolu-1"),
            prompt(T0 + 10, "p-2"), text(T0 + 12),
            prompt(T0 + 20, "p-3"),
        ])
        self.assertEqual(roles(out), ["run.started", "tool.started", "run.stopped", "run.started", "run.completed",
                                      "run.started"])
        self.assertEqual([attrs(out[i])["session.id"] for i in (2, 4)], ["p-1", "p-2"])
        self.assertEqual(attrs(out[2])["duration_ms"], 10000)
        self.assertEqual(attrs(out[4])["duration_ms"], 2000)

    def test_tool_use_after_end_turn_continues_the_run(self):
        out, state = feed(trace.parse_claude, [
            prompt(T0, "p-1"), text(T0 + 1),
            claude("system", T0 + 1, subtype="stop_hook_summary"),
            tool_use(T0 + 2, "toolu-9"), tool_result(T0 + 3, "toolu-9", "p-1"), text(T0 + 4),
        ])
        self.assertEqual(roles(out), ["run.started", "tool.started", "tool.completed"])
        end = trace.claude_flush(state)
        self.assertEqual(attrs(end[0])["duration_ms"], 4000)

    def test_max_tokens_is_not_the_end_of_the_task(self):
        # The shape measured on real transcripts: the model hits max_tokens
        # mid-thinking and Claude Code continues the same task with tools.
        ctx = context("/p/s.jsonl")
        out, state = feed(trace.parse_claude, [
            prompt(T0, "p-1"),
            claude("assistant", T0 + 1, message={"stop_reason": "max_tokens", "content": [
                {"type": "thinking", "thinking": SECRET}]}),
        ], ctx=ctx)
        self.assertEqual(roles(out), ["run.started"])
        # A quiet file (the continuation can take longer than QUIET_SECONDS) must not end the run.
        self.assertEqual(trace.claude_flush(state), [])
        more, _ = feed(trace.parse_claude, [
            claude("assistant", T0 + 50, message={"stop_reason": "tool_use", "content": [{"type": "thinking",
                                                                                         "thinking": SECRET}]}),
            tool_use(T0 + 50, "toolu-1"), tool_result(T0 + 51, "toolu-1", "p-1"), text(T0 + 52),
            claude("system", T0 + 52, subtype="turn_duration", durationMs=52000),
        ], state, ctx)
        self.assertEqual(roles(more), ["tool.started", "tool.completed", "run.completed"])
        self.assertEqual((more[-1]["timeUnixNano"], attrs(more[-1])["duration_ms"]), (str(ns(T0 + 52)), 52000))
        self.assertEqual(ctx.stats["claude.after_end"], 0)
        self.assertNotIn("max_tokens", trace.CLAUDE_TERMINAL)

    def test_records_after_an_emitted_end_are_counted(self):
        ctx = context("/p/s.jsonl")
        out, state = feed(trace.parse_claude, [prompt(T0, "p-1"), text(T0 + 1)], ctx=ctx)
        out += trace.claude_flush(state)  # the file went quiet: final
        later, _ = feed(trace.parse_claude, [tool_use(T0 + 60, "toolu-9"), text(T0 + 61)], state, ctx)
        self.assertEqual(roles(out), ["run.started", "run.completed"])
        # Still reported (they happened), never a second end, and counted as an early end.
        self.assertEqual(roles(later), ["tool.started"])
        self.assertEqual(ctx.stats["claude.after_end"], 2)

    def test_api_error_fails_the_run_with_enum_only(self):
        out, _ = feed(trace.parse_claude, [
            prompt(T0, "p-1"),
            text(T0 + 1, stop="stop_sequence", isApiErrorMessage=True, error="server_error"),
            prompt(T0 + 5, "p-2"),
            text(T0 + 6, stop="stop_sequence", isApiErrorMessage=True, error="Rate limited: " + SECRET),
        ])
        self.assertEqual(roles(out), ["run.started", "run.failed", "run.started", "run.failed"])
        self.assertEqual(attrs(out[1])["error.type"], "server_error")
        self.assertNotIn("error.type", attrs(out[3]))
        self.assertEqual(out[1]["severityNumber"], 17)

    def test_subagent_file_is_its_own_run_in_the_same_conversation(self):
        parent, _ = feed(trace.parse_claude, [prompt(T0, "p-1")])
        sub = [
            prompt(T0 + 1, "p-1", isSidechain=True, agentId="a1b2c3", parentUuid=None),
            tool_use(T0 + 2, "toolu-s1", isSidechain=True, agentId="a1b2c3", promptId="p-1"),
            tool_result(T0 + 3, "toolu-s1", "p-1", isSidechain=True, agentId="a1b2c3"),
            prompt(T0 + 4, "p-1", isSidechain=True, agentId="a1b2c3"),
            text(T0 + 5, isSidechain=True, agentId="a1b2c3"),
        ]
        out, state = feed(trace.parse_claude, sub, ctx=context("/p/s/subagents/agent-a1b2c3.jsonl", "agent:a1b2c3"))
        out += trace.claude_flush(state)
        self.assertEqual(roles(out), ["run.started", "tool.started", "tool.completed", "run.completed"])
        self.assertEqual({attrs(r)["session.id"] for r in out}, {"agent:a1b2c3"})
        self.assertEqual({attrs(r)["conversation.id"] for r in out}, {"5a1c-session"})
        self.assertNotEqual(out[0]["traceId"], parent[0]["traceId"])
        # An inline sidechain in a main transcript never disturbs the main run.
        inline, state = feed(trace.parse_claude, [prompt(T0, "p-1"), *sub, tool_use(T0 + 6, "toolu-m1")])
        self.assertEqual(roles(inline), ["run.started", "tool.started"])
        self.assertEqual({attrs(r)["session.id"] for r in inline}, {"p-1"})
        self.assertEqual(state["o"], 1)


class TrackerTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.home = os.path.join(self.directory.name, "home")
        self.sessions = os.path.join(self.home, ".codex", "sessions", "2026", "09", "20")
        self.projects = os.path.join(self.home, ".claude", "projects", "-home-bux")
        os.makedirs(self.sessions)
        os.makedirs(self.projects)
        self.files = {}
        self.tracker = trace.Tracker(self.home, self.files)

    def tearDown(self):
        self.directory.cleanup()

    def write(self, path, records, mode="w", tail="\n"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, mode) as stream:
            stream.write("".join((r if isinstance(r, str) else json.dumps(r)) + "\n" for r in records[:-1]))
            if records:
                last = records[-1]
                stream.write((last if isinstance(last, str) else json.dumps(last)) + tail)
        return path

    def collect(self, now=None, **limits):
        records = []
        working, complete = self.tracker.collect(
            records.append, max_records=limits.get("max_records", 10**9), max_bytes=limits.get("max_bytes", 10**12),
            now=time.time() + 3600 if now is None else now)
        self.tracker.commit(working)
        return records

    def test_oversize_lines_are_skipped_and_offsets_advance(self):
        path = os.path.join(self.sessions, "rollout-big.jsonl")
        output = codex("response_item", T0 + 3, {"type": "custom_tool_call_output", "call_id": "call-1",
                                                 "output": SECRET * (trace.MAX_LINE // len(SECRET) + 10)}, ordinal=3)
        compacted = codex("compacted", T0 + 4, {"message": SECRET * (trace.MAX_LINE // len(SECRET) + 10)}, ordinal=4)
        self.write(path, [
            codex_meta(),
            codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "turn-1", "started_at": T0 + 1}, ordinal=1),
            codex("response_item", T0 + 2, {"type": "custom_tool_call", "call_id": "call-1", "name": "exec",
                                            "input": SECRET}, ordinal=2),
            json.dumps(output, separators=(",", ":")),
            json.dumps(compacted, separators=(",", ":")),
            codex("event_msg", T0 + 5, {"type": "task_complete", "turn_id": "turn-1", "duration_ms": 4000}, ordinal=5),
        ])
        claude_path = self.write(os.path.join(self.projects, "s.jsonl"), [
            prompt(T0, "p-1"),
            json.dumps(tool_result(T0 + 1, "x", "p-1") | {"pad": SECRET * (trace.MAX_LINE // len(SECRET) + 10)}),
            tool_use(T0 + 2, "toolu-big", name="Read"),
            # Oversize, in Claude Code's own layout: id in the head, is_error and time in the tail.
            result_line(T0 + 3, "toolu-big", "p-1", SECRET * (trace.MAX_LINE // len(SECRET) + 10), is_error=False,
                        result={"type": "text"}),
            text(T0 + 4),
        ])
        out = self.collect()
        self.assertEqual(roles(out), ["run.started", "tool.started", "tool.completed", "run.completed",
                                      "run.started", "tool.started", "tool.completed", "run.completed"])
        self.assertEqual(attrs(out[2])["duration_ms"], 1000)
        recovered = attrs(out[6])
        self.assertEqual((out[6]["timeUnixNano"], recovered["tool.name"], recovered["success"], recovered["duration_ms"]),
                         (str(ns(T0 + 3)), "Read", True, 1000))
        self.assertEqual(self.files[path]["o"], os.path.getsize(path))
        self.assertEqual(self.files[claude_path]["o"], os.path.getsize(claude_path))
        self.assertEqual(self.tracker.stats["lines.oversize"], 4)
        self.assertEqual(self.tracker.stats["lines.oversize_recovered"], 2)
        self.assertEqual(self.collect(), [])

    def test_container_heavy_lines_are_never_parsed_and_their_envelope_is_recovered(self):
        spy = spy_on_parses(self)
        heavy = [{}] * (trace.MAX_CONTAINERS + 10)            # real JSON containers
        braces = "{[" * (trace.MAX_CONTAINERS // 2 + 10)      # container bytes inside a string count too
        claude_path = self.write(os.path.join(self.projects, "r.jsonl"), [
            prompt(T0, "p-1"),
            tool_use(T0 + 1, "toolu-a", name="Read"),
            # Message small, toolUseResult heavy: id, is_error and time are all in the head.
            result_line(T0 + 2, "toolu-a", "p-1", SECRET, result={"file": heavy}, is_error=True),
            tool_use(T0 + 3, "toolu-b", name="Grep"),
            # Content heavy, id written last: id, is_error and time are in the tail.
            result_line(T0 + 4, "toolu-b", "p-1", braces, result={"n": 1}, is_error=False, order="last"),
            tool_use(T0 + 5, "toolu-c", name="Bash"),
            # Both heavy: the time is in the unread middle, so the next record's time ends it.
            result_line(T0 + 6, "toolu-c", "p-1", braces, result={"file": heavy}),
            text(T0 + 9),
        ])
        waiting = self.write(os.path.join(self.projects, "w.jsonl"), [
            prompt(T0, "p-2"), tool_use(T0 + 1, "toolu-d", name="Bash"),
            result_line(T0 + 2, "toolu-d", "p-2", braces, result={"file": heavy}),
        ])
        os.utime(waiting, (T0 + 30, T0 + 30))
        rollout = self.write(os.path.join(self.sessions, "rollout-heavy.jsonl"), [
            codex_meta(), codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "turn-1", "started_at": T0 + 1}),
            # A call's id follows its arguments, so only the tail has it.
            json.dumps(codex("response_item", T0 + 2, {"type": "function_call", "id": "fc-1", "name": "apply_patch",
                                                      "arguments": braces, "call_id": "call-1"}), separators=(",", ":")),
            codex("response_item", T0 + 3, {"type": "function_call_output", "call_id": "call-1", "output": SECRET}),
        ])
        out = self.collect()
        by_file = collections.defaultdict(list)
        for record in out:
            by_file[attrs(record)["service.name"] + ":" + attrs(record)["session.id"]].append(record)
        main, other, codex_run = by_file["claude-code:p-1"], by_file["claude-code:p-2"], by_file["codex:turn-1"]
        self.assertEqual(roles(main), ["run.started", "tool.started", "tool.failed", "tool.started", "tool.completed",
                                       "tool.started", "tool.completed", "run.completed"])
        failed, completed, deferred = attrs(main[2]), attrs(main[4]), attrs(main[6])
        self.assertEqual((main[2]["timeUnixNano"], failed["success"], failed["duration_ms"], failed["tool.name"]),
                         (str(ns(T0 + 2)), False, 1000, "Read"))
        self.assertEqual((main[4]["timeUnixNano"], completed["success"], completed["duration_ms"]),
                         (str(ns(T0 + 4)), True, 1000))
        # Upper-bound time only: no duration and no outcome are claimed.
        self.assertEqual(main[6]["timeUnixNano"], str(ns(T0 + 9)))
        self.assertEqual(main[6]["spanId"], main[5]["spanId"])
        self.assertNotIn("success", deferred)
        self.assertNotIn("duration_ms", deferred)
        # With nothing written after it, the quiet file's mtime ends it.
        self.assertEqual(roles(other), ["run.started", "tool.started", "tool.completed"])
        self.assertEqual(other[2]["timeUnixNano"], str(ns(T0 + 30)))
        self.assertEqual(roles(codex_run), ["run.started", "tool.started", "tool.completed"])
        self.assertEqual(attrs(codex_run[1])["tool.name"], "apply_patch")
        self.assertEqual(codex_run[1]["spanId"], codex_run[2]["spanId"])
        self.assertEqual(spy.long_parses, 0)
        self.assertEqual((self.tracker.stats["lines.containers"], self.tracker.stats["lines.containers_recovered"]), (5, 5))
        self.assertEqual(self.tracker.stats["claude.result_time_deferred"], 2)
        for path in (claude_path, waiting, rollout):
            self.assertEqual(self.files[path]["o"], os.path.getsize(path))
        self.assertNotIn(SECRET, json.dumps(out))
        self.assertEqual(self.collect(), [])

    def test_partial_trailing_line_waits_for_its_newline(self):
        path = os.path.join(self.sessions, "rollout-partial.jsonl")
        self.write(path, [codex_meta(), codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "t1",
                                                                    "started_at": T0 + 1})], tail="")
        self.assertEqual(self.collect(), [])
        with open(path, "a") as stream:
            stream.write("\n")
        self.assertEqual(roles(self.collect()), ["run.started"])

    def test_truncated_or_replaced_files_restart_with_fresh_state(self):
        path = self.write(os.path.join(self.sessions, "rollout-t.jsonl"), [codex_meta(), *codex_turn("turn-1")])
        self.assertEqual(len(self.collect()), 4)
        self.write(path, [codex_meta(session="s-2"), codex("event_msg", T0, {"type": "task_started", "turn_id": "t-2",
                                                                             "started_at": T0})])
        out = self.collect()
        self.assertEqual(roles(out), ["run.started"])
        self.assertEqual(attrs(out[0])["conversation.id"], "s-2")
        replacement = self.write(path + ".new", [codex_meta(session="s-3"), *codex_turn("turn-3")])
        os.replace(replacement, path)
        out = self.collect()
        self.assertEqual(len(out), 4)
        self.assertEqual({attrs(r)["conversation.id"] for r in out}, {"s-3"})
        self.assertEqual(self.tracker.stats["files.reset"], 2)

    def test_history_before_first_start_is_not_backfilled(self):
        old = self.write(os.path.join(self.sessions, "rollout-old.jsonl"), [codex_meta(session="old-s"),
                                                                              *codex_turn("turn-1")])
        os.utime(old, (T0, T0))
        self.tracker.backfill_before = time.time() - 60
        self.assertEqual(self.collect(), [])
        self.assertEqual(self.files[old]["o"], os.path.getsize(old))
        # A resumed old session keeps its conversation, seeded from session_meta.
        self.write(old, codex_turn("turn-2", start=T0 + 100), mode="a")
        new = self.write(os.path.join(self.sessions, "rollout-new.jsonl"), [codex_meta(session="new-s"),
                                                                              *codex_turn("turn-9")])
        out = self.collect()
        self.assertEqual(sorted({(attrs(r)["conversation.id"], attrs(r)["session.id"]) for r in out}),
                         [("new-s", "turn-9"), ("old-s", "turn-2")])
        self.assertEqual(self.files[new]["o"], os.path.getsize(new))

    def test_deleted_files_are_dropped_and_old_state_is_pruned(self):
        path = self.write(os.path.join(self.sessions, "rollout-p.jsonl"), [
            codex_meta(), codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "t1", "started_at": T0 + 1}),
            codex("response_item", T0 + 2, {"type": "function_call", "id": "fc", "call_id": "c1", "name": "a"}),
            codex("event_msg", T0 + 3, {"type": "item_completed", "item": {"id": "c1", "status": "failed"}})])
        claude_path = self.write(os.path.join(self.projects, "p.jsonl"), [prompt(T0, "p-1"), tool_use(T0, "tu-1")])
        self.collect()
        codex_state, claude_state = self.files[path]["p"], self.files[claude_path]["p"]
        self.assertEqual((len(codex_state["R"]), len(codex_state["T"]), len(codex_state["A"]), len(codex_state["I"])),
                         (1, 1, 1, 1))
        trace.prune_parser("codex", codex_state, ns(T0 + 23 * 3600))
        self.assertEqual(len(codex_state["T"]), 1)
        trace.prune_parser("codex", codex_state, ns(T0 + 25 * 3600))
        trace.prune_parser("claude", claude_state, ns(T0 + 25 * 3600))
        self.assertEqual((codex_state["R"], codex_state["T"], codex_state["A"], codex_state["I"], codex_state["r"]),
                         ({}, {}, {}, {}, None))
        self.assertEqual((claude_state["T"], claude_state["o"]), ({}, 0))
        os.unlink(path)
        self.collect()
        self.assertNotIn(path, self.files)
        self.assertIn(claude_path, self.files)

    def test_links_journals_and_side_files_are_ignored(self):
        target = self.write(os.path.join(self.directory.name, "elsewhere", "rollout-x.jsonl"),
                            [codex_meta(), *codex_turn()])
        os.symlink(target, os.path.join(self.sessions, "rollout-link.jsonl"))
        os.symlink(os.path.dirname(target), os.path.join(self.sessions, "linked-dir"))
        subagents = os.path.join(self.projects, "5a1c-session", "subagents")
        self.write(os.path.join(subagents, "workflows", "wf_1", "journal.jsonl"), [prompt(T0, "p-j")])
        self.write(os.path.join(subagents, "notes.jsonl"), [prompt(T0, "p-n")])
        with open(os.path.join(subagents, "agent-a1.meta.json"), "w") as stream:
            json.dump({"agentType": "general-purpose"}, stream)
        self.write(os.path.join(subagents, "workflows", "wf_1", "agent-a1.jsonl"),
                   [prompt(T0, "p-1", isSidechain=True, agentId="a1"), text(T0 + 1, isSidechain=True, agentId="a1")])
        out = self.collect()
        self.assertEqual(roles(out), ["run.started", "run.completed"])
        self.assertEqual(attrs(out[0])["session.id"], "agent:a1")

    def test_claude_end_is_final_once_the_file_is_quiet(self):
        path = self.write(os.path.join(self.projects, "q.jsonl"), [prompt(T0, "p-1"), text(T0 + 2)])
        mtime = os.path.getmtime(path)
        self.assertEqual(roles(self.collect(now=mtime + 1)), ["run.started"])
        self.assertEqual(self.collect(now=mtime + 5), [])
        self.assertEqual(roles(self.collect(now=mtime + trace.QUIET_SECONDS + 1)), ["run.completed"])
        self.assertEqual(self.collect(now=mtime + 3600), [])

    def test_collection_honours_record_limits_without_losing_lines(self):
        path = self.write(os.path.join(self.sessions, "rollout-many.jsonl"), [codex_meta(), *codex_turn(calls=30)])
        first = []
        working, complete = self.tracker.collect(first.append, max_records=25, max_bytes=10**9, now=time.time())
        self.assertEqual(len(first), 25)
        self.assertFalse(complete)
        self.tracker.commit(working)
        rest = self.collect()
        self.assertEqual(len(first) + len(rest), 62)
        self.assertEqual(len({attrs(r)["event.id"] for r in first + rest}), 62)
        self.assertEqual(self.files[path]["o"], os.path.getsize(path))


class MockIngest:
    """A local dashboard stand-in: records every request, answers from a script."""

    def __init__(self):
        self.requests = []
        self.responses = collections.defaultdict(list)
        mock = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                mock.requests.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
                queue = mock.responses[self.path]
                status, payload, extra = queue.pop(0) if queue else (200, b"{}", {})
                self.send_response(status)
                for key, value in extra.items():
                    self.send_header(key, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    def transport(self, url, headers, body, timeout):
        # The reporter only accepts https endpoints; route the fixture origin to
        # this plain-HTTP socket through the real urllib transport.
        prefix = "https://dashboard.test/"
        assert url.startswith(prefix), url
        return trace.urllib_transport("http://127.0.0.1:%d/%s" % (self.server.server_port, url[len(prefix):]),
                                      headers, body, timeout)

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def ingested(self):
        return [(headers, json.loads(body)) for path, headers, body in self.requests if path == trace.INGEST_PATH]

    @staticmethod
    def records(document):
        (resource,) = document["resourceLogs"]
        (scope,) = resource["scopeLogs"]
        return scope["logRecords"]


class ReporterTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = self.directory.name
        self.state_dir = os.path.join(self.root, "var", "lib", "hivra-agent-trace")
        os.makedirs(self.state_dir, mode=0o700)
        self.home = os.path.join(self.root, "home", "bux")
        self.sessions = os.path.join(self.home, ".codex", "sessions", "2026", "09", "20")
        self.projects = os.path.join(self.home, ".claude", "projects", "-home-bux")
        os.makedirs(self.sessions)
        os.makedirs(self.projects)
        self.mock = MockIngest()
        self.now = time.time() + 120  # every fixture file is already quiet
        self.logs = []
        self.write_credential(TOKEN, iso(int(self.now) + 6 * 86400))
        self.reporter = trace.Reporter(root=self.root, home="/home/bux", transport=self.mock.transport,
                                       clock=lambda: self.now, log=self.logs.append)
        self.reporter.state["firstStart"] = 0
        self.reporter.tracker.backfill_before = 0

    def tearDown(self):
        self.mock.close()
        self.directory.cleanup()

    def write_credential(self, token, expires):
        trace.write_atomic(os.path.join(self.state_dir, "credential.json"), trace.credential_bytes(
            {"endpoint": ENDPOINT, "resourceId": RESOURCE, "token": token, "expiresAt": expires}), 0o600)

    def write(self, name, records, directory=None):
        path = os.path.join(directory or self.sessions, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as stream:
            stream.write("".join(json.dumps(r) + "\n" for r in records))
        return path

    def all_records(self):
        return [record for _, document in self.mock.ingested() for record in self.mock.records(document)]

    def heartbeats(self):
        return [r for r in self.all_records() if attrs(r)["event.name"] == "collector.heartbeat"]

    def events(self):
        return [r for r in self.all_records() if attrs(r)["event.name"] != "collector.heartbeat"]

    def test_request_shape_heartbeat_batches_and_offsets(self):
        path = self.write("rollout-a.jsonl", [codex_meta(), *codex_turn(calls=225)])
        self.assertEqual(self.reporter.step(), trace.LOOP_SECONDS)
        ingested = self.mock.ingested()
        self.assertEqual(len(ingested), 3)
        for headers, document in ingested:
            self.assertEqual(headers["authorization"], "Bearer " + TOKEN)
            self.assertEqual(headers["x-hivra-resource-id"], RESOURCE)
            self.assertEqual(headers["content-type"], "application/json")
            self.assertEqual(document["resourceLogs"][0]["resource"]["attributes"],
                             [{"key": "service.namespace", "value": {"stringValue": "hivra.native"}}])
        # The heartbeat comes last, in its own request, once the events were accepted.
        (heartbeat,) = self.mock.records(ingested[-1][1])
        self.assertEqual(set(heartbeat), {"timeUnixNano", "severityNumber", "attributes"})
        self.assertEqual(set(attrs(heartbeat)), {"event.name", "event.id", "service.name"})
        self.assertEqual(attrs(heartbeat)["event.name"], "collector.heartbeat")
        self.assertEqual(attrs(heartbeat)["service.name"], "hivra-agent-trace")
        sizes = [len(self.mock.records(document)) for _, document in ingested[:-1]]
        self.assertEqual(sizes, [400, 52])
        records = [r for _, document in ingested[:-1] for r in self.mock.records(document)]
        self.assertEqual(len({attrs(r)["event.id"] for r in records}), 452)
        for record in records:
            self.assertEqual(set(attrs(record)) - {"event.name", "event.id", "service.name", "conversation.id",
                                                   "session.id", "tool.name", "success", "duration_ms", "error.type",
                                                   "parent.span.id"}, set())
        with open(os.path.join(self.state_dir, "state.json")) as stream:
            saved = json.load(stream)
        self.assertEqual(saved["files"][path]["o"], os.path.getsize(path))
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.state_dir, "state.json")).st_mode), 0o600)
        # Nothing new: no requests until the next heartbeat is due.
        self.now += 10
        self.reporter.step()
        self.assertEqual(len(self.mock.ingested()), 3)
        self.now += trace.HEARTBEAT_SECONDS
        self.reporter.step()
        self.assertEqual(len(self.mock.ingested()), 4)
        self.assertEqual(roles(self.mock.records(self.mock.ingested()[3][1])), ["collector.heartbeat"])

    def test_idle_files_are_forgotten_without_replay(self):
        idle = self.write("rollout-idle.jsonl", [codex_meta(session="idle-s"), *codex_turn("turn-1")])
        busy = self.write("rollout-busy.jsonl", [codex_meta(session="busy-s"), codex(
            "event_msg", T0, {"type": "task_started", "turn_id": "open-turn", "started_at": int(self.now)})])
        self.reporter.step()
        self.assertEqual(len(self.events()), 5)
        os.utime(idle, (self.now - 2 * 86400, self.now - 2 * 86400))
        os.utime(busy, (self.now - 2 * 86400, self.now - 2 * 86400))
        self.now += trace.PRUNE_INTERVAL_SECONDS
        self.reporter.step()
        # The fully read idle file is forgotten, leaving only a tombstone; the one with an open run stays.
        size = os.path.getsize(idle)
        self.assertEqual(sorted(self.reporter.state["files"]), [busy])
        self.assertEqual(self.reporter.state["idle"], {idle: [os.stat(idle).st_ino, size]})
        with open(os.path.join(self.state_dir, "state.json")) as stream:
            saved = json.load(stream)
        self.assertEqual((sorted(saved["files"]), sorted(saved["idle"])), ([busy], [idle]))
        # Further passes neither recreate its state nor reopen it.
        opened = []
        original = trace._open_regular
        trace._open_regular = lambda path, expected=None: (opened.append(path), original(path, expected))[1]
        self.addCleanup(setattr, trace, "_open_regular", original)
        seen = dict(self.reporter.tracker.stats)
        for _ in range(3):
            self.now += 10
            self.reporter.step()
        self.assertEqual(sorted(self.reporter.state["files"]), [busy])
        self.assertNotIn(idle, opened)
        self.assertEqual({key: self.reporter.tracker.stats[key] - seen.get(key, 0)
                          for key in ("files.new", "files.skipped_history", "files.resumed")},
                         {"files.new": 0, "files.skipped_history": 0, "files.resumed": 0})
        self.assertEqual(len(self.events()), 5)  # no replay
        # A restart keeps the tombstones; a forgotten file written again resumes where it stopped.
        restarted = trace.Reporter(root=self.root, home="/home/bux", transport=self.mock.transport,
                                   clock=lambda: self.now, log=self.logs.append)
        self.assertEqual(restarted.tracker.idle, {idle: [os.stat(idle).st_ino, size]})
        self.write("rollout-idle.jsonl", codex_turn("turn-2", start=T0 + 100))
        self.now += 10
        restarted.step()
        resumed = self.events()[5:]
        self.assertEqual(roles(resumed), ["run.started", "tool.started", "tool.completed", "run.completed"])
        self.assertEqual({(attrs(r)["conversation.id"], attrs(r)["session.id"]) for r in resumed},
                         {("idle-s", "turn-2")})
        self.assertEqual(restarted.state["files"][idle]["o"], os.path.getsize(idle))
        self.assertEqual(restarted.state["idle"], {})
        self.assertEqual(restarted.tracker.stats["files.resumed"], 1)
        # Deleting a forgotten file drops its tombstone.
        entry = restarted.state["files"].pop(busy)
        restarted.state["idle"][busy] = [entry["i"], entry["o"]]
        os.unlink(busy)
        self.now += 10
        restarted.step()
        self.assertEqual((sorted(restarted.state["files"]), restarted.state["idle"]), ([idle], {}))

    def test_offsets_advance_only_after_a_successful_response(self):
        path = self.write("rollout-a.jsonl", [codex_meta(), *codex_turn()])
        self.mock.responses[trace.INGEST_PATH] = [(503, b"{}", {}), (502, b"{}", {})]
        self.reporter.step()
        self.assertNotIn(path, self.reporter.state["files"])
        self.assertEqual(self.reporter.blocked_until, self.now + 10)
        self.reporter.step()
        self.assertEqual(len(self.mock.ingested()), 1)  # still backing off
        self.now += 10
        self.reporter.step()
        self.assertEqual(self.reporter.blocked_until, self.now + 20)
        self.now += 20
        self.reporter.step()
        self.assertEqual(self.reporter.state["files"][path]["o"], os.path.getsize(path))
        attempts = [self.mock.records(document) for _, document in self.mock.ingested()]
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(attempts[1], attempts[2])  # the same records, not lost
        self.assertEqual(roles(attempts[3]), ["collector.heartbeat"])  # only once they were accepted
        self.assertEqual(self.reporter.failures, 0)

    def test_heartbeats_stop_while_event_delivery_keeps_failing(self):
        def events_fail(url, headers, body, timeout):
            names = {attrs(r)["event.name"] for r in self.mock.records(json.loads(body))}
            if names != {"collector.heartbeat"}:
                self.mock.requests.append((trace.INGEST_PATH, {}, body))
                return 503, b""  # a heartbeat alone would still be accepted
            return self.mock.transport(url, headers, body, timeout)

        self.reporter.transport = events_fail
        self.reporter.step()
        self.assertEqual(len(self.heartbeats()), 1)
        self.write("rollout-a.jsonl", [codex_meta(), *codex_turn()])
        start = self.now
        while self.now - start < 3 * trace.HEARTBEAT_SECONDS:
            self.now = max(self.now + 10, self.reporter.blocked_until)
            self.reporter.step()
        self.assertEqual(len(self.heartbeats()), 1)  # none while the events cannot be delivered
        self.reporter.transport = self.mock.transport
        self.now = max(self.now + 10, self.reporter.blocked_until)
        self.reporter.step()
        self.assertEqual(len(self.heartbeats()), 2)
        self.assertEqual(roles(self.all_records())[-1], "collector.heartbeat")

    @unittest.skipIf(os.geteuid() == 0, "requires an unprivileged user")
    def test_heartbeats_stop_while_unread_bytes_are_stuck(self):
        path = self.write("rollout-a.jsonl", [codex_meta(), *codex_turn()])
        os.chmod(path, 0)
        self.reporter.step()
        self.assertEqual((len(self.heartbeats()), len(self.events())), (1, 0))  # just started: still healthy
        for _ in range(4):
            self.now += trace.HEARTBEAT_SECONDS // 4 + 1
            self.reporter.step()
        self.assertEqual(len(self.heartbeats()), 1)
        self.assertTrue(self.reporter.stalled(self.now))
        self.assertIn("heartbeat withheld", " ".join(self.logs))
        os.chmod(path, 0o600)
        self.now += 10
        self.reporter.step()
        self.assertEqual((len(self.heartbeats()), len(self.events())), (2, 4))
        self.assertFalse(self.reporter.stalled(self.now))

    def test_a_line_that_kills_the_parse_is_skipped_on_the_next_start(self):
        spy = spy_on_parses(self, kill_on=b"KILLS-THE-PARSER")
        path = self.write("s.jsonl", [prompt(T0, "p-1"), tool_use(T0 + 1, "toolu-1", name="Read")],
                          directory=self.projects)
        start = os.path.getsize(path)
        with open(path, "a") as stream:
            line = result_line(T0 + 2, "toolu-1", "p-1", "x" * (trace.MARK_BYTES + 10) + "KILLS-THE-PARSER",
                               is_error=False, result={"type": "text"})
            stream.write(line + "\n")
        self.write("s.jsonl", [text(T0 + 3)], directory=self.projects)
        with self.assertRaises(ProcessKilled):
            self.reporter.step()
        # Nothing was reported as healthy by the process that died.
        self.assertEqual(self.mock.ingested(), [])
        marker = os.path.join(self.state_dir, "parsing.json")
        self.assertEqual(stat.S_IMODE(os.stat(marker).st_mode), 0o600)
        with open(marker) as stream:
            self.assertEqual(json.load(stream)["line"], [path, os.stat(path).st_ino, start, len(line)])
        # systemd restarts it: that line is recovered from its envelope, never parsed again.
        restarted = trace.Reporter(root=self.root, home="/home/bux", transport=self.mock.transport,
                                   clock=lambda: self.now, log=self.logs.append)
        restarted.state["firstStart"] = restarted.tracker.backfill_before = 0
        restarted.step()
        self.assertEqual(spy.long_parses, 1)
        self.assertEqual(roles(self.events()), ["run.started", "tool.started", "tool.completed", "run.completed"])
        self.assertEqual((self.events()[2]["timeUnixNano"], attrs(self.events()[2])["success"]), (str(ns(T0 + 2)), True))
        self.assertEqual(len(self.heartbeats()), 1)
        self.assertEqual((restarted.tracker.stats["lines.crashed"], restarted.tracker.stats["lines.crashed_recovered"]),
                         (1, 1))
        self.assertIn("stopped the reporter", " ".join(self.logs))
        # Once delivered past it, the skip is forgotten.
        trace.Reporter(root=self.root, home="/home/bux", transport=self.mock.transport, clock=lambda: self.now,
                       log=self.logs.append)
        with open(marker) as stream:
            self.assertEqual(json.load(stream), {"v": 1, "line": None, "skip": []})

    def test_large_lines_parse_normally_under_the_marker(self):
        spy = spy_on_parses(self)
        path = self.write("s.jsonl", [prompt(T0, "p-1"), tool_use(T0 + 1, "toolu-1")], directory=self.projects)
        with open(path, "a") as stream:
            stream.write(result_line(T0 + 2, "toolu-1", "p-1", "x" * (trace.MARK_BYTES + 10)) + "\n")
        marks = []
        guard = self.reporter.tracker.guard
        self.reporter.tracker.guard = lambda line: (marks.append(line), guard(line))[1]
        self.reporter.step()
        self.assertEqual(spy.long_parses, 1)
        self.assertEqual([None if line is None else line[0] for line in marks], [path, None])
        self.assertEqual(roles(self.events()), ["run.started", "tool.started", "tool.completed"])
        with open(os.path.join(self.state_dir, "parsing.json")) as stream:
            self.assertIsNone(json.load(stream)["line"])

    def test_first_start_floor_uses_the_filesystem_clock(self):
        os.unlink(os.path.join(self.state_dir, "state.json"))
        # The process clock may run ahead of file timestamps (coarse or other clock domain).
        reporter = trace.Reporter(root=self.root, home="/home/bux", transport=self.mock.transport,
                                  clock=lambda: time.time() + 5, log=self.logs.append)
        marker = os.stat(os.path.join(self.state_dir, "state.json")).st_mtime
        self.assertAlmostEqual(reporter.state["firstStart"], marker - trace.FRESH_MARGIN, delta=0.25)
        history = self.write("rollout-old.jsonl", [codex_meta(session="old-s"), *codex_turn("turn-0")])
        os.utime(history, (marker - 60, marker - 60))
        # Written just after the first start, on a filesystem that truncates timestamps.
        fresh = self.write("rollout-new.jsonl", [codex_meta(session="new-s"), *codex_turn("turn-1")])
        os.utime(fresh, (marker - 0.5, marker - 0.5))
        reporter.step()
        self.assertEqual({attrs(r)["conversation.id"] for r in self.events()}, {"new-s"})
        self.assertEqual(len(self.events()), 4)
        self.assertEqual(reporter.state["files"][history]["o"], os.path.getsize(history))

    def test_rejected_batches_are_dropped_and_advanced(self):
        path = self.write("rollout-a.jsonl", [codex_meta(), *codex_turn()])
        self.mock.responses[trace.INGEST_PATH] = [(200, b"{}", {}), (400, b"{}", {})]
        self.reporter.step()
        self.assertEqual(self.reporter.state["files"][path]["o"], os.path.getsize(path))
        self.now += 10
        self.reporter.step()
        self.assertEqual(len(self.mock.ingested()), 2)

    def test_expired_token_renews_once_and_retries(self):
        self.write("rollout-a.jsonl", [codex_meta(), *codex_turn()])
        expires = iso(int(self.now) + 7 * 86400)
        self.mock.responses[trace.INGEST_PATH] = [(401, b"{}", {})]
        self.mock.responses[trace.RENEW_PATH] = [
            (200, json.dumps({"token": NEW_TOKEN, "expiresAt": expires, "extra": SECRET}).encode(), {})]
        self.reporter.step()
        paths = [(path, headers["authorization"][len("Bearer "):]) for path, headers, _ in self.mock.requests]
        self.assertEqual(paths[:3], [(trace.INGEST_PATH, TOKEN), (trace.RENEW_PATH, TOKEN), (trace.INGEST_PATH, NEW_TOKEN)])
        renew = self.mock.requests[1]
        self.assertEqual((renew[1]["x-hivra-resource-id"], renew[2]), (RESOURCE, b"{}"))
        credential = os.path.join(self.state_dir, "credential.json")
        with open(credential) as stream:
            self.assertEqual(json.load(stream), {"endpoint": ENDPOINT, "resourceId": RESOURCE, "token": NEW_TOKEN,
                                                 "expiresAt": expires})
        self.assertEqual(stat.S_IMODE(os.stat(credential).st_mode), 0o600)
        # The refused run records, their retry, then the heartbeat.
        self.assertEqual([len(self.mock.records(d)) for _, d in self.mock.ingested()], [4, 4, 1])

    def test_failed_renewal_waits_for_a_pushed_replacement(self):
        self.write("rollout-a.jsonl", [codex_meta(), *codex_turn()])
        self.mock.responses[trace.INGEST_PATH] = [(401, b"{}", {})]
        self.mock.responses[trace.RENEW_PATH] = [(401, b"{}", {})]
        self.reporter.step()
        self.assertEqual(self.reporter.state["credential"], "expired")
        self.assertEqual(self.reporter.blocked_until, self.now + trace.MAX_BACKOFF)
        with open(os.path.join(self.state_dir, "state.json")) as stream:
            self.assertEqual(json.load(stream)["credential"], "expired")
        count = len(self.mock.requests)
        self.now += 10
        self.reporter.step()
        self.assertEqual(len(self.mock.requests), count)
        self.write_credential(NEW_TOKEN, iso(int(self.now) + 7 * 86400))  # pushed by a computer start
        self.now += 10
        self.reporter.step()
        self.assertEqual({headers["authorization"] for _, headers, _ in self.mock.requests[count:]},
                         {"Bearer " + NEW_TOKEN})
        self.assertEqual([len(self.mock.records(d)) for _, d in self.mock.ingested()], [4, 4, 1])
        self.assertNotIn("credential", self.reporter.state)

    def test_forbidden_and_missing_resource_back_off_five_minutes(self):
        for status in (403, 404):
            self.mock.responses[trace.INGEST_PATH] = [(status, b"{}", {})]
            self.reporter.last_heartbeat = None
            self.reporter.blocked_until = 0
            self.reporter.step()
            self.assertEqual(self.reporter.blocked_until, self.now + 300)

    def test_scheduled_renewal_and_rate_limit(self):
        self.write_credential(TOKEN, iso(int(self.now) + 2 * 86400))
        self.mock.responses[trace.RENEW_PATH] = [(429, b"{}", {})]
        self.reporter.step()
        self.assertEqual(self.mock.requests[0][0], trace.RENEW_PATH)
        self.assertEqual(self.reporter.renew_after, self.now + 3600)
        self.now += 10
        self.reporter.step()
        self.assertEqual([path for path, _, _ in self.mock.requests].count(trace.RENEW_PATH), 1)
        self.now += 3600
        self.mock.responses[trace.RENEW_PATH] = [
            (200, json.dumps({"token": NEW_TOKEN, "expiresAt": iso(int(self.now) + 7 * 86400)}).encode(), {})]
        self.reporter.step()
        self.assertEqual(self.mock.requests[-1][1]["authorization"], "Bearer " + NEW_TOKEN)
        self.now += 10
        self.reporter.step()
        self.assertEqual([path for path, _, _ in self.mock.requests].count(trace.RENEW_PATH), 2)

    def test_network_failures_back_off_exponentially_and_never_crash(self):
        errors = [http.client.IncompleteRead(b"x"), urllib.error.URLError("down"), TimeoutError(),
                  ConnectionResetError(), http.client.RemoteDisconnected("gone")]
        delays = []

        def failing(url, headers, body, timeout):
            raise errors.pop(0) if errors else OSError()

        self.reporter.transport = failing
        for _ in range(8):
            self.reporter.step()
            delays.append(round(self.reporter.blocked_until - self.now))
            self.now = self.reporter.blocked_until
        self.assertEqual(delays, [10, 20, 40, 80, 160, 300, 300, 300])

    def test_redirects_are_never_followed(self):
        self.mock.responses[trace.INGEST_PATH] = [(302, b"", {"Location": "/elsewhere"})]
        self.reporter.step()
        self.assertEqual([path for path, _, _ in self.mock.requests], [trace.INGEST_PATH])
        self.assertEqual(self.reporter.failures, 1)

    def test_invalid_credential_file_sends_nothing(self):
        for payload, mode in ((b"{}", 0o600), (trace.credential_bytes({"endpoint": ENDPOINT, "resourceId": RESOURCE,
                                                                        "token": TOKEN, "expiresAt": iso(T0)}), 0o644)):
            trace.write_atomic(os.path.join(self.state_dir, "credential.json"), payload, mode)
            self.assertEqual(self.reporter.step(), trace.LOOP_SECONDS)
        self.assertEqual(self.mock.requests, [])

    def test_no_content_leaves_the_guest(self):
        self.write("rollout-leak.jsonl", [
            codex_meta(instructions=SECRET),
            codex("turn_context", T0, {"turn_id": "turn-1", "cwd": SECRET, "user_instructions": SECRET}),
            codex("event_msg", T0 + 1, {"type": "task_started", "turn_id": "turn-1", "started_at": T0 + 1}),
            codex("event_msg", T0 + 1, {"type": "user_message", "message": SECRET, "images": [SECRET]}),
            codex("response_item", T0 + 1, {"type": "message", "role": "user",
                                            "content": [{"type": "input_text", "text": SECRET}]}),
            codex("response_item", T0 + 1, {"type": "reasoning", "summary": [{"text": SECRET}],
                                            "encrypted_content": SECRET}),
            codex("response_item", T0 + 2, {"type": "function_call", "id": "fc-1", "call_id": "call-1",
                                            "name": "exec_command", "arguments": SECRET}),
            codex("event_msg", T0 + 3, {"type": "item_completed", "item": {
                "type": "CommandExecution", "id": "call-1", "status": "failed", "exit_code": 1, "command": SECRET,
                "aggregated_output": SECRET, "cwd": SECRET}, "started_at_ms": 1, "completed_at_ms": 2}),
            codex("response_item", T0 + 3, {"type": "function_call_output", "call_id": "call-1", "output": SECRET}),
            codex("response_item", T0 + 4, {"type": "custom_tool_call", "call_id": "call-2", "name": "exec",
                                            "input": SECRET, "status": "completed"}),
            codex("response_item", T0 + 5, {"type": "custom_tool_call_output", "call_id": "call-2",
                                            "output": [{"type": "input_text", "text": SECRET}]}),
            codex("response_item", T0 + 5, {"type": "web_search_call", "action": {"query": SECRET}}),
            codex("event_msg", T0 + 6, {"type": "agent_message", "message": SECRET}),
            codex("compacted", T0 + 6, {"message": SECRET, "replacement_history": [SECRET]}),
            codex("event_msg", T0 + 7, {"type": "task_complete", "turn_id": "turn-1", "duration_ms": 6000,
                                        "last_agent_message": SENTINEL_ENUM,
                                        "error": {"message": SENTINEL_ENUM, "codex_error_info": "other"}}),
            codex("event_msg", T0 + 8, {"type": "task_started", "turn_id": "turn-2", "started_at": T0 + 8}),
            codex("event_msg", T0 + 9, {"type": "turn_aborted", "turn_id": "turn-2", "reason": SENTINEL_ENUM}),
        ])
        self.write("s.jsonl", [
            {"type": "queue-operation", "operation": "enqueue", "content": SECRET, "sessionId": "5a1c-session",
             "timestamp": iso(T0)},
            prompt(T0, "p-1", permissionMode=SECRET),
            prompt(T0, "p-1", isMeta=True),
            claude("assistant", T0 + 1, message={"stop_reason": None, "content": [
                {"type": "thinking", "thinking": SECRET, "signature": SECRET}]}),
            tool_use(T0 + 2, "toolu-1"),
            tool_result(T0 + 3, "toolu-1", "p-1", is_error=True),
            claude("attachment", T0 + 3, attachment={"type": "file", "content": SECRET}),
            claude("system", T0 + 3, subtype="local_command", content=SECRET),
            text(T0 + 4),
            {"type": "last-prompt", "lastPrompt": SECRET, "sessionId": "5a1c-session"},
            {"type": "custom-title", "customTitle": SECRET, "sessionId": "5a1c-session"},
            {"type": "summary", "summary": SECRET, "leafUuid": "x"},
            prompt(T0 + 10, "p-2"),
            text(T0 + 11, stop="stop_sequence", isApiErrorMessage=True, error=SENTINEL_ENUM + "_x"),
        ], directory=self.projects)
        self.write("agent-a1.jsonl", [prompt(T0 + 1, "p-1", isSidechain=True, agentId="a1"),
                                      text(T0 + 2, isSidechain=True, agentId="a1")],
                   directory=os.path.join(self.projects, "5a1c-session", "subagents"))
        self.reporter.step()
        records = self.all_records()
        self.assertEqual(roles(records).count("run.started"), 5)
        self.assertEqual([attrs(r).get("error.type") for r in records if attrs(r)["event.name"] == "run.failed"],
                         ["other", SENTINEL_ENUM + "_x"])
        for _, headers, body in self.mock.requests:
            for value in (body.decode("utf-8"), json.dumps(headers)):
                self.assertNotIn(SECRET, value)
                self.assertNotIn(SENTINEL_ENUM + '"', value.replace(SENTINEL_ENUM + '_x"', ""))
        with open(os.path.join(self.state_dir, "state.json")) as stream:
            self.assertNotIn(SECRET, stream.read())
        self.assertNotIn(SECRET, json.dumps(self.logs))
        self.assertNotIn(TOKEN, json.dumps(self.logs))


class ScanCommandTest(unittest.TestCase):
    def test_scan_prints_aggregate_counts_only(self):
        with tempfile.TemporaryDirectory() as home:
            sessions = os.path.join(home, ".codex", "sessions", "2026")
            projects = os.path.join(home, ".claude", "projects", "-home-bux")
            os.makedirs(sessions)
            os.makedirs(projects)
            with open(os.path.join(sessions, "rollout-a.jsonl"), "w") as stream:
                for record in [codex_meta(), *codex_turn(calls=3, error={"codex_error_info": "other"})]:
                    stream.write(json.dumps(record) + "\n")
            with open(os.path.join(projects, "s.jsonl"), "w") as stream:
                for record in [prompt(T0, "p-1"), tool_use(T0 + 1, "toolu-1"), text(T0 + 2)]:
                    stream.write(json.dumps(record) + "\n")
            result = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), "scan", "--home", home, "--all-history",
                                     "--stats"], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        stats = json.loads(result.stdout)
        self.assertEqual(stats["records.codex.run.started"], 1)
        self.assertEqual(stats["records.codex.run.failed"], 1)
        self.assertEqual(stats["records.codex.tool.started"], 3)
        self.assertEqual(stats["records.claude-code.run.started"], 1)
        self.assertEqual(stats["tools.open_at_eof.claude-code"], 1)
        self.assertEqual(stats["runs.open_at_eof.claude-code"], 1)
        self.assertEqual(stats.get("event_ids.duplicate", 0), 0)
        for leaked in (SECRET, "019a-session-root", "turn-1", "call-turn-1", "toolu-1", "5a1c-session", "p-1", home):
            self.assertNotIn(leaked, result.stdout)
        self.assertTrue(all(isinstance(value, int) for value in stats.values()))


VALID = {"endpoint": ENDPOINT, "resourceId": RESOURCE, "token": TOKEN, "expiresAt": "2026-09-29T12:00:00.000Z"}


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = self.directory.name

    def tearDown(self):
        self.directory.cleanup()

    def install(self, document, *extra):
        data = document if isinstance(document, bytes) else json.dumps(document).encode()
        return subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), "install", "--source-dir", str(HERE),
                               "--root", self.root, "--no-systemctl", *extra], input=data, capture_output=True,
                              timeout=60)

    def path(self, absolute):
        return os.path.join(self.root, absolute.lstrip("/"))

    def install_in_process(self, document):
        data = document if isinstance(document, bytes) else json.dumps(document).encode()
        stderr = io.StringIO()
        args = type("Args", (), {"source_dir": str(HERE), "root": self.root, "no_systemctl": True})
        code = trace.install_command(args, stdin=io.BytesIO(data), stderr=stderr)
        return code, stderr.getvalue()

    def test_installs_script_unit_and_private_credential(self):
        result = self.install(VALID)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(len(result.stderr.decode().splitlines()), 1)
        self.assertNotIn(TOKEN.encode(), result.stderr)
        for absolute, source, mode in ((trace.SCRIPT_PATH, SCRIPT, 0o644),
                                       (trace.UNIT_PATH, HERE / "hivra-agent-trace.service", 0o644)):
            with open(self.path(absolute), "rb") as stream:
                self.assertEqual(stream.read(), source.read_bytes())
            self.assertEqual(stat.S_IMODE(os.stat(self.path(absolute)).st_mode), mode)
        credential = self.path(trace.CREDENTIAL_PATH)
        with open(credential) as stream:
            self.assertEqual(json.load(stream), VALID)
        self.assertEqual(stat.S_IMODE(os.stat(credential).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.path(trace.STATE_DIR)).st_mode), 0o700)
        os.chmod(self.path(trace.STATE_DIR), 0o750)  # e.g. created by hand: tightened again
        os.chmod(self.path(os.path.dirname(trace.UNIT_PATH)), 0o711)  # a system directory: left alone
        # Re-running replaces atomically (new inode) and keeps the modes.
        before = os.stat(credential).st_ino
        replacement = dict(VALID, token=NEW_TOKEN)
        self.assertEqual(self.install(replacement).returncode, 0)
        with open(credential) as stream:
            self.assertEqual(json.load(stream)["token"], NEW_TOKEN)
        self.assertNotEqual(os.stat(credential).st_ino, before)
        self.assertEqual(stat.S_IMODE(os.stat(credential).st_mode), 0o600)
        self.assertEqual(sorted(os.listdir(self.path(trace.STATE_DIR))), ["credential.json"])
        self.assertEqual(stat.S_IMODE(os.stat(self.path(trace.STATE_DIR)).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.path(os.path.dirname(trace.UNIT_PATH))).st_mode), 0o711)
        # A pushed credential is what the service loop reads.
        self.assertEqual(trace.read_credential(credential)["token"], NEW_TOKEN)

    def test_rejects_malformed_credential_documents(self):
        cases = {
            "extra key": dict(VALID, extra="x"),
            "missing key": {k: v for k, v in VALID.items() if k != "expiresAt"},
            "http": dict(VALID, endpoint="http://dashboard.test/api/activity/ingest"),
            "userinfo": dict(VALID, endpoint="https://user:pw@dashboard.test/api/activity/ingest"),
            "query": dict(VALID, endpoint=ENDPOINT + "?next=1"),
            "fragment": dict(VALID, endpoint=ENDPOINT + "#x"),
            "path": dict(VALID, endpoint="https://dashboard.test/api/activity/ingest/"),
            "other path": dict(VALID, endpoint="https://dashboard.test/api/activity/collector/renew"),
            "upper host": dict(VALID, endpoint="https://Dashboard.test/api/activity/ingest"),
            "port": dict(VALID, endpoint="https://dashboard.test:70000/api/activity/ingest"),
            "upper uuid": dict(VALID, resourceId=RESOURCE.upper()),
            "not uuid": dict(VALID, resourceId="agent-1"),
            "token prefix": dict(VALID, token="hvra_otlp_v2.a.b"),
            "token space": dict(VALID, token=TOKEN + " "),
            "token size": dict(VALID, token="hvra_otlp_v1." + "a" * 4096 + ".b"),
            "no zone": dict(VALID, expiresAt="2026-09-29T12:00:00"),
            "other zone": dict(VALID, expiresAt="2026-09-29T12:00:00+02:00"),
            "bad date": dict(VALID, expiresAt="2026-02-30T12:00:00Z"),
            "number": dict(VALID, expiresAt=1790000000),
            "array": [VALID],
            "duplicate": ('{"endpoint":"%s","resourceId":"%s","token":"%s","token":"%s","expiresAt":"%s"}' % (
                ENDPOINT, RESOURCE, TOKEN, NEW_TOKEN, VALID["expiresAt"])).encode(),
            "not json": b"endpoint=" + ENDPOINT.encode(),
            "too large": json.dumps(dict(VALID, pad="x" * 20000)).encode(),
        }
        for name, document in cases.items():
            with self.subTest(name):
                code, stderr = self.install_in_process(document)
                self.assertEqual(code, 1, stderr)
                self.assertEqual(len(stderr.splitlines()), 1)
                self.assertNotIn("hvra_otlp_v1.", stderr)
                self.assertFalse(os.path.exists(self.path(trace.CREDENTIAL_PATH)))
                self.assertFalse(os.path.exists(self.path(trace.SCRIPT_PATH)))
        result = self.install(cases["duplicate"])  # and once through the real command line
        self.assertEqual((result.returncode, len(result.stderr.splitlines())), (1, 1))
        self.assertNotIn(b"hvra_otlp_v1.", result.stderr)
        self.assertEqual(self.install_in_process(dict(VALID, endpoint="https://canary.hivra.dev:8443/api/activity/ingest"))[0], 0)

    @unittest.skipIf(os.geteuid() == 0, "requires an unprivileged user")
    def test_refuses_unsafe_directories(self):
        os.makedirs(self.path("/opt/hivra"))
        os.chmod(self.path("/opt/hivra"), 0o777)
        code, stderr = self.install_in_process(VALID)
        self.assertEqual((code, stderr), (1, "hivra-agent-trace: install failed: unsafe reporter directory\n"))
        os.chmod(self.path("/opt/hivra"), 0o755)
        os.makedirs(self.path("/elsewhere"))
        os.symlink(self.path("/elsewhere"), self.path(os.path.dirname(trace.SCRIPT_PATH)))
        self.assertEqual(self.install_in_process(VALID)[0], 1)
        self.assertEqual(os.listdir(self.path("/elsewhere")), [])

    def test_refuses_the_real_root_without_privileges(self):
        result = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), "install", "--source-dir", str(HERE),
                                 "--no-systemctl"], input=json.dumps(VALID).encode(), capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"must run as root", result.stderr)

    def fake_systemctl(self, active=0, dropin=""):
        log = os.path.join(self.root, "systemctl.log")
        fake = os.path.join(self.root, "systemctl")
        with open(fake, "w") as stream:
            stream.write("#!/bin/sh\necho \"$*\" >> %s\ncase \"$1\" in\n"
                         "  show) printf 'FragmentPath=%s\\nDropInPaths=%s\\n' ;;\n"
                         "  is-active) exit %d ;;\nesac\nexit 0\n" % (log, trace.UNIT_PATH, dropin, active))
        os.chmod(fake, 0o755)
        return fake, log

    def run_install(self, fake):
        previous = trace.SYSTEMCTL
        trace.SYSTEMCTL = fake
        try:
            return trace.install(str(HERE), json.dumps(VALID).encode(), root=self.root, settle=0)
        finally:
            trace.SYSTEMCTL = previous

    def test_systemctl_sequence_requires_an_active_unit(self):
        fake, log = self.fake_systemctl()
        self.assertEqual(self.run_install(fake), "installed and active")
        with open(log) as stream:
            self.assertEqual(stream.read().splitlines(), [
                "daemon-reload", "enable hivra-agent-trace.service",
                "show --property=FragmentPath --property=DropInPaths hivra-agent-trace.service",
                "restart hivra-agent-trace.service", "is-active --quiet hivra-agent-trace.service"])
        fake, _ = self.fake_systemctl(active=3)
        with self.assertRaisesRegex(trace.InstallError, "not active"):
            self.run_install(fake)
        fake, _ = self.fake_systemctl(dropin="/etc/systemd/system/hivra-agent-trace.service.d/x.conf")
        with self.assertRaisesRegex(trace.InstallError, "override"):
            self.run_install(fake)

    def test_command_reports_one_line_status(self):
        fake, _ = self.fake_systemctl(active=3)
        previous = trace.SYSTEMCTL
        trace.SYSTEMCTL = fake
        stderr = io.StringIO()
        try:
            args = type("Args", (), {"source_dir": str(HERE), "root": self.root, "no_systemctl": False})
            original_sleep = trace.time.sleep
            trace.time.sleep = lambda seconds: None
            try:
                code = trace.install_command(args, stdin=io.BytesIO(json.dumps(VALID).encode()), stderr=stderr)
            finally:
                trace.time.sleep = original_sleep
        finally:
            trace.SYSTEMCTL = previous
        self.assertEqual(code, 1)
        self.assertEqual(stderr.getvalue(), "hivra-agent-trace: install failed: service is not active\n")


class UnitFileTest(unittest.TestCase):
    def test_unit_is_least_privilege_and_starts_without_optional_paths(self):
        settings = collections.defaultdict(list)
        for line in (HERE / "hivra-agent-trace.service").read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                settings[key].append(value)
        expected = {
            "ExecStart": "/usr/bin/python3 -I -B %s run" % trace.SCRIPT_PATH, "User": "root",
            "CapabilityBoundingSet": "CAP_DAC_READ_SEARCH", "NoNewPrivileges": "true",
            "StateDirectory": "hivra-agent-trace", "StateDirectoryMode": "0700", "ProtectSystem": "strict",
            "ProtectHome": "read-only", "PrivateTmp": "true", "Restart": "always",
            "RestrictAddressFamilies": "AF_INET AF_INET6 AF_UNIX", "WantedBy": "multi-user.target",
        }
        for key, value in expected.items():
            self.assertEqual(settings[key], [value], key)
        self.assertNotIn("ReadWritePaths", settings)  # would fail before the state directory exists
        self.assertTrue(all(path.startswith("-") for value in settings["ReadOnlyPaths"] for path in value.split()))
        self.assertTrue(settings["MemoryMax"] and settings["CPUQuota"])

    def test_memory_ceiling_holds_the_worst_admitted_line_with_margin(self):
        (ceiling,) = [line.split("=", 1)[1] for line in (HERE / "hivra-agent-trace.service").read_text().splitlines()
                      if line.startswith("MemoryMax=")]
        self.assertRegex(ceiling, r"^[0-9]+M$")
        ceiling_mb = int(ceiling[:-1])

        def peak_mb(line):
            # The real line path (read, bound check, parse) in a fresh process; aggregate counts only.
            with tempfile.TemporaryDirectory() as home:
                projects = os.path.join(home, ".claude", "projects", "p")
                os.makedirs(projects)
                with open(os.path.join(projects, "s.jsonl"), "wb") as stream:
                    stream.write(line + b"\n")
                result = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), "scan", "--home", home,
                                         "--all-history", "--stats"], capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            stats = json.loads(result.stdout)
            return stats["max_rss_mb"], stats.get("lines.containers", 0)

        def fill(prefix, unit, suffix):
            count = (trace.MAX_LINE - len(prefix) - len(suffix)) // len(unit)
            return prefix + unit * count + suffix

        # The costliest shapes measured per byte: one object of distinct keys
        # (admitted: one container), and small objects (bounded by the count).
        keys, size, index = [b"{"], 1, 0
        while size < trace.MAX_LINE - 32:
            item = b'"%x":0,' % index
            keys.append(item)
            size += len(item)
            index += 1
        admitted, admitted_containers = peak_mb(b"".join(keys)[:-1] + b"}")
        refused, refused_containers = peak_mb(fill(b"[", b'{"a":0},', b'{"a":0}]'))
        self.assertEqual((admitted_containers, refused_containers), (0, 1))
        self.assertLess(refused, admitted)
        # 1.5x margin over the worst admitted line, which includes the interpreter itself.
        self.assertLessEqual(admitted * 1.5, ceiling_mb, "MemoryMax=%s, worst admitted line peaked at %d MB"
                             % (ceiling, admitted))


if __name__ == "__main__":
    unittest.main()
