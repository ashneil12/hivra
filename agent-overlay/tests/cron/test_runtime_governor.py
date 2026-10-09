"""Runtime governor around a cron agent turn (``cron.scheduler._run_agent_with_watchdog``).

Hivra overlay: runtime-governor seam (applied by hivra_overlay.seams). Drives the REAL ``run_job`` so a future upstream merge that
drops or bypasses the decorator on ``_run_agent_with_watchdog`` fails here.
"""
import threading
from unittest.mock import MagicMock, patch

import cron.scheduler as cron_scheduler
from gateway.runtime_governor import (
    GOVERNED_ATTR,
    RuntimeGovernorDecision,
    RuntimeGovernorHeartbeat,
)

_JOB = {"id": "job-1", "name": "test", "prompt": "hello", "model": "test-model"}


class _Governor:
    enabled = True

    def __init__(self, decision, heartbeat=None):
        self.decision = decision
        self.heartbeat_result = heartbeat or RuntimeGovernorHeartbeat(should_stop=False)
        self.calls = []

    def admit(self, **kwargs):
        self.calls.append(("admit", kwargs))
        return self.decision

    def start(self, lease_id):
        self.calls.append(("start", lease_id))

    def heartbeat(self, lease_id):
        self.calls.append(("heartbeat", lease_id))
        return self.heartbeat_result

    def finish(self, lease_id, *, reason):
        self.calls.append(("finish", lease_id, reason))

    def fail(self, lease_id, *, reason):
        self.calls.append(("fail", lease_id, reason))


def _run_job(monkeypatch, tmp_path, governor, configure_agent):
    monkeypatch.setattr("gateway.runtime_governor.get_runtime_governor", lambda: governor)
    monkeypatch.setenv("HERMES_RUNTIME_GOVERNOR_HEARTBEAT_SECONDS", "0.05")
    resolved = {
        "api_key": "test-key",
        "base_url": "https://example.invalid/v1",
        "provider": "openrouter",
        "api_mode": "chat_completions",
    }
    with patch("cron.scheduler._hermes_home", tmp_path), \
         patch("cron.scheduler._get_hermes_home", return_value=tmp_path), \
         patch("cron.scheduler_delivery._resolve_origin", return_value=None), \
         patch("hermes_cli.env_loader.load_hermes_dotenv"), \
         patch("hermes_cli.env_loader.reset_secret_source_cache"), \
         patch("hermes_state_registry.acquire", return_value=MagicMock()), \
         patch("hermes_cli.runtime_provider.resolve_runtime_provider", return_value=resolved), \
         patch("run_agent.AIAgent") as agent_cls:
        agent = agent_cls.return_value
        agent.session_id = "cron_job-1_20260101_000000"
        configure_agent(agent)
        outcome = cron_scheduler.run_job(dict(_JOB))
    return outcome, agent


def test_cron_seam_is_wired():
    assert getattr(cron_scheduler._run_agent_with_watchdog, GOVERNED_ATTR, None) == "cron_run"


def test_cron_runtime_governor_denial_skips_the_agent_turn(monkeypatch, tmp_path):
    governor = _Governor(RuntimeGovernorDecision(allowed=False, reason="daily_cap", user_message="Daily cap reached."))

    (success, output, final_response, error), agent = _run_job(
        monkeypatch, tmp_path, governor, lambda agent: None)

    assert success is True, (output, final_response, error)
    assert error is None
    assert final_response == "Daily cap reached."
    assert "Daily cap reached." in output
    # hermes-fork: admission now sits at the agent turn (after the script/wake gates), so the agent
    # object exists by then; what must never happen is the turn itself.
    agent.run_conversation.assert_not_called()
    assert [call[0] for call in governor.calls] == ["admit"]
    admit = governor.calls[0][1]
    assert admit["platform"] == "cron"
    assert admit["session_key"] == "cron_job-1_20260101_000000"
    assert 0 < len(admit["message_preview"]) <= 500  # the assembled cron prompt, truncated


def test_cron_runtime_governor_finishes_successful_lease(monkeypatch, tmp_path):
    governor = _Governor(RuntimeGovernorDecision(allowed=True, lease_id="lease-1", reason="allowed"))

    def configure(agent):
        agent.run_conversation.return_value = {"final_response": "ok"}

    (success, _output, final_response, error), _agent = _run_job(monkeypatch, tmp_path, governor, configure)

    assert success is True
    assert error is None
    assert final_response == "ok"
    assert [call[0] for call in governor.calls] == ["admit", "start", "finish"]
    assert governor.calls[-1] == ("finish", "lease-1", "agent_end")


def test_cron_runtime_governor_cutoff_interrupts_agent_and_delivers_the_cutoff_message(monkeypatch, tmp_path):
    governor = _Governor(
        RuntimeGovernorDecision(allowed=True, lease_id="lease-1"),
        heartbeat=RuntimeGovernorHeartbeat(should_stop=True, user_message="Runtime cap reached."),
    )
    stopped = threading.Event()

    def configure(agent):
        def _run(prompt, task_id=None):
            assert stopped.wait(timeout=10), "governor never interrupted the cron agent"
            return {"final_response": "partial", "interrupted": True, "completed": False}

        agent.run_conversation.side_effect = _run
        agent.interrupt.side_effect = lambda *_a, **_k: stopped.set()

    (success, _output, final_response, error), agent = _run_job(monkeypatch, tmp_path, governor, configure)

    assert agent.interrupt.called
    assert success is True
    assert error is None
    assert final_response == "Runtime cap reached."
    assert governor.calls[-1] == ("fail", "lease-1", "runtime_cutoff")


def test_cron_runtime_governor_failed_turn_fails_the_lease(monkeypatch, tmp_path):
    governor = _Governor(RuntimeGovernorDecision(allowed=True, lease_id="lease-1"))

    def configure(agent):
        agent.run_conversation.side_effect = RuntimeError("provider exploded")

    (success, _output, _final, error), _agent = _run_job(monkeypatch, tmp_path, governor, configure)

    assert success is False
    assert "provider exploded" in error
    assert governor.calls[-1] == ("fail", "lease-1", "agent_error")
