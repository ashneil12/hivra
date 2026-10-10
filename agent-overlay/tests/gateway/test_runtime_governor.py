"""Runtime governor (managed metering): client, governed-turn lifecycle, and seam wiring.

hermes-fork: the wiring into upstream-owned files is one decorator per agent-run choke point.
``test_every_seam_is_wired`` and the ``*_real_*`` tests fail if an upstream merge silently drops
one of them, so these tests are the living manifest of the runtime-governor seam.
"""

import asyncio
import hashlib
import hmac
import importlib
import json
import time
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.config import Platform
from gateway.runtime_governor import (
    DEFAULT_LIMIT_MESSAGE,
    DEFAULT_UNAVAILABLE_MESSAGE,
    GOVERNED_ATTR,
    GOVERNED_SEAMS,
    GovernedTurn,
    RuntimeGovernorClient,
    RuntimeGovernorDecision,
    RuntimeGovernorError,
    RuntimeGovernorHeartbeat,
    get_runtime_governor,
)
from gateway.session import SessionSource


class _FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self._payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class _Governor:
    """Records every lifecycle call; heartbeat/start behaviour is scriptable."""

    enabled = True

    def __init__(self, decision=None, *, heartbeat=None, start_error=None):
        self.decision = decision or RuntimeGovernorDecision(allowed=True, lease_id="lease-1")
        self.heartbeat_result = heartbeat or RuntimeGovernorHeartbeat(should_stop=False)
        self.start_error = start_error
        self.calls = []

    def admit(self, **kwargs):
        self.calls.append(("admit", kwargs))
        return self.decision

    def start(self, lease_id):
        self.calls.append(("start", lease_id))
        if self.start_error is not None:
            raise self.start_error

    def heartbeat(self, lease_id):
        self.calls.append(("heartbeat", lease_id))
        if isinstance(self.heartbeat_result, Exception):
            raise self.heartbeat_result
        return self.heartbeat_result

    def finish(self, lease_id, *, reason):
        self.calls.append(("finish", lease_id, reason))

    def fail(self, lease_id, *, reason):
        self.calls.append(("fail", lease_id, reason))

    def names(self):
        return [call[0] for call in self.calls]


class _Agent:
    """Minimal agent: ``run`` blocks until a hard interrupt, like a long tool wait."""

    def __init__(self):
        self.interrupts = []
        self.session_id = "session-1"

    def interrupt(self, message=None):
        self.interrupts.append(message)

    @property
    def interrupted(self):
        return bool(self.interrupts)


def _install(monkeypatch, governor):
    monkeypatch.setattr("gateway.runtime_governor.get_runtime_governor", lambda: governor)
    monkeypatch.setenv("HERMES_RUNTIME_GOVERNOR_HEARTBEAT_SECONDS", "0.05")
    return governor


def _wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


# ---------------------------------------------------------------------------
# Client (ported from the previous fork wiring tests)
# ---------------------------------------------------------------------------


def test_runtime_governor_admit_signs_sidecar_payload(monkeypatch):
    captured = {}

    def _fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["body"] = request.data
        captured["timestamp"] = request.get_header("X-hermes-timestamp")
        captured["signature"] = request.get_header("X-hermes-signature")
        return _FakeResponse(
            {
                "success": True,
                "data": {
                    "allowed": True,
                    "leaseId": "lease-1",
                    "deadlineAt": "2026-04-25T12:00:00Z",
                },
            }
        )

    monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)
    client = RuntimeGovernorClient(
        base_url="http://127.0.0.1:9090/api/runtime",
        instance_id="inst_1",
        api_key="secret",
        required=True,
        timeout_seconds=2,
        default_user_id="user-1",
        default_tier="free",
    )

    decision = client.admit(platform="telegram", session_key="s1", message_preview="hello")

    assert decision.allowed is True
    assert decision.lease_id == "lease-1"
    assert captured["url"] == "http://127.0.0.1:9090/api/runtime/admit"
    body = json.loads(captured["body"].decode("utf-8"))
    assert body == {
        "userId": "user-1",
        "tier": "free",
        "platform": "telegram",
        "sessionKey": "s1",
        "sourceMessageId": "",
        "messagePreview": "hello",
        "instanceId": "inst_1",
    }
    expected_signature = hmac.new(
        b"secret",
        captured["timestamp"].encode("utf-8") + b"." + captured["body"],
        hashlib.sha256,
    ).hexdigest()
    assert captured["signature"] == expected_signature
    assert captured["timeout"] == 2


def test_required_runtime_governor_missing_config_denies(monkeypatch):
    monkeypatch.setenv("HERMES_RUNTIME_GOVERNOR_REQUIRED", "1")
    monkeypatch.delenv("HERMES_RUNTIME_GOVERNOR_URL", raising=False)
    monkeypatch.delenv("HERMES_RUNTIME_GOVERNOR_INSTANCE_ID", raising=False)
    monkeypatch.delenv("API_SERVER_KEY", raising=False)

    decision = get_runtime_governor().admit(platform="telegram", session_key="s1")

    assert decision.allowed is False
    assert decision.reason == "policy_unavailable"


def test_unset_governor_is_a_disabled_pass_through(monkeypatch):
    for name in ("HERMES_RUNTIME_GOVERNOR_REQUIRED", "HERMES_RUNTIME_GOVERNOR_ENABLED"):
        monkeypatch.delenv(name, raising=False)

    turn = GovernedTurn.begin(platform="telegram", session_key="s1")

    assert turn.denied is False
    assert turn.lease_id == ""
    assert turn.active is False
    turn.close()  # no sidecar, no error


# ---------------------------------------------------------------------------
# GovernedTurn lifecycle
# ---------------------------------------------------------------------------


def test_denied_admission_blocks_the_turn(monkeypatch):
    governor = _install(monkeypatch, _Governor(
        RuntimeGovernorDecision(allowed=False, reason="daily_cap", user_message="Daily cap reached.")))

    turn = GovernedTurn.begin(platform="telegram", session_key="s1", message_preview="hi")

    assert turn.denied is True
    assert turn.user_message == "Daily cap reached."
    assert governor.names() == ["admit"]


def test_admission_error_fails_closed(monkeypatch):
    governor = _Governor()
    governor.admit = lambda **kwargs: (_ for _ in ()).throw(RuntimeError("boom"))
    _install(monkeypatch, governor)

    turn = GovernedTurn.begin(platform="telegram", session_key="s1")

    assert turn.denied is True
    assert turn.user_message == DEFAULT_UNAVAILABLE_MESSAGE


def test_start_failure_denies_and_closes_the_lease(monkeypatch):
    governor = _install(monkeypatch, _Governor(start_error=RuntimeGovernorError("Sidecar says no.")))

    turn = GovernedTurn.begin(platform="telegram", session_key="s1")

    assert turn.denied is True
    assert turn.user_message == "Sidecar says no."
    assert governor.names() == ["admit", "start", "fail"]


def test_clean_end_finishes_the_lease(monkeypatch):
    governor = _install(monkeypatch, _Governor())

    turn = GovernedTurn.begin(platform="cron", session_key="s1")
    assert turn.active
    turn.observe({"final_response": "ok"})
    turn.close()
    turn.close()  # idempotent

    assert governor.names() == ["admit", "start", "finish"]
    assert governor.calls[-1] == ("finish", "lease-1", "agent_end")


def test_unobserved_end_fails_the_lease_as_agent_error(monkeypatch):
    governor = _install(monkeypatch, _Governor())

    turn = GovernedTurn.begin(platform="cron", session_key="s1")
    turn.close()

    assert governor.calls[-1] == ("fail", "lease-1", "agent_error")


def test_heartbeat_stop_interrupts_agent_and_marks_cutoff(monkeypatch):
    governor = _install(monkeypatch, _Governor(
        heartbeat=RuntimeGovernorHeartbeat(should_stop=True, reason="cap", user_message="Runtime cap reached.")))
    agent = _Agent()

    turn = GovernedTurn.begin(platform="telegram", session_key="s1", get_agent=lambda: agent)
    assert _wait_for(lambda: agent.interrupted)
    result = turn.observe({"final_response": "partial", "interrupted": True}, mode="replace")
    turn.close()

    assert agent.interrupts == [None]  # no message: it would be replayed as a follow-up turn
    assert result["runtime_cutoff"] is True
    assert result["final_response"] == "Runtime cap reached."
    assert result["failed"] is True
    assert governor.calls[-1] == ("fail", "lease-1", "runtime_cutoff")


def test_heartbeat_error_is_a_cutoff(monkeypatch):
    _install(monkeypatch, _Governor(heartbeat=RuntimeError("sidecar down")))
    agent = _Agent()

    turn = GovernedTurn.begin(platform="telegram", session_key="s1", get_agent=lambda: agent)
    assert _wait_for(lambda: agent.interrupted)
    turn.close()

    assert turn.cutoff is True
    assert turn.cutoff_message == DEFAULT_UNAVAILABLE_MESSAGE


def test_closed_turn_never_interrupts_the_agent(monkeypatch):
    _install(monkeypatch, _Governor(heartbeat=RuntimeGovernorHeartbeat(should_stop=True)))
    agent = _Agent()

    turn = GovernedTurn(get_agent=lambda: agent)
    turn.close()
    turn._record_cutoff("late")  # a heartbeat that lands after close()

    assert agent.interrupts == []
    assert turn.cutoff is False


@pytest.mark.asyncio
async def test_real_gateway_run_agent_error_fails_the_lease(monkeypatch):
    from gateway.run import GatewayRunner

    governor = _install(monkeypatch, _Governor())
    inner = AsyncMock(side_effect=[{"final_response": "first"}, RuntimeError("boom")])
    runner = _gateway_runner(_Agent(), inner)

    async def resolve(event, source):
        await GatewayRunner._run_agent(runner, "hi", "", [], source, "session-1")
        with pytest.raises(RuntimeError):  # e.g. the pending-message recursion failing
            await GatewayRunner._run_agent(runner, "again", "", [], source, "session-1")
        return None

    await _run_gateway_turn(runner, _event(), resolve)

    assert governor.calls[-1] == ("fail", "lease-1", "agent_error")


def test_cutoff_before_the_agent_exists_interrupts_it_once_it_does(monkeypatch):
    _install(monkeypatch, _Governor(heartbeat=RuntimeGovernorHeartbeat(should_stop=True)))
    holder = [None]

    turn = GovernedTurn.begin(platform="telegram", session_key="s1", get_agent=lambda: holder[0])
    assert _wait_for(lambda: turn.cutoff)
    agent = holder[0] = _Agent()
    assert _wait_for(lambda: agent.interrupted)
    turn.close()

    assert turn.cutoff_message == DEFAULT_LIMIT_MESSAGE


# ---------------------------------------------------------------------------
# Seam wiring: fails if an upstream merge drops a decorator
# ---------------------------------------------------------------------------


def _resolve(path: str):
    module_name, qualname = path.split(":")
    obj = importlib.import_module(module_name)
    for part in qualname.split("."):
        obj = getattr(obj, part)
    return obj


@pytest.mark.parametrize("seam", sorted(GOVERNED_SEAMS))
def test_every_seam_is_wired(seam):
    assert getattr(_resolve(GOVERNED_SEAMS[seam]), GOVERNED_ATTR, None) == seam


def _source() -> SessionSource:
    return SessionSource(platform=Platform.TELEGRAM, chat_id="12345", chat_type="dm", user_id="user-1")


def _gateway_runner(agent, inner):
    """Just enough GatewayRunner surface for the two real gateway seams to run."""
    runner = SimpleNamespace()
    runner._profile_scope_for_source = lambda source: nullcontext()
    runner._run_agent_inner = inner
    runner._session_state = lambda key: SimpleNamespace(turn=SimpleNamespace(agent=agent))
    return runner


async def _run_gateway_turn(governor_runner, event, resolve):
    """Drive the REAL decorated ``_handle_message_with_agent`` -> ``_run_agent`` chain."""
    from gateway.run import GatewayRunner

    governor_runner._hmwa_resolve_session = resolve
    return await GatewayRunner._handle_message_with_agent(governor_runner, event, _source(), "agent:main:telegram:dm:12345", 1)


def _event():
    return SimpleNamespace(text="hello there", message_id=42, platform_update_id=None)


@pytest.mark.asyncio
async def test_real_gateway_denial_short_circuits_before_session_work(monkeypatch):
    governor = _install(monkeypatch, _Governor(
        RuntimeGovernorDecision(allowed=False, reason="cap", user_message="Daily cap reached.")))
    resolve = AsyncMock()
    runner = _gateway_runner(_Agent(), AsyncMock())

    reply = await _run_gateway_turn(runner, _event(), resolve)

    assert reply == "Daily cap reached."
    resolve.assert_not_awaited()
    _name, admit = governor.calls[0]
    assert admit["platform"] == "telegram"
    assert admit["session_key"] == "agent:main:telegram:dm:12345"
    assert admit["source_message_id"] == "42"
    assert admit["message_preview"] == "hello there"
    assert admit["user_id"] == "user-1"


@pytest.mark.asyncio
async def test_real_gateway_turn_finishes_lease_after_run_agent(monkeypatch):
    from gateway.run import GatewayRunner

    governor = _install(monkeypatch, _Governor())
    agent = _Agent()
    inner = AsyncMock(return_value={"final_response": "ok", "messages": []})
    runner = _gateway_runner(agent, inner)

    async def resolve(event, source):
        result = await GatewayRunner._run_agent(runner, "hi", "", [], source, "session-1")
        assert result["final_response"] == "ok"
        assert "runtime_cutoff" not in result
        return None

    assert await _run_gateway_turn(runner, _event(), resolve) is None
    assert governor.names() == ["admit", "start", "finish"]
    assert governor.calls[-1] == ("finish", "lease-1", "agent_end")


@pytest.mark.asyncio
async def test_real_gateway_cutoff_interrupts_agent_and_replaces_response(monkeypatch):
    from gateway.run import GatewayRunner

    governor = _install(monkeypatch, _Governor(
        heartbeat=RuntimeGovernorHeartbeat(should_stop=True, user_message="Runtime cap reached.")))
    agent = _Agent()

    async def inner(*_args, **_kwargs):
        while not agent.interrupted:
            await asyncio.sleep(0.01)
        return {"final_response": "partial answer", "interrupted": True, "messages": []}

    runner = _gateway_runner(agent, inner)
    seen = {}

    async def resolve(event, source):
        seen["result"] = await GatewayRunner._run_agent(runner, "hi", "", [], source, "session-1")
        return None

    await asyncio.wait_for(_run_gateway_turn(runner, _event(), resolve), timeout=5)

    assert seen["result"]["runtime_cutoff"] is True
    assert seen["result"]["final_response"] == "Runtime cap reached."
    assert agent.interrupts == [None]
    assert governor.calls[-1] == ("fail", "lease-1", "runtime_cutoff")


@pytest.mark.asyncio
async def test_real_gateway_run_agent_is_untouched_without_a_governed_turn():
    from gateway.run import GatewayRunner

    inner = AsyncMock(return_value={"final_response": "ok"})
    runner = _gateway_runner(_Agent(), inner)

    assert await GatewayRunner._run_agent(runner, "hi", "", [], _source(), "session-1") == {"final_response": "ok"}


@pytest.mark.asyncio
async def test_real_api_run_agent_denial(monkeypatch):
    from gateway.platforms.api_server import APIServerAdapter

    governor = _install(monkeypatch, _Governor(
        RuntimeGovernorDecision(allowed=False, reason="cap", user_message="Daily cap reached.")))

    result, usage = await APIServerAdapter._run_agent(
        object(), "hello", [], session_id="sid-1", gateway_session_key="key-1")

    assert result["final_response"] == "Daily cap reached."
    assert result["failed"] is True and result["runtime_cutoff"] is True
    assert usage == {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    assert governor.calls[0][1]["platform"] == "api_server"
    assert governor.calls[0][1]["session_key"] == "key-1"


@pytest.mark.asyncio
async def test_api_run_wrapper_injects_agent_ref_and_closes_lease(monkeypatch):
    from gateway.runtime_governor import governed_api_run

    governor = _install(monkeypatch, _Governor(
        heartbeat=RuntimeGovernorHeartbeat(should_stop=True, user_message="Runtime cap reached.")))
    agent = _Agent()

    @governed_api_run
    async def _run_agent(self, user_message, conversation_history, session_id=None, agent_ref=None):
        agent_ref[0] = agent  # what upstream's _run does once the agent exists
        while not agent.interrupted:
            await asyncio.sleep(0.01)
        return {"final_response": ""}, {"total_tokens": 3}

    result, usage = await asyncio.wait_for(_run_agent(object(), "hi", [], session_id="sid"), timeout=5)

    assert result["runtime_cutoff"] is True
    assert result["final_response"] == "Runtime cap reached."  # empty response is filled
    assert usage == {"total_tokens": 3}
    assert governor.calls[-1] == ("fail", "lease-1", "runtime_cutoff")


def test_real_runs_sync_denial(monkeypatch):
    from gateway.platforms import api_server_runs

    governor = _install(monkeypatch, _Governor(
        RuntimeGovernorDecision(allowed=False, reason="cap", user_message="Daily cap reached.")))
    run = SimpleNamespace(approval_session_key="run-key", run_id="run_1", user_message="hello")
    agent = SimpleNamespace()

    result, usage, served = api_server_runs._run_agent_sync(
        SimpleNamespace(), run, agent, None, _api_server=None)

    assert result["failed"] is True and result["error"] == "Daily cap reached."
    assert usage["input_tokens"] == 0
    assert served == {"provider": "", "model": ""}
    assert governor.names() == ["admit"]


def test_runs_sync_wrapper_finishes_lease(monkeypatch):
    from gateway.runtime_governor import governed_run_sync

    governor = _install(monkeypatch, _Governor())

    @governed_run_sync
    def _run_agent_sync(self, run, agent, approval_notify, *, _api_server):
        return {"final_response": "ok"}, {}, {}

    result, _usage, _served = _run_agent_sync(
        SimpleNamespace(), SimpleNamespace(approval_session_key="run-key"), _Agent(), None, _api_server=None)

    assert result == {"final_response": "ok"}
    assert governor.calls[-1] == ("finish", "lease-1", "agent_end")
