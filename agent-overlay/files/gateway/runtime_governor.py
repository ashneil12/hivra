"""Runtime governor client for HermesOS managed instances.

The dashboard sidecar owns the local enforcement API. This module keeps the
agent runtime independent from dashboard internals: it signs local requests,
fails closed when required, and returns small typed decisions to gateway/cron.

Hivra overlay: ``GovernedTurn`` and the ``governed_*`` decorators at the bottom of this module are the
only runtime-governor wiring. hivra_overlay.seams wraps the five upstream choke points at plugin load.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import hmac
import hashlib
import inspect
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from utils import is_truthy_value

logger = logging.getLogger(__name__)

DEFAULT_UNAVAILABLE_MESSAGE = (
    "HermesOS runtime limits could not be verified. Try again in a moment."
)
DEFAULT_LIMIT_MESSAGE = (
    "HermesOS runtime limit reached. Upgrade or wait for your allowance to reset."
)


@dataclass(frozen=True)
class RuntimeGovernorDecision:
    allowed: bool
    lease_id: Optional[str] = None
    deadline_at: Optional[str] = None
    reason: str = ""
    user_message: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RuntimeGovernorHeartbeat:
    should_stop: bool = False
    reason: str = ""
    user_message: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


class RuntimeGovernorError(RuntimeError):
    """Raised for required lifecycle calls that cannot be verified."""

    def __init__(self, message: str = DEFAULT_UNAVAILABLE_MESSAGE):
        super().__init__(message)
        self.user_message = message


class RuntimeGovernorClient:
    """Small stdlib-only client for the local sidecar runtime API."""

    def __init__(
        self,
        *,
        base_url: str,
        instance_id: str,
        api_key: str,
        required: bool,
        timeout_seconds: float = 5.0,
        default_user_id: str = "",
        default_tier: str = "free",
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.instance_id = (instance_id or "").strip()
        self.api_key = api_key or ""
        self.required = bool(required)
        self.timeout_seconds = max(float(timeout_seconds or 5.0), 0.5)
        self.default_user_id = (default_user_id or "").strip()
        self.default_tier = (default_tier or "free").strip() or "free"

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.instance_id and self.api_key)

    @property
    def enabled(self) -> bool:
        return self.required or self.configured

    def admit(
        self,
        *,
        platform: str,
        session_key: str,
        source_message_id: str = "",
        message_preview: str = "",
        user_id: str = "",
        tier: str = "",
    ) -> RuntimeGovernorDecision:
        if not self.enabled:
            return RuntimeGovernorDecision(allowed=True, reason="disabled")

        if not self.configured:
            return RuntimeGovernorDecision(
                allowed=False,
                reason="policy_unavailable",
                user_message=DEFAULT_UNAVAILABLE_MESSAGE,
            )

        payload = {
            "userId": (user_id or self.default_user_id).strip(),
            "tier": (tier or self.default_tier).strip() or "free",
            "platform": str(platform or "").strip(),
            "sessionKey": str(session_key or "").strip(),
            "sourceMessageId": str(source_message_id or "").strip(),
            "messagePreview": str(message_preview or "")[:500],
        }
        try:
            data = self._post("/admit", payload)
        except RuntimeGovernorError as exc:
            logger.warning(
                "Runtime governor admission failed closed: %s",
                exc.__class__.__name__,
            )
            return RuntimeGovernorDecision(
                allowed=False,
                reason="policy_unavailable",
                user_message=exc.user_message,
            )

        allowed = bool(data.get("allowed"))
        return RuntimeGovernorDecision(
            allowed=allowed,
            lease_id=_optional_string(data.get("leaseId")),
            deadline_at=_optional_string(data.get("deadlineAt")),
            reason=_optional_string(data.get("reason")) or ("allowed" if allowed else "denied"),
            user_message=_optional_string(data.get("userMessage"))
            or ("" if allowed else DEFAULT_LIMIT_MESSAGE),
            raw=data,
        )

    def start(self, lease_id: str) -> None:
        if not lease_id:
            return
        self._post_lifecycle("/start", lease_id)

    def heartbeat(self, lease_id: str) -> RuntimeGovernorHeartbeat:
        if not lease_id:
            return RuntimeGovernorHeartbeat()
        try:
            data = self._post_lifecycle("/heartbeat", lease_id)
        except RuntimeGovernorError as exc:
            logger.warning(
                "Runtime governor heartbeat failed closed: %s",
                exc.__class__.__name__,
            )
            return RuntimeGovernorHeartbeat(
                should_stop=True,
                reason="policy_unavailable",
                user_message=exc.user_message,
            )

        should_stop = bool(data.get("shouldStop"))
        return RuntimeGovernorHeartbeat(
            should_stop=should_stop,
            reason=_optional_string(data.get("reason")) or ("cutoff" if should_stop else "ok"),
            user_message=_optional_string(data.get("userMessage"))
            or (DEFAULT_LIMIT_MESSAGE if should_stop else ""),
            raw=data,
        )

    def finish(self, lease_id: str, *, reason: str = "agent_end") -> None:
        if not lease_id:
            return
        self._post_lifecycle("/finish", lease_id, reason=reason)

    def fail(self, lease_id: str, *, reason: str = "agent_error") -> None:
        if not lease_id:
            return
        self._post_lifecycle("/fail", lease_id, reason=reason)

    def _post_lifecycle(
        self,
        path: str,
        lease_id: str,
        *,
        reason: str = "",
    ) -> dict[str, Any]:
        if not self.enabled:
            return {}
        if not self.configured:
            raise RuntimeGovernorError()
        payload = {"leaseId": lease_id}
        if reason:
            payload["reason"] = reason
        return self._post(path, payload)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.configured:
            raise RuntimeGovernorError()

        request_payload = {
            **payload,
            "instanceId": self.instance_id,
        }
        body = json.dumps(
            request_payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        timestamp = str(int(time.time() * 1000))
        signature = hmac.new(
            self.api_key.encode("utf-8"),
            timestamp.encode("utf-8") + b"." + body,
            hashlib.sha256,
        ).hexdigest()

        url = self.base_url + (path if path.startswith("/") else "/" + path)
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-hermes-timestamp": timestamp,
                "x-hermes-signature": signature,
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                response_body = response.read().decode("utf-8")
                status = getattr(response, "status", response.getcode())
        except urllib.error.HTTPError as exc:
            status = exc.code
            try:
                response_body = exc.read().decode("utf-8")
            except Exception:
                response_body = ""
            raise RuntimeGovernorError(_safe_error_message(status, response_body)) from exc
        except Exception as exc:
            raise RuntimeGovernorError() from exc

        if status >= 400:
            raise RuntimeGovernorError(_safe_error_message(status, response_body))

        try:
            parsed = json.loads(response_body) if response_body else {}
        except json.JSONDecodeError as exc:
            raise RuntimeGovernorError() from exc

        if parsed.get("success") is False:
            raise RuntimeGovernorError(
                _optional_string(parsed.get("error")) or DEFAULT_UNAVAILABLE_MESSAGE
            )

        data = parsed.get("data", parsed)
        if not isinstance(data, dict):
            raise RuntimeGovernorError()
        return data


class DisabledRuntimeGovernorClient(RuntimeGovernorClient):
    def __init__(self) -> None:
        super().__init__(
            base_url="",
            instance_id="",
            api_key="",
            required=False,
        )

    @property
    def enabled(self) -> bool:
        return False


def get_runtime_governor() -> RuntimeGovernorClient:
    required = is_truthy_value(os.getenv("HERMES_RUNTIME_GOVERNOR_REQUIRED"), default=False)
    enabled = required or is_truthy_value(
        os.getenv("HERMES_RUNTIME_GOVERNOR_ENABLED"),
        default=False,
    )
    if not enabled:
        return DisabledRuntimeGovernorClient()

    timeout_raw = os.getenv("HERMES_RUNTIME_GOVERNOR_TIMEOUT_SECONDS", "5")
    try:
        timeout_seconds = float(timeout_raw)
    except (TypeError, ValueError):
        timeout_seconds = 5.0

    return RuntimeGovernorClient(
        base_url=os.getenv("HERMES_RUNTIME_GOVERNOR_URL", ""),
        instance_id=os.getenv("HERMES_RUNTIME_GOVERNOR_INSTANCE_ID", ""),
        api_key=os.getenv("API_SERVER_KEY", ""),
        required=required,
        timeout_seconds=timeout_seconds,
        default_user_id=os.getenv("HERMES_RUNTIME_GOVERNOR_USER_ID", ""),
        default_tier=os.getenv("HERMES_RUNTIME_GOVERNOR_TIER", "free"),
    )


def _optional_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _safe_error_message(status: int, response_body: str) -> str:
    if status >= 500:
        return DEFAULT_UNAVAILABLE_MESSAGE
    try:
        parsed = json.loads(response_body) if response_body else {}
    except json.JSONDecodeError:
        parsed = {}
    message = _optional_string(parsed.get("error")) if isinstance(parsed, dict) else ""
    return message or DEFAULT_UNAVAILABLE_MESSAGE


# ---------------------------------------------------------------------------
# hermes-fork: governed turn (admit -> start -> heartbeat -> finish/fail)
#
# The wiring into upstream-owned files is one decorator line per agent-run
# choke point (see ``GOVERNED_SEAMS`` and tests/gateway/test_runtime_governor.py,
# which fails if a future upstream merge drops one of them).  Everything the
# old fork spread through gateway/run.py, api_server.py and cron/scheduler.py
# (admission, lease close, step-callback heartbeats, poll-loop cutoff checks,
# synthesized cutoff responses) lives here instead.
#
# Behaviour preserved from the previous wiring:
#   * DEFAULT-OFF: with HERMES_RUNTIME_GOVERNOR_* unset ``get_runtime_governor``
#     returns a disabled client and every wrapper is a straight pass-through.
#   * admit() denial or an unreachable sidecar denies the turn (fail closed, a
#     failed ``start`` also denies); the user sees the sidecar's message.
#   * the lease is closed exactly once: ``finish(agent_end)`` on a clean end,
#     ``fail(runtime_cutoff)`` after a cutoff, ``fail(agent_error)`` otherwise.
#   * a heartbeat that says stop, errors, or cannot be verified is a cutoff: the
#     agent is hard-interrupted and the user-visible response becomes the cutoff
#     message (``runtime_cutoff: True`` on the result).
#
# One deliberate change: heartbeats now come from a timer thread owned by the
# turn (every HERMES_RUNTIME_GOVERNOR_HEARTBEAT_SECONDS, default 5) instead of
# the agent step callback plus the gateway/cron poll loops, so the three
# surfaces no longer need a callback or a poll-loop edit each.
# ---------------------------------------------------------------------------

HEARTBEAT_SECONDS_ENV = "HERMES_RUNTIME_GOVERNOR_HEARTBEAT_SECONDS"
DEFAULT_HEARTBEAT_SECONDS = 5.0
GOVERNED_ATTR = "__hermes_runtime_governor__"

# Seam name -> "module:qualified.name" of the upstream function that carries the decorator.
# tests/gateway/test_runtime_governor.py resolves each one and asserts the marker is present.
GOVERNED_SEAMS = {
    "gateway_turn": "gateway.run:GatewayRunner._handle_message_with_agent",
    "gateway_run": "gateway.run:GatewayRunner._run_agent",
    "api_run": "gateway.platforms.api_server:APIServerAdapter._run_agent",
    "api_runs_sync": "gateway.platforms.api_server_runs:_run_agent_sync",
    "cron_run": "cron.scheduler:_run_agent_with_watchdog",
}

_CURRENT_TURN: "contextvars.ContextVar[Optional[GovernedTurn]]" = contextvars.ContextVar(
    "hermes_runtime_governed_turn", default=None
)


def _heartbeat_interval() -> float:
    try:
        return max(float(os.getenv(HEARTBEAT_SECONDS_ENV, "") or DEFAULT_HEARTBEAT_SECONDS), 0.05)
    except (TypeError, ValueError):
        return DEFAULT_HEARTBEAT_SECONDS


def _interrupt_agent(agent: Any) -> bool:
    """Hard-stop ``agent`` without a message (a message would be replayed as a follow-up turn)."""
    if agent is None or not callable(getattr(agent, "interrupt", None)):
        return False
    try:
        from agent.interrupt_compat import request_hard_interrupt

        return bool(request_hard_interrupt(agent, None, tool_reason="runtime governor cutoff"))
    except ImportError:
        agent.interrupt(None)
        return True


class GovernedTurn:
    """One metered agent turn.  Build with :meth:`begin`; never raises."""

    def __init__(self, governor: Optional[RuntimeGovernorClient] = None, *,
                 get_agent: Optional[Callable[[], Any]] = None) -> None:
        self.governor = governor
        self.lease_id = ""
        self.denied = False
        self.user_message = ""
        self.outcome = "agent_error"
        self.cutoff = False
        self.cutoff_message = ""
        self.closed = False
        self._get_agent = get_agent
        self._interrupted = False
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- construction -------------------------------------------------------
    @classmethod
    def begin(cls, *, platform: str, session_key: str, source_message_id: str = "",
              message_preview: str = "", user_id: str = "",
              get_agent: Optional[Callable[[], Any]] = None) -> "GovernedTurn":
        turn = cls(get_agent=get_agent)
        try:
            governor = get_runtime_governor()
            if getattr(governor, "enabled", True) is False:
                return turn
            turn.governor = governor
            decision = governor.admit(
                platform=platform, session_key=session_key,
                source_message_id=source_message_id, message_preview=message_preview,
                user_id=user_id,
            )
            if not decision.allowed:
                return turn._deny(decision.user_message or DEFAULT_UNAVAILABLE_MESSAGE)
            if decision.lease_id:
                try:
                    governor.start(decision.lease_id)
                except RuntimeGovernorError as exc:
                    logger.warning("Runtime governor start failed closed for %s: %s",
                                   (session_key or "")[:20], exc.__class__.__name__)
                    turn.lease_id = decision.lease_id
                    turn.close()
                    return turn._deny(exc.user_message)
                turn.lease_id = decision.lease_id
                turn._start_heartbeat()
            return turn
        except Exception as exc:
            logger.warning("Runtime governor admission failed closed for %s: %s",
                           (session_key or "")[:20], exc.__class__.__name__)
            if turn.lease_id:
                turn.close()
            return turn._deny(DEFAULT_UNAVAILABLE_MESSAGE)

    def _deny(self, message: str) -> "GovernedTurn":
        self.denied = True
        self.user_message = message or DEFAULT_UNAVAILABLE_MESSAGE
        return self

    @property
    def active(self) -> bool:
        return bool(self.lease_id) and not self.closed and not self.denied

    # -- heartbeat / cutoff ---------------------------------------------------
    def _start_heartbeat(self) -> None:
        self._thread = threading.Thread(
            target=self._heartbeat_loop, name="runtime-governor-heartbeat", daemon=True
        )
        self._thread.start()

    def _heartbeat_loop(self) -> None:
        interval = _heartbeat_interval()
        while not self._stop.wait(interval):
            if self.cutoff:
                # Cut off before an agent existed (or the interrupt missed): keep trying until close().
                self._interrupt()
                continue
            try:
                heartbeat = self.governor.heartbeat(self.lease_id)
            except Exception as exc:
                logger.warning("Runtime governor heartbeat error: %s", exc.__class__.__name__)
                self._record_cutoff(DEFAULT_UNAVAILABLE_MESSAGE)
                continue
            if heartbeat.should_stop:
                self._record_cutoff(heartbeat.user_message)

    def _record_cutoff(self, user_message: str) -> None:
        if self.cutoff or self.closed:
            return
        self.cutoff = True
        self.cutoff_message = user_message or DEFAULT_LIMIT_MESSAGE
        self._interrupt()

    def _interrupt(self) -> None:
        # A closed turn must never touch the agent: the gateway reuses cached agents across turns.
        if self._interrupted or self._get_agent is None or self.closed:
            return
        try:
            self._interrupted = _interrupt_agent(self._get_agent())
        except Exception as exc:
            logger.debug("Runtime governor interrupt failed: %s", exc.__class__.__name__)

    # -- result handling ------------------------------------------------------
    def observe(self, result: Any, *, mode: str = "flag") -> Any:
        """Record the outcome of a finished run and surface a cutoff on ``result``.

        ``mode``: ``flag`` only sets ``runtime_cutoff``; ``fill`` also supplies the cutoff message
        when the response is empty; ``replace`` makes the cutoff message the response and marks the
        turn failed (the gateway's historical synthesized response).
        """
        if self.closed:
            return result
        cutoff = self.cutoff or (isinstance(result, dict) and bool(result.get("runtime_cutoff")))
        self.outcome = "runtime_cutoff" if cutoff else "agent_end"
        if cutoff and isinstance(result, dict):
            message = self.cutoff_message or DEFAULT_LIMIT_MESSAGE
            result["runtime_cutoff"] = True
            if mode == "replace":
                result["final_response"] = message
                result["failed"] = True
            elif mode == "fill" and not (result.get("final_response") or "").strip():
                result["final_response"] = message
        return result

    def mark_error(self) -> None:
        """The run raised: close the lease as ``agent_error`` (a cutoff keeps its own outcome)."""
        self.outcome = "runtime_cutoff" if self.cutoff else "agent_error"

    def denial_result(self) -> dict:
        return {"final_response": self.user_message, "error": self.user_message,
                "failed": True, "runtime_cutoff": True}

    def close(self) -> None:
        """Close the lease (idempotent, blocking HTTP: call from a worker thread)."""
        if self.closed:
            return
        self.closed = True
        self._stop.set()
        if not self.lease_id or self.governor is None:
            return
        try:
            if self.outcome == "agent_end":
                self.governor.finish(self.lease_id, reason="agent_end")
            else:
                self.governor.fail(self.lease_id, reason=self.outcome or "agent_error")
        except Exception as exc:
            logger.warning("Runtime governor lease close failed: %s", exc.__class__.__name__)


async def _begin_async(**kwargs: Any) -> GovernedTurn:
    """``GovernedTurn.begin`` off the event loop; a cancelled caller still closes its lease."""
    future = asyncio.get_running_loop().run_in_executor(
        None, functools.partial(GovernedTurn.begin, **kwargs)
    )
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        future.add_done_callback(
            lambda f: (not f.cancelled() and f.exception() is None) and f.result().close()
        )
        raise


async def _close_async(turn: GovernedTurn) -> None:
    if not turn.lease_id or turn.closed:
        return
    future = asyncio.get_running_loop().run_in_executor(None, turn.close)
    await asyncio.shield(future)


def _mark(fn: Callable, seam: str) -> Callable:
    setattr(fn, GOVERNED_ATTR, seam)
    return fn


def _text(value: Any, limit: int = 500) -> str:
    return value[:limit] if isinstance(value, str) else str(value or "")[:limit]


# -- seam: gateway_turn -- GatewayRunner._handle_message_with_agent (admission) ----------
def governed_gateway_turn(fn: Callable) -> Callable:
    """Admit the inbound turn before any session work; close the lease when the handler unwinds."""

    @functools.wraps(fn)
    async def wrapper(self, event, source, _quick_key, *args, **kwargs):
        platform = getattr(getattr(source, "platform", None), "value", None) or ""
        message_id = getattr(event, "message_id", None)

        def _agent():
            return getattr(self._session_state(_quick_key).turn, "agent", None)

        turn = await _begin_async(
            platform=str(platform), session_key=_quick_key or "",
            source_message_id=str(message_id) if message_id is not None
            else str(getattr(event, "platform_update_id", "") or ""),
            message_preview=_text(getattr(event, "text", "")),
            user_id=getattr(source, "user_id", None) or getattr(source, "user_id_alt", None) or "",
            get_agent=_agent,
        )
        if turn.denied:
            return turn.user_message
        token = _CURRENT_TURN.set(turn)
        try:
            return await fn(self, event, source, _quick_key, *args, **kwargs)
        finally:
            _CURRENT_TURN.reset(token)
            await _close_async(turn)

    return _mark(wrapper, "gateway_turn")


# -- seam: gateway_run -- GatewayRunner._run_agent (outcome + cutoff response) -------------
def governed_gateway_run(fn: Callable) -> Callable:
    """Record the run outcome on the turn opened by ``governed_gateway_turn``."""

    @functools.wraps(fn)
    async def wrapper(self, *args, **kwargs):
        turn = _CURRENT_TURN.get()
        if turn is None or not turn.active:
            return await fn(self, *args, **kwargs)
        try:
            result = await fn(self, *args, **kwargs)
        except BaseException:
            turn.mark_error()
            raise
        return turn.observe(result, mode="replace")

    return _mark(wrapper, "gateway_run")


# -- seam: api_run -- APIServerAdapter._run_agent (chat/responses/session chat) ------------
def governed_api_run(fn: Callable) -> Callable:
    signature = inspect.signature(fn)

    @functools.wraps(fn)
    async def wrapper(self, *args, **kwargs):
        bound = signature.bind(self, *args, **kwargs)
        arguments = bound.arguments
        agent_ref = arguments.get("agent_ref")
        injected = agent_ref is None
        holder = [None] if injected else agent_ref
        session_key = arguments.get("gateway_session_key") or arguments.get("session_id") or ""
        turn = await _begin_async(
            platform="api_server", session_key=session_key, source_message_id=session_key,
            message_preview=_text(arguments.get("user_message")), get_agent=lambda: holder[0],
        )
        if turn.denied:
            return turn.denial_result(), {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        if injected and turn.lease_id:
            arguments["agent_ref"] = holder
        try:
            result, usage = await fn(*bound.args, **bound.kwargs)
        except BaseException:
            await _close_async(turn)
            raise
        turn.observe(result, mode="fill")
        await _close_async(turn)
        return result, usage

    return _mark(wrapper, "api_run")


# -- seam: api_runs_sync -- /v1/runs executor-thread body ------------------------------------
def governed_run_sync(fn: Callable) -> Callable:
    @functools.wraps(fn)
    def wrapper(self, run, agent, *args, **kwargs):
        session_key = (getattr(run, "approval_session_key", None) or getattr(run, "run_id", "") or "")
        turn = GovernedTurn.begin(
            platform="api_server", session_key=session_key, source_message_id=session_key,
            message_preview=_text(getattr(run, "user_message", "")), get_agent=lambda: agent,
        )
        if turn.denied:
            from gateway.platforms import api_server_runs as _runs

            return turn.denial_result(), _runs._run_usage(agent), _runs._served_runtime(agent)
        try:
            result, usage, served = fn(self, run, agent, *args, **kwargs)
        except BaseException:
            turn.close()
            raise
        turn.observe(result, mode="flag")
        turn.close()
        return result, usage, served

    return _mark(wrapper, "api_runs_sync")


# -- seam: cron_run -- cron.scheduler._run_agent_with_watchdog ----------------------------------
def governed_cron_run(fn: Callable) -> Callable:
    """Meter one cron agent turn after every pre-agent gate (script/wake gate) has passed."""

    @functools.wraps(fn)
    def wrapper(agent, prompt, job, job_id, *args, **kwargs):
        session_id = getattr(agent, "session_id", None)
        session_key = session_id if isinstance(session_id, str) and session_id else f"cron_{job_id}"
        turn = GovernedTurn.begin(
            platform="cron", session_key=session_key, source_message_id=session_key,
            message_preview=_text(prompt), get_agent=lambda: agent,
        )
        if turn.denied:
            return {"final_response": turn.user_message}
        try:
            result = fn(agent, prompt, job, job_id, *args, **kwargs)
        except BaseException:
            turn.close()
            raise
        turn.observe(result, mode="flag")
        cutoff = turn.cutoff
        message = turn.cutoff_message
        turn.close()
        # A cutoff is a clean metered end: deliver the cutoff message as the job's response.
        return {"final_response": message or DEFAULT_LIMIT_MESSAGE} if cutoff else result

    return _mark(wrapper, "cron_run")
