"""Tests for the hivra_approval_relay plugin.

The plugin relays pre_approval_request / post_approval_response to the Hivra
dashboard so a blocked agent is visible outside the workspace iframe. Two
invariants matter more than anything it sends:

1. It must never raise into the agent thread (hooks are observers).
2. It must never *block* the agent thread (a wedged dashboard cannot be
   allowed to stall an approval that a user is actively waiting on).
"""

import importlib
import queue

import pytest


@pytest.fixture
def relay(monkeypatch):
    plugin = importlib.import_module("plugins.observability.hivra_approval_relay")
    plugin.reset_for_tests()
    monkeypatch.setenv("HERMES_DASHBOARD_URL", "https://hivra.cloud")
    monkeypatch.setenv("API_SERVER_KEY", "a" * 64)
    monkeypatch.setenv("HERMES_INSTANCE_ID", "inst-1234")
    monkeypatch.delenv("HIVRA_APPROVAL_RELAY_ENABLED", raising=False)
    monkeypatch.delenv("HIVRA_APPROVAL_RELAY_URL", raising=False)
    monkeypatch.delenv("HIVRA_APPROVAL_RELAY_SEND_COMMAND", raising=False)
    try:
        yield plugin
    finally:
        plugin.reset_for_tests()


@pytest.fixture
def sent(relay, monkeypatch):
    """Capture payloads at the _enqueue boundary (no threads, no sockets)."""
    captured = []
    monkeypatch.setattr(relay, "_enqueue", captured.append)
    return captured


def _kwargs(**overrides):
    base = {
        "command": "rm -rf /var/lib/thing",
        "description": "Recursive delete",
        "pattern_key": "rm_rf",
        "pattern_keys": ["rm_rf"],
        "session_key": "sess-1",
        "surface": "gateway",
        "turn_id": "turn-1",
        "tool_call_id": "call-abc",
    }
    base.update(overrides)
    return base


class TestConfig:
    def test_inert_without_env(self, relay, monkeypatch):
        monkeypatch.delenv("HERMES_DASHBOARD_URL", raising=False)
        relay.reset_for_tests()
        assert relay._resolve_config() is None

    def test_disabled_by_flag(self, relay, monkeypatch):
        monkeypatch.setenv("HIVRA_APPROVAL_RELAY_ENABLED", "0")
        relay.reset_for_tests()
        assert relay._resolve_config() is None

    def test_refuses_plaintext_endpoint(self, relay, monkeypatch):
        """The bearer is the per-instance API_SERVER_KEY - never over http."""
        monkeypatch.setenv("HERMES_DASHBOARD_URL", "http://evil.example")
        relay.reset_for_tests()
        assert relay._resolve_config() is None

    def test_allows_http_loopback_for_dev(self, relay, monkeypatch):
        monkeypatch.setenv("HERMES_DASHBOARD_URL", "http://127.0.0.1:3000")
        relay.reset_for_tests()
        cfg = relay._resolve_config()
        assert cfg is not None
        assert cfg.url == "http://127.0.0.1:3000/api/internal/agent-notify"

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1:0@attacker.com/api/internal/agent-notify",
            "http://localhost:1@attacker.com/api/internal/agent-notify",
            "http://127.0.0.1@attacker.com/x",
            "http://user:127.0.0.1@attacker.com/x",
        ],
    )
    def test_rejects_userinfo_loopback_spoof(self, relay, monkeypatch, url):
        """A user:pass@ userinfo that merely LOOKS like loopback must not defeat
        the https gate - urlopen would connect to the real host (attacker.com)
        over plaintext and leak the bearer."""
        monkeypatch.setenv("HIVRA_APPROVAL_RELAY_URL", url)
        relay.reset_for_tests()
        assert relay._resolve_config() is None

    def test_allows_https_with_any_userinfo(self, relay, monkeypatch):
        monkeypatch.setenv("HIVRA_APPROVAL_RELAY_URL", "https://hivra.cloud/api/internal/agent-notify")
        relay.reset_for_tests()
        assert relay._resolve_config() is not None

    def test_builds_endpoint_from_dashboard_url(self, relay):
        cfg = relay._resolve_config()
        assert cfg.url == "https://hivra.cloud/api/internal/agent-notify"
        assert cfg.instance_id == "inst-1234"

    def test_explicit_url_override_wins(self, relay, monkeypatch):
        monkeypatch.setenv("HIVRA_APPROVAL_RELAY_URL", "https://x.test/ingest")
        relay.reset_for_tests()
        assert relay._resolve_config().url == "https://x.test/ingest"


class TestRelayPayloads:
    def test_pre_emits_pending(self, relay, sent):
        relay.on_pre_approval_request(**_kwargs())
        assert len(sent) == 1
        p = sent[0]
        assert p["event"] == "prompt.pending"
        assert p["kind"] == "approval"
        assert p["instance_id"] == "inst-1234"
        assert p["prompt_id"] == "call-abc"
        assert p["summary"] == "Recursive delete"
        assert p["ttl_seconds"] >= 1

    def test_post_emits_resolved_with_choice(self, relay, sent):
        relay.on_post_approval_response(**_kwargs(choice="deny"))
        assert sent[0]["event"] == "prompt.resolved"
        assert sent[0]["choice"] == "deny"

    def test_timeout_choice_defaults_when_absent(self, relay, sent):
        relay.on_post_approval_response(**_kwargs())
        assert sent[0]["choice"] == "timeout"

    def test_prompt_id_pairs_pre_and_post(self, relay, sent):
        kw = _kwargs(tool_call_id="")
        relay.on_pre_approval_request(**kw)
        relay.on_post_approval_response(**dict(kw, choice="once"))
        assert sent[0]["prompt_id"] == sent[1]["prompt_id"]
        assert sent[0]["prompt_id"]  # non-empty digest fallback

    def test_cli_surface_is_not_relayed(self, relay, sent):
        """A TTY prompt is already in front of the user."""
        relay.on_pre_approval_request(**_kwargs(surface="cli"))
        relay.on_post_approval_response(**_kwargs(surface="cli", choice="once"))
        assert sent == []

    def test_command_is_redacted(self, relay, sent):
        secret = "sk-" + "livekey" + "1234567890abcdefghijklmnop"  # split so secret scanners do not flag the fixture
        relay.on_pre_approval_request(
            **_kwargs(command=f"curl -H 'Authorization: Bearer {secret}' https://x")
        )
        assert secret not in sent[0]["command"]

    def test_summary_is_redacted(self, relay, sent):
        # The mcp-elicitation path passes a RAW description into the hook; the
        # summary must not be a redaction hole.
        secret = "sk-" + "livekey" + "1234567890abcdefghijklmnop"  # split so secret scanners do not flag the fixture
        relay.on_pre_approval_request(
            **_kwargs(description=f"please approve using token {secret}")
        )
        assert secret not in sent[0]["summary"]

    def test_command_is_truncated(self, relay, sent):
        relay.on_pre_approval_request(**_kwargs(command="echo " + "x" * 5000))
        assert len(sent[0]["command"]) <= relay._COMMAND_MAX_CHARS

    def test_command_can_be_omitted(self, relay, monkeypatch, sent):
        monkeypatch.setenv("HIVRA_APPROVAL_RELAY_SEND_COMMAND", "0")
        relay.reset_for_tests()
        relay.on_pre_approval_request(**_kwargs())
        assert "command" not in sent[0]

    def test_inert_config_emits_nothing(self, relay, monkeypatch, sent):
        monkeypatch.delenv("API_SERVER_KEY", raising=False)
        relay.reset_for_tests()
        relay.on_pre_approval_request(**_kwargs())
        assert sent == []


class TestNeverBlocksNeverRaises:
    def test_full_queue_drops_without_raising(self, relay, monkeypatch):
        class _LiveWorker:
            def is_alive(self):
                return True

        relay._resolve_config()
        full = queue.Queue(maxsize=1)
        full.put_nowait({"filler": True})
        monkeypatch.setattr(relay, "_queue", full)
        monkeypatch.setattr(relay, "_worker", _LiveWorker())

        relay._enqueue({"event": "prompt.pending"})  # must not raise
        assert full.qsize() == 1  # dropped, not blocked

    def test_hooks_swallow_internal_errors(self, relay, monkeypatch):
        def boom(_payload):
            raise RuntimeError("dashboard on fire")

        monkeypatch.setattr(relay, "_enqueue", boom)
        relay.on_pre_approval_request(**_kwargs())
        relay.on_post_approval_response(**_kwargs(choice="once"))

    def test_hooks_survive_garbage_kwargs(self, relay, sent):
        relay.on_pre_approval_request()
        relay.on_post_approval_response(command=None, surface=None)
        assert all(p["instance_id"] == "inst-1234" for p in sent)


class TestTransport:
    def test_4xx_is_terminal_no_retry(self, relay, monkeypatch):
        import urllib.error

        calls = []

        def fake_urlopen(req, timeout=None):
            calls.append(req)
            raise urllib.error.HTTPError(req.full_url, 401, "no", {}, None)

        monkeypatch.setattr(relay.urllib.request, "urlopen", fake_urlopen)
        relay._post({"event": "prompt.pending"}, relay._resolve_config())
        assert len(calls) == 1

    def test_5xx_retries_then_gives_up(self, relay, monkeypatch):
        import urllib.error

        calls = []

        def fake_urlopen(req, timeout=None):
            calls.append(req)
            raise urllib.error.HTTPError(req.full_url, 503, "down", {}, None)

        monkeypatch.setattr(relay.urllib.request, "urlopen", fake_urlopen)
        relay._post({"event": "prompt.pending"}, relay._resolve_config())
        assert len(calls) == relay._SEND_ATTEMPTS

    def test_sends_bearer_and_json(self, relay, monkeypatch):
        seen = {}

        class _Resp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout=None):
            seen["auth"] = req.get_header("Authorization")
            seen["ctype"] = req.get_header("Content-type")
            seen["body"] = req.data
            return _Resp()

        monkeypatch.setattr(relay.urllib.request, "urlopen", fake_urlopen)
        relay._post({"event": "prompt.pending"}, relay._resolve_config())
        assert seen["auth"] == "Bearer " + "a" * 64
        assert seen["ctype"] == "application/json"
        assert b"prompt.pending" in seen["body"]


def test_register_wires_both_hooks(relay):
    registered = {}

    class _Ctx:
        def register_hook(self, name, cb):
            registered[name] = cb

    relay.register(_Ctx())
    assert set(registered) == {"pre_approval_request", "post_approval_response"}
