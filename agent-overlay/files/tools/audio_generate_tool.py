#!/usr/bin/env python3
"""Audio generation tool - Venice-backed (music + SFX).

Wraps Venice's ``/audio/queue`` + ``/audio/{id}`` (or ``/audio/complete``
for one-shot) so the agent can generate music, sound effects, or
vocalized audio in response to user prompts.

Distinct from :mod:`tools.tts_tool` (text-to-speech is for spoken words
on top of provided text). This tool generates *new* audio content from
a creative prompt.

Authentication: ``VENICE_API_KEY``. Base URL is overridable via
``VENICE_BASE_URL`` for the managed-Venice proxy.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from tools.registry import registry

logger = logging.getLogger(__name__)


DEFAULT_VENICE_BASE_URL = "https://api.venice.ai/api/v1"
DEFAULT_AUDIO_MODEL = "elevenlabs-music"
DEFAULT_DURATION_SECONDS = 15
DEFAULT_POLL_INTERVAL_SECONDS = 3
DEFAULT_POLL_TIMEOUT_SECONDS = 180


def _resolve_credentials() -> Tuple[str, str]:
    api_key = os.environ.get("VENICE_API_KEY", "").strip()
    base_url = (
        os.environ.get("VENICE_BASE_URL", "").strip()
        or DEFAULT_VENICE_BASE_URL
    ).rstrip("/")
    return api_key, base_url


def _read_configured_audio_model() -> Optional[str]:
    """Return ``audio_gen.model`` from config.yaml, or None.

    Set via the WebUI Settings → Media "Music model" dropdown. Lets the user
    pin a default music/audio model without passing it on every call. An
    explicit ``model`` argument (from the LLM) still wins.
    """
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("audio_gen") if isinstance(cfg, dict) else None
        if isinstance(section, dict):
            value = section.get("model")
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception as exc:
        logger.debug("Could not read audio_gen.model: %s", exc)
    return None


def _audio_cache_dir() -> Path:
    from hermes_constants import get_hermes_home

    path = get_hermes_home() / "cache" / "audio"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _save_binary_audio(data: bytes, *, prefix: str, ext: str = "mp3") -> Path:
    import datetime

    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    short = uuid.uuid4().hex[:8]
    path = _audio_cache_dir() / f"{prefix}_{ts}_{short}.{ext}"
    path.write_bytes(data)
    return path


def check_audio_generate_requirements() -> bool:
    api_key, _ = _resolve_credentials()
    return bool(api_key)


_AUDIO_EXT_BY_CT = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
}


async def _queue_and_poll(
    *,
    api_key: str,
    base_url: str,
    payload: Dict[str, Any],
    poll_timeout: int,
    poll_interval: int,
) -> Tuple[str, bytes, str]:
    """Submit to ``/audio/queue``, then poll ``POST /audio/retrieve`` until the
    rendered audio is returned.

    Venice's audio queue API works in three steps (per docs):
      1. ``POST /audio/queue``     → ``{queue_id, status: "QUEUED"}``
      2. ``POST /audio/retrieve``  → JSON ``{status: "PROCESSING"}`` while the
         job runs, then the raw audio bytes (``audio/mpeg|wav|flac``) once done.
         ``delete_media_on_completion`` makes Venice clean up server-side after
         this download, so no separate ``/audio/complete`` call is needed.
      3. ``POST /audio/complete``  → only required if retrieve didn't delete.

    Both queue and retrieve require ``model`` + ``queue_id``. Returns
    ``(queue_id, audio_bytes, ext)``. Raises on terminal errors / timeout.
    """
    import httpx

    model = payload.get("model")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "hermes-agent/audio-gen-venice",
    }

    async with httpx.AsyncClient() as client:
        submit = await client.post(
            f"{base_url}/audio/queue",
            headers=headers,
            json=payload,
            timeout=60,
        )
        submit.raise_for_status()
        submit_body = submit.json()
        queue_id = submit_body.get("queue_id") or submit_body.get("id")
        if not queue_id:
            raise RuntimeError("Venice audio queue response did not include queue_id")

        elapsed = 0.0
        last_status = "QUEUED"
        while elapsed < poll_timeout:
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
            poll = await client.post(
                f"{base_url}/audio/retrieve",
                headers=headers,
                json={
                    "model": model,
                    "queue_id": queue_id,
                    "delete_media_on_completion": True,
                },
                timeout=60,
            )
            content_type = (poll.headers.get("content-type") or "").split(";")[0].strip().lower()
            # Completed: Venice streams the rendered audio back as binary.
            if poll.status_code == 200 and content_type.startswith("audio/"):
                ext = _AUDIO_EXT_BY_CT.get(content_type, "mp3")
                return queue_id, poll.content, ext
            # Otherwise expect a JSON status envelope (still processing / error).
            try:
                body = poll.json()
            except Exception:
                body = {}
            last_status = str(body.get("status") or "").upper()
            if last_status in {"FAILED", "ERROR", "EXPIRED", "CANCELLED", "CANCELED"}:
                raise RuntimeError(
                    f"Venice audio generation ended with status {last_status}: "
                    f"{body.get('error') or body.get('message')}"
                )
            # A 4xx that is NOT a transient "still queued/processing" state is fatal.
            if poll.status_code >= 400 and last_status not in {"PROCESSING", "QUEUED", "PENDING", ""}:
                raise RuntimeError(
                    f"Venice audio retrieve failed ({poll.status_code}): "
                    f"{body.get('error') or poll.text[:200]}"
                )

        raise TimeoutError(
            f"Timed out waiting for Venice audio after {poll_timeout}s (last status: {last_status})"
        )


def audio_generate_tool(
    prompt: str,
    model: Optional[str] = None,
    duration_seconds: Optional[int] = None,
    lyrics_prompt: Optional[str] = None,
    voice: Optional[str] = None,
    force_instrumental: Optional[bool] = None,
    language_code: Optional[str] = None,
) -> str:
    """Generate music or sound effects from a text prompt via Venice."""
    api_key, base_url = _resolve_credentials()
    if not api_key:
        return json.dumps(
            {
                "success": False,
                "error": "VENICE_API_KEY not set. Configure Venice in `hermes model` first.",
                "error_type": "missing_api_key",
            }
        )

    if not isinstance(prompt, str) or not prompt.strip():
        return json.dumps(
            {"success": False, "error": "prompt is required", "error_type": "missing_prompt"}
        )

    chosen_model = (model or _read_configured_audio_model() or DEFAULT_AUDIO_MODEL).strip() or DEFAULT_AUDIO_MODEL
    duration = duration_seconds if isinstance(duration_seconds, int) else DEFAULT_DURATION_SECONDS
    duration = max(1, min(300, duration))

    payload: Dict[str, Any] = {
        "model": chosen_model,
        "prompt": prompt.strip(),
        "duration_seconds": duration,
    }
    if isinstance(lyrics_prompt, str) and lyrics_prompt.strip():
        payload["lyrics_prompt"] = lyrics_prompt.strip()
    if isinstance(voice, str) and voice.strip():
        payload["voice"] = voice.strip()
    if isinstance(force_instrumental, bool):
        payload["force_instrumental"] = force_instrumental
    if isinstance(language_code, str) and language_code.strip():
        payload["language_code"] = language_code.strip()

    try:
        loop = asyncio.new_event_loop()
        try:
            queue_id, audio_bytes, audio_ext = loop.run_until_complete(
                _queue_and_poll(
                    api_key=api_key,
                    base_url=base_url,
                    payload=payload,
                    poll_timeout=DEFAULT_POLL_TIMEOUT_SECONDS,
                    poll_interval=DEFAULT_POLL_INTERVAL_SECONDS,
                )
            )
        finally:
            loop.close()
    except TimeoutError as exc:
        return json.dumps({"success": False, "error": str(exc), "error_type": "timeout"})
    except RuntimeError as exc:
        return json.dumps({"success": False, "error": str(exc), "error_type": "api_error"})
    except Exception as exc:
        return json.dumps({"success": False, "error": f"Venice audio generation failed: {exc}", "error_type": "api_error"})

    # Venice's /audio/retrieve returns the rendered audio as raw bytes once the
    # job completes; persist it to the audio cache and hand back the local path.
    if not audio_bytes:
        return json.dumps(
            {
                "success": False,
                "error": "Venice audio generation completed but returned no audio data",
                "error_type": "empty_response",
            }
        )
    try:
        saved = _save_binary_audio(audio_bytes, prefix=f"venice_audio_{chosen_model}", ext=audio_ext)
    except Exception as exc:
        return json.dumps(
            {"success": False, "error": f"Could not save audio: {exc}", "error_type": "io_error"}
        )

    return json.dumps(
        {
            "success": True,
            "audio": str(saved),
            "model": chosen_model,
            "provider": "venice",
            "queue_id": queue_id,
            "duration_seconds": duration,
        }
    )


AUDIO_GENERATE_SCHEMA = {
    "name": "audio_generate",
    "description": (
        "Generate real music, background music, songs, jingles, ambient "
        "tracks, or sound effects (SFX) from a text prompt - cloud-rendered "
        "via Venice (elevenlabs-music), nothing to install. THIS is the tool "
        "to use for ANY request to make/generate music, a soundtrack, "
        "background/bg music, a beat, or sound effects. Always prefer it over "
        "writing code, running the terminal, or the audiocraft / MusicGen / "
        "songwriting skills - those are unnecessary and lower quality here. "
        "(Different from text_to_speech, which only reads provided text "
        "aloud.) Returns the saved .mp3 file path."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Creative description of the audio (e.g. 'cyberpunk synth loop, 120bpm').",
            },
            "model": {
                "type": "string",
                "description": "Venice audio model (defaults to elevenlabs-music).",
            },
            "duration_seconds": {
                "type": "integer",
                "description": "Length of generated audio (1-300). Model may clamp shorter.",
                "default": 15,
            },
            "lyrics_prompt": {
                "type": "string",
                "description": "Optional lyrics for vocal/lyric-capable models.",
            },
            "voice": {
                "type": "string",
                "description": "Voice selection for voice-enabled models.",
            },
            "force_instrumental": {
                "type": "boolean",
                "description": "Force an instrumental track (no vocals).",
            },
            "language_code": {
                "type": "string",
                "description": "ISO 639-1 language code for lyric models (e.g. 'en', 'es').",
            },
        },
        "required": ["prompt"],
    },
}


registry.register(
    name="audio_generate",
    toolset="video_gen",
    schema=AUDIO_GENERATE_SCHEMA,
    handler=lambda args, **kw: audio_generate_tool(**args),
    check_fn=check_audio_generate_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="🎵",
)
