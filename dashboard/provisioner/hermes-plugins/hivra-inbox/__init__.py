"""hivra-inbox: the owner's Hivra "Needs you" list for this Hermes.

When Hermes stops to ask its owner something (a command that needs approval,
or a question), this plugin tells Hivra, so the owner sees it in Needs you
even when no chat is open. For approvals Hivra can also send the owner's
answer back, and this plugin hands it to Hermes through the same function
Hermes's own /approve and /deny use.

It only uses Hermes's public plugin hooks (pre_approval_request,
post_approval_response, on_human_input_request, on_human_input_resolved) and
``tools.approval.resolve_gateway_approval``. Hooks are observers: nothing here
can block, veto or slow an approval. Every network call happens on one daemon
thread, and any failure leaves Hermes's own chat prompt exactly as it was.

Settings, read once:
    ~/.hivra/api-token        this computer's Hivra token (already on every Hivra computer)
    ~/.hivra/control-origin   the Hivra address, for example https://hivra.cloud

Remove it with ``hermes plugins disable hivra-inbox``.
"""

from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

ENDPOINT_PATH = "/api/internal/agent-prompts"
TIMEOUT_S = 5.0
POLL_EVERY_S = 3.0
QUEUE_MAX = 64
COMMAND_MAX = 2000
SUMMARY_MAX = 500
QUESTION_MAX = 1000
DEFAULT_WAIT_S = 300
APPROVAL_CHOICES = ("once", "session", "always", "deny")

_lock = threading.RLock()
_config: Optional[dict] = None
_config_read = False
_sends: "queue.Queue[dict] | None" = None
_worker: Optional[threading.Thread] = None
# prompt_id -> {"session_key", "command", "complete", "choices", "deadline"}
_open: dict[str, dict] = {}


# --------------------------------------------------------------------------- settings

def _home() -> Path:
    return Path.home()


def _read_small(path: Path, limit: int = 512) -> str:
    try:
        with path.open("rb") as handle:
            return handle.read(limit).decode("utf-8", "replace").strip()
    except OSError:
        return ""


def _valid_origin(value: str) -> Optional[str]:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return None
    if parsed.scheme == "https" and host:
        return f"https://{parsed.netloc.lower()}"
    if parsed.scheme == "http" and host in ("localhost", "127.0.0.1", "::1"):
        return f"http://{parsed.netloc.lower()}"
    return None


def _settings() -> Optional[dict]:
    global _config, _config_read
    with _lock:
        if _config_read:
            return _config
        _config_read = True
        token = _read_small(_home() / ".hivra" / "api-token", 128)
        origin = _valid_origin(_read_small(_home() / ".hivra" / "control-origin", 300))
        if not re.fullmatch(r"[0-9a-f]{64}", token) or not origin:
            logger.info("hivra-inbox: not set up on this computer, staying quiet")
            return None
        _config = {"url": origin + ENDPOINT_PATH, "token": token}
        return _config


# --------------------------------------------------------------------------- helpers

def _redact(text: str) -> str:
    """Hermes's own redactor; without it nothing of the text leaves the computer."""
    if not text:
        return ""
    try:
        from agent.redact import redact_approval_display
        return redact_approval_display(str(text), force=True) or ""
    except Exception:
        try:
            from agent.redact import redact_sensitive_text
            return redact_sensitive_text(str(text), force=True) or ""
        except Exception:
            return ""


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _post(payload: dict, cfg: dict) -> Optional[dict]:
    request = urllib.request.Request(
        cfg["url"],
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['token']}",
            "User-Agent": "hivra-inbox/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            if 200 <= response.status < 300:
                body = response.read(65536)
                return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        logger.debug("hivra-inbox: Hivra answered HTTP %s", exc.code)
    except Exception as exc:
        logger.debug("hivra-inbox: could not reach Hivra: %s", exc)
    return None


def _send(payload: dict) -> None:
    """Queue a message for Hivra. Never blocks and never raises."""
    cfg = _settings()
    if cfg is None:
        return
    global _sends, _worker
    with _lock:
        if _sends is None:
            _sends = queue.Queue(maxsize=QUEUE_MAX)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, args=(_sends, cfg), name="hivra-inbox", daemon=True)
            _worker.start()
        sends = _sends
    try:
        sends.put_nowait(payload)
    except queue.Full:
        logger.warning("hivra-inbox: too many waiting messages, dropping one")


# --------------------------------------------------------------------------- answers

def _pending_entry(session_key: str, request_id: str):
    from tools import approval
    with approval._lock:
        for entry in approval._gateway_queues.get(session_key, []) or []:
            if entry.data.get("request_id") == request_id:
                return entry
    return None


def _apply(prompt_id: str, info: dict, answer: dict) -> str:
    """Hand one answer from Hivra to Hermes. Returns what happened, for Hivra's record."""
    choice = answer.get("choice")
    if choice not in info["choices"]:
        return "refused"
    if choice != "deny" and not info["complete"]:
        # Hivra could not show the whole command, so it may only be refused from there.
        return "refused"
    if _pending_entry(info["session_key"], prompt_id) is None:
        return "gone"
    reason = answer.get("text") if choice == "deny" else None
    reason = _cut(str(reason), 500) if isinstance(reason, str) and reason.strip() else None
    from tools import approval
    try:
        resolved = approval.resolve_gateway_approval(info["session_key"], choice, reason=reason, request_id=prompt_id)
    except TypeError:
        resolved = approval.resolve_gateway_approval(info["session_key"], choice)
    return "applied" if resolved else "gone"


def _poll(cfg: dict) -> None:
    now = time.monotonic()
    with _lock:
        for prompt_id in [p for p, info in _open.items() if info["deadline"] < now]:
            _open.pop(prompt_id, None)
        open_ids = [p for p, info in _open.items() if info["answerable"]]
    if not open_ids:
        return
    reply = _post({"event": "prompt.poll", "prompt_ids": open_ids[:20]}, cfg)
    body = reply.get("data") if isinstance(reply, dict) and isinstance(reply.get("data"), dict) else reply
    answers = body.get("answers") if isinstance(body, dict) else None
    for answer in answers if isinstance(answers, list) else []:
        if not isinstance(answer, dict):
            continue
        prompt_id = answer.get("prompt_id")
        with _lock:
            info = _open.get(prompt_id) if isinstance(prompt_id, str) else None
        if info is None:
            continue
        try:
            outcome = _apply(prompt_id, info, answer)
        except Exception as exc:
            logger.debug("hivra-inbox: could not apply an answer: %s", exc)
            outcome = "error"
        if outcome != "applied":
            with _lock:
                _open.pop(prompt_id, None)
            _post({"event": "prompt.resolved", "prompt_id": prompt_id, "kind": "approval",
                   "outcome": "answer_" + outcome}, cfg)


def _run(sends: "queue.Queue[dict]", cfg: dict) -> None:
    next_poll = 0.0
    while True:
        try:
            payload = sends.get(timeout=1.0)
        except queue.Empty:
            payload = None
        if payload is not None:
            try:
                _post(payload, cfg)
            finally:
                sends.task_done()
            continue
        if time.monotonic() >= next_poll:
            next_poll = time.monotonic() + POLL_EVERY_S
            try:
                _poll(cfg)
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("hivra-inbox: poll failed: %s", exc)


# --------------------------------------------------------------------------- hooks

def _find_request(session_key: str, command: str, pattern_keys: list) -> Optional[dict]:
    """The queued approval these hook arguments describe (Hermes queues it before the hook runs)."""
    try:
        from tools import approval
        with approval._lock:
            matches = [e for e in approval._gateway_queues.get(session_key, []) or []
                       if e.data.get("command") == command
                       and list(e.data.get("pattern_keys") or [e.data.get("pattern_key", "")]) == list(pattern_keys)]
            return dict(matches[-1].data) if matches else None
    except Exception:
        return None


def on_pre_approval_request(**kw: Any) -> None:
    try:
        if str(kw.get("surface") or "") == "cli" or kw.get("coalesced"):
            return
        if _settings() is None:
            return
        session_key = str(kw.get("session_key") or "")
        raw_command = str(kw.get("command") or "")
        keys = list(kw.get("pattern_keys") or [kw.get("pattern_key") or ""])
        data = _find_request(session_key, raw_command, keys) if session_key else None
        if not data or not data.get("request_id"):
            return
        prompt_id = str(data["request_id"])[:128]
        command = _redact(raw_command)
        complete = bool(command) and len(command) <= COMMAND_MAX
        choices = ["once"]
        if data.get("allow_session", True) and not data.get("smart_denied"):
            choices.append("session")
        if data.get("allow_permanent", True) and not data.get("smart_denied"):
            choices.append("always")
        choices.append("deny")
        try:
            wait_s = max(int(float(data.get("timeout_s") or DEFAULT_WAIT_S)), 30)
        except (TypeError, ValueError):
            wait_s = DEFAULT_WAIT_S
        with _lock:
            _open[prompt_id] = {"session_key": session_key, "command": raw_command, "complete": complete,
                                "choices": choices, "answerable": True, "deadline": time.monotonic() + wait_s + 30}
        _send({
            "event": "prompt.pending", "prompt_id": prompt_id, "kind": "approval",
            "summary": _cut(_redact(str(kw.get("description") or "")), SUMMARY_MAX),
            "command": _cut(command, COMMAND_MAX), "command_complete": complete,
            "choices": choices, "session_id": _cut(str(kw.get("session_id") or ""), 200),
            "ttl_seconds": wait_s,
        })
    except Exception as exc:  # pragma: no cover - hooks never raise
        logger.debug("hivra-inbox: approval hook failed: %s", exc)


def on_post_approval_response(**kw: Any) -> None:
    try:
        if str(kw.get("surface") or "") == "cli" or _settings() is None:
            return
        session_key = str(kw.get("session_key") or "")
        command = str(kw.get("command") or "")
        with _lock:
            match = next((p for p, info in _open.items()
                          if info["session_key"] == session_key and info["command"] == command), None)
            if match:
                _open.pop(match, None)
        if match:
            _send({"event": "prompt.resolved", "prompt_id": match, "kind": "approval",
                   "outcome": str(kw.get("choice") or "timeout")[:32]})
    except Exception as exc:  # pragma: no cover
        logger.debug("hivra-inbox: approval result hook failed: %s", exc)


def on_human_input_request(**kw: Any) -> None:
    # Approvals are covered by the approval hooks above; questions are shown, answered in the chat.
    try:
        if kw.get("kind") != "clarify" or str(kw.get("platform") or "") == "cli" or _settings() is None:
            return
        prompt_id = str(kw.get("request_id") or "")[:128]
        if not prompt_id:
            return
        with _lock:
            _open[prompt_id] = {"session_key": str(kw.get("session_key") or ""), "command": "", "complete": False,
                                "choices": [], "answerable": False, "deadline": time.monotonic() + 3600}
        _send({"event": "prompt.pending", "prompt_id": prompt_id, "kind": "clarify",
               "summary": _cut(_redact(str(kw.get("prompt") or "")), QUESTION_MAX),
               "session_id": _cut(str(kw.get("session_id") or ""), 200), "ttl_seconds": 3600})
    except Exception as exc:  # pragma: no cover
        logger.debug("hivra-inbox: question hook failed: %s", exc)


def on_human_input_resolved(**kw: Any) -> None:
    try:
        if kw.get("kind") != "clarify" or _settings() is None:
            return
        prompt_id = str(kw.get("request_id") or "")[:128]
        with _lock:
            known = _open.pop(prompt_id, None)
        if known is not None:
            _send({"event": "prompt.resolved", "prompt_id": prompt_id, "kind": "clarify",
                   "outcome": str(kw.get("outcome") or "error")[:32]})
    except Exception as exc:  # pragma: no cover
        logger.debug("hivra-inbox: question result hook failed: %s", exc)


def register(ctx) -> None:
    ctx.register_hook("pre_approval_request", on_pre_approval_request)
    ctx.register_hook("post_approval_response", on_post_approval_response)
    ctx.register_hook("on_human_input_request", on_human_input_request)
    ctx.register_hook("on_human_input_resolved", on_human_input_resolved)


def reset_for_tests() -> None:
    global _config, _config_read, _sends, _worker
    with _lock:
        _config = None
        _config_read = False
        _sends = None
        _worker = None
        _open.clear()
