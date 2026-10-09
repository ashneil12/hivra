"""Browser sidecar toolset - deterministic Playwright HTTP primitives.

The browser sidecar (services/browser-sidecar/ in Hermesdeploy) is a Pro-tier-
gated Playwright service the dashboard provisions alongside the agent VM. This
module exposes its 11 HTTP primitives as agent tools so QA agents (Vex) can
drive a persistent Chromium context with cookie/auth state that survives
restarts.

Configuration:
    HERMES_BROWSER_SIDECAR_URL  Base URL of the sidecar HTTP API.
                                Default: http://browser-sidecar:8789
                                (works inside the user's docker-compose where
                                 the agent and sidecar share a network).
    HERMES_BROWSER_SIDECAR_IDENTITY
                                Persistent context identity to bind sessions
                                to. Defaults to "vex" - match the seeded
                                identity created by `hermes-browser seed`.

Failure handling:
    - SESSION_EXPIRED → returns {"error": "SESSION_EXPIRED", "blocked": true}
      The LLM must NOT retry login. Operator must re-seed.
    - Transport failure (sidecar unreachable, e.g. tier downgrade stopped
      the container) → same shape, signals BLOCKED.
    - All other failures bubble through tool_error() with the upstream message.

Session model:
    The sidecar's HTTP surface uses session_id explicitly per call. To keep
    the LLM-facing API simple, this module keeps an implicit session per
    agent process: the first browser tool call auto-starts a session against
    the configured identity; subsequent calls reuse it. Call
    `browser_session_end` to release the page when done.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Dict, Optional

import requests

from tools.registry import registry, tool_error

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_DEFAULT_TIMEOUT = 60  # most primitives are sub-second; 60s covers slow flows
_DEFAULT_IDENTITY = "vex"
_DEFAULT_URL = "http://browser-sidecar:8789"

_session_lock = threading.Lock()
_active_session_id: Optional[str] = None


def _base_url() -> str:
    return os.getenv("HERMES_BROWSER_SIDECAR_URL", _DEFAULT_URL).rstrip("/")


def _identity() -> str:
    return os.getenv("HERMES_BROWSER_SIDECAR_IDENTITY", _DEFAULT_IDENTITY).strip() or _DEFAULT_IDENTITY


def _is_sidecar_available() -> bool:
    """check_fn for toolset gating. True when /health returns 200 and tier_ok."""
    try:
        resp = requests.get(f"{_base_url()}/health", timeout=3)
        if resp.status_code != 200:
            return False
        data = resp.json()
        return bool(data.get("ok") and data.get("tier_ok") is not False)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

def _post(path: str, body: Dict[str, Any], timeout: int = _DEFAULT_TIMEOUT) -> Any:
    """POST JSON to the sidecar. Returns parsed JSON on 2xx, raises RuntimeError otherwise.

    Caller is responsible for converting RuntimeError to tool_error() with
    the right blocking semantics.
    """
    url = f"{_base_url()}{path}"
    try:
        resp = requests.post(url, json=body, timeout=timeout)
    except requests.RequestException as exc:
        # Transport failure - sidecar is unreachable. Treat as BLOCKED, same
        # as SESSION_EXPIRED. This catches the mid-session tier-downgrade case
        # where the reconcile job stopped the container.
        raise RuntimeError("SIDECAR_UNREACHABLE") from exc

    try:
        data = resp.json()
    except ValueError:
        raise RuntimeError(f"sidecar returned non-JSON ({resp.status_code})")

    if resp.status_code >= 200 and resp.status_code < 300:
        return data

    err = (data or {}).get("error") or "INTERNAL"
    msg = (data or {}).get("message") or f"HTTP {resp.status_code}"
    raise RuntimeError(f"{err}:{msg}")


def _ensure_session() -> str:
    """Return the active session_id, starting a new session against the configured
    identity if none exists. Caller holds no lock.
    """
    global _active_session_id
    with _session_lock:
        if _active_session_id:
            return _active_session_id
        body = {"identity": _identity()}
        try:
            data = _post("/session/start", body, timeout=15)
        except RuntimeError as exc:
            # Surface the unreachable case to the caller - they'll wrap it
            # with tool_error(blocked=True).
            raise
        sid = data.get("session_id")
        if not isinstance(sid, str) or not sid:
            raise RuntimeError("INVALID_SESSION_RESPONSE")
        _active_session_id = sid
        return sid


def _format_error(exc: RuntimeError) -> str:
    """Convert a sidecar RuntimeError into a tool_error() with the right
    blocked flag. SESSION_EXPIRED and SIDECAR_UNREACHABLE both signal
    BLOCKED so the agent stops trying.
    """
    raw = str(exc)
    code = raw.split(":", 1)[0]
    if code in ("SESSION_EXPIRED", "SIDECAR_UNREACHABLE"):
        # Reset the cached session so the next agent run can re-init cleanly.
        global _active_session_id
        with _session_lock:
            _active_session_id = None
        return tool_error(code, blocked=True, identity=_identity())
    return tool_error(raw)


def _ok(data: Optional[Dict[str, Any]] = None) -> str:
    body: Dict[str, Any] = {"ok": True}
    if data:
        body.update(data)
    return json.dumps(body)


# ===========================================================================
# Tools
# ===========================================================================

# --- session_start ---------------------------------------------------------

SESSION_START_SCHEMA = {
    "name": "browser_session_start",
    "description": (
        "Start a browser session against the persistent context for this agent's "
        "identity. Returns a session_id. Most callers should NOT call this - the "
        "first navigation/click/etc. auto-starts a session if none exists. Call "
        "this manually only if you want to reset state mid-flow."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "identity": {
                "type": "string",
                "description": (
                    "Override the default identity. Almost always omit this - "
                    "the env-configured identity is the seeded persistent profile."
                ),
            },
        },
        "required": [],
    },
}


def _handle_session_start(args: Dict[str, Any], **_) -> str:
    global _active_session_id
    identity = (args.get("identity") or _identity()).strip()
    body = {"identity": identity}
    try:
        data = _post("/session/start", body, timeout=15)
    except RuntimeError as exc:
        return _format_error(exc)
    sid = data.get("session_id", "")
    if not sid:
        return tool_error("INVALID_SESSION_RESPONSE")
    with _session_lock:
        _active_session_id = sid
    return _ok({"session_id": sid, "identity": identity})


# --- session_end -----------------------------------------------------------

SESSION_END_SCHEMA = {
    "name": "browser_session_end",
    "description": (
        "Close the current browser session. The persistent context (cookies, "
        "auth) survives - only the page is closed. Call when QA work is done "
        "to release the page slot."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}


def _handle_session_end(_args: Dict[str, Any], **_) -> str:
    global _active_session_id
    with _session_lock:
        sid = _active_session_id
    if not sid:
        return _ok({"closed": False, "reason": "no_active_session"})
    try:
        _post("/session/end", {"session_id": sid}, timeout=10)
    except RuntimeError as exc:
        # Best-effort close - don't fail the LLM on a teardown error.
        logger.warning("browser_session_end failed: %s", exc)
    with _session_lock:
        _active_session_id = None
    return _ok({"closed": True})


# --- goto ------------------------------------------------------------------

GOTO_SCHEMA = {
    "name": "browser_goto",
    "description": (
        "Navigate the persistent browser to a URL. Auto-starts a session if "
        "none is active. Returns the resolved current_url and page title."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Absolute URL to navigate to."},
        },
        "required": ["url"],
    },
}


def _handle_goto(args: Dict[str, Any], **_) -> str:
    url = args.get("url", "").strip()
    if not url:
        return tool_error("url is required")
    try:
        sid = _ensure_session()
        data = _post("/goto", {"session_id": sid, "url": url})
    except RuntimeError as exc:
        return _format_error(exc)
    return _ok({"current_url": data.get("current_url"), "title": data.get("title")})


# --- click_text ------------------------------------------------------------

CLICK_TEXT_SCHEMA = {
    "name": "browser_click_text",
    "description": (
        "Click the first element matching the given text. Use nth (0-indexed) "
        "to disambiguate when multiple matches exist."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Text content to click."},
            "nth": {"type": "integer", "minimum": 0, "description": "0-indexed match to click. Optional."},
        },
        "required": ["text"],
    },
}


def _handle_click_text(args: Dict[str, Any], **_) -> str:
    text = args.get("text", "")
    if not text:
        return tool_error("text is required")
    body: Dict[str, Any] = {"session_id": "", "text": text}
    if isinstance(args.get("nth"), int):
        body["nth"] = args["nth"]
    try:
        body["session_id"] = _ensure_session()
        _post("/click_text", body)
    except RuntimeError as exc:
        return _format_error(exc)
    return _ok()


# --- click_selector --------------------------------------------------------

CLICK_SELECTOR_SCHEMA = {
    "name": "browser_click_selector",
    "description": "Click the first element matching a CSS selector.",
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector."},
        },
        "required": ["selector"],
    },
}


def _handle_click_selector(args: Dict[str, Any], **_) -> str:
    selector = args.get("selector", "")
    if not selector:
        return tool_error("selector is required")
    try:
        sid = _ensure_session()
        _post("/click_selector", {"session_id": sid, "selector": selector})
    except RuntimeError as exc:
        return _format_error(exc)
    return _ok()


# --- fill ------------------------------------------------------------------

FILL_SCHEMA = {
    "name": "browser_fill",
    "description": (
        "Fill an input/textarea matched by CSS selector with the provided value. "
        "Do not use this to enter passwords for accounts you don't own - the "
        "sidecar redacts the value field in logs but the value is still sent over "
        "the network."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector for the input."},
            "value": {"type": "string", "description": "Value to type."},
        },
        "required": ["selector", "value"],
    },
}


def _handle_fill(args: Dict[str, Any], **_) -> str:
    selector = args.get("selector", "")
    value = args.get("value", "")
    if not selector:
        return tool_error("selector is required")
    try:
        sid = _ensure_session()
        _post("/fill", {"session_id": sid, "selector": selector, "value": value})
    except RuntimeError as exc:
        return _format_error(exc)
    return _ok()


# --- wait_for --------------------------------------------------------------

WAIT_FOR_SCHEMA = {
    "name": "browser_wait_for",
    "description": (
        "Wait for a CSS selector to be visible. Useful between navigations and "
        "actions when the page is async-rendered. timeout_ms defaults to the "
        "sidecar's configured action timeout."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string"},
            "timeout_ms": {"type": "integer", "minimum": 1, "maximum": 120000},
        },
        "required": ["selector"],
    },
}


def _handle_wait_for(args: Dict[str, Any], **_) -> str:
    selector = args.get("selector", "")
    if not selector:
        return tool_error("selector is required")
    body: Dict[str, Any] = {"session_id": "", "selector": selector}
    if isinstance(args.get("timeout_ms"), int):
        body["timeout_ms"] = args["timeout_ms"]
    try:
        body["session_id"] = _ensure_session()
        _post("/wait_for", body)
    except RuntimeError as exc:
        return _format_error(exc)
    return _ok()


# --- assert_visible --------------------------------------------------------

ASSERT_VISIBLE_SCHEMA = {
    "name": "browser_assert_visible",
    "description": (
        "Check whether an element is visible. Provide either selector or text, "
        "not both. Returns visible: true|false (does not throw on absence)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string"},
            "text": {"type": "string"},
        },
        "required": [],
    },
}


def _handle_assert_visible(args: Dict[str, Any], **_) -> str:
    selector = args.get("selector")
    text = args.get("text")
    if not selector and not text:
        return tool_error("either selector or text is required")
    body: Dict[str, Any] = {"session_id": ""}
    if selector:
        body["selector"] = selector
    elif text:
        body["text"] = text
    try:
        body["session_id"] = _ensure_session()
        data = _post("/assert_visible", body)
    except RuntimeError as exc:
        return _format_error(exc)
    return _ok({"visible": bool(data.get("visible"))})


# --- get_text --------------------------------------------------------------

GET_TEXT_SCHEMA = {
    "name": "browser_get_text",
    "description": "Read the visible inner text of the first element matching a CSS selector.",
    "parameters": {
        "type": "object",
        "properties": {"selector": {"type": "string"}},
        "required": ["selector"],
    },
}


def _handle_get_text(args: Dict[str, Any], **_) -> str:
    selector = args.get("selector", "")
    if not selector:
        return tool_error("selector is required")
    try:
        sid = _ensure_session()
        data = _post("/get_text", {"session_id": sid, "selector": selector})
    except RuntimeError as exc:
        return _format_error(exc)
    return _ok({"text": data.get("text", "")})


# --- screenshot ------------------------------------------------------------

SCREENSHOT_SCHEMA = {
    "name": "browser_screenshot",
    "description": (
        "Take a screenshot. Returns the saved file path on the sidecar. Set "
        "base64=true to also return the image bytes inline (large; use only "
        "when explicitly needed for vision analysis). Set full_page=true to "
        "capture the entire scrollable page rather than just the viewport."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "full_page": {"type": "boolean", "default": False},
            "base64": {"type": "boolean", "default": False},
        },
        "required": [],
    },
}


def _handle_screenshot(args: Dict[str, Any], **_) -> str:
    body: Dict[str, Any] = {"session_id": ""}
    if args.get("full_page") is True:
        body["full_page"] = True
    if args.get("base64") is True:
        body["base64"] = True
    try:
        body["session_id"] = _ensure_session()
        data = _post("/screenshot", body)
    except RuntimeError as exc:
        return _format_error(exc)
    out: Dict[str, Any] = {"path": data.get("path")}
    if "base64" in data:
        out["base64"] = data["base64"]
    return _ok(out)


# --- run_named_flow --------------------------------------------------------

RUN_NAMED_FLOW_SCHEMA = {
    "name": "browser_run_named_flow",
    "description": (
        "Execute a pre-defined YAML flow on the sidecar. Use this for complex "
        "multi-step actions like login_clerk (idempotent - returns immediately "
        "if already authed) or logout (wipes the persistent context). Custom "
        "flows live at /var/lib/hermes-browser/flows/<flow_id>.yaml on the "
        "sidecar volume."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "flow_id": {"type": "string", "description": "Filename stem of the flow."},
            "args": {
                "type": "object",
                "description": "Optional ${args:KEY} interpolation values for the flow.",
                "additionalProperties": True,
            },
        },
        "required": ["flow_id"],
    },
}


def _handle_run_named_flow(args: Dict[str, Any], **_) -> str:
    flow_id = args.get("flow_id", "")
    if not flow_id:
        return tool_error("flow_id is required")
    body: Dict[str, Any] = {"session_id": "", "flow_id": flow_id}
    flow_args = args.get("args")
    if isinstance(flow_args, dict):
        body["args"] = flow_args
    try:
        body["session_id"] = _ensure_session()
        data = _post("/run_named_flow", body, timeout=180)
    except RuntimeError as exc:
        return _format_error(exc)
    return _ok({"output": data.get("output", {})})


# ===========================================================================
# Registration
# ===========================================================================
#
# Toolset: the sidecar primitives register under upstream's own ``browser`` toolset rather than a
# private ``browser_sidecar`` one. Upstream only default-enables toolsets it knows statically
# (``CONFIGURABLE_TOOLSETS``) or that a plugin registered, so a registry-only toolset would never
# appear on a default box and the fork would need edits to toolsets.py / tools_config.py. Under
# ``browser`` they follow the browser toolset's enablement, and each tool's check_fn still hides
# them unless the provisioned sidecar's /health answers (inert on boxes without the sidecar).
SIDECAR_TOOLSET = "browser"

# Each registry.register(...) below is a top-level ast.Expr statement (NOT
# inside a for-loop or function call). This matters because the agent's
# tools/registry.py:_module_registers_tools() uses AST analysis to detect
# whether a module registers tools, and only matches statements of shape
# `Expr(Call(Attribute(Name("registry"), "register"), ...))` at module body
# level. A for-loop wrapping these calls would be ast.For - discovery would
# skip the module silently and the toolset would never appear in the schema.
# Keep these as explicit top-level calls.

registry.register(
    name="browser_session_start",
    toolset=SIDECAR_TOOLSET,
    schema=SESSION_START_SCHEMA,
    handler=_handle_session_start,
    check_fn=_is_sidecar_available,
    emoji="🪪",
)

registry.register(
    name="browser_session_end",
    toolset=SIDECAR_TOOLSET,
    schema=SESSION_END_SCHEMA,
    handler=_handle_session_end,
    check_fn=_is_sidecar_available,
    emoji="🚪",
)

registry.register(
    name="browser_goto",
    toolset=SIDECAR_TOOLSET,
    schema=GOTO_SCHEMA,
    handler=_handle_goto,
    check_fn=_is_sidecar_available,
    emoji="🌐",
)

registry.register(
    name="browser_click_text",
    toolset=SIDECAR_TOOLSET,
    schema=CLICK_TEXT_SCHEMA,
    handler=_handle_click_text,
    check_fn=_is_sidecar_available,
    emoji="🖱️",
)

registry.register(
    name="browser_click_selector",
    toolset=SIDECAR_TOOLSET,
    schema=CLICK_SELECTOR_SCHEMA,
    handler=_handle_click_selector,
    check_fn=_is_sidecar_available,
    emoji="🖱️",
)

registry.register(
    name="browser_fill",
    toolset=SIDECAR_TOOLSET,
    schema=FILL_SCHEMA,
    handler=_handle_fill,
    check_fn=_is_sidecar_available,
    emoji="⌨️",
)

registry.register(
    name="browser_wait_for",
    toolset=SIDECAR_TOOLSET,
    schema=WAIT_FOR_SCHEMA,
    handler=_handle_wait_for,
    check_fn=_is_sidecar_available,
    emoji="⏳",
)

registry.register(
    name="browser_assert_visible",
    toolset=SIDECAR_TOOLSET,
    schema=ASSERT_VISIBLE_SCHEMA,
    handler=_handle_assert_visible,
    check_fn=_is_sidecar_available,
    emoji="👁️",
)

registry.register(
    name="browser_get_text",
    toolset=SIDECAR_TOOLSET,
    schema=GET_TEXT_SCHEMA,
    handler=_handle_get_text,
    check_fn=_is_sidecar_available,
    emoji="📄",
)

registry.register(
    name="browser_screenshot",
    toolset=SIDECAR_TOOLSET,
    schema=SCREENSHOT_SCHEMA,
    handler=_handle_screenshot,
    check_fn=_is_sidecar_available,
    emoji="📸",
)

registry.register(
    name="browser_run_named_flow",
    toolset=SIDECAR_TOOLSET,
    schema=RUN_NAMED_FLOW_SCHEMA,
    handler=_handle_run_named_flow,
    check_fn=_is_sidecar_available,
    emoji="🎬",
)
