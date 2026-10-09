"""Regression guard for media-generation tool wiring (hermes-fork).

Run in-image by the docker publish workflow ("Media tool wiring regression gate")
BEFORE a broken :stable can ship. Network-free and key-free. It is the living
manifest of the Venice seams on top of upstream: every invariant below silently
broke production Venice media at least once, or would break on an upstream sync.

Seam shape (thin fork): Venice media lives in add-only files and bundled backend
plugins; upstream-owned files carry only the ``venice-autopair`` marker lines.

Invariants:
  1. Every fork-registered tool handler accepts the executor's call shape
     ``handler(args, **kwargs)`` (a ``lambda **kw:`` handler TypeErrors on every
     agent call; four fork tools shipped like that).
  2. Fork tools register under toolsets upstream DEFAULT-ENABLES (image_gen, web,
     tts, memory, browser) or the opt-in video_gen, so ``_get_platform_tools``
     resolves them with no edit to toolsets.py / tools_config.py.
  3. Venice audio polls the queue/retrieve flow, not ``GET /audio/{id}``.
  4. Venice video omits ``aspect_ratio`` for image/reference-to-video.
  5. The Venice image/video/TTS/STT backends are registered plugins; the three
     upstream seams carry their ``hermes-fork: venice-autopair`` marker and an
     unset provider resolves to venice only when VENICE_API_KEY is set.
  6. No registered tool schema is pre-enveloped (Venice 400s on a double wrap).
"""

import inspect
import json
import re
from pathlib import Path

import pytest

import hivra_overlay

import model_tools  # noqa: F401 - import triggers discover_builtin_tools()
from tools.registry import registry
from toolsets import get_toolset, resolve_toolset
import tools.audio_generate_tool as audio_mod
import tools.venice_extras_tool as extras_mod

REPO = Path(hivra_overlay.__file__).resolve().parents[1]

# name -> toolset, for every tool the fork adds (tools/*.py self-registration).
FORK_TOOLS = {
    "image_edit": "image_gen",
    "image_compose": "image_gen",
    "image_upscale": "image_gen",
    "image_remove_background": "image_gen",
    "image_styles": "image_gen",
    "multimodal_get_settings": "image_gen",
    "multimodal_set_model": "image_gen",
    "text_parser": "web",
    "video_transcribe": "web",
    "crypto_rpc": "web",
    "voice_clone": "tts",
    "text_embed": "memory",
    "venice_characters": "memory",
    "audio_generate": "video_gen",
    "audio_quote": "video_gen",
    "video_quote": "video_gen",
    "browser_session_start": "browser",
    "browser_session_end": "browser",
    "browser_goto": "browser",
    "browser_click_text": "browser",
    "browser_click_selector": "browser",
    "browser_fill": "browser",
    "browser_wait_for": "browser",
    "browser_assert_visible": "browser",
    "browser_get_text": "browser",
    "browser_screenshot": "browser",
    "browser_run_named_flow": "browser",
}


class TestForkToolRegistration:
    @pytest.mark.parametrize("tool,toolset", sorted(FORK_TOOLS.items()))
    def test_registered_in_expected_toolset(self, tool, toolset):
        entry = registry.get_entry(tool)
        assert entry is not None, f"{tool} not registered (discover_builtin_tools should import its module)"
        assert entry.toolset == toolset
        # The registry merges into the static toolset: this is what makes the tool reach the model.
        assert tool in resolve_toolset(toolset), f"{tool} missing from resolved {toolset}"

    @pytest.mark.parametrize("tool", sorted(FORK_TOOLS))
    def test_handler_accepts_positional_args_dict(self, tool):
        # The executor calls ``entry.handler(args, **kwargs)``.
        handler = registry.get_entry(tool).handler
        try:
            inspect.signature(handler).bind({"prompt": "x"})
        except TypeError:
            pytest.fail(
                f"{tool} handler must accept a positional args dict "
                f"(executor calls handler(args, **kwargs)); got {inspect.signature(handler)}"
            )

    def test_audio_generate_member_of_video_gen_toolset(self):
        assert "audio_generate" in get_toolset("video_gen")["tools"]
        assert "video_generate" in resolve_toolset("video_gen")
        assert "image_generate" in resolve_toolset("image_gen")

    def test_no_registered_schema_is_pre_enveloped(self):
        # {"type":"function","function":{...}} registered as a schema is wrapped a second time
        # downstream; strict providers (Venice) reject the whole request. Upstream does not unwrap.
        bad = [
            name for name in registry.get_all_tool_names()
            if isinstance(registry.get_entry(name).schema, dict)
            and (registry.get_entry(name).schema.get("type") == "function"
                 or "function" in registry.get_entry(name).schema)
        ]
        assert not bad, f"pre-enveloped schemas registered: {bad}"

    def test_venice_characters_schema_is_flat(self):
        from tools.venice_characters_tool import VENICE_CHARACTERS_SCHEMA

        assert VENICE_CHARACTERS_SCHEMA.get("type") != "function"
        assert VENICE_CHARACTERS_SCHEMA["name"] == "venice_characters"

    def test_multimodal_get_settings_dispatches_through_registry(self, monkeypatch, tmp_path):
        # Real executor path (registry.dispatch), not a direct call: the direct call masks bug 1.
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        out = json.loads(registry.dispatch("multimodal_get_settings", {}))
        assert out.get("success") is True, out

    def test_crypto_rpc_blocks_signing_methods(self, monkeypatch):
        # Read-only by design: state-changing/signing methods are refused BEFORE any network call.
        monkeypatch.setenv("VENICE_API_KEY", "test-key-not-used")
        for m in ("eth_sendTransaction", "eth_sendRawTransaction", "personal_sign"):
            out = json.loads(extras_mod.crypto_rpc_tool("ethereum", m))
            assert out["success"] is False
            assert out["error_type"] == "write_method_blocked", f"{m} must be blocked; got {out}"


class TestDefaultVisibility:
    """Upstream's toolset resolver (no fork edit) must enable the fork tools on a default Venice box.

    This is the failure the old toolsets.py edits guarded: a toolset silently dropping out of the
    LLM's tool list, after which the agent falls back to shell/curl.
    """

    @pytest.fixture
    def default_defs(self, monkeypatch, tmp_path):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.setenv("VENICE_API_KEY", "test-key")
        # Control-plane contract (replaces the old venice-autopair fork seam): a managed Venice box
        # carries explicit image_gen/video_gen/stt providers in config.yaml.
        (tmp_path / "config.yaml").write_text(
            "image_gen:\n  provider: venice\nvideo_gen:\n  provider: venice\nstt:\n  provider: venice\n")
        import tools.browser_sidecar as sidecar
        from hermes_cli.tools_config import _get_platform_tools

        monkeypatch.setattr(sidecar, "_is_sidecar_available", lambda: True)
        # check_fn was bound at registration; flip the live entries too.
        for name, ts in FORK_TOOLS.items():
            if ts == "browser":
                monkeypatch.setattr(registry.get_entry(name), "check_fn", lambda: True)
        enabled = sorted(_get_platform_tools({}, "cli"))
        defs = model_tools.get_tool_definitions(
            enabled_toolsets=enabled, quiet_mode=True, skip_tool_search_assembly=True)
        return enabled, {d["function"]["name"] for d in defs}

    @pytest.mark.parametrize(
        "tool", sorted(t for t, ts in FORK_TOOLS.items() if ts != "video_gen"))
    def test_fork_tool_visible_on_default_platform_toolsets(self, default_defs, tool):
        enabled, names = default_defs
        assert tool in names, f"{tool} not exposed by default (enabled toolsets: {enabled})"

    @pytest.mark.parametrize("configured,expected", [(True, True), (False, False)])
    def test_image_generate_follows_the_control_plane_config_contract(self, tmp_path, configured, expected):
        # Fresh process (config and registry caches make in-process runs order dependent). A managed
        # Venice box carries image_gen.provider: venice in config.yaml (written by the control plane,
        # replacing the old venice-autopair fork seam). Stock upstream does NOT pair a lone key.
        import os
        import subprocess
        import sys

        if configured:
            (tmp_path / "config.yaml").write_text("image_gen:\n  provider: venice\n")
        code = (
            "import model_tools\n"
            "from hermes_cli.tools_config import _get_platform_tools\n"
            "defs = model_tools.get_tool_definitions(enabled_toolsets=sorted(_get_platform_tools({}, 'cli')),"
            " quiet_mode=True, skip_tool_search_assembly=True)\n"
            "print('IMAGE_GENERATE=' + str('image_generate' in {d['function']['name'] for d in defs}))\n"
        )
        env = {**os.environ, "HERMES_HOME": str(tmp_path), "VENICE_API_KEY": "test-key"}
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120)
        assert f"IMAGE_GENERATE={expected}" in out.stdout, out.stdout + out.stderr

    def test_video_gen_tools_exposed_when_toolset_enabled(self, tmp_path):
        # video_gen is default-off upstream (opt-in via hermes tools); once enabled the audio tools
        # ride along. Fresh process: config and registry caches make in-process runs order dependent.
        import os
        import subprocess
        import sys

        (tmp_path / "config.yaml").write_text("video_gen:\n  provider: venice\n")
        code = (
            "import model_tools\n"
            "defs = model_tools.get_tool_definitions(enabled_toolsets=['video_gen'], quiet_mode=True,"
            " skip_tool_search_assembly=True)\n"
            "print('NAMES=' + ','.join(sorted(d['function']['name'] for d in defs)))\n"
        )
        env = {**os.environ, "HERMES_HOME": str(tmp_path), "VENICE_API_KEY": "test-key"}
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120)
        names = set(next((l for l in out.stdout.splitlines() if l.startswith("NAMES=")), "NAMES=")[6:].split(","))
        assert {"video_generate", "audio_generate", "audio_quote", "video_quote"} <= names, out.stdout + out.stderr


class TestVeniceAudioWiring:
    def test_venice_queue_and_retrieve_endpoints(self):
        # Venice audio is POST /audio/queue then POST /audio/retrieve (binary), NOT GET /audio/{queue_id}.
        src = inspect.getsource(audio_mod)
        assert "/audio/queue" in src
        assert "/audio/retrieve" in src, "Venice audio must poll POST /audio/retrieve; a GET /audio/{id} poll 404s"

    def test_audio_generate_reads_configured_model(self):
        # Settings -> Media music-model dropdown must be a live control.
        assert hasattr(audio_mod, "_read_configured_audio_model")
        assert "_read_configured_audio_model" in inspect.getsource(audio_mod.audio_generate_tool)


class TestMediaGuidanceSeam:
    """Steers code-biased models to the media tools instead of hand-rolling WAVs.
    hermes-fork: the guidance lives in the bundled `hivra-core` plugin (plugins/hivra-core),
    injected through upstream's register_system_prompt_section API, so no prompt_builder edit."""

    def test_media_generation_guidance_present_and_wired(self):
        import importlib.util
        from pathlib import Path

        path = REPO / "plugins" / "hivra-core" / "__init__.py"
        spec = importlib.util.spec_from_file_location("hivra_core_for_test", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        assert "audio_generate" in mod.MEDIA_GENERATION_GUIDANCE
        assert "register_system_prompt_section" in path.read_text(encoding="utf-8")


class TestVideoModelResolution:
    """Dynamic family+mode -> variant resolution for Venice video, so the user picks a FAMILY (or
    Auto) and the plugin selects the right text/image/reference-to-video model from the inputs."""

    def _vv(self):
        import plugins.video_gen.venice as vv

        return vv

    def test_detect_mode_from_inputs(self):
        vv = self._vv()
        assert vv._detect_mode(image_url=None, reference_images=None) == "text-to-video"
        assert vv._detect_mode(image_url="https://x/a.png", reference_images=None) == "image-to-video"
        assert vv._detect_mode(image_url=None, reference_images=["https://x/a.png"]) == "reference-to-video"

    def test_family_plus_mode_resolves_variant(self, monkeypatch):
        vv = self._vv()
        catalog = [
            "seedance-2-0-text-to-video", "seedance-2-0-image-to-video",
            "seedance-2-0-reference-to-video", "wan-2-7-text-to-video",
            "wan-2-7-image-to-video",
        ]
        monkeypatch.setattr(vv, "_video_model_ids", lambda: catalog)
        assert vv._resolve_concrete_model("seedance-2-0", "image-to-video") == "seedance-2-0-image-to-video"
        assert vv._resolve_concrete_model("seedance-2-0", "text-to-video") == "seedance-2-0-text-to-video"
        # a pinned full variant is re-pointed to the actual request mode
        assert vv._resolve_concrete_model("seedance-2-0-text-to-video", "reference-to-video") == "seedance-2-0-reference-to-video"
        # family lacking the exact mode falls back sensibly (wan has no reference)
        assert vv._resolve_concrete_model("wan-2-7", "reference-to-video") == "wan-2-7-image-to-video"

    def test_single_id_family_resolves_to_itself(self, monkeypatch):
        vv = self._vv()
        monkeypatch.setattr(vv, "_video_model_ids", lambda: ["veo-3.1", "kling-v3"])
        # Veo/Kling carry the mode in the payload (image_url switch) -> unchanged.
        assert vv._resolve_concrete_model("veo-3.1", "image-to-video") == "veo-3.1"


class TestVeniceVideoPayload:
    """Submit payload must omit aspect_ratio for image/reference-to-video (Venice 400s: 'This model
    does not support aspect_ratio'); pure text-to-video keeps it."""

    def _provider_capturing(self, monkeypatch):
        import plugins.video_gen.venice as vv

        captured: dict = {}

        async def fake_submit(client, payload, *, api_key, base_url):
            captured["payload"] = dict(payload)
            return "queue-test-1"

        async def fake_poll(client, queue_id, *, api_key, base_url, timeout_seconds, poll_interval):
            return {"status": "done", "body": {"download_url": "https://x/v.mp4", "model": "m"}}

        monkeypatch.setattr(vv, "_resolve_credentials", lambda: ("test-key", "https://api.venice.ai/api/v1"))
        monkeypatch.setattr(vv, "_resolve_concrete_model", lambda family, mode: f"seedance-2-0-{mode}")
        monkeypatch.setattr(vv, "_submit_job", fake_submit)
        monkeypatch.setattr(vv, "_poll_job", fake_poll)
        return vv.VeniceVideoGenProvider(), captured

    def test_text_to_video_keeps_aspect_ratio(self, monkeypatch):
        provider, captured = self._provider_capturing(monkeypatch)
        res = provider.generate("a neon city", aspect_ratio="16:9")
        assert res.get("success") is True, res
        assert captured["payload"].get("aspect_ratio") == "16:9"
        assert "image_url" not in captured["payload"]

    def test_image_to_video_omits_aspect_ratio(self, monkeypatch):
        provider, captured = self._provider_capturing(monkeypatch)
        res = provider.generate("make it move", image_url="data:image/png;base64,AAAA", aspect_ratio="16:9")
        assert res.get("success") is True, res
        assert "aspect_ratio" not in captured["payload"], "image-to-video must NOT send aspect_ratio"
        assert captured["payload"].get("image_url") == "data:image/png;base64,AAAA"

    def test_reference_to_video_omits_aspect_ratio(self, monkeypatch):
        provider, captured = self._provider_capturing(monkeypatch)
        res = provider.generate("blend these", reference_image_urls=["https://x/a.png"], aspect_ratio="9:16")
        assert res.get("success") is True, res
        assert "aspect_ratio" not in captured["payload"]
        assert captured["payload"].get("reference_image_urls") == ["https://x/a.png"]


class TestVeniceBackendsRegistered:
    """The Venice backends are bundled plugins (no inline bodies in upstream tool files)."""

    def test_all_four_registries_have_venice(self):
        from hermes_cli.plugins import _ensure_plugins_discovered
        from agent import image_gen_registry, transcription_registry, tts_registry, video_gen_registry

        _ensure_plugins_discovered()
        assert image_gen_registry.get_provider("venice") is not None
        assert video_gen_registry.get_provider("venice") is not None
        assert tts_registry.get_provider("venice") is not None
        assert transcription_registry.get_provider("venice") is not None

    def test_venice_is_not_a_builtin_name_that_would_shadow_the_plugin(self):
        from tools.transcription_tools import BUILTIN_STT_PROVIDERS
        from tools.tts_tool import BUILTIN_TTS_PROVIDERS

        assert "venice" not in BUILTIN_TTS_PROVIDERS
        assert "venice" not in BUILTIN_STT_PROVIDERS


class TestMediaConfigHonoring:
    """Settings -> Media controls must not become dead controls: the Venice image plugin reads
    the config defaults the WebUI persists."""

    def test_image_style_preset_default_reaches_the_venice_payload(self, monkeypatch):
        import plugins.image_gen.venice as vi

        monkeypatch.setenv("VENICE_API_KEY", "k")
        monkeypatch.setattr(vi, "_configured_style_preset", lambda: "Neon Punk")
        sent = {}

        class _R:
            status_code = 200

            def raise_for_status(self):
                return None

            def json(self):
                return {"images": ["aGk="]}

        def fake_post(url, **kw):
            sent.update(kw["json"])
            return _R()

        monkeypatch.setattr(vi.requests, "post", fake_post)
        monkeypatch.setattr(vi, "save_b64_image", lambda b64, prefix="": "/tmp/g.png")
        assert vi.VeniceImageGenProvider().generate("a cat")["success"] is True
        assert sent.get("style_preset") == "Neon Punk"


