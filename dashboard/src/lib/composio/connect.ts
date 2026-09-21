import "server-only";

// src/lib/composio/connect.ts
//
// Server-side Composio helpers for the BYO model. Each user pastes their OWN
// Composio MCP consumer key — the `X-CONSUMER-API-KEY` (ck_…) from Composio's
// Install page → MCP card. That key + Composio's hosted Tool Router endpoint IS
// the entire integration: one MCP server that lets the agent search 500+ apps'
// tools, connect accounts on demand (hosted OAuth, in-chat), and execute them.
//
// So there is NO SDK, no project API key, no auth-configs, no session minting —
// we validate the key against the Tool Router and hand back ONE static
// mcp_servers entry to write into the box. Deterministic (same key → same entry),
// so writes are idempotent.

import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/crypto";
import {
  COMPOSIO_PROVIDER,
  COMPOSIO_TOOL_ROUTER_URL,
  COMPOSIO_CONSUMER_KEY_HEADER,
  COMPOSIO_SURFACED_SLUGS,
  isComposioConnectFlagOn,
} from "@/lib/composio/config";
import {
  extractComposioRedirectUrl,
  parseComposioToolResult,
  type ComposioMcpServerEntry,
} from "@/lib/composio/mcp-server";

/** Read + decrypt the caller's stored Composio consumer key. Null when absent/off. */
export async function getUserComposioKey(userId: string | null | undefined): Promise<string | null> {
  if (!isComposioConnectFlagOn()) return null;
  if (!supabaseAdmin) return null;
  const id = userId?.trim();
  if (!id) return null;
  const { data, error } = await supabaseAdmin
    .from("user_api_keys")
    .select("encrypted_key")
    .eq("user_id", id)
    .eq("provider", COMPOSIO_PROVIDER)
    .maybeSingle();
  if (error || !data?.encrypted_key) return null;
  try {
    return decryptApiKey(data.encrypted_key);
  } catch {
    return null;
  }
}

/**
 * The box-config MCP entry for a user's Composio Tool Router: the hosted endpoint
 * + their consumer key in the auth header. Deterministic and side-effect-free —
 * there is no session to mint, so re-deriving/re-writing it is a pure no-op when
 * the key is unchanged.
 */
export function buildComposioMcpServerEntry(apiKey: string): ComposioMcpServerEntry {
  return {
    url: COMPOSIO_TOOL_ROUTER_URL,
    headers: { [COMPOSIO_CONSUMER_KEY_HEADER]: apiKey },
  };
}

export type ComposioKeyCheck =
  | { ok: true }
  | { ok: false; reason: "invalid" | "error"; message: string };

/**
 * Validate a pasted Composio consumer key by asking the Tool Router to list its
 * tools — a cheap, read-only MCP call against the EXACT endpoint the box will use,
 * so a key that validates here is guaranteed to work for the agent. 200 with a
 * tools payload → valid; 401/403 → rejected; anything else → transient error.
 */
export async function validateComposioKey(apiKey: string): Promise<ComposioKeyCheck> {
  const key = apiKey?.trim();
  if (!key) return { ok: false, reason: "invalid", message: "No key provided." };
  const rejected = {
    ok: false as const,
    reason: "invalid" as const,
    message:
      "That Composio key was rejected. Copy the X-CONSUMER-API-KEY (starts with ck_) from your Composio Install page → MCP card.",
  };
  try {
    const res = await fetch(COMPOSIO_TOOL_ROUTER_URL, {
      method: "POST",
      headers: {
        [COMPOSIO_CONSUMER_KEY_HEADER]: key,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      cache: "no-store",
    });
    if (res.ok) {
      // The Tool Router streams an SSE `data: {...}` frame; confirm it's a real
      // tools/list result (not an HTML/error 200) before accepting the key.
      const text = (await res.text().catch(() => "")) || "";
      if (/"tools"\s*:/.test(text) || /COMPOSIO_/.test(text)) return { ok: true };
      return rejected;
    }
    if (res.status === 401 || res.status === 403) return rejected;
    return { ok: false, reason: "error", message: "Couldn't reach Composio to verify that key. Try again." };
  } catch {
    return { ok: false, reason: "error", message: "Couldn't reach Composio to verify that key. Try again." };
  }
}

export type ComposioConnectResult =
  | { ok: true; redirectUrl: string }
  | { ok: false; message: string };

/**
 * Initiate a hosted-OAuth connection for a toolkit via the Tool Router
 * (COMPOSIO_MANAGE_CONNECTIONS, action "add") using the user's consumer key, and
 * return the login link to open. No SDK / project key — the SAME endpoint the box
 * uses, so the connection lands on the same consumer the agent's Tool Router
 * reads. Powers the dashboard's one-tap connect tiles (no "ask the agent" hop).
 */
export async function initiateComposioConnection(
  userId: string,
  toolkitSlug: string,
): Promise<ComposioConnectResult> {
  const key = await getUserComposioKey(userId);
  if (!key) return { ok: false, message: "No Composio key on file." };
  const slug = toolkitSlug.trim().toLowerCase();
  try {
    const res = await fetch(COMPOSIO_TOOL_ROUTER_URL, {
      method: "POST",
      headers: {
        [COMPOSIO_CONSUMER_KEY_HEADER]: key,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "COMPOSIO_MANAGE_CONNECTIONS",
          arguments: { toolkits: [{ name: slug, action: "add" }] },
        },
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        ok: false,
        message: res.status === 401 ? "Your Composio key was rejected." : "Couldn't reach Composio.",
      };
    }
    // The Tool Router returns the login link as `redirect_url` inside a JSON
    // tool-result payload streamed as an SSE `data:` frame — nested JSON, so the
    // quotes are backslash-escaped in the raw body. extractComposioRedirectUrl
    // handles that (and a bare-URL fallback).
    const text = (await res.text().catch(() => "")) || "";
    const link = extractComposioRedirectUrl(text);
    if (link) return { ok: true, redirectUrl: link };
    return {
      ok: false,
      message: "Composio didn't return a login link for that app — check the app name.",
    };
  } catch {
    return { ok: false, message: "Couldn't reach Composio to start that connection." };
  }
}

/**
 * The toolkit slugs the user has an ACTIVE connection for — drives the
 * "Connected" state on the tiles/picker. Asks the Tool Router's
 * COMPOSIO_MANAGE_CONNECTIONS (action "list") for a batch of slugs in one call:
 * the surfaced set by default, or an explicit `slugs` batch (the app picker's
 * currently-visible page). Only ever pass CATALOG-KNOWN slugs — action:list does
 * NOT validate slugs (a fake slug looks "initiated"), and we only trust
 * status === "active". Returns null on any non-authoritative failure (so the UI
 * keeps its last state rather than flashing everything to "not connected").
 */
export async function listComposioConnectedApps(
  userId: string,
  slugs?: readonly string[],
): Promise<string[] | null> {
  const key = await getUserComposioKey(userId);
  if (!key) return null;
  const query =
    slugs && slugs.length
      ? Array.from(new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean)))
      : COMPOSIO_SURFACED_SLUGS;
  if (!query.length) return [];
  try {
    const res = await fetch(COMPOSIO_TOOL_ROUTER_URL, {
      method: "POST",
      headers: {
        [COMPOSIO_CONSUMER_KEY_HEADER]: key,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "COMPOSIO_MANAGE_CONNECTIONS",
          arguments: {
            toolkits: query.map((name) => ({ name, action: "list" })),
          },
        },
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const parsed = parseComposioToolResult((await res.text().catch(() => "")) || "");
    const results = (parsed as { data?: { results?: Record<string, unknown> }; results?: Record<string, unknown> })
      ?.data?.results
      ?? (parsed as { results?: Record<string, unknown> })?.results;
    if (!results || typeof results !== "object") return null;
    const active: string[] = [];
    for (const [slug, info] of Object.entries(results)) {
      if ((info as { status?: unknown })?.status === "active") active.push(slug.toLowerCase());
    }
    return active;
  } catch {
    return null;
  }
}
