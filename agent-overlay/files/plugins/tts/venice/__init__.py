"""Venice text-to-speech backend.

Venice unifies 50+ voices across several TTS model families (Kokoro, Qwen 3, xAI,
ElevenLabs, Inworld, Orpheus, ...) behind one OpenAI-shaped ``/audio/speech`` endpoint.
Authentication is ``VENICE_API_KEY``; the base URL is overridable via ``VENICE_BASE_URL``
so the same plugin targets Venice direct or the HermesOS managed-Venice proxy.

Selected by an explicit ``tts.provider: venice`` (what the Media settings write).
Settings read from ``tts.venice``: ``model``, ``voice``, ``speed`` (0.25-4.0),
``language``, ``base_url``.

Fork note: this used to live inline in ``tools/tts_tool.py`` (``_generate_venice_tts``);
upstream's TTS plugin registry now carries it, so the tool file stays vanilla.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from agent.tts_provider import TTSProvider

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "tts-kokoro"
DEFAULT_VOICE = "af_sky"
DEFAULT_BASE_URL = "https://api.venice.ai/api/v1"
DEFAULT_TIMEOUT_SECONDS = 120

# Venice /audio/speech response_format values.
_RESPONSE_FORMATS = frozenset({"mp3", "opus", "aac", "flac", "wav", "pcm"})


def _load_venice_config() -> Dict[str, Any]:
    """``tts.venice`` from config.yaml ({} when unavailable)."""
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("tts") if isinstance(cfg, dict) else None
        venice = section.get("venice") if isinstance(section, dict) else None
        return venice if isinstance(venice, dict) else {}
    except Exception as exc:
        logger.debug("Could not read tts.venice config: %s", exc)
        return {}


def _clean(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


class VeniceTTSProvider(TTSProvider):
    """Venice ``/audio/speech`` backend."""

    @property
    def name(self) -> str:
        return "venice"

    @property
    def display_name(self) -> str:
        return "Venice"

    def is_available(self) -> bool:
        return bool(os.environ.get("VENICE_API_KEY", "").strip())

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": DEFAULT_MODEL, "display": "Kokoro (default)"}]

    def default_model(self) -> Optional[str]:
        return DEFAULT_MODEL

    def list_voices(self) -> List[Dict[str, Any]]:
        return [{"id": DEFAULT_VOICE, "display": "Sky (default)"}]

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Venice",
            "badge": "paid",
            "tag": "50+ voices (Kokoro, Qwen 3, ElevenLabs, ...) - uses VENICE_API_KEY (same key as Venice chat)",
            "env_vars": [
                {"key": "VENICE_API_KEY", "prompt": "Venice API key", "url": "https://venice.ai/settings/api"},
            ],
        }

    def synthesize(
        self, text: str, output_path: str, *, voice: Optional[str] = None, model: Optional[str] = None,
        speed: Optional[float] = None, format: str = "mp3", **extra: Any,
    ) -> str:
        import requests

        api_key = os.environ.get("VENICE_API_KEY", "").strip()
        if not api_key:
            raise ValueError("No Venice credentials found. Set VENICE_API_KEY (same key as Venice chat).")

        cfg = _load_venice_config()
        # tts.venice.* wins: the dispatcher forwards the top-level tts.voice/model, which belong
        # to whichever provider the user used before (an Edge voice id 400s on Venice).
        model_id = _clean(cfg.get("model")) or _clean(model) or DEFAULT_MODEL
        voice_id = _clean(cfg.get("voice")) or _clean(voice) or DEFAULT_VOICE
        speed_raw = cfg.get("speed") if cfg.get("speed") is not None else speed
        try:
            rate = float(speed_raw) if speed_raw is not None else 1.0
        except (TypeError, ValueError):
            rate = 1.0
        rate = max(0.25, min(4.0, rate))
        base_url = (_clean(cfg.get("base_url")) or os.environ.get("VENICE_BASE_URL", "").strip()
                    or DEFAULT_BASE_URL).rstrip("/")

        # The output extension picks the wire format; anything Venice can't emit (.ogg) is mp3.
        ext = output_path.rsplit(".", 1)[-1].lower() if "." in output_path else "mp3"
        response_format = ext if ext in _RESPONSE_FORMATS else "mp3"

        payload: Dict[str, Any] = {
            "model": model_id, "input": text, "voice": voice_id,
            "response_format": response_format, "speed": rate,
        }
        language = _clean(cfg.get("language"))
        if language:
            payload["language"] = language

        response = requests.post(
            f"{base_url}/audio/speech",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "hermes-agent/tts-venice",
            },
            json=payload,
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        with open(output_path, "wb") as f:
            f.write(response.content)
        return output_path


def register(ctx: Any) -> None:
    """Register this provider with the TTS registry."""
    ctx.register_tts_provider(VeniceTTSProvider())
