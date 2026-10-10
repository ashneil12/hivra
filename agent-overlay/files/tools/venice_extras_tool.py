"""Extra Venice-backed tools: image styles, document/text parser, voice cloning,
YouTube transcription, and music/video cost quotes.

All authenticate with ``VENICE_API_KEY`` (same key as chat/image/video/audio).
Base URL is overridable via ``VENICE_BASE_URL``. Endpoints mirror the official
Venice API (see github.com/veniceai/venice-mcp-server for the spec).
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

from tools.registry import registry

logger = logging.getLogger(__name__)

DEFAULT_VENICE_BASE_URL = "https://api.venice.ai/api/v1"
_HTTP_TIMEOUT = 60


def _creds() -> tuple[str, str]:
    key = os.environ.get("VENICE_API_KEY", "").strip()
    base = (os.environ.get("VENICE_BASE_URL", "").strip() or DEFAULT_VENICE_BASE_URL).rstrip("/")
    return key, base


def _need_key() -> Optional[str]:
    key, _ = _creds()
    if not key:
        return json.dumps({
            "success": False,
            "error": "VENICE_API_KEY not set. Configure Venice in `hermes model` first.",
            "error_type": "missing_api_key",
        })
    return None


def check_venice_requirements() -> bool:
    key, _ = _creds()
    return bool(key)


def _headers(extra: Optional[dict] = None) -> dict:
    key, _ = _creds()
    h = {"Authorization": f"Bearer {key}", "User-Agent": "hermes-agent/venice-extras"}
    if extra:
        h.update(extra)
    return h


# --------------------------------------------------------------------------- #
# image styles
# --------------------------------------------------------------------------- #
def image_styles_tool() -> str:
    """List the image style presets available for image_generate (style_preset)."""
    err = _need_key()
    if err:
        return err
    _, base = _creds()
    try:
        import requests

        resp = requests.get(f"{base}/image/styles", headers=_headers(), timeout=30)
        resp.raise_for_status()
        data = resp.json()
        styles = data.get("data") if isinstance(data, dict) else data
        return json.dumps({"success": True, "styles": styles})
    except Exception as exc:  # noqa: BLE001
        logger.debug("image styles failed", exc_info=True)
        return json.dumps({"success": False, "error": f"Venice image styles failed: {exc}", "error_type": "api_error"})


# --------------------------------------------------------------------------- #
# document / text parser (PDF / DOCX / EPUB / PPTX / XLSX / …)
# --------------------------------------------------------------------------- #
def text_parser_tool(url: str) -> str:
    """Extract plain text from a document at *url* (PDF, DOCX, EPUB, PPTX, XLSX…)."""
    err = _need_key()
    if err:
        return err
    if not isinstance(url, str) or not url.strip():
        return json.dumps({"success": False, "error": "url is required", "error_type": "missing_url"})
    _, base = _creds()
    try:
        import requests

        src = requests.get(url.strip(), timeout=_HTTP_TIMEOUT)
        src.raise_for_status()
        filename = url.strip().rstrip("/").split("/")[-1] or "document"
        ctype = src.headers.get("content-type", "application/octet-stream").split(";")[0]
        files = {"file": (filename, src.content, ctype)}
        resp = requests.post(f"{base}/augment/text-parser", headers=_headers(), files=files, timeout=_HTTP_TIMEOUT)
        resp.raise_for_status()
        body = resp.json()
        text = body.get("text") if isinstance(body, dict) else None
        return json.dumps({"success": True, "text": text if text is not None else body, "source": url.strip()})
    except Exception as exc:  # noqa: BLE001
        logger.debug("text parser failed", exc_info=True)
        return json.dumps({"success": False, "error": f"Venice text parser failed: {exc}", "error_type": "api_error"})


# --------------------------------------------------------------------------- #
# voice cloning / voice catalog
# --------------------------------------------------------------------------- #
_VOICE_CATALOG = {
    "note": "Built-in voices across Venice TTS models. Cloned voices return as vv_<id> from action=create.",
    "kokoro (default, multilingual)": [
        "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
        "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
        "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck",
    ],
    "orpheus (expressive, emotion tags)": ["leah", "jess", "mia", "zoe", "leo", "dan", "zac", "tara"],
    "other_models": [
        "tts-qwen3-0-6b", "tts-qwen3-1-7b", "tts-xai-v1", "tts-inworld-1-5-max",
        "tts-chatterbox-hd", "tts-elevenlabs-turbo-v2-5", "tts-minimax-speech-02-hd",
    ],
    "voice_cloning_models": ["tts-chatterbox-hd", "tts-minimax-speech-02-hd"],
}


def voice_clone_tool(action: str = "list", sample_url: Optional[str] = None, model: Optional[str] = None) -> str:
    """List built-in TTS voices (action='list') or clone a voice from a sample
    audio URL (action='create', requires sample_url + a cloning model)."""
    action = (action or "list").strip().lower()
    if action == "list":
        return json.dumps({"success": True, "voices": _VOICE_CATALOG})
    err = _need_key()
    if err:
        return err
    if action != "create":
        return json.dumps({"success": False, "error": "action must be 'list' or 'create'", "error_type": "bad_action"})
    if not sample_url or not str(sample_url).strip():
        return json.dumps({"success": False, "error": "sample_url is required for action='create'", "error_type": "missing_sample"})
    _, base = _creds()
    try:
        import requests

        src = requests.get(str(sample_url).strip(), timeout=_HTTP_TIMEOUT)
        src.raise_for_status()
        ctype = src.headers.get("content-type", "audio/mpeg").split(";")[0]
        files = {"file": ("sample", src.content, ctype)}
        data = {"model": model} if (model and str(model).strip()) else {}
        resp = requests.post(f"{base}/audio/voices", headers=_headers(), files=files, data=data, timeout=_HTTP_TIMEOUT)
        resp.raise_for_status()
        return json.dumps({"success": True, "voice": resp.json()})
    except Exception as exc:  # noqa: BLE001
        logger.debug("voice clone failed", exc_info=True)
        return json.dumps({"success": False, "error": f"Venice voice clone failed: {exc}", "error_type": "api_error"})


# --------------------------------------------------------------------------- #
# YouTube / video transcription
# --------------------------------------------------------------------------- #
def video_transcribe_tool(url: str, response_format: Optional[str] = None) -> str:
    """Transcribe a YouTube video by URL (Venice fetches + transcribes it)."""
    err = _need_key()
    if err:
        return err
    if not isinstance(url, str) or not url.strip():
        return json.dumps({"success": False, "error": "url is required (a YouTube URL)", "error_type": "missing_url"})
    _, base = _creds()
    payload: Dict[str, Any] = {"url": url.strip()}
    if response_format and str(response_format).strip():
        payload["response_format"] = str(response_format).strip()
    try:
        import requests

        resp = requests.post(
            f"{base}/video/transcriptions",
            headers=_headers({"Content-Type": "application/json"}),
            json=payload,
            timeout=180,
        )
        resp.raise_for_status()
        body = resp.json() if "application/json" in resp.headers.get("content-type", "") else {"text": resp.text}
        transcript = (body.get("transcript") or body.get("text")) if isinstance(body, dict) else None
        return json.dumps({"success": True, "transcript": transcript if transcript is not None else body,
                           "lang": body.get("lang") if isinstance(body, dict) else None})
    except Exception as exc:  # noqa: BLE001
        logger.debug("video transcribe failed", exc_info=True)
        return json.dumps({"success": False, "error": f"Venice video transcription failed: {exc}", "error_type": "api_error"})


# --------------------------------------------------------------------------- #
# cost quotes (music / video) - preview price before generating
# --------------------------------------------------------------------------- #
def audio_quote_tool(model: str, duration_seconds: Optional[int] = None, character_count: Optional[int] = None) -> str:
    """Get a price quote for a music/audio generation BEFORE queuing it."""
    err = _need_key()
    if err:
        return err
    if not model or not str(model).strip():
        return json.dumps({"success": False, "error": "model is required (e.g. elevenlabs-music)", "error_type": "missing_model"})
    _, base = _creds()
    payload: Dict[str, Any] = {"model": str(model).strip()}
    if isinstance(duration_seconds, int):
        payload["duration_seconds"] = duration_seconds
    if isinstance(character_count, int):
        payload["character_count"] = character_count
    try:
        import requests

        resp = requests.post(f"{base}/audio/quote", headers=_headers({"Content-Type": "application/json"}), json=payload, timeout=30)
        resp.raise_for_status()
        return json.dumps({"success": True, "quote": resp.json()})
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": f"Venice audio quote failed: {exc}", "error_type": "api_error"})


def video_quote_tool(model: str, duration: Optional[str] = None) -> str:
    """Get a price quote for a video generation BEFORE queuing it."""
    err = _need_key()
    if err:
        return err
    if not model or not str(model).strip():
        return json.dumps({"success": False, "error": "model is required (e.g. veo3.1-fast-text-to-video)", "error_type": "missing_model"})
    _, base = _creds()
    payload: Dict[str, Any] = {"model": str(model).strip()}
    if duration and str(duration).strip():
        payload["duration"] = str(duration).strip()
    try:
        import requests

        resp = requests.post(f"{base}/video/quote", headers=_headers({"Content-Type": "application/json"}), json=payload, timeout=30)
        resp.raise_for_status()
        return json.dumps({"success": True, "quote": resp.json()})
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"success": False, "error": f"Venice video quote failed: {exc}", "error_type": "api_error"})


# --------------------------------------------------------------------------- #
# crypto RPC - read-only on-chain awareness (EVM + others) via Venice
# --------------------------------------------------------------------------- #
# State-changing / signing methods are blocked outright: this tool is
# read-only by design. Signing a transaction needs a wallet + private key the
# agent must never hold, so "send" ships as its own follow-on once a signing
# layer exists. Until then we expose reads (balances, blocks, logs, eth_call).
_BLOCKED_RPC_METHODS = {
    "eth_sendtransaction", "eth_sendrawtransaction",
    "eth_sign", "eth_signtransaction", "eth_signtypeddata", "eth_signtypeddata_v4",
    "personal_sendtransaction", "personal_sign", "personal_unlockaccount",
    "personal_importrawkey", "personal_newaccount",
}


def crypto_rpc_tool(
    network: Optional[str] = None,
    method: Optional[str] = None,
    params: Optional[list] = None,
) -> str:
    """Read on-chain data via Venice's JSON-RPC proxy.

    ``network='list'`` enumerates supported networks; otherwise calls *method*
    (a read-only JSON-RPC method) on *network* with optional *params*.
    """
    err = _need_key()
    if err:
        return err
    _, base = _creds()
    net = (network or "").strip()
    try:
        import requests

        if not net or net.lower() in ("list", "networks"):
            resp = requests.get(f"{base}/crypto/rpc/networks", headers=_headers(), timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict):
                nets = data.get("networks") or data.get("data")
            else:
                nets = data
            return json.dumps({"success": True, "networks": nets})

        if not method or not str(method).strip():
            return json.dumps({
                "success": False,
                "error": "method is required (e.g. eth_blockNumber). Use network='list' to see supported networks.",
                "error_type": "missing_method",
            })
        m = str(method).strip()
        if m.lower() in _BLOCKED_RPC_METHODS:
            return json.dumps({
                "success": False,
                "error": (
                    f"'{m}' changes state / needs a signature and is disabled. This tool is "
                    "read-only (no wallet, no signing). Use read methods like eth_blockNumber, "
                    "eth_getBalance, eth_call, eth_getTransactionReceipt, eth_getLogs."
                ),
                "error_type": "write_method_blocked",
            })
        payload: Dict[str, Any] = {
            "jsonrpc": "2.0",
            "method": m,
            "params": params if isinstance(params, list) else [],
            "id": 1,
        }
        resp = requests.post(
            f"{base}/crypto/rpc/{net}",
            headers=_headers({"Content-Type": "application/json"}),
            json=payload,
            timeout=_HTTP_TIMEOUT,
        )
        resp.raise_for_status()
        return json.dumps({"success": True, "network": net, "result": resp.json()})
    except Exception as exc:  # noqa: BLE001
        logger.debug("crypto rpc failed", exc_info=True)
        return json.dumps({"success": False, "error": f"Venice crypto RPC failed: {exc}", "error_type": "api_error"})


# --------------------------------------------------------------------------- #
# registrations
# --------------------------------------------------------------------------- #
registry.register(
    name="image_styles",
    toolset="image_gen",
    schema={
        "name": "image_styles",
        "description": "List the art-style presets available for image_generate (pass one as style_preset). Use before generating if the user wants a specific look.",
        "parameters": {"type": "object", "properties": {}},
    },
    handler=lambda args, **kw: image_styles_tool(),
    check_fn=check_venice_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="🎨",
)

registry.register(
    name="text_parser",
    toolset="web",
    schema={
        "name": "text_parser",
        "description": "Extract the full plain text from a document at a URL - PDF, DOCX, EPUB, PPTX, XLSX, etc. Use this to read documents (not HTML pages; for web pages use web_extract).",
        "parameters": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "URL of the document (PDF/DOCX/EPUB/PPTX/XLSX)."}},
            "required": ["url"],
        },
    },
    handler=lambda args, **kw: text_parser_tool(args.get("url")),
    check_fn=check_venice_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="📄",
)

registry.register(
    name="video_transcribe",
    toolset="web",
    schema={
        "name": "video_transcribe",
        "description": "Transcribe a YouTube video from its URL (returns the spoken transcript). Use to summarize or quote a YouTube video.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "YouTube URL, e.g. https://www.youtube.com/watch?v=..."},
                "response_format": {"type": "string", "description": "json or text (optional)."},
            },
            "required": ["url"],
        },
    },
    handler=lambda args, **kw: video_transcribe_tool(args.get("url"), args.get("response_format")),
    check_fn=check_venice_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="📺",
)

registry.register(
    name="voice_clone",
    toolset="tts",
    schema={
        "name": "voice_clone",
        "description": "List Venice TTS voices (action='list') or clone a custom voice from a sample audio URL (action='create', needs sample_url + a cloning model like tts-chatterbox-hd). The cloned voice id (vv_...) can then be used as the tts voice.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "create"], "description": "list = show voices, create = clone from sample_url."},
                "sample_url": {"type": "string", "description": "Audio sample URL (WAV/MP3/M4A) for action=create."},
                "model": {"type": "string", "description": "Cloning model for action=create (tts-chatterbox-hd or tts-minimax-speech-02-hd)."},
            },
            "required": ["action"],
        },
    },
    handler=lambda args, **kw: voice_clone_tool(args.get("action", "list"), args.get("sample_url"), args.get("model")),
    check_fn=check_venice_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="🗣️",
)

registry.register(
    name="audio_quote",
    toolset="video_gen",
    schema={
        "name": "audio_quote",
        "description": "Get a price quote for a music/audio generation BEFORE running audio_generate. Useful for budgeting.",
        "parameters": {
            "type": "object",
            "properties": {
                "model": {"type": "string", "description": "Music model id, e.g. elevenlabs-music."},
                "duration_seconds": {"type": "integer", "description": "Length in seconds (1-300)."},
                "character_count": {"type": "integer", "description": "For character-priced models."},
            },
            "required": ["model"],
        },
    },
    handler=lambda args, **kw: audio_quote_tool(args.get("model"), args.get("duration_seconds"), args.get("character_count")),
    check_fn=check_venice_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="💵",
)

registry.register(
    name="video_quote",
    toolset="video_gen",
    schema={
        "name": "video_quote",
        "description": "Get a price quote for a video generation BEFORE running video_generate. Useful for budgeting.",
        "parameters": {
            "type": "object",
            "properties": {
                "model": {"type": "string", "description": "Video model id, e.g. veo3.1-fast-text-to-video."},
                "duration": {"type": "string", "description": "Duration string e.g. '4s', '6s', '8s' (model-specific)."},
            },
            "required": ["model"],
        },
    },
    handler=lambda args, **kw: video_quote_tool(args.get("model"), args.get("duration")),
    check_fn=check_venice_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="💵",
)

registry.register(
    name="crypto_rpc",
    toolset="web",  # no private "crypto" toolset: only upstream-known toolsets are default-enabled (see tools/browser_sidecar.py)
    schema={
        "name": "crypto_rpc",
        "description": (
            "Read on-chain data via Venice's crypto JSON-RPC proxy (EVM chains + more). "
            "Pass network='list' FIRST to enumerate supported networks. Network ids are "
            "full names like 'ethereum-mainnet', 'base-mainnet', 'arbitrum-mainnet', "
            "'polygon-mainnet', 'optimism-mainnet'. Then pass network + a READ-only "
            "JSON-RPC method (eth_blockNumber, eth_getBalance, eth_call, "
            "eth_getTransactionReceipt, eth_getLogs, eth_gasPrice, …) and optional params. "
            "Read-only by design: signing/sending transactions is disabled (no wallet)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "network": {"type": "string", "description": "Full network id (e.g. ethereum-mainnet, base-mainnet, arbitrum-mainnet). Use 'list' to enumerate supported networks first."},
                "method": {"type": "string", "description": "Read-only JSON-RPC method, e.g. eth_blockNumber, eth_getBalance, eth_call."},
                "params": {"type": "array", "description": "JSON-RPC params array (method-specific). Optional.", "items": {}},
            },
            "required": ["network"],
        },
    },
    handler=lambda args, **kw: crypto_rpc_tool(args.get("network"), args.get("method"), args.get("params")),
    check_fn=check_venice_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="⛓️",
)
