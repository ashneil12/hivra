#!/usr/bin/env python3
"""Test double for the no-fork experiment: an OpenAI-compatible chat endpoint that calls the
`terminal` tool when the user message contains "RUN: <command>", then echoes the tool result, plus a
fake runtime-governor API (/governor/admit|start|heartbeat|finish|fail) that logs every call.
Stdlib only. NOT a product component: it lets us drive the real agent tool loop and the metering
seams without spending LLM credits.

  python3 stub-llm-and-governor.py [port]      # default 9999
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = "/tmp/stub-calls.log"


def log(line: str) -> None:
    with open(LOG, "a") as fh:
        fh.write(f"{time.strftime('%H:%M:%S')} {line}\n")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        log(f"GET {self.path}")
        if self.path.startswith("/v1/models"):
            return self._send(200, {"object": "list", "data": [{"id": "stub-model", "object": "model"}]})
        self._send(200, {"ok": True})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            body = {}
        if self.path.startswith("/governor/"):
            step = self.path.rsplit("/", 1)[1]
            log(f"GOVERNOR {step} {json.dumps({k: v for k, v in body.items() if k != 'messagePreview'})[:200]}")
            if step == "admit":
                return self._send(200, {"allowed": True, "leaseId": "lease-" + str(int(time.time() * 1000))})
            if step == "heartbeat":
                return self._send(200, {"shouldStop": False})
            return self._send(200, {"ok": True})
        if self.path.endswith("/chat/completions"):
            return self._chat(body)
        self._send(404, {"error": "unknown"})

    def _chat(self, body):
        msgs = body.get("messages", [])
        last = msgs[-1] if msgs else {}
        text = last.get("content") if isinstance(last.get("content"), str) else json.dumps(last.get("content"))
        tools = body.get("tools") or []
        tool_names = [t.get("function", {}).get("name") for t in tools]
        system = " ".join(m.get("content") for m in msgs if m.get("role") == "system" and isinstance(m.get("content"), str))
        marks = [m for m in ("Updating this computer", "Media generation", "Bankr wallet") if m in system]
        log(f"LLM role={last.get('role')} tools={len(tools)} stream={body.get('stream')} system_has={marks}")
        msg = {"role": "assistant"}
        finish = "stop"
        if last.get("role") == "tool":
            msg["content"] = "TOOL_RESULT: " + (text or "")[:1500]
        elif "RUN:" in (text or "") and "terminal" in tool_names:
            cmd = text.split("RUN:", 1)[1].strip().splitlines()[0]
            msg["content"] = None
            msg["tool_calls"] = [{"id": "call_1", "type": "function",
                                  "function": {"name": "terminal", "arguments": json.dumps({"command": cmd})}}]
            finish = "tool_calls"
        else:
            msg["content"] = "STUB-ECHO: " + (text or "")[:300]
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        if body.get("stream"):
            def chunk(delta, fin=None, extra=None):
                d = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "stub-model",
                     "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}
                if extra:
                    d.update(extra)
                return ("data: " + json.dumps(d) + "\n\n").encode()
            out = chunk({"role": "assistant"})
            if msg.get("tool_calls"):
                tc = msg["tool_calls"][0]
                out += chunk({"tool_calls": [{"index": 0, "id": tc["id"], "type": "function",
                                              "function": {"name": tc["function"]["name"],
                                                           "arguments": tc["function"]["arguments"]}}]})
            else:
                out += chunk({"content": msg["content"]})
            out += chunk({}, finish, {"usage": usage})
            out += b"data: [DONE]\n\n"
            return self._send(200, out, "text/event-stream")
        self._send(200, {"id": "c1", "object": "chat.completion", "created": 0, "model": "stub-model",
                         "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
