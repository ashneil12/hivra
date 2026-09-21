// Hermes-lane tool reconciliation (Tools v2).
//
// The CLI lane writes MCP servers into the box's own agent config (~/.claude.json
// / ~/.codex/config.toml) over SSH — see tool-mcp-seed.ts. The HERMES lane has
// its own MCP surface: the agent's `config.yaml` -> `mcp_servers`, already
// written by hermes-config-write.ts (used today by Composio + Bankr). So a Hermes
// agent can carry tools with NO new transport: we just reconcile OUR entries in
// that same map, exactly like buildHermesConfigWithComposioMcp does for its one.
//
// NAMING: every entry we manage is prefixed `hivra_` so this reconciler can find
// and strip its own entries without ever touching the composio entry, a
// user-authored server, or anything else in the map. (The composio reconciler
// owns `composio`; the two are disjoint by construction.)
//
// ENTRY SHAPE: the Hermes config takes hosted servers as {url, headers} — the
// same shape our v1.1 `transport:"http"` tools already produce. STDIO tools
// (command/args/env) are also emitted, for a Hermes agent that runs local
// processes; unsupported shapes are simply never passed in by the caller.

import { COMPOSIO_MIN_MCP_DISCOVERY_TIMEOUT_S } from "@/lib/composio/config";

/** Prefix marking an mcp_servers entry as managed by the Hivra tools installer. */
const HIVRA_TOOL_SERVER_PREFIX = "hivra_";

/** True for an mcp_servers key WE manage (never the composio entry). */
export function isHivraManagedServerName(name: string): boolean {
  return name.startsWith(HIVRA_TOOL_SERVER_PREFIX);
}

/** The config key for a tool's MCP server name (`searxng` -> `hivra_searxng`). */
export function hivraServerNameFor(mcpName: string): string {
  return `${HIVRA_TOOL_SERVER_PREFIX}${mcpName}`;
}

/** A single server to write into the Hermes config's mcp_servers map. */
export interface HermesToolServerEntry {
  /** Bare MCP name (without the hivra_ prefix). */
  name: string;
  /** Hosted server: endpoint + auth headers. */
  url?: string;
  headers?: Record<string, string>;
  /** Local server: process + args + env. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function serverPayload(e: HermesToolServerEntry): Record<string, unknown> {
  if (e.url) {
    const out: Record<string, unknown> = { url: e.url };
    if (e.headers && Object.keys(e.headers).length) out.headers = e.headers;
    return out;
  }
  const out: Record<string, unknown> = { command: String(e.command) };
  if (e.args && e.args.length) out.args = e.args;
  if (e.env && Object.keys(e.env).length) out.env = e.env;
  return out;
}

/**
 * Reconcile the Hivra-managed tool entries in a Hermes agent config's
 * `mcp_servers`.
 *
 * CONTRACT (mirrors buildHermesConfigWithComposioMcp deliberately):
 *   - `entries === undefined` → PRESERVE: return config untouched. General config
 *     writers must never drop tools they don't manage.
 *   - `entries === []`        → strip ALL hivra_-managed entries (uninstall all).
 *   - `entries` non-empty     → strip hivra_-managed entries, then set these.
 *
 * Never throws. The composio entry, user-authored servers, and the rest of the
 * config are always left intact.
 */
export function buildHermesConfigWithTools(params: {
  config: Record<string, unknown>;
  entries?: HermesToolServerEntry[];
}): Record<string, unknown> {
  if (params.entries === undefined) return params.config;

  const raw = params.config.mcp_servers;
  const servers =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};

  // Strip only what we manage — composio + user entries survive untouched.
  for (const key of Object.keys(servers)) {
    if (isHivraManagedServerName(key)) delete servers[key];
  }

  let hasHosted = false;
  for (const entry of params.entries) {
    if (!entry?.name) continue;
    if (entry.url) hasHosted = true;
    servers[hivraServerNameFor(entry.name)] = serverPayload(entry);
  }

  const next = { ...params.config };
  if (Object.keys(servers).length === 0) {
    delete next.mcp_servers;
  } else {
    next.mcp_servers = servers;
  }

  // A remote server needs longer than Hermes' 1.5s default discovery window or
  // it gets dropped at boot (same reason Composio raises it). Upward-only.
  if (hasHosted) {
    const cur = next.mcp_discovery_timeout;
    if (typeof cur !== "number" || cur < COMPOSIO_MIN_MCP_DISCOVERY_TIMEOUT_S) {
      next.mcp_discovery_timeout = COMPOSIO_MIN_MCP_DISCOVERY_TIMEOUT_S;
    }
  }
  return next;
}

/** Read back the bare tool-server names currently installed on a Hermes config. */
export function readInstalledHermesToolNames(config: Record<string, unknown>): string[] {
  const raw = config?.mcp_servers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>)
    .filter(isHivraManagedServerName)
    .map((k) => k.slice(HIVRA_TOOL_SERVER_PREFIX.length));
}
