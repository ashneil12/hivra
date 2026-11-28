# lite-agent-worker (CANARY, preview)

Free **Lite cloud agents**: a light agent that lives in Cloudflare Durable
Objects instead of on a computer. It sleeps, and costs nothing, until a message
wakes it; it asks a model, saves the reply and sleeps again. The dashboard shows
it only while `NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT=1`.

The shape follows [Salts](https://github.com/AlwaysHungrie/salts-agent)
(Apache-2.0): one Durable Object per agent with its own SQLite. No Salts code is
copied.

## Objects

| Object | Named by | Holds |
| --- | --- | --- |
| `LiteAccount` | Hivra account id | The account's agents, today's free-message count |
| `LiteAgent` | random agent id | Name, personality, memory notes, sessions, messages, optional own model key |

## Who can call it

Only Hivra's server. Every request carries `x-hivra-account`,
`x-hivra-timestamp` (unix seconds, 5 minutes of skew allowed) and
`x-hivra-signature`:

```
hex(HMAC-SHA256(LITE_AGENT_SECRET,
  "lite|v1|" + METHOD + "|" + path + "|" + account + "|" + timestamp + "|" + hex(SHA-256(body))))
```

An agent id that is not on the caller's account answers 404, the same as one
that does not exist.

## Routes

| Method and path | Does |
| --- | --- |
| `GET /v1/me` | Agents, today's allowance, limits, whether a model is configured |
| `POST /v1/agents` `{name, persona?}` | Create an agent (409 `agent_limit` at the limit) |
| `GET / PATCH / DELETE /v1/agents/:id` | Read; change `name`, `persona`, `ownKey` (`{baseUrl, model, apiKey}` or `null`), `deleteNote`; delete everything |
| `POST /v1/agents/:id/sessions` | New chat (409 `session_limit`) |
| `GET / DELETE /v1/agents/:id/sessions/:sid` | Messages; delete the chat |
| `POST /v1/agents/:id/sessions/:sid/messages` `{content}` | Answer one message (429 `daily_limit`, 502 `model_unavailable`) |

## Models and the free allowance

`LITE_MODELS` is an ordered JSON list of OpenAI-compatible chat endpoints; the
first that answers wins:

```json
[{"id":"default","baseUrl":"https://api.example.com/v1","model":"some-model","keySecret":"LITE_MODEL_KEY_DEFAULT"}]
```

`keySecret` names a Worker secret holding that provider's key. A message on
Hivra's models takes one from the account's daily allowance
(`LITE_DAILY_MESSAGES`, reset at 00:00 UTC); if no model answers it is given
back and the message is not kept. An agent with its owner's own key spends no
allowance. The own key is never returned by any route.

The agent has two tools, `remember` and `forget`, and its notes are put in the
system prompt of every chat (at most 100 notes of 500 characters).

## Settings

| Setting | Default | Kind |
| --- | --- | --- |
| `LITE_AGENT_SECRET` | none: the Worker answers 503 | secret, 32+ characters, same value as `HIVRA_LITE_AGENT_SECRET` on Vercel |
| `LITE_MODELS` | `[]` | var |
| `LITE_MAX_AGENTS` | 1 | var |
| `LITE_MAX_SESSIONS` | 256 | var |
| `LITE_DAILY_MESSAGES` | 20 | var |

## Develop

```bash
npm ci
npm run typecheck
npm test        # builds, then runs the Miniflare tests with a fake model
```

### Managed credits smoke lane (Canary only)

The dashboard-only Canary QA settings can additionally allow one enrolled owner
to choose an own-key request or a Hivra credits request explicitly. This lane
is off by default and expires with the existing QA row. It is not a product
launch or a change to the older sponsored preview. With the lane active,
implicit sends are refused.

A managed send verifies agent/session ownership, then makes one signed callback
to the canonical Canary dashboard. The dashboard verifies a separately scoped
HMAC and claims the owner/request UUID once in Postgres before dispatch. It
uses an operator-pinned active, owner-matching card-credit proxy key and model,
with no implicit grants, wallet switching, or sponsored fallback. The provider
key is never sent to the Worker. The smoke reply uses only the current prompt,
without tools, stored memory, or previous conversation, and the Worker saves the
exchange in the chat. Closing the tab doesn't turn an accepted request into a
free request: a duplicate ID is rejected and a transport outcome with uncertain
usage is reconciled rather than treated as definitely unbilled.

Before any authorized test, deploy compatible Worker and dashboard revisions,
apply the additive settings migration, and verify the flag stays off. Only an
operator may set the managed fields on the existing exact-owner expiring
Canary QA row. Use a dedicated card-credit proxy key for that owner, stored as a
sealed dashboard secret, an approved model, and an already funded wallet.
Never put the key into a browser, the Worker config, an output log, or a
migration. Disable the managed flag to restore the prior lane; disable the
existing QA gate too if that owner should no longer be enrolled.
