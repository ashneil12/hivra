# GBrain memory provider

Shared **organisation brain** memory for Hermes. One brain, every persona -
facts written by one persona are recallable by all of them. GBrain is a
Bun/TypeScript server exposing a single stateless JSON-RPC MCP endpoint over
Streamable-HTTP at `<GBRAIN_BASE_URL>/mcp`.

## Config

| Env var            | Required | Default                 | Notes                              |
| ------------------ | -------- | ----------------------- | ---------------------------------- |
| `GBRAIN_BASE_URL`  | yes      | `http://127.0.0.1:3131` | Server base URL (loopback default) |
| `GBRAIN_MCP_TOKEN` | yes      | -                       | Shared org bearer token            |

The same bearer token is used for **every** persona - the provider is
intentionally not scoped per profile, so the org brain is shared not siloed.

## Behaviour

- **prefetch / volunteer_context** → `volunteer_context {window}` + `search {query, limit:5}`, injected as context before each turn.
- **search / recall** → `gbrain_search` / `gbrain_recall` tools (`search` / `recall` ops).
- **sync_turn** → writes the turn to `put_page {slug: sessions/<session_id>, body}` on a background thread (best-effort, never blocks or raises into the turn).
- Tools exposed to the model: `gbrain_search`, `gbrain_recall`, `gbrain_put_page`.

## Transport notes

The Streamable-HTTP transport may answer with a plain JSON body or an SSE
`data: {...}` frame - the client handles both. The MCP tool result text field
is itself a JSON string and is `json.loads`-decoded into the structured
payload.

Additive and backward-compatible: the provider only activates when both env
vars are set (`is_available`).
