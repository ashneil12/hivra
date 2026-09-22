import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("trace", Path(__file__).with_name("hivra-agent-trace.py"))
trace = importlib.util.module_from_spec(spec); spec.loader.exec_module(trace)

def attrs(event):
    return {item["key"]: next(iter(item["value"].values())) for item in event["attributes"]}

class NativeTraceProtocolTest(unittest.TestCase):
    def test_codex_links_run_and_tool_without_content(self):
        state = {}
        records = [
            {"timestamp":"2026-09-21T20:00:00Z","type":"session_meta","payload":{"session_id":"session-1","base_instructions":"private"}},
            {"timestamp":"2026-09-21T20:00:01Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":"2026-09-21T20:00:01Z"}},
            {"timestamp":"2026-09-21T20:00:02Z","type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"exec_command","arguments":"secret"}},
            {"timestamp":"2026-09-21T20:00:04Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"secret"}},
            {"timestamp":"2026-09-21T20:00:06Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}},
        ]
        events = [event for record in records for event in trace.parse_codex(record, state)]
        self.assertEqual([attrs(e)["event.name"] for e in events], ["run.started","tool.started","tool.completed","run.completed"])
        self.assertEqual(attrs(events[2])["duration_ms"], "2000")
        self.assertEqual(attrs(events[3])["duration_ms"], "5000")
        self.assertEqual({attrs(e)["session.id"] for e in events}, {"turn-1"})
        self.assertNotIn("secret", str(events))

    def test_claude_links_tool_result_and_failure_without_bodies(self):
        state = {}
        records = [
            {"type":"user","sessionId":"session-2","uuid":"run-2","promptId":"prompt-2","timestamp":"2026-09-21T20:00:01Z","message":{"content":"private"}},
            {"type":"assistant","sessionId":"session-2","timestamp":"2026-09-21T20:00:02Z","message":{"content":[{"type":"tool_use","id":"tool-2","name":"Read","input":{"file":"secret"}}]}},
            {"type":"user","sessionId":"session-2","sourceToolAssistantUUID":"x","timestamp":"2026-09-21T20:00:05Z","message":{"content":[{"type":"tool_result","tool_use_id":"tool-2","is_error":True,"content":"secret"}]},"toolUseResult":{"stdout":"secret"}},
        ]
        events = [event for record in records for event in trace.parse_claude(record, state)]
        self.assertEqual([attrs(e)["event.name"] for e in events], ["run.started","tool.started","tool.failed"])
        self.assertEqual(attrs(events[-1])["duration_ms"], "3000")
        self.assertEqual(attrs(events[-1])["success"], False)
        self.assertNotIn("secret", str(events))

    def test_identifiers_are_stable(self):
        one = trace._event("codex","s","r","tool.started","2026-09-21T20:00:00Z",tool="Read",event_id="call:start")
        two = trace._event("codex","s","r","tool.started","2026-09-21T20:00:00Z",tool="Read",event_id="call:start")
        self.assertEqual(one, two)

if __name__ == "__main__": unittest.main()
