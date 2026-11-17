# memory-worker

Portable agent memory on Cloudflare. One Durable Object with its own SQLite per
person; agents reach it over MCP (`POST /mcp`) or a plain API (`/v1/*`). Not
linked from anywhere yet: nothing uses it until a dashboard flag does.

## How it works

- **The agent decides what to save.** No language model runs here on a save.
  The Worker stores, searches and hands back.
- **Search** blends a keyword index (SQLite FTS5) with meaning search (one
  1 KB vector per memory from Workers AI `bge-m3`). Without embeddings it falls
  back to keywords.
- **Keeping memory current.** A word-for-word restatement replaces the older
  memory. Anything merely similar is returned to the calling agent, which says
  what is out of date by saving again with `replaces`. Replaced memories stay
  in the export, marked as replaced.
- **Keys** name their account, are signed with `MEMORY_SECRET`, can be
  read-only or tied to one project, and are revocable.
- Credentials are masked before storing. `forget` deletes for good.
  `DELETE /admin/account` empties the object.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `POST /mcp` | agent key | MCP tools: `remember`, `recall`, `profile`, `forget`, `export` |
| `POST /v1/remember`, `POST /v1/recall`, `GET/PUT /v1/profile`, `POST /v1/forget`, `GET /v1/export`, `GET /v1/activity` | agent key | Same, as a plain API |
| `POST/GET/DELETE /admin/keys`, `GET /admin/stats`, `DELETE /admin/account` | Hivra's server, signed | Mint and revoke keys, read the usage meter |

`GET /admin/stats` reports rows read, rows written, embedding tokens and stored
bytes: the units Cloudflare bills on.

## Connect an agent

```json
{ "mcpServers": { "memory": { "type": "http", "url": "https://<worker>/mcp",
  "headers": { "Authorization": "Bearer hm_..." } } } }
```

Agents with a memory of their own use this one reliably only when their
instruction file says so (two lines in `CLAUDE.md` / `AGENTS.md`).

## Develop

```
npm install
npm test        # builds, then runs the Worker in Miniflare
npm run typecheck
```
