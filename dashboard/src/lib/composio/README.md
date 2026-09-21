# Composio Connect (BYO, MCP consumer key)

Each user brings their OWN Composio **MCP consumer key** — the `X-CONSUMER-API-KEY`
(`ck_…`) shown on Composio's Install page → MCP card. That key plus Composio's
hosted **Tool Router** endpoint IS the whole integration, so the marginal cost to
Hivra is **$0** at any scale and there is **no SDK, no project API key, and no
per-provider OAuth registration**.

## Flow

1. **Paste key** — `POST /api/account/composio/key` validates the key by asking the
   Tool Router to list its tools (the exact endpoint the box will use), then stores
   it in `user_api_keys` (provider `composio`), like the BYO-Venice key.
2. **Register the box entry** — `connectors-sync` writes a SINGLE, STATIC
   `mcp_servers.composio` entry into the box's `config.yaml`:
   `{ url: "https://connect.composio.dev/mcp", headers: { "X-CONSUMER-API-KEY": "ck_…" } }`.
   Deterministic (same key → same entry), so re-writing it is a no-op.
3. **Connect an app** — one-tap from the dashboard. A CommandPanel tile → `POST
   /api/account/composio/connect-link { toolkitSlug }` → `initiateComposioConnection`
   calls the Tool Router's `COMPOSIO_MANAGE_CONNECTIONS` (action `add`) with the
   user's consumer key and returns the hosted-OAuth `redirect_url`, which the client
   opens in a popup. No SDK / project key. (The agent can also connect apps itself
   conversationally — same Tool Router meta-tool — but the dashboard drives it
   directly so the user never has to ask.)
4. **Callable** — one Tool Router serves ALL of the user's apps dynamically (search
   → connect → execute), so a newly connected app is usable without any config
   change or gateway restart. The box config is touched only on first registration /
   key rotation / de-register.

## Why this is the simple model

- ONE static entry (endpoint + key header) — nothing to mint, nothing to orphan.
- The agent connects apps conversationally via the Tool Router meta-tools; the
  dashboard never brokers OAuth or holds a project key.
- No `@composio/core` SDK, no auth-configs, no sessions, no connect-link/callback.

## Environment

**No platform secret** — the key is per-user (BYO). The feature is **on by default**;
set the flag to the literal `"false"` to hard-disable it.

| Var | Notes |
|-----|-------|
| `NEXT_PUBLIC_COMPOSIO_CONNECT_ENABLED` | kill-switch; only `"false"` disables it |

## Module layout

- `config.ts` — client-safe: flag + slug + Tool Router URL/header constants.
- `mcp-server.ts` — SDK-free: the `mcp_servers.composio` entry type + read helper.
- `connect.ts` — server-only: key read, `validateComposioKey` (Tool Router
  `tools/list` check), and `buildComposioMcpServerEntry` (the static entry).
- `sync-connectors.ts` — writes/removes the single entry on a box (webfree SSH
  merge + non-webfree agent-API PUT), change-gated gateway restart.
- `use-composio-connect.ts` — client hooks (key management + the on/off flag).
