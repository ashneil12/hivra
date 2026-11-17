# Free cloud agent (Lite agent)

Status: step 1 built, preview, off by default (`NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT`).
`docs/STATUS.md` decides what is available; this file is the plan.

## Why

A free account today needs its own computer before Hivra does anything. The
free cloud agent gives every signed-in account a working agent in under a
minute, without a Hivra-run computer, at a cost to Hivra close to zero.

## Shape

| | Free: Lite agent | Paid: full agent |
| --- | --- | --- |
| Runs on | Cloudflare Durable Objects (`services/lite-agent-worker`), asleep until messaged | Its own Hivra computer |
| Can | Chat, memory notes, sessions | Everything the upstream agent does |
| Model | Daily free allowance on Hivra's configured models, or the owner's own key | Managed inference or own key |

The design follows [Salts](https://github.com/AlwaysHungrie/salts-agent)
(Apache-2.0): one Durable Object per agent with its own SQLite. Its measured
Cloudflare cost is about $0.00005 a message, so the model is the only real cost,
and the daily allowance caps it.

## Steps

1. **Lite agent core (built).** Worker with `LiteAgent` and `LiteAccount`
   objects, signed calls from the dashboard (`/api/lite-agents/*`), the
   `/dashboard/free-agent` page, model fallback list, own key, memory tools.
2. **Reminders, web search, Telegram.** Durable Object alarms; search through
   the existing gateway; a bot per agent.
3. **Give it a computer.** Upgrading launches the official Hermes Agent on a
   Hivra computer and carries the name, personality and memory notes across.
4. **Sandboxes.** Short-lived code execution on Cloudflare Sandboxes, billed
   per second.
5. **Launch.** Plans page, homepage and `docs/STATUS.md` updated together.

## Free inference notes

Free model tiers that only answer their own client (for example OpenCode's free
models) cannot be served from a hosted agent. The allowance therefore runs on
inexpensive hosted models with a fallback list, and free-tier keys from other
providers are supported as the owner's own key.

## Turning it on (Canary)

1. `cd services/lite-agent-worker && npx wrangler deploy`
2. `npx wrangler secret put LITE_AGENT_SECRET` (32+ characters) and one secret
   per `keySecret` in `LITE_MODELS`; set `LITE_MODELS` in `wrangler.toml` or the
   dashboard.
3. On the Vercel project: `HIVRA_LITE_AGENT_URL` (the Worker URL),
   `HIVRA_LITE_AGENT_SECRET` (same value), `NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT=1`.
