// src/lib/composio/mcp-server.ts
//
// SDK-FREE helpers + types for the SINGLE `mcp_servers.composio` entry written
// into a box's ~/.hermes/config.yaml. Kept free of @composio/core so config-write
// code (and its tests) never pull the SDK. The SDK-using session builder
// (buildComposioMcpServerEntry) lives in connect.ts.
//
// Composio is ONE multi-toolkit Tool Router session per user
// (composio.sessions.create(userId, { mcp: true }) → session.mcp = { url, headers,
// type }) routing to ALL connected apps dynamically — a newly-connected app needs
// NO regeneration or gateway restart.

import { COMPOSIO_MCP_SERVER_NAME } from "@/lib/composio/config";

export { COMPOSIO_MCP_SERVER_NAME };

/** Live dashboard apex fallback (mirrors the managed-Venice proxy pattern). */
const DEFAULT_APP_URL = "https://hivra.cloud";

/**
 * Read NEXT_PUBLIC_APP_URL through a COMPUTED key so Next does NOT build-inline
 * it — the callback origin must track the LIVE apex on every request.
 */
function runtimeAppUrl(): string | undefined {
  const key = "NEXT_PUBLIC_APP_URL";
  return process.env[key];
}

/** Origin (no trailing slash) for building post-connect callback URLs. */
export function getDashboardOrigin(appUrl: string | undefined = runtimeAppUrl()): string {
  return (appUrl?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
}

/** True for the single entry WE manage in a box's mcp_servers. */
export function isComposioManagedServerName(name: string): boolean {
  return name === COMPOSIO_MCP_SERVER_NAME;
}

export interface ComposioMcpServerEntry {
  url: string;
  headers: Record<string, string>;
}

/** Read the box's current managed `composio` entry from a config object. */
export function readCurrentComposioEntry(
  config: Record<string, unknown>,
): ComposioMcpServerEntry | null {
  const servers = config?.mcp_servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  const entry = (servers as Record<string, unknown>)[COMPOSIO_MCP_SERVER_NAME];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const { url, headers } = entry as { url?: unknown; headers?: unknown };
  if (typeof url !== "string" || !url) return null;
  const h: Record<string, string> = {};
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof v === "string") h[k] = v;
    }
  }
  return { url, headers: h };
}

/**
 * Pull the hosted-OAuth login link out of a COMPOSIO_MANAGE_CONNECTIONS tool
 * result. The link sits inside a JSON-string-in-JSON payload streamed as an SSE
 * frame, so the quotes around `redirect_url` are BACKSLASH-ESCAPED in the raw
 * body (`\"redirect_url\":\"https://…\"`). Match tolerantly (optional backslashes),
 * then fall back to the bare hosted-connect URL, which appears unescaped.
 */
export function extractComposioRedirectUrl(rawBody: string): string | null {
  if (!rawBody) return null;
  const escaped = rawBody.match(/redirect_url\\?"\s*:\s*\\?"(https?:\/\/[^"\\\s]+)/);
  if (escaped?.[1]) return escaped[1];
  const bare = rawBody.match(/https?:\/\/connect\.composio\.dev\/link\/lk_[A-Za-z0-9]+/);
  return bare ? bare[0] : null;
}

/**
 * Parse a Composio MCP `tools/call` response body into the tool's JSON result.
 * The result is a JSON string nested inside `result.content[].text` of a JSON-RPC
 * envelope, itself streamed as an SSE `data:` frame — so this walks the frames,
 * finds the text content, and JSON-parses it. Returns null if nothing parses.
 */
export function parseComposioToolResult(rawBody: string): unknown | null {
  if (!rawBody) return null;
  for (const line of rawBody.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.+)$/);
    const payload = m ? m[1] : line; // tolerate non-SSE (bare JSON) bodies too
    let env: unknown;
    try {
      env = JSON.parse(payload);
    } catch {
      continue;
    }
    const content = (env as { result?: { content?: unknown } })?.result?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        const text = (c as { text?: unknown })?.text;
        if (typeof text === "string") {
          try {
            return JSON.parse(text);
          } catch {
            /* not JSON — try the next content item */
          }
        }
      }
    }
  }
  return null;
}
