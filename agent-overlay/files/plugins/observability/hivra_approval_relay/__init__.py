"""hivra_approval_relay - surface blocking approval prompts outside the workspace.

Why this exists
---------------
When ``tools/approval.py`` blocks an agent worker thread on a dangerous-command
approval, the only signal is an ``approval.request`` JSON-RPC event pushed down
the ``/api/ws`` socket that the Hivra workspace iframe holds open. If the owner
isn't looking at that iframe, a blocked agent is indistinguishable from an idle
one until the approval times out and the agent unwinds as denied.

There is no pollable endpoint on the agent: ``tui_gateway`` registers
``approval.respond`` but no list/query method, and ``tools.approval._pending``
is written only on the *no-gateway-callback* fallback path (and never read).
The real blocked-state lives in ``tools.approval._gateway_queues``, in-process.

So we push instead of poll. ``_await_gateway_decision`` fires
``pre_approval_request`` *before* it calls the gateway notify callback and
``post_approval_response`` after the wait resolves - one pair of hooks covering
both blocking call sites (the terminal command guard and the execute_code
guard). This plugin relays that pair to the dashboard, which turns it into a
user-visible "your agent needs you" signal.

Contract
--------
Hooks are observers: return values are ignored and exceptions are swallowed by
``invoke_hook``. We additionally guarantee we never block the agent thread -
every send is handed to a bounded queue drained by one daemon worker.

Configuration (all via env; the VM's compose ``.env`` already carries the first
two, and ``HERMES_INSTANCE_ID`` is seeded alongside them):

    HERMES_DASHBOARD_URL    e.g. https://hivra.cloud   (required)
    API_SERVER_KEY          per-instance bearer         (required)
    HERMES_INSTANCE_ID      instance uuid               (required)

    HIVRA_APPROVAL_RELAY_ENABLED      "0"/"false" hard-disables (default on)
    HIVRA_APPROVAL_RELAY_URL          full endpoint override
    HIVRA_APPROVAL_RELAY_TIMEOUT_S    per-request timeout (default 5.0)
    HIVRA_APPROVAL_RELAY_SEND_COMMAND "0" to omit the command text (default on)

Missing required env => the plugin loads but stays inert (logged once).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

logger = logging.getLogger(__name__)

_ENDPOINT_PATH = "/api/internal/agent-notify"
_DEFAULT_TIMEOUT_S = 5.0
_QUEUE_MAXSIZE = 64
_SEND_ATTEMPTS = 2
_COMMAND_MAX_CHARS = 400
_SUMMARY_MAX_CHARS = 300
_DEFAULT_TTL_S = 300

_lock = threading.Lock()
_queue: "queue.Queue[dict] | None" = None
_worker: Optional[threading.Thread] = None
_config: "_Config | None" = None
_config_resolved = False
_inert_logged = False


class _Config:
    __slots__ = ("url", "bearer", "instance_id", "timeout_s", "send_command")

    def __init__(self, url: str, bearer: str, instance_id: str,
                 timeout_s: float, send_command: bool) -> None:
        self.url = url
        self.bearer = bearer
        self.instance_id = instance_id
        self.timeout_s = timeout_s
        self.send_command = send_command


def _env_flag(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


def _resolve_config() -> Optional[_Config]:
    """Read env once. Returns None when the relay can't be configured."""
    global _config, _config_resolved, _inert_logged
    with _lock:
        if _config_resolved:
            return _config
        _config_resolved = True

        if not _env_flag("HIVRA_APPROVAL_RELAY_ENABLED", True):
            logger.info("hivra_approval_relay: disabled by env")
            return None

        bearer = (os.environ.get("API_SERVER_KEY") or "").strip()
        instance_id = (os.environ.get("HERMES_INSTANCE_ID") or "").strip()
        override = (os.environ.get("HIVRA_APPROVAL_RELAY_URL") or "").strip()
        base = (os.environ.get("HERMES_DASHBOARD_URL") or "").strip()

        url = override or (base.rstrip("/") + _ENDPOINT_PATH if base else "")

        missing = [
            name for name, value in (
                ("HERMES_DASHBOARD_URL/HIVRA_APPROVAL_RELAY_URL", url),
                ("API_SERVER_KEY", bearer),
                ("HERMES_INSTANCE_ID", instance_id),
            ) if not value
        ]
        if missing:
            if not _inert_logged:
                _inert_logged = True
                logger.info(
                    "hivra_approval_relay: inert (missing %s)", ", ".join(missing)
                )
            return None

        # The bearer is the per-instance API_SERVER_KEY - never ship it in
        # cleartext. Parse with urlsplit so the real host is used: naive string
        # splitting treats a `user:pass@host` userinfo as the host, so
        # `http://127.0.0.1:0@attacker.com/…` would look like loopback while
        # urlopen actually connects to attacker.com and leaks the bearer. Only a
        # genuine-loopback hostname may use http (dev boxes point at localhost).
        try:
            parsed = urllib.parse.urlsplit(url)
        except Exception:
            logger.warning("hivra_approval_relay: unparseable endpoint %r", url)
            return None
        scheme = (parsed.scheme or "").lower()
        hostname = (parsed.hostname or "").lower()  # excludes userinfo + port
        if scheme != "https":
            if scheme != "http" or hostname not in ("localhost", "127.0.0.1", "::1"):
                logger.warning(
                    "hivra_approval_relay: refusing non-https endpoint host=%r", hostname
                )
                return None

        try:
            timeout_s = float(os.environ.get("HIVRA_APPROVAL_RELAY_TIMEOUT_S") or "")
        except (TypeError, ValueError):
            timeout_s = _DEFAULT_TIMEOUT_S
        if timeout_s <= 0:
            timeout_s = _DEFAULT_TIMEOUT_S

        _config = _Config(
            url=url,
            bearer=bearer,
            instance_id=instance_id,
            timeout_s=timeout_s,
            send_command=_env_flag("HIVRA_APPROVAL_RELAY_SEND_COMMAND", True),
        )
        return _config


def _approval_ttl_seconds() -> int:
    """The park window the dashboard should expire a stale pending row after.

    Mirrors ``tools.approval._await_gateway_decision``'s
    ``approvals.gateway_timeout`` so a crashed agent (which never fires
    ``post_approval_response``) can't strand a badge forever.
    """
    try:
        from hermes_cli.config import load_config

        approvals = load_config().get("approvals") or {}
        return max(int(approvals.get("gateway_timeout", _DEFAULT_TTL_S)), 1)
    except Exception:
        return _DEFAULT_TTL_S


def _redact(command: str) -> str:
    """Strip credential-shaped values before the command leaves the box.

    Same Tirith-grade redactor the gateway applies to ``approval.request``
    frames - ``gateway.run._redact_approval_command`` is a thin wrapper over
    this, and we call the wrapped function directly to avoid importing the
    chat-platform gateway into the dashboard process. A credential-shaped value
    would otherwise be echoed verbatim into a dashboard row.
    """
    if not command:
        return ""
    try:
        from agent.redact import redact_sensitive_text

        return redact_sensitive_text(str(command), force=True) or ""
    except Exception:
        # No redactor reachable - drop the command rather than risk a leak.
        logger.debug("hivra_approval_relay: redactor unavailable, dropping command")
        return ""


def _truncate(text: str, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _prompt_id(kwargs: dict) -> str:
    """A stable id shared by the pre/post pair for one approval.

    ``_fire_approval_hook`` seeds ``tool_call_id`` from a contextvar, so it is
    the natural key. It can be empty (execute_code outside a tool call, or an
    older turn), so fall back to a digest of the fields that do identify the
    request. Both hooks see identical values for these, so the pre/post pair
    always agrees.
    """
    tool_call_id = str(kwargs.get("tool_call_id") or "").strip()
    if tool_call_id:
        return tool_call_id[:64]
    seed = "|".join(
        str(kwargs.get(k) or "")
        for k in ("session_key", "turn_id", "pattern_key", "command")
    )
    return hashlib.sha256(seed.encode("utf-8", "replace")).hexdigest()[:32]


def _worker_loop(q: "queue.Queue[dict]", cfg: _Config) -> None:
    while True:
        payload = q.get()
        try:
            _post(payload, cfg)
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("hivra_approval_relay: send failed: %s", exc, exc_info=True)
        finally:
            q.task_done()


def _post(payload: dict, cfg: _Config) -> None:
    body = json.dumps(payload).encode("utf-8")
    last_exc: Exception | None = None
    for attempt in range(_SEND_ATTEMPTS):
        req = urllib.request.Request(
            cfg.url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {cfg.bearer}",
                "User-Agent": "hivra-approval-relay/0.1",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=cfg.timeout_s) as resp:
                if 200 <= resp.status < 300:
                    return
                last_exc = RuntimeError(f"HTTP {resp.status}")
        except urllib.error.HTTPError as exc:
            # 4xx is terminal (bad bearer, unknown instance) - don't retry.
            if 400 <= exc.code < 500:
                logger.warning(
                    "hivra_approval_relay: endpoint rejected event (HTTP %s)", exc.code
                )
                return
            last_exc = exc
        except Exception as exc:
            last_exc = exc
        if attempt + 1 < _SEND_ATTEMPTS:
            continue
    logger.debug("hivra_approval_relay: giving up after %d attempts: %s",
                 _SEND_ATTEMPTS, last_exc)


def _enqueue(payload: dict) -> None:
    """Hand off to the worker. Never blocks, never raises."""
    cfg = _resolve_config()
    if cfg is None:
        return

    global _queue, _worker
    with _lock:
        if _queue is None:
            _queue = queue.Queue(maxsize=_QUEUE_MAXSIZE)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(
                target=_worker_loop,
                args=(_queue, cfg),
                name="hivra-approval-relay",
                daemon=True,
            )
            _worker.start()
        q = _queue

    try:
        q.put_nowait(payload)
    except queue.Full:
        # A wedged dashboard must never stall an approval. Drop the event; the
        # agent still blocks correctly and the iframe still gets its WS frame.
        logger.warning("hivra_approval_relay: queue full, dropping event")


def _base_payload(kwargs: dict, cfg: _Config) -> dict:
    return {
        "instance_id": cfg.instance_id,
        "prompt_id": _prompt_id(kwargs),
        "kind": "approval",
        "surface": str(kwargs.get("surface") or "gateway"),
        "session_key": str(kwargs.get("session_key") or ""),
    }


def _should_relay(kwargs: dict) -> bool:
    # The CLI-interactive path prompts on a TTY the user is already watching.
    # Only gateway-surface approvals are invisible.
    return str(kwargs.get("surface") or "") != "cli"


def on_pre_approval_request(**kwargs: Any) -> None:
    try:
        if not _should_relay(kwargs):
            return
        cfg = _resolve_config()
        if cfg is None:
            return

        # Redact the summary too, not just the command. The dangerous-command
        # guards pre-redact their description, but other surfaces (e.g. the
        # mcp-elicitation approval path) pass a RAW description into the hook, so
        # redact defensively here - a summary is short human text but must not be
        # a redaction hole if it ever carries a credential-shaped value.
        summary = _redact(str(kwargs.get("description") or "")) or "Approval requested"
        payload = _base_payload(kwargs, cfg)
        payload.update(
            {
                "event": "prompt.pending",
                "summary": _truncate(summary, _SUMMARY_MAX_CHARS),
                "ttl_seconds": _approval_ttl_seconds(),
            }
        )
        if cfg.send_command:
            payload["command"] = _truncate(
                _redact(str(kwargs.get("command") or "")), _COMMAND_MAX_CHARS
            )
        _enqueue(payload)
    except Exception as exc:  # pragma: no cover - hooks must never raise
        logger.debug("hivra_approval_relay: pre hook failed: %s", exc, exc_info=True)


def on_post_approval_response(**kwargs: Any) -> None:
    try:
        if not _should_relay(kwargs):
            return
        cfg = _resolve_config()
        if cfg is None:
            return

        payload = _base_payload(kwargs, cfg)
        payload.update(
            {
                "event": "prompt.resolved",
                # "once" | "session" | "always" | "deny" | "timeout"
                "choice": str(kwargs.get("choice") or "timeout"),
            }
        )
        _enqueue(payload)
    except Exception as exc:  # pragma: no cover - hooks must never raise
        logger.debug("hivra_approval_relay: post hook failed: %s", exc, exc_info=True)


def register(ctx) -> None:
    ctx.register_hook("pre_approval_request", on_pre_approval_request)
    ctx.register_hook("post_approval_response", on_post_approval_response)


def reset_for_tests() -> None:
    global _queue, _worker, _config, _config_resolved, _inert_logged
    with _lock:
        _queue = None
        _worker = None
        _config = None
        _config_resolved = False
        _inert_logged = False
