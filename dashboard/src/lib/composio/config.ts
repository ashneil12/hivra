// src/lib/composio/config.ts
//
// Client-SAFE gating + shared constants for the BYO-Composio connect layer.
// NO server-only imports, NO SDK, NO supabase here — the client hook imports
// isComposioConnectFlagOn() from this file, so it must stay browser-safe. All
// server work (SDK, key read, sessions) lives in connect.ts / mcp-server.ts.
//
// BYO model: there is NO platform-level Composio secret. Each user pastes their
// OWN Composio MCP consumer key — the `X-CONSUMER-API-KEY` (ck_…) shown on
// Composio's Install page → MCP card. That key + the hosted Tool Router endpoint
// IS the whole integration (search / connect / execute across 500+ apps), so we
// just write ONE static mcp_servers entry into the box; no SDK, no project key.
// "enabled" is purely the public feature flag; per-user readiness = "does this
// user have a stored Composio key?" (answered by the server routes).

/** The user_api_keys.provider value for a user's Composio key. */
export const COMPOSIO_PROVIDER = "composio";

/** The mcp_servers.<name> key for the (single, multi-toolkit) Composio entry. */
export const COMPOSIO_MCP_SERVER_NAME = "composio";

/**
 * Composio's hosted Tool Router MCP endpoint — the exact URL shown on the Install
 * page's MCP card. One server, dynamically routing ALL of a user's apps.
 */
export const COMPOSIO_TOOL_ROUTER_URL = "https://connect.composio.dev/mcp";

/** The header the Tool Router authenticates the user's consumer key with. */
export const COMPOSIO_CONSUMER_KEY_HEADER = "X-CONSUMER-API-KEY";

/**
 * Minimum `mcp_discovery_timeout` (seconds) the box must allow when a Composio
 * entry is present. Composio's Tool Router is REMOTE (~2.7s to connect+list),
 * and Hermes' default (1.5s) is too short — discovery times out at gateway boot
 * so the tools never enter the agent's toolset (they DO for a fast/local server
 * like the old Pipedream proxy, which is why that "just worked"). We bump the
 * timeout (only upward) whenever we write the composio entry.
 */
export const COMPOSIO_MIN_MCP_DISCOVERY_TIMEOUT_S = 15;

/**
 * Every toolkit slug the UI surfaces (hero tiles + "more apps" chips). The
 * connected-apps endpoint queries these to mark which are connected. KEEP IN SYNC
 * with CommandPanel's APP_CONNECTORS + MORE_APPS slug sets.
 */
export const COMPOSIO_SURFACED_SLUGS = [
  "googlecalendar", "gmail", "github", "slack", "notion", "linear",
  "googledrive", "googlesheets", "googledocs", "outlook", "discord", "jira",
  "asana", "trello", "clickup", "hubspot", "salesforce", "airtable", "calendly",
  "zoom", "dropbox", "twitter", "linkedin", "reddit", "youtube", "stripe",
  "shopify", "zendesk",
] as const;

/**
 * Public feature flag — read identically on client + server.
 *
 * ON BY DEFAULT: BYO-Composio has no platform secret and no marginal cost (every
 * user brings their own key), so there's nothing to protect by hiding it. The
 * flag is a pure kill-switch — set NEXT_PUBLIC_COMPOSIO_CONNECT_ENABLED="false"
 * to hard-disable the whole connect layer; any other value leaves it enabled.
 */
export function isComposioConnectFlagOn(): boolean {
  return process.env.NEXT_PUBLIC_COMPOSIO_CONNECT_ENABLED !== "false";
}
