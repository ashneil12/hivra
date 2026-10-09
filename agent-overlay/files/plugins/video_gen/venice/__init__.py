"""Venice video generation backend (text-to-video + image-to-video).

Surface: ``POST /video/queue`` (submit) plus ``POST /video/retrieve``
(poll with ``queue_id`` for completion). Venice exposes a curated catalog spanning Veo, Kling,
Seedance, Wan, and others through one endpoint - the plugin abstracts
that as ``model=`` selection with a default of ``veo-3.1`` for
prompt-only requests and the same model for image-to-video (the
``image_url`` parameter is the t2v/i2v switch, mirroring the FAL and
xAI plugins).

Authentication: ``VENICE_API_KEY``. Base URL is overridable via
``VENICE_BASE_URL`` so the same plugin can target either Venice direct
(``https://api.venice.ai/api/v1``) or the HermesOS managed-Venice proxy
(``https://hermesos.cloud/api/managed-venice/v1``).

Unknown model ids are forwarded as-is; Venice's catalog moves faster
than we can keep the constant table current and rejecting unknown ids
would create a constant maintenance burden.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

import httpx

from agent.video_gen_provider import (
    VideoGenProvider,
    error_response,
    success_response,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_VENICE_BASE_URL = "https://api.venice.ai/api/v1"
DEFAULT_MODEL = "veo-3.1"
DEFAULT_DURATION_SECONDS = 8
DEFAULT_ASPECT_RATIO = "16:9"
DEFAULT_RESOLUTION = "720p"
DEFAULT_TIMEOUT_SECONDS = 360
DEFAULT_POLL_INTERVAL_SECONDS = 5

VALID_ASPECT_RATIOS = {"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"}
VALID_RESOLUTIONS = {"256p", "360p", "480p", "540p", "720p", "1080p", "true_1080p", "1440p", "4k"}
MAX_REFERENCE_IMAGES = 9
MAX_DURATION_SECONDS = 30
MIN_DURATION_SECONDS = 2


# Curated catalog. Not exhaustive - Venice rotates models often. Users
# can pass an unknown id via ``model=`` and the plugin forwards it
# verbatim. Display metadata is just for the model picker.
_MODELS: Dict[str, Dict[str, Any]] = {
    "veo-3.1": {
        "display": "Veo 3.1",
        "speed": "~60-180s",
        "strengths": "Google Veo 3.1 via Venice. Strong text-to-video, native audio.",
        "modalities": ["text", "image"],
    },
    "kling-v3": {
        "display": "Kling v3",
        "speed": "~60-180s",
        "strengths": "Kling v3. Long-form, cinematic. Image-to-video.",
        "modalities": ["text", "image"],
    },
    "seedance-2.0": {
        "display": "Seedance 2.0",
        "speed": "~45-120s",
        "strengths": "Bytedance Seedance 2.0. Fast, expressive motion.",
        "modalities": ["text", "image"],
    },
    "wan-2.5": {
        "display": "Wan 2.5",
        "speed": "~30-90s",
        "strengths": "Wan 2.5. Affordable text-to-video.",
        "modalities": ["text", "image"],
    },
    "grok-imagine-video": {
        "display": "Grok Imagine Video (via Venice)",
        "speed": "~60-240s",
        "strengths": "Grok Imagine Video routed through Venice (single key).",
        "modalities": ["text", "image"],
    },
}


# ---------------------------------------------------------------------------
# Config + auth
# ---------------------------------------------------------------------------


def _load_venice_config() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("video_gen") if isinstance(cfg, dict) else None
        venice_section = section.get("venice") if isinstance(section, dict) else None
        return venice_section if isinstance(venice_section, dict) else {}
    except Exception as exc:
        logger.debug("Could not load video_gen.venice config: %s", exc)
        return {}


def _resolve_base_url() -> str:
    env_url = os.environ.get("VENICE_BASE_URL", "").strip()
    if env_url:
        return env_url.rstrip("/")

    cfg = _load_venice_config()
    cfg_url = cfg.get("base_url") if isinstance(cfg.get("base_url"), str) else None
    if cfg_url:
        return cfg_url.strip().rstrip("/")

    return DEFAULT_VENICE_BASE_URL


def _resolve_model(call_override: Optional[str]) -> str:
    candidate = (call_override or "").strip()
    if candidate:
        return candidate
    env_override = os.environ.get("VENICE_VIDEO_MODEL", "").strip()
    if env_override:
        return env_override
    cfg = _load_venice_config()
    cfg_model = cfg.get("model") if isinstance(cfg.get("model"), str) else None
    if cfg_model:
        return cfg_model
    return DEFAULT_MODEL


# ---------------------------------------------------------------------------
# Dynamic mode-aware model resolution
# ---------------------------------------------------------------------------
# Newer Venice video FAMILIES encode the generation MODE in the model id
# (seedance-2-0-text-to-video / -image-to-video / -reference-to-video,
# wan-2-7-video-to-video, …). The user picks a FAMILY (or Auto) in the WebUI;
# we derive the mode from the request inputs and resolve the concrete variant -
# so the agent never has to name an exact model and a pinned family works for
# EVERY mode. Older single-id families (Veo/Kling) carry all modes in the
# payload, so they resolve to themselves and the image_url switch still applies.
_MODE_SUFFIXES = ("reference-to-video", "image-to-video", "text-to-video", "video-to-video")
_MODE_FALLBACK = {
    "text-to-video": ("text-to-video",),
    "image-to-video": ("image-to-video", "reference-to-video"),
    "reference-to-video": ("reference-to-video", "image-to-video"),
    "video-to-video": ("video-to-video",),
}
_CATALOG_CACHE: Dict[str, Any] = {"ts": 0.0, "ids": []}
_CATALOG_TTL_SECONDS = 300


def _detect_mode(
    *,
    image_url: Optional[str],
    reference_images: Optional[List[str]],
    video_url: Optional[str] = None,
) -> str:
    if video_url:
        return "video-to-video"
    if reference_images:
        return "reference-to-video"
    if image_url:
        return "image-to-video"
    return "text-to-video"


def _strip_mode_suffix(model_id: str) -> str:
    for suf in _MODE_SUFFIXES:
        if model_id.endswith("-" + suf):
            return model_id[: -(len(suf) + 1)]
    return model_id


def _video_model_ids() -> List[str]:
    """Live video model ids from ``GET /models?type=video`` (5-min cached, best-effort)."""
    import time

    now = time.time()
    cached = _CATALOG_CACHE.get("ids") or []
    if cached and (now - float(_CATALOG_CACHE.get("ts") or 0)) < _CATALOG_TTL_SECONDS:
        return cached
    api_key, base_url = _resolve_credentials()
    if not api_key:
        return cached
    try:
        resp = httpx.get(
            f"{base_url}/models?type=video",
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            timeout=8,
        )
        resp.raise_for_status()
        data = resp.json()
        items = data.get("data") if isinstance(data, dict) else data
        ids = [str(m["id"]) for m in (items or []) if isinstance(m, dict) and m.get("id")]
        if ids:
            _CATALOG_CACHE["ts"] = now
            _CATALOG_CACHE["ids"] = ids
            return ids
    except Exception:
        logger.debug("video model catalog fetch failed", exc_info=True)
    return cached


def _resolve_concrete_model(family_or_id: str, mode: str) -> str:
    """Map a family preference (or full id) + detected mode → a concrete model id.

    Split families resolve to ``<family>-<mode>`` (with a sensible mode-fallback
    when a family lacks the exact variant); single-id families (Veo/Kling)
    resolve to themselves and rely on the payload's image_url switch.
    """
    family_or_id = (family_or_id or "").strip()
    if not family_or_id:
        return DEFAULT_MODEL
    stem = _strip_mode_suffix(family_or_id)
    catalog = _video_model_ids()
    if catalog:
        for cand_suf in _MODE_FALLBACK.get(mode, (mode,)):
            cand = f"{stem}-{cand_suf}"
            if cand in catalog:
                return cand
        if family_or_id in catalog:
            return family_or_id
        if stem in catalog:
            return stem
        fam = sorted(m for m in catalog if m.startswith(stem + "-"))
        if fam:
            return fam[0]
        return family_or_id
    # Offline / no catalog: if it already carried a mode suffix, swap it; else verbatim.
    if stem != family_or_id:
        return f"{stem}-{mode}"
    return family_or_id


def _resolve_credentials() -> Tuple[str, str]:
    api_key = os.environ.get("VENICE_API_KEY", "").strip()
    return api_key, _resolve_base_url()


def _venice_user_agent() -> str:
    return "hermes-agent/video_gen-venice"


def _venice_headers(api_key: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": _venice_user_agent(),
    }


def _coerce_image_to_data_url(ref: str, *, budget: int = 3_000_000) -> str:
    """Make an image reference safe to send as a Venice video ``image_url``.

    HTTP(S) and ``data:`` URLs pass through. A LOCAL file path (or raw base64) -- e.g. an
    image the agent just generated -- is read, downscaled to fit the managed-proxy request
    cap and returned as a ``data:image/...;base64,`` URL, so "turn this image into a video"
    works without the agent hand-building a data URL in the terminal. Best-effort: anything
    unresolvable (or not a recognised image) is returned unchanged so Venice reports it.
    """
    ref = (ref or "").strip()
    if not ref:
        return ref
    low = ref.lower()
    if low.startswith(("http://", "https://", "data:")):
        return ref
    try:
        import base64 as _b64

        from tools.image_edit_tool import _open_image_for_upload, _shrink_image_bytes

        data, _name = _open_image_for_upload(ref)
        data = _shrink_image_bytes(data, budget)
        if data[:3] == b"\xff\xd8\xff":
            mime = "image/jpeg"
        elif data[:8] == b"\x89PNG\r\n\x1a\n":
            mime = "image/png"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            mime = "image/webp"
        else:
            # Not an image (e.g. a bare provider file-id that happens to be valid base64):
            # never fabricate a data: URL, let the provider validate the original value.
            return ref
        return f"data:{mime};base64," + _b64.b64encode(data).decode("ascii")
    except Exception:
        return ref


def _normalize_reference_images(refs: Optional[List[str]]) -> Optional[List[str]]:
    if not refs:
        return None
    out = [url.strip() for url in refs if isinstance(url, str) and url.strip()]
    return out or None


def _clamp_duration(duration: Optional[int]) -> int:
    value = duration if isinstance(duration, int) else DEFAULT_DURATION_SECONDS
    if value < MIN_DURATION_SECONDS:
        value = MIN_DURATION_SECONDS
    if value > MAX_DURATION_SECONDS:
        value = MAX_DURATION_SECONDS
    return value


async def _submit_job(
    client: httpx.AsyncClient,
    payload: Dict[str, Any],
    *,
    api_key: str,
    base_url: str,
) -> str:
    response = await client.post(
        f"{base_url}/video/queue",
        headers=_venice_headers(api_key),
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    body = response.json()
    queue_id = body.get("queue_id") or body.get("id") or body.get("request_id")
    if not queue_id:
        raise RuntimeError("Venice video response did not include queue_id")
    return str(queue_id)


async def _poll_job(
    client: httpx.AsyncClient,
    queue_id: str,
    *,
    api_key: str,
    base_url: str,
    timeout_seconds: int,
    poll_interval: int,
) -> Dict[str, Any]:
    elapsed = 0.0
    last_status = "queued"
    while elapsed < timeout_seconds:
        response = await client.post(
            f"{base_url}/video/retrieve",
            headers=_venice_headers(api_key),
            json={"queue_id": queue_id},
            timeout=30,
        )
        response.raise_for_status()
        body = response.json()
        last_status = str(body.get("status") or "").lower()

        if last_status in {"done", "succeeded", "completed"}:
            return {"status": "done", "body": body}
        if last_status in {"failed", "error", "expired", "cancelled", "canceled"}:
            return {"status": last_status, "body": body}

        await asyncio.sleep(poll_interval)
        elapsed += poll_interval

    return {"status": "timeout", "body": {"status": last_status}}


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class VeniceVideoGenProvider(VideoGenProvider):
    """Venice video gen backend (text-to-video + image-to-video)."""

    @property
    def name(self) -> str:
        return "venice"

    @property
    def display_name(self) -> str:
        return "Venice"

    def is_available(self) -> bool:
        api_key, _ = _resolve_credentials()
        return bool(api_key)

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": mid, **meta} for mid, meta in _MODELS.items()]

    def list_model_families(self) -> List[str]:
        """Switchable family ids from the LIVE catalog (mode suffix stripped),
        so the agent can override per-request via ``model=<family>`` (e.g.
        "use Kling"). Falls back to the static catalog when the live list is
        unavailable."""
        fams: List[str] = []
        seen = set()
        for mid in _video_model_ids():
            stem = _strip_mode_suffix(mid)
            if stem and stem not in seen:
                seen.add(stem)
                fams.append(stem)
        return fams or list(_MODELS.keys())

    def default_model(self) -> Optional[str]:
        return DEFAULT_MODEL

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Venice",
            "badge": "paid",
            "tag": "Veo / Kling / Seedance / Wan via Venice - text-to-video + image-to-video; uses VENICE_API_KEY (same key as Venice chat + image gen)",
            "env_vars": [
                {
                    "key": "VENICE_API_KEY",
                    "prompt": "Venice API key",
                    "url": "https://venice.ai/settings/api",
                },
            ],
        }

    def capabilities(self) -> Dict[str, Any]:
        return {
            "modalities": ["text", "image"],
            "aspect_ratios": sorted(VALID_ASPECT_RATIOS),
            "resolutions": sorted(VALID_RESOLUTIONS),
            "max_duration": MAX_DURATION_SECONDS,
            "min_duration": MIN_DURATION_SECONDS,
            "supports_audio": True,
            "supports_negative_prompt": True,
            "max_reference_images": MAX_REFERENCE_IMAGES,
        }

    def generate(
        self,
        prompt: str,
        *,
        model: Optional[str] = None,
        image_url: Optional[str] = None,
        reference_image_urls: Optional[List[str]] = None,
        duration: Optional[int] = None,
        aspect_ratio: str = DEFAULT_ASPECT_RATIO,
        resolution: str = DEFAULT_RESOLUTION,
        negative_prompt: Optional[str] = None,
        audio: Optional[bool] = None,
        seed: Optional[int] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        if image_url:
            image_url = _coerce_image_to_data_url(image_url)
        if reference_image_urls:
            reference_image_urls = [_coerce_image_to_data_url(r) for r in reference_image_urls]
        try:
            loop = asyncio.new_event_loop()
            try:
                return loop.run_until_complete(self._generate_async(
                    prompt=prompt,
                    model=model,
                    image_url=image_url,
                    reference_image_urls=reference_image_urls,
                    duration=duration,
                    aspect_ratio=aspect_ratio,
                    resolution=resolution,
                    negative_prompt=negative_prompt,
                    audio=audio,
                    seed=seed,
                ))
            finally:
                loop.close()
        except Exception as exc:
            logger.warning("Venice video gen unexpected failure: %s", exc, exc_info=True)
            return error_response(
                error=f"Venice video generation failed: {exc}",
                error_type="api_error",
                provider="venice",
                model=model or DEFAULT_MODEL,
                prompt=prompt,
                aspect_ratio=aspect_ratio,
            )

    async def _generate_async(
        self,
        *,
        prompt: str,
        model: Optional[str],
        image_url: Optional[str],
        reference_image_urls: Optional[List[str]],
        duration: Optional[int],
        aspect_ratio: str,
        resolution: str,
        negative_prompt: Optional[str],
        audio: Optional[bool],
        seed: Optional[int],
    ) -> Dict[str, Any]:
        api_key, base_url = _resolve_credentials()
        if not api_key:
            return error_response(
                error="No Venice credentials found. Set VENICE_API_KEY (same key as Venice chat).",
                error_type="auth_required",
                provider="venice",
                prompt=prompt,
            )

        prompt = (prompt or "").strip()
        if not prompt:
            return error_response(
                error="prompt is required for Venice video generation",
                error_type="missing_prompt",
                provider="venice",
                prompt=prompt,
            )

        image_url_norm = (image_url or "").strip() or None
        modality_used = "image" if image_url_norm else "text"

        refs = _normalize_reference_images(reference_image_urls)
        if refs and len(refs) > MAX_REFERENCE_IMAGES:
            return error_response(
                error=f"reference_image_urls supports at most {MAX_REFERENCE_IMAGES} images on Venice",
                error_type="too_many_references",
                provider="venice",
                prompt=prompt,
            )

        clamped_duration = _clamp_duration(duration)

        normalized_aspect_ratio = (aspect_ratio or DEFAULT_ASPECT_RATIO).strip()
        if normalized_aspect_ratio not in VALID_ASPECT_RATIOS:
            normalized_aspect_ratio = DEFAULT_ASPECT_RATIO

        normalized_resolution = (resolution or DEFAULT_RESOLUTION).strip().lower()
        if normalized_resolution not in VALID_RESOLUTIONS:
            normalized_resolution = DEFAULT_RESOLUTION

        # Derive the generation mode from the inputs and resolve the concrete
        # model variant for the user's chosen family (or Auto). The agent only
        # has to supply prompt + optional image_url/reference images - the right
        # seedance/wan/… variant (text/image/reference-to-video) is picked here.
        mode = _detect_mode(image_url=image_url_norm, reference_images=refs)
        model_id = _resolve_concrete_model(_resolve_model(model), mode)

        payload: Dict[str, Any] = {
            "model": model_id,
            "prompt": prompt,
            "duration": f"{clamped_duration}s",
            "resolution": normalized_resolution,
        }
        # aspect_ratio is only valid for pure text-to-video. When a source image
        # (image_url) or reference images are supplied, the output frame is
        # derived from that image and Venice rejects the request with
        # 400 "This model does not support aspect_ratio". Omit it in those modes.
        if not image_url_norm and not refs:
            payload["aspect_ratio"] = normalized_aspect_ratio
        if audio is not None:
            payload["audio"] = bool(audio)
        if isinstance(seed, int):
            payload["seed"] = seed
        if isinstance(negative_prompt, str) and negative_prompt.strip():
            payload["negative_prompt"] = negative_prompt.strip()
        if image_url_norm:
            payload["image_url"] = image_url_norm
        if refs:
            payload["reference_image_urls"] = refs

        async with httpx.AsyncClient() as client:
            try:
                queue_id = await _submit_job(
                    client, payload, api_key=api_key, base_url=base_url
                )
            except httpx.HTTPStatusError as exc:
                detail = ""
                try:
                    detail = exc.response.text[:500]
                except Exception:
                    pass
                return error_response(
                    error=f"Venice submit failed ({exc.response.status_code}): {detail or exc}",
                    error_type="api_error",
                    provider="venice",
                    model=model_id,
                    prompt=prompt,
                )

            poll_result = await _poll_job(
                client, queue_id,
                api_key=api_key, base_url=base_url,
                timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
                poll_interval=DEFAULT_POLL_INTERVAL_SECONDS,
            )

        status = poll_result["status"]
        body = poll_result["body"]

        if status == "done":
            # Venice returns ``download_url`` for completed jobs. Some
            # response variants nest it under ``video.url`` or ``video[0].url``.
            url = (
                body.get("download_url")
                or (body.get("video") or {}).get("url")
                or (body.get("video") or {}).get("download_url")
            )
            if not url and isinstance(body.get("videos"), list) and body["videos"]:
                head = body["videos"][0]
                if isinstance(head, dict):
                    url = head.get("url") or head.get("download_url")
                elif isinstance(head, str):
                    url = head

            if not url:
                return error_response(
                    error="Venice video generation completed without a video URL",
                    error_type="empty_response",
                    provider="venice",
                    model=body.get("model") or model_id,
                    prompt=prompt,
                )

            extra: Dict[str, Any] = {
                "queue_id": queue_id,
                "resolution": normalized_resolution,
            }
            if body.get("usage"):
                extra["usage"] = body["usage"]

            return success_response(
                video=url,
                model=body.get("model") or model_id,
                prompt=prompt,
                modality=modality_used,
                aspect_ratio=normalized_aspect_ratio,
                duration=clamped_duration,
                provider="venice",
                extra=extra,
            )

        if status == "timeout":
            return error_response(
                error=f"Timed out waiting for Venice video after {DEFAULT_TIMEOUT_SECONDS}s",
                error_type="timeout",
                provider="venice",
                model=model_id,
                prompt=prompt,
            )

        message = (
            (body.get("error", {}) or {}).get("message")
            or body.get("message")
            or f"Venice video generation ended with status '{status}'"
        )
        return error_response(
            error=message,
            error_type=f"venice_{status}",
            provider="venice",
            model=model_id,
            prompt=prompt,
        )


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------


def register(ctx: Any) -> None:
    ctx.register_video_gen_provider(VeniceVideoGenProvider())
