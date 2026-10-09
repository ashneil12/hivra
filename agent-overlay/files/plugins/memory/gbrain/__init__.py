"""GBrain memory plugin - MemoryProvider interface.

Shared *organisation* brain memory for Hermes. Unlike per-user providers,
GBrain is a single shared org workspace: every persona on the box talks to
the SAME brain through the SAME bearer token, so facts written by one
persona are recallable by all of them (one-brain-many-personas). We do NOT
scope by per-persona profile - doing so would silo the org brain.

Transport
---------
GBrain is a Bun/TypeScript server exposing a single *stateless* JSON-RPC
MCP endpoint over Streamable-HTTP at ``<GBRAIN_BASE_URL>/mcp``:

  POST <base>/mcp
  Authorization: Bearer <GBRAIN_MCP_TOKEN>
  Accept: application/json, text/event-stream
  Content-Type: application/json
  {"jsonrpc":"2.0","id":<n>,"method":"tools/call",
   "params":{"name":<op>,"arguments":{...}}}

The StreamableHTTP transport may answer with either a plain JSON body or an
SSE frame (``data: {...}``). We handle both. The MCP tool result arrives as
``result.content[0].text`` which is itself a JSON *string* - we json.loads
it to get the structured payload.

Config (env vars):
  GBRAIN_BASE_URL    - server base URL (default: http://127.0.0.1:3131)
  GBRAIN_MCP_TOKEN   - shared org bearer token (required)
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "http://127.0.0.1:3131"


def _tool_error(message: str) -> str:
    """JSON tool-error envelope.

    Mirrors ``tools.registry.tool_error`` but defined locally so importing
    this module never triggers the heavy tools-registry import chain.
    """
    return json.dumps({"error": message})


# ---------------------------------------------------------------------------
# Tool schemas (OpenAI function-calling format)
# ---------------------------------------------------------------------------

SEARCH_SCHEMA = {
    "name": "gbrain_search",
    "description": (
        "Hybrid search across the shared org brain. Returns ranked pages and "
        "facts relevant to the query from long-term organisation memory."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for."},
            "limit": {"type": "integer", "description": "Max results (default: 5)."},
        },
        "required": ["query"],
    },
}

RECALL_SCHEMA = {
    "name": "gbrain_recall",
    "description": (
        "Recall a specific page or hot fact from the shared org brain. Use "
        "for direct lookups (a known slug/topic) rather than fuzzy search."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The slug, topic, or fact to recall."},
            "limit": {"type": "integer", "description": "Max results (default: 5)."},
        },
        "required": ["query"],
    },
}

PUT_PAGE_SCHEMA = {
    "name": "gbrain_put_page",
    "description": (
        "Write or update a fat-markdown page in the shared org brain. Use to "
        "persist a durable fact, decision, or note other personas should see."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "slug": {"type": "string", "description": "Page slug, e.g. 'decisions/pricing'."},
            "body": {"type": "string", "description": "Markdown body to store at the slug."},
        },
        "required": ["slug", "body"],
    },
}


# ---------------------------------------------------------------------------
# JSON-RPC / Streamable-HTTP MCP client
# ---------------------------------------------------------------------------

class _Client:
    """Thin client for GBrain's stateless ``/mcp`` JSON-RPC endpoint."""

    def __init__(self, base_url: str, token: str, timeout: float = 8.0):
        self.base_url = re.sub(r"/+$", "", base_url)
        self.token = token.replace("Bearer ", "").strip()
        self.timeout = timeout
        self._id = 0
        self._id_lock = threading.Lock()

    @property
    def endpoint(self) -> str:
        return f"{self.base_url}/mcp"

    def _next_id(self) -> int:
        with self._id_lock:
            self._id += 1
            return self._id

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "x-sdk-runtime": "hermes-plugin",
        }

    @staticmethod
    def _parse_body(text: str, content_type: str) -> Dict[str, Any]:
        """Parse a StreamableHTTP response that may be plain JSON or SSE.

        SSE frames look like ``event: message\\ndata: {...}\\n\\n``. We pull
        the JSON out of the last ``data:`` line. Plain JSON bodies parse
        directly.
        """
        stripped = (text or "").lstrip()
        is_sse = "text/event-stream" in (content_type or "") or stripped.startswith("data:")
        if is_sse:
            data_payload = None
            for line in (text or "").splitlines():
                line = line.strip()
                if line.startswith("data:"):
                    data_payload = line[len("data:"):].strip()
            if data_payload is None:
                raise RuntimeError("GBrain SSE response had no data frame")
            return json.loads(data_payload)
        return json.loads(text)

    def call(self, name: str, arguments: Dict[str, Any]) -> Any:
        """Invoke an MCP tool and return the parsed result payload.

        The MCP envelope returns ``result.content[0].text`` as a JSON string;
        we json.loads it. Falls back to the raw text if it is not JSON.
        """
        import requests

        rpc = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        resp = requests.post(
            self.endpoint,
            json=rpc,
            headers=self._headers(),
            timeout=self.timeout,
        )
        payload = self._parse_body(resp.text, resp.headers.get("Content-Type", ""))

        if not resp.ok:
            raise RuntimeError(f"GBrain {name} failed ({resp.status_code}): {resp.text}")

        if isinstance(payload, dict) and payload.get("error"):
            err = payload["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            raise RuntimeError(f"GBrain {name} error: {msg}")

        result = payload.get("result") if isinstance(payload, dict) else None
        if not isinstance(result, dict):
            return result

        # MCP content array → first text block (a JSON string)
        content = result.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text" and "text" in block:
                    text = block["text"]
                    try:
                        return json.loads(text)
                    except (ValueError, TypeError):
                        return text
        # Some servers return structuredContent directly
        if "structuredContent" in result:
            return result["structuredContent"]
        return result

    # ── Operations ─────────────────────────────────────────────────────────

    def volunteer_context(self, window: str) -> Any:
        return self.call("volunteer_context", {"window": window})

    def search(self, query: str, limit: int = 5) -> Any:
        return self.call("search", {"query": query, "limit": limit})

    def recall(self, query: str, limit: int = 5) -> Any:
        return self.call("recall", {"query": query, "limit": limit})

    def put_page(self, slug: str, body: str) -> Any:
        return self.call("put_page", {"slug": slug, "body": body})


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

class GBrainProvider(MemoryProvider):
    """Shared org-brain memory provider backed by the GBrain MCP server."""

    def __init__(self) -> None:
        self._client: Optional[_Client] = None
        self._session_id: str = ""
        self._lock = threading.Lock()
        self._prefetch_result: str = ""
        self._prefetch_thread: Optional[threading.Thread] = None

    # ── Core identity ──────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "gbrain"

    def is_available(self) -> bool:
        # Both the endpoint and the shared org bearer token must be set.
        # GBRAIN_BASE_URL has a loopback default, but we still require it to be
        # explicitly present so the operator opts in deliberately.
        return bool(os.environ.get("GBRAIN_BASE_URL")) and bool(os.environ.get("GBRAIN_MCP_TOKEN"))

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "base_url",
                "description": "GBrain server base URL",
                "default": _DEFAULT_BASE_URL,
                "env_var": "GBRAIN_BASE_URL",
            },
            {
                "key": "token",
                "description": "Shared org bearer token for the GBrain MCP endpoint",
                "secret": True,
                "required": True,
                "env_var": "GBRAIN_MCP_TOKEN",
            },
        ]

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def initialize(self, session_id: str, **kwargs) -> None:
        base_url = os.environ.get("GBRAIN_BASE_URL", _DEFAULT_BASE_URL) or _DEFAULT_BASE_URL
        token = os.environ.get("GBRAIN_MCP_TOKEN", "")
        # Single shared org workspace: one bearer token for EVERY persona.
        # Intentionally NOT scoped by profile/agent_identity so the org brain
        # is shared, not siloed per persona.
        self._client = _Client(base_url, token)
        self._session_id = session_id

    def system_prompt_block(self) -> str:
        return (
            "# GBrain Org Memory\n"
            "Active - shared organisation brain (one brain, all personas).\n"
            "Use gbrain_search to find org knowledge, gbrain_recall for direct "
            "lookups, gbrain_put_page to persist durable facts other personas "
            "should see."
        )

    # ── Background prefetch (fires at turn-end, consumed next turn-start) ──

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if not self._client or not query:
            return
        # Don't pile up threads if turns fire faster than prefetches complete.
        if self._prefetch_thread is not None:
            self._prefetch_thread.join(timeout=2.0)
        t = threading.Thread(
            target=self._prefetch_worker,
            args=(query,),
            name="gbrain-prefetch",
            daemon=True,
        )
        self._prefetch_thread = t
        t.start()

    def _prefetch_worker(self, query: str) -> None:
        parts: List[str] = []
        try:
            volunteered = self._client.volunteer_context(query)
            text = self._stringify(volunteered)
            if text:
                parts.append(f"[GBrain Volunteered Context]\n{text}")
        except Exception as exc:
            logger.debug("GBrain volunteer_context failed: %s", exc)
        try:
            results = self._client.search(query, limit=5)
            text = self._stringify(results)
            if text:
                parts.append(f"[GBrain Search]\n{text}")
        except Exception as exc:
            logger.debug("GBrain search prefetch failed: %s", exc)
        with self._lock:
            self._prefetch_result = "\n\n".join(parts)

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        with self._lock:
            result = self._prefetch_result
            self._prefetch_result = ""
        return result

    # ── Turn sync (best-effort, never blocks/raises into the turn) ─────────

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if not self._client or not user_content:
            return
        sid = session_id or self._session_id or "default"
        turn = {
            "user": user_content,
            "assistant": assistant_content,
        }
        threading.Thread(
            target=self._sync_turn_worker,
            args=(sid, turn),
            name="gbrain-sync-turn",
            daemon=True,
        ).start()

    def _sync_turn_worker(self, session_id: str, turn: Dict[str, Any]) -> None:
        try:
            body = json.dumps(turn, ensure_ascii=False, indent=2)
            self._client.put_page(slug=f"sessions/{session_id}", body=body)
        except Exception as exc:
            logger.debug("GBrain sync_turn failed (best-effort): %s", exc)

    # ── Tools ──────────────────────────────────────────────────────────────

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [SEARCH_SCHEMA, RECALL_SCHEMA, PUT_PAGE_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if not self._client:
            return _tool_error("GBrain not initialized")
        try:
            return json.dumps(self._dispatch(tool_name, args))
        except Exception as exc:
            return _tool_error(str(exc))

    def _dispatch(self, tool_name: str, args: Dict[str, Any]) -> Any:
        c = self._client

        if tool_name == "gbrain_search":
            return c.search(args.get("query", ""), int(args.get("limit", 5) or 5))

        if tool_name == "gbrain_recall":
            return c.recall(args.get("query", ""), int(args.get("limit", 5) or 5))

        if tool_name == "gbrain_put_page":
            return c.put_page(args.get("slug", ""), args.get("body", ""))

        raise RuntimeError(f"Unknown GBrain tool: {tool_name}")

    # ── Helpers ─────────────────────────────────────────────────────────────

    @staticmethod
    def _stringify(payload: Any) -> str:
        if payload is None:
            return ""
        if isinstance(payload, str):
            return payload.strip()
        try:
            return json.dumps(payload, ensure_ascii=False).strip()
        except (TypeError, ValueError):
            return str(payload).strip()

    def shutdown(self) -> None:
        if self._prefetch_thread is not None:
            self._prefetch_thread.join(timeout=1.0)


def register(ctx) -> None:
    """Register GBrain as a memory provider plugin."""
    ctx.register_memory_provider(GBrainProvider())
