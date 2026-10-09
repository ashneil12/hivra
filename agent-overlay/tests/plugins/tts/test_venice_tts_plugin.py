"""Venice TTS ships as a bundled backend plugin (``plugins/tts/venice``), not inline in
``tools/tts_tool.py`` (hermes-fork). Network-free."""

from __future__ import annotations

import pytest


class _Resp:
    content = b"ID3venice-audio"

    def raise_for_status(self):
        return None


@pytest.fixture
def venice_tts(monkeypatch):
    monkeypatch.setenv("VENICE_API_KEY", "test-key")
    monkeypatch.delenv("VENICE_BASE_URL", raising=False)
    import plugins.tts.venice as mod

    monkeypatch.setattr(mod, "_load_venice_config", lambda: {})
    return mod


def _capture_post(monkeypatch):
    import requests

    seen = {}

    def fake_post(url, **kwargs):
        seen["url"] = url
        seen.update(kwargs)
        return _Resp()

    monkeypatch.setattr(requests, "post", fake_post)
    return seen


def test_registers_with_tts_registry_and_not_builtin(venice_tts):
    from agent import tts_registry
    from tools.tts_tool import BUILTIN_TTS_PROVIDERS

    # A built-in "venice" would make the registry reject the plugin ("built-ins always win").
    assert "venice" not in BUILTIN_TTS_PROVIDERS
    assert "venice" not in tts_registry._BUILTIN_NAMES

    class _Ctx:
        def __init__(self):
            self.registered = []

        def register_tts_provider(self, provider):
            self.registered.append(provider)

    ctx = _Ctx()
    venice_tts.register(ctx)
    assert [p.name for p in ctx.registered] == ["venice"]


def test_bundled_manifest_auto_loads_and_registers():
    from hermes_cli.plugins import _ensure_plugins_discovered
    from agent.tts_registry import get_provider

    _ensure_plugins_discovered()
    assert get_provider("venice") is not None


def test_synthesize_posts_openai_shaped_request(venice_tts, monkeypatch, tmp_path):
    seen = _capture_post(monkeypatch)
    out = tmp_path / "speech.mp3"
    result = venice_tts.VeniceTTSProvider().synthesize("hello", str(out))
    assert result == str(out)
    assert out.read_bytes() == b"ID3venice-audio"
    assert seen["url"] == "https://api.venice.ai/api/v1/audio/speech"
    assert seen["headers"]["Authorization"] == "Bearer test-key"
    assert seen["json"] == {
        "model": "tts-kokoro", "input": "hello", "voice": "af_sky",
        "response_format": "mp3", "speed": 1.0,
    }


def test_tts_venice_section_wins_over_dispatcher_args(venice_tts, monkeypatch, tmp_path):
    seen = _capture_post(monkeypatch)
    monkeypatch.setenv("VENICE_BASE_URL", "https://proxy.example/v1/")
    monkeypatch.setattr(venice_tts, "_load_venice_config",
                        lambda: {"model": "tts-qwen3", "voice": "vv", "speed": 9, "language": "en"})
    venice_tts.VeniceTTSProvider().synthesize(
        "hi", str(tmp_path / "a.wav"), voice="en-US-AriaNeural", model="edge-model", speed=0.5)
    assert seen["url"] == "https://proxy.example/v1/audio/speech"
    body = seen["json"]
    assert (body["model"], body["voice"], body["language"]) == ("tts-qwen3", "vv", "en")
    assert body["speed"] == 4.0  # clamped
    assert body["response_format"] == "wav"


def test_ogg_output_path_falls_back_to_mp3_wire_format(venice_tts, monkeypatch, tmp_path):
    seen = _capture_post(monkeypatch)
    venice_tts.VeniceTTSProvider().synthesize("hi", str(tmp_path / "a.ogg"))
    assert seen["json"]["response_format"] == "mp3"


def test_missing_key_raises_for_dispatcher_envelope(venice_tts, monkeypatch, tmp_path):
    monkeypatch.delenv("VENICE_API_KEY")
    with pytest.raises(ValueError, match="VENICE_API_KEY"):
        venice_tts.VeniceTTSProvider().synthesize("hi", str(tmp_path / "a.mp3"))


def test_explicit_provider_routes_through_tool_dispatcher(venice_tts, monkeypatch, tmp_path):
    """tts.provider: venice reaches the plugin via tools.tts_tool's plugin dispatcher."""
    from agent import tts_registry
    from tools.tts_tool_plugins import _dispatch_to_plugin_provider

    seen = _capture_post(monkeypatch)
    monkeypatch.setattr(tts_registry, "get_provider",
                        lambda name: venice_tts.VeniceTTSProvider() if name == "venice" else None)
    monkeypatch.setattr("tools.tts_tool_plugins._lookup_plugin_provider",
                        lambda key, **kw: venice_tts.VeniceTTSProvider() if key == "venice" else None)
    out = tmp_path / "x.mp3"
    assert _dispatch_to_plugin_provider("hello", str(out), "venice", {"provider": "venice"}) == str(out)
    assert seen["json"]["input"] == "hello"
