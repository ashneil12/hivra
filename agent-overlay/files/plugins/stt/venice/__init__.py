"""Venice speech-to-text backend.

Venice's OpenAI-compatible ``/audio/transcriptions`` endpoint, same ``VENICE_API_KEY`` as
chat + image + video + speech. Base URL is overridable via ``VENICE_BASE_URL`` (managed
proxy). Settings read from ``stt.venice``: ``model``, ``language``, ``base_url``,
``response_format`` (``json`` default; ``text``/``srt``/``vtt`` return raw text).

Fork note: this used to live inline in ``tools/transcription_tools.py``
(``_transcribe_venice``); upstream's transcription plugin registry carries it now. The
unset-provider auto-detect on Venice-only boxes is the ``venice-autopair`` seam.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.transcription_provider import TranscriptionProvider

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.venice.ai/api/v1"
# Venice's transcription model id (NOT OpenAI's "whisper-1", which 404s on Venice).
DEFAULT_MODEL = "openai/whisper-large-v3"
DEFAULT_TIMEOUT_SECONDS = 180


def _load_venice_config() -> Dict[str, Any]:
    """``stt.venice`` from config.yaml ({} when unavailable)."""
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("stt") if isinstance(cfg, dict) else None
        venice = section.get("venice") if isinstance(section, dict) else None
        return venice if isinstance(venice, dict) else {}
    except Exception as exc:
        logger.debug("Could not read stt.venice config: %s", exc)
        return {}


def _clean(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _fail(message: str) -> Dict[str, Any]:
    return {"success": False, "transcript": "", "error": message, "provider": "venice"}


class VeniceTranscriptionProvider(TranscriptionProvider):
    """Venice ``/audio/transcriptions`` backend."""

    @property
    def name(self) -> str:
        return "venice"

    @property
    def display_name(self) -> str:
        return "Venice"

    def is_available(self) -> bool:
        return bool(os.environ.get("VENICE_API_KEY", "").strip())

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": DEFAULT_MODEL, "display": "Whisper large-v3 (default)"}]

    def default_model(self) -> Optional[str]:
        return DEFAULT_MODEL

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Venice",
            "badge": "paid",
            "tag": "Whisper large-v3 - uses VENICE_API_KEY (same key as Venice chat)",
            "env_vars": [
                {"key": "VENICE_API_KEY", "prompt": "Venice API key", "url": "https://venice.ai/settings/api"},
            ],
        }

    def transcribe(
        self, file_path: str, *, model: Optional[str] = None, language: Optional[str] = None, **extra: Any,
    ) -> Dict[str, Any]:
        api_key = os.environ.get("VENICE_API_KEY", "").strip()
        if not api_key:
            return _fail("No Venice credentials found. Set VENICE_API_KEY (same key as Venice chat).")

        cfg = _load_venice_config()
        base_url = (_clean(cfg.get("base_url")) or os.environ.get("VENICE_BASE_URL", "").strip()
                    or DEFAULT_BASE_URL).rstrip("/")
        model_id = _clean(model) or _clean(cfg.get("model")) or DEFAULT_MODEL
        lang = _clean(language) or _clean(cfg.get("language"))
        response_format = _clean(cfg.get("response_format")) or "json"

        try:
            import requests

            data: Dict[str, str] = {"model": model_id, "response_format": response_format}
            if lang:
                data["language"] = lang
            with open(file_path, "rb") as audio_file:
                response = requests.post(
                    f"{base_url}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}", "User-Agent": "hermes-agent/stt-venice"},
                    files={"file": (Path(file_path).name, audio_file)},
                    data=data,
                    timeout=DEFAULT_TIMEOUT_SECONDS,
                )

            if response.status_code != 200:
                try:
                    detail = (response.json().get("error") or {}).get("message", "") or response.text[:300]
                except Exception:
                    detail = response.text[:300]
                return _fail(f"Venice STT error (HTTP {response.status_code}): {detail}")

            if response_format in {"text", "srt", "vtt"}:
                transcript = response.text.strip()
            else:
                transcript = (response.json().get("text") or "").strip()
            if not transcript:
                return _fail("Venice STT returned empty transcript")

            logger.info("Transcribed %s via Venice STT (model=%s, %d chars)",
                        Path(file_path).name, model_id, len(transcript))
            return {"success": True, "transcript": transcript, "provider": "venice"}
        except PermissionError:
            return _fail(f"Permission denied: {file_path}")
        except Exception as exc:
            logger.error("Venice STT transcription failed: %s", exc, exc_info=True)
            return _fail(f"Venice STT transcription failed: {exc}")


def register(ctx: Any) -> None:
    """Register this provider with the transcription registry."""
    ctx.register_transcription_provider(VeniceTranscriptionProvider())
