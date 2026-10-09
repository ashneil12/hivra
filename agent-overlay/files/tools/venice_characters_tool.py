"""Venice characters discovery tool.

Lists / searches Venice's public character personas via ``GET /characters``.

Authentication: ``VENICE_API_KEY`` (the same key used across the rest of the
Venice multi-modal surface). The base URL is overridable via
``VENICE_BASE_URL`` so this works on either Venice direct
(``https://api.venice.ai/api/v1``) or the HermesOS managed-Venice proxy.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

import requests

from tools.registry import registry

logger = logging.getLogger(__name__)

DEFAULT_VENICE_BASE_URL = "https://api.venice.ai/api/v1"


def _resolve_credentials() -> tuple[str, str]:
    api_key = os.environ.get("VENICE_API_KEY", "").strip()
    base_url = (
        os.environ.get("VENICE_BASE_URL", "").strip()
        or DEFAULT_VENICE_BASE_URL
    )
    return api_key, base_url


def check_venice_characters_requirements() -> bool:
    api_key, _ = _resolve_credentials()
    return bool(api_key)


def venice_characters_tool(
    query: Optional[str] = None,
    limit: int = 20,
    include_adult: bool = False,
) -> str:
    """Return Venice character personas, optionally filtered by ``query``.

    Each result includes ``name``, ``slug`` (pass as
    ``venice_parameters.character_slug`` in a Venice chat request to converse
    as/with that character), ``description`` and ``tags``.
    """
    api_key, base_url = _resolve_credentials()
    if not api_key:
        return json.dumps({
            "success": False,
            "error": "VENICE_API_KEY is not set; cannot list Venice characters.",
        })

    try:
        resp = requests.get(
            f"{base_url.rstrip('/')}/characters",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json().get("data", []) or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("venice_characters lookup failed: %s", exc)
        return json.dumps({"success": False, "error": str(exc)})

    q = (query or "").lower().strip()
    try:
        cap = max(1, min(int(limit), 50))
    except (TypeError, ValueError):
        cap = 20

    out: List[Dict[str, Any]] = []
    for c in data:
        if not isinstance(c, dict):
            continue
        if not include_adult and c.get("adult"):
            continue
        if q:
            haystack = " ".join([
                str(c.get("name", "")),
                str(c.get("description", "")),
                " ".join(c.get("tags", []) or []),
            ]).lower()
            if q not in haystack:
                continue
        out.append({
            "name": c.get("name"),
            "slug": c.get("slug"),
            "description": c.get("description"),
            "tags": c.get("tags"),
            "adult": bool(c.get("adult")),
            "shareUrl": c.get("shareUrl"),
        })
        if len(out) >= cap:
            break

    return json.dumps({
        "success": True,
        "count": len(out),
        "characters": out,
        "hint": (
            "To converse as/with a character, pass its slug as "
            "venice_parameters.character_slug in a Venice chat request."
        ),
    })


# Flat {name, description, parameters} body - registry.register wraps this in
# the {"type":"function","function":{...}} envelope itself. Defining it already
# enveloped here double-wrapped the tool, which strict providers (Venice) reject
# with 400 "Extra inputs are not permitted, field tools[N].function.type".
VENICE_CHARACTERS_SCHEMA = {
    "name": "venice_characters",
    "description": (
        "List or search Venice AI character personas (curated roleplay / "
        "assistant personalities). Returns each character's name, slug, "
        "description and tags. Use a character's slug with Venice chat "
        "(venice_parameters.character_slug) to talk as/with it. "
        "Requires VENICE_API_KEY."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Optional search term matched against character name, "
                    "description and tags."
                ),
            },
            "limit": {
                "type": "integer",
                "description": "Maximum characters to return (default 20, max 50).",
            },
            "include_adult": {
                "type": "boolean",
                "description": "Include adult-rated characters (default false).",
            },
        },
        "required": [],
    },
}


registry.register(
    name="venice_characters",
    toolset="memory",
    schema=VENICE_CHARACTERS_SCHEMA,
    handler=lambda args, **kw: venice_characters_tool(**(args or {})),
    check_fn=check_venice_characters_requirements,
    requires_env=["VENICE_API_KEY"],
    is_async=False,
    emoji="\U0001F3AD",
)
