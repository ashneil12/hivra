# Venice multi-modal runbook

What shipped on 2026-05-18, where it lives, how it bills, and how to safely re-roll it. Companion to [`managed-venice-runbook.md`](./managed-venice-runbook.md) (chat-completions); this doc covers everything else Venice exposes.

## What shipped (Phase A–G)

One Venice API key now unlocks every modality the agent and dashboard expose. Bi-directional: a key configured on a tenant VM also routes through HermesOS's managed-Venice proxy when the agent is pointed at `https://hermesos.cloud/api/managed-venice/v1`.

| Phase | Modality | Dashboard route | Agent surface |
|---|---|---|---|
| A | Images (text→image) | `/api/managed-venice/v1/images/generate` | `plugins/image_gen/venice/` → tool `image_generate` |
| A | Videos (text→video, image→video) | `/api/managed-venice/v1/videos/queue` + `/videos/[id]` | `plugins/video_gen/venice/` → tool `video_generate` |
| B | TTS | `/api/managed-venice/v1/audio/speech` | `tools/tts_tool.py` provider=`venice` |
| B | STT | `/api/managed-venice/v1/audio/transcriptions` | `tools/transcription_tools.py` provider=`venice` |
| C | Image editing — upscale | `/api/managed-venice/v1/images/upscale` | `tools/image_edit_tool.py` → tool `image_upscale` |
| C | Image editing — edit/inpaint | `/api/managed-venice/v1/images/edit` | `tools/image_edit_tool.py` → tool `image_edit` |
| C | Image editing — multi-edit/compose | `/api/managed-venice/v1/images/multi-edit` | `tools/image_edit_tool.py` → tool `image_compose` |
| C | Image editing — bg remove | `/api/managed-venice/v1/images/background-remove` | `tools/image_edit_tool.py` → tool `image_remove_background` |
| D | Web search | `/api/managed-venice/v1/augment/search` | `plugins/web/venice/` (search backend) |
| D | Web scrape (URL→md) | `/api/managed-venice/v1/augment/scrape` | `plugins/web/venice/` (extract backend) |
| E | Embeddings | `/api/managed-venice/v1/embeddings` | `tools/embed_tool.py` → tool `text_embed` |
| F | Music / SFX | `/api/managed-venice/v1/audio/queue` + `/audio/[id]` | `tools/audio_generate_tool.py` → tool `audio_generate` |
| G | Settings UI + agent self-config | `/api/multimodal/settings` (GET + PATCH), `/static/multimodal.html` (hermes-webui) | `tools/multimodal_config_tool.py` → tools `multimodal_get_settings` + `multimodal_set_model` |

**Auto-pair**: when `VENICE_API_KEY` is in env on a tenant VM and `image_gen.provider` / `video_gen.provider` / `tts.provider` are unset, the agent's registries (`agent/image_gen_registry.py`, `agent/video_gen_registry.py`) default to `venice`. STT auto-detect inserts venice between OpenAI and xAI. Net effect: a Venice-only user gets full multi-modal without touching `config.yaml`.

**Base URL override**: every agent-side surface honors `VENICE_BASE_URL`. Default is `https://api.venice.ai/api/v1` (direct). Set to `https://hermesos.cloud/api/managed-venice/v1` to route through the proxy.

## How metering works

Every managed-Venice request goes to Venice with **Hivra's** upstream key, so Venice bills Hivra whether or not the user can pay. The chat path reserves per call (`reserveManagedVeniceChatRequest` → token-level recost → refund-or-flag). Every paid media route (images, video, audio, embeddings, web search/scrape, and the paid paths of the `[...path]` passthrough) goes through the **media spend gate** in [`lib/venice/media-spend-gate.ts`](../src/lib/venice/media-spend-gate.ts):

1. **Price before forwarding.** The request is priced from the in-code catalog [`lib/venice/multimodal-pricing.ts`](../src/lib/venice/multimodal-pricing.ts) as a conservative ceiling (`computeVeniceMultimodalHoldCost`: a request that sends no tier holds at the most expensive published tier, variant counts round up). An operation the catalog can't price (today: video, music, STT, embeddings, multi-edit, background removal, text parser, voice clone, crypto RPC, and any image/edit model not in the catalog) is **refused with a 402** and never sent to Venice.
2. **Hold.** The ceiling (after `MANAGED_VENICE_MULTIMODAL_MARKUP`) is reserved on the key's wallet with the same reservation table, DB balance trigger and monthly spend cap as chat. A wallet that can't cover it gets a 402 (`managed_venice_insufficient_balance`) and Venice is never called. If the balance can't be checked, the request fails closed with a 503.
3. **Settle.** Venice error or no answer → the hold is released and nothing is charged. A 2xx → the catalog's settlement price (the price of the tier that was sent, or of Venice's default tier when none was; never more than the hold) is captured from the hold, and a `status='recorded'` usage row + `usage_capture` financial event are written.

Priced image generation models: `qwen-image-2`, `nano-banana-2`, `nano-banana-pro`, `gpt-image-2`, `venice-sd35` and `grok-imagine-image`, which is every model the agent's Venice image plugin offers. Edits: `seedream-v4-edit`, `firered-image-edit`, `nano-banana-2-edit`, `nano-banana-2-lite-edit`. Also upscale, Kokoro TTS, web search and web scrape.

**Every wallet debit is one database transaction.** Captures and hold-less debits (chat overage, the backlog pass) call `capture_managed_venice_reservation` and `debit_managed_venice_wallet` (migration `20260925201500_managed_venice_atomic_wallet_debits.sql`). Each takes the per-user wallet lock the reservation and card balance guards use, debits token lots oldest first with the lots row-locked (or writes one card ledger debit), and, for a capture, marks the hold captured in the same transaction. Before this, ten images captured at once on a $1.00 lot all wrote $0.95, so the wallet paid for one image in ten; a debit spanning two lots could land on one and fail on the other; and a capture retried after a lost response was charged twice. Now a debit lands whole or not at all, and a hold that is no longer active is never charged again.

**A chat, Anthropic or Responses stream that Venice answered 200 is settled in the request, however it ends.** When the client disconnects, the route stops forwarding but keeps reading Venice to its usage frame (or the routes' 270 s deadline), so the request is charged Venice's exact usage, hidden reasoning included: a reasoning model's thinking (GPT-5.x, encrypted Responses reasoning) never appears in the stream. The routes keep the function alive for that with `next/server` `after`. Only when the usage never arrives (the deadline, a broken stream, Venice leaving it out) is the stream charged the input estimate plus the output it read ([`lib/venice/stream-output-meter.ts`](../src/lib/venice/stream-output-meter.ts): the larger of the frames that carried text and a token per 4 ASCII characters plus a token per other character; Responses output sent only in `.done` events counts too), and those rows carry `metadata.pricingPolicy = managed_venice_observed_output_capture`. Either way a cost past the hold captures the hold and debits the rest as `<reference>:overage`; an overage the wallet cannot cover files `managed_venice_overage_uncovered` and pauses the key. The rest of the hold goes straight back. `venice_parameters.strip_thinking_response` is refused (400), since it hides the reasoning a stream would otherwise carry. A refused request's hold is released, a Venice 5xx included; if that release fails, `managed_venice_chat_release_failed` is filed. The Cloudflare Worker does the same through `/internal/settle`: after the box disconnects it reads Venice for up to 20 s more (Cloudflare allows 30 s of `waitUntil` work), then sends the usage or `observedOutputTokens`; it retries settles until they land, runs everything after authorize under `waitUntil`, and chooses each hold's reference itself so it can release the hold after any failure that follows authorize. A release that finds no hold yet answers 503, so the Worker retries while a slow authorize may still commit one.

**Holds that the request could not settle** are settled by the stale-hold sweep ([`lib/venice/reservation-sweep.ts`](../src/lib/venice/reservation-sweep.ts)), run hourly by `/api/cron/managed-venice-hold-sweep`. Items are settled 15 minutes after they are filed:
- Every hold has an `expires_at`: one hour for media, a day for chat and Responses. Each media hold records what a success is charged (`metadata.captureOnSuccessMicroUsd`); each chat hold records its input estimate and output price.
- Venice answered 2xx but the request could not write its charge: the hold is **captured**, at the number the request recorded (Venice's reported usage, or the input estimate plus the observed output, with any part past the hold debited as an overage), or the catalog price for media. Only a hold with nothing recorded is charged an estimate: the input plus at most 4,096 output tokens per choice (never more than the pre-request estimate).
- Venice refused the request and the in-request release failed (`managed_venice_media_release_failed`, `managed_venice_chat_release_failed`): the hold is **released**.
- A Responses hold whose upstream outcome is unknown (the dispatch threw) is left to an operator for an hour, then **released**. Every other Responses item follows a 200 and is captured.
- An expired hold with no reconciliation item (the function died mid-request) is **captured** at its estimate: nothing proves Venice didn't run it. Expired holds have their own per-run budget, so a backlog of items never starves them.
- A hold created before holds expired is left to an operator.
Swept captures write a usage row (`metadata.pricingPolicy = managed_venice_hold_sweep_capture`) and a `usage_capture` event. The chat reconciliation cron skips both estimated-capture policies, since there are no token counts to re-cost.

A successful paid request is **always charged**. `MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED` does not affect the gate: it only switches the retroactive settlement of old `status='reconciliation_required'` rows written before the gate existed (`settleManagedVeniceMultimodalUsage`, reached from `/api/ops/managed-venice/invoice-reconciliation`; flag off = dry run). If a success released its hold, the gate would only prove the wallet was non-empty, and one small top-up would buy unlimited media on Hivra's key.

**The priced request is the forwarded request.** Before any hold, every paid route refuses (400) a request whose pricing fields (`model`, `modelId`, `scale`, `enhance`, `resolution`, `variants`, `duration`) are repeated, are files, arrays or objects, or where `modelId` (Venice's deprecated alias) names a different model from `model` ([`lib/venice/media-request-fields.ts`](../src/lib/venice/media-request-fields.ts)). On image edit and multi-edit, whichever of `model` / `modelId` is sent is the model priced. JSON bodies are re-serialized after parsing, so a repeated JSON key reaches Venice as the one value that was priced.

Then, for every endpoint the catalog bills, the body that is priced and forwarded is built by `planMediaRequest` (same file):

- **Only documented fields are forwarded.** Each endpoint has a field list taken from Venice's OpenAPI request schema (`MEDIA_REQUEST_POLICIES`); anything else is dropped (and logged), so an undocumented or newly added option, or a name like `model[0]`, can't add to the bill.
- **Options Venice bills extra for are refused (400)** when switched on: `enable_web_search`, `enhance_prompt`, `quality` and `style_references` on `image/generate`, `enhance_prompt` and `quality` on `image/edit`. Switched off, they are dropped. The agent's plugins send none of them.
- **A tier is sent as the tier charged.** Resolution is matched case-insensitively (`"4k"` → `4K`); an upscale `scale` is read as a number, and a factor between tiers goes up to the next published tier (`"3"`, `"4.0"`, `"04"` → 4x) and is sent to Venice as that tier. A value that maps to no published tier (`"8K"`, `scale: 1`) is refused with a 400 before any hold. No tier field at all is Venice's default (1K, 2x): held at the top tier, charged at the default.

### The passthrough is an allowlist

`/api/managed-venice/v1/[...path]` forwards only these paths (evidence: callers in the Hermes agent fork that use `VENICE_BASE_URL`):

| Method | Path | Why it's allowed |
|---|---|---|
| GET | `models` | model discovery (normally served by the dedicated `/v1/models` route) |
| GET | `image/styles` | `venice_extras_tool` style list; free |
| GET | `crypto/rpc/networks` | `venice_extras_tool` network list; free |
| GET | `characters` | `venice_characters_tool` public persona list; free |
| POST | `video/retrieve`, `audio/retrieve` | job polling; the generation was held at queue time |
| POST | `video/quote`, `audio/quote` | free price previews |
| POST | `image/generate`, `image/edit`, `image/upscale` | paid; forwarded only under a wallet hold |
| POST | `image/multi-edit`, `image/background-remove`, `video/queue`, `video/transcriptions`, `audio/voices`, `augment/text-parser`, `crypto/rpc/{network}` | paid; routed through the gate, which refuses them (402) until the catalog prices them |

Everything else — Venice account management (`api_keys*`, `billing*`, ...), unknown paths, upper-case or percent-encoded variants, dot or empty segments, and any other method — gets a 404 and is never fetched.

A paid passthrough request must be `application/json` or `multipart/form-data` and must parse; anything else gets a 415 (wrong type) or 400 (unreadable body) with no hold and no fetch, rather than being priced as if it named no fields. The body forwarded to Venice is rebuilt from the parsed fields (re-serialized JSON, or the parsed form with a fresh boundary). Free POSTs (`*/retrieve`, `*/quote`) still forward their original bytes.

### Why the chat reconciliation cron skips multi-modal

`/api/cron/managed-venice-reconciliation` (daily 09:00 UTC) is for chat only — it filters at the SQL layer to `endpoint='/api/v1/chat/completions'`. Without that filter, multi-modal rows show up as `unpriceable_model` (their model ids aren't in the chat catalog) and trigger a daily warn-level ops alert. Filter landed in PR #157.

### Pricing more operations

To unblock an operation the gate refuses, add a Venice list-price entry to `VENICE_MULTIMODAL_PRICES` (with its unit and, for tiered prices, the tier key), a request policy for a new endpoint in `MEDIA_REQUEST_POLICIES`, and a test. Never add a guessed price: the gate treats the catalog as the only source of truth. Pricing moves fast on Venice — re-pull the catalog from docs.venice.ai when it goes stale, and compare it with `model_spec.pricing` in Venice's public `GET https://api.venice.ai/api/v1/models?type=<image|inpaint|upscale|tts>` (no key needed), which can be higher than the docs page (it prices `nano-banana-2-edit` by resolution while the docs list a flat $0.10). Where they differ, the catalog takes the higher price. Where `GET /models` also prices by `quality` (e.g. `gpt-image-2`), the catalog charges the resolution price, which is at or above every quality price, and the gate refuses requests that set `quality`. Last full check against both sources: 2026-09-25.

## How to redeploy a tenant VM with the new code

The agent and webui run from `:stable` images. Merging to `main` (vanilla-hermes-agent) / `master` (hermes-webui) auto-fires the GHCR rebuilds via `Docker Build and Publish` / `Hermes Deploy Image` workflows. After the workflows complete, kick a redeploy:

```bash
CRON_SECRET=$(grep '^CRON_SECRET=' dashboard/.env.local | sed -E 's/^CRON_SECRET="?([^"]*)"?$/\1/')
curl -sS -X POST "https://hermesos.cloud/api/cron/redeploy-webui-instances" \
  -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"instanceIds":["<id1>","<id2>"]}' | jq .
```

Max 10 IDs per call. After ~60s, SSH-verify the VM pulled fresh digests:

```bash
ssh -i /path/to/proxmox-admin-key root@<host_ip> \
  "ssh -o BatchMode=yes -i /etc/hivra/keys/vm-orchestrator hermes@<vm_priv_ip> \
    'sudo docker inspect ghcr.io/ashneil12/vanilla-hermes-agent:stable --format {{.Id}}; \
     sudo docker exec agent-<full-id>-official-dashboard ls /opt/hermes/plugins/image_gen/venice/'"
```

The `:stable` digest should match `gh api repos/ashneil12/vanilla-hermes-agent/branches/main` HEAD.

## File-by-file conflict guide

Stacked PRs (which is how everything shipped) cause one recurring rebase conflict and one recurring class of merge mistake. Both are mechanical to resolve.

### Conflict 1: `dashboard/__tests__/scripture-architecture.test.ts`

Every managed-venice route file has a ``SCRIPTURE_ANCHOR`` comment, and the test enforces a fixed allowlist of `(file, id, reference)` triples in `EXPECTED_DASHBOARD_ANCHORS`. Each phase's PR added entries to this list. When you rebase a stacked branch onto main after the predecessor merged via squash, git replays the predecessor's commit AGAIN and conflicts with the squashed version.

**Resolution**: keep the HEAD version (which is the squashed predecessor + this branch's additions) and `git rebase --skip`. The "current" anchors are always whatever's in main; your branch only needs to add NEW anchors below them.

```bash
git checkout --theirs dashboard/__tests__/scripture-architecture.test.ts
git rebase --skip
```

### Conflict 2: don't `--delete-branch` on stacked merges

`gh pr merge --squash --delete-branch` deletes the source branch on merge. If that branch was the **base** of a still-open stacked PR, GitHub auto-closes the dependent PR (its base no longer exists). You can't reopen it; you have to create a fresh PR with `--base main`.

**Resolution**: either retarget the dependent PR to `main` **before** merging the predecessor (`gh pr edit <n> --base main`), or merge without `--delete-branch` and clean up the branches afterward in a batch. The second approach is simpler when you're driving 7+ stacked merges.

### Conflict 3: the `tts_tool.py` / `transcription_tools.py` provider lists

Two existing monolithic files now know about `"venice"`. If you ever rebase a downstream change that touches `BUILTIN_TTS_PROVIDERS` or the auto-detect chain in `_get_provider()`, expect a hunk-level conflict and resolve by keeping both entries — the file is order-sensitive (auto-detect priority: `local > groq > openai > venice > xai` for STT).

### Conflict 4: `agent/image_gen_registry.py` / `video_gen_registry.py` fallback chain

Both registries now have a `VENICE_API_KEY`-detection step between the single-provider check and the legacy FAL fallback. If upstream NousResearch changes this fallback chain, mergeably with us means preserving the venice step AND whatever upstream added. The docstring at the top documents the canonical order.

## Why the agent has TWO places where TTS/STT live

Historical: TTS/STT in vanilla-hermes-agent is monolithic in `tools/tts_tool.py` (2200+ LOC) and `tools/transcription_tools.py`. Image gen + video gen got proper plugin abstractions (`agent/image_gen_provider.py` ABC + `plugins/image_gen/<name>/` slots).

When we added Venice to TTS/STT, we extended the monolithic path rather than building a `TTSProvider` ABC. **Reason**: refactoring 2200 LOC of TTS code with 10 providers (edge, elevenlabs, openai, minimax, mistral, gemini, xai, neutts, kittentts, piper) for one new provider added unwarranted scope. A future TTS plugin abstraction is a clean follow-up.

If you build the abstraction later: mirror `agent/image_gen_provider.py` exactly. Move each existing provider into `plugins/tts/<name>/` and replace the `BUILTIN_TTS_PROVIDERS` + dispatch chain with `agent/tts_registry.get_active_provider()`.

## Where each piece of code lives

- **Agent plugins** (the Venice backends): `vanilla-hermes-agent/plugins/{image_gen,video_gen,web}/venice/`
- **Agent tools** (LLM-callable): `vanilla-hermes-agent/tools/{image_edit_tool,audio_generate_tool,embed_tool,multimodal_config_tool}.py`
- **Agent inline TTS/STT**: `vanilla-hermes-agent/tools/{tts_tool,transcription_tools}.py` — search for `_generate_venice_tts` / `_transcribe_venice`
- **Agent registries** (auto-pair logic): `vanilla-hermes-agent/agent/{image_gen,video_gen}_registry.py`
- **Dashboard proxy routes**: `Hermesdeploy/dashboard/src/app/api/managed-venice/v1/`
- **Dashboard usage recorder**: `Hermesdeploy/dashboard/src/lib/venice/proxy-settlement.ts` → `recordManagedVeniceMultimodalUsage()`
- **WebUI settings**: `hermes-webui/api/multimodal.py` + `hermes-webui/api/routes.py` (route registration) + `hermes-webui/static/multimodal.html`

## Original PR list (for archeology)

All merged 2026-05-18.

| Repo | Phase | PR |
|---|---|---|
| Hermesdeploy | A.1 images+videos | [#148](https://github.com/ashneil12/hermesdeploy/pull/148) |
| Hermesdeploy | B.2 audio (TTS+STT) | [#155](https://github.com/ashneil12/hermesdeploy/pull/155) (recreated from closed #149) |
| Hermesdeploy | C.2 image editing | [#150](https://github.com/ashneil12/hermesdeploy/pull/150) |
| Hermesdeploy | D.2 web search/scrape | [#151](https://github.com/ashneil12/hermesdeploy/pull/151) |
| Hermesdeploy | E.2 embeddings | [#153](https://github.com/ashneil12/hermesdeploy/pull/153) |
| Hermesdeploy | F.2 audio/music | [#154](https://github.com/ashneil12/hermesdeploy/pull/154) |
| Hermesdeploy | reconciliation scope | [#157](https://github.com/ashneil12/hermesdeploy/pull/157) |
| vanilla-hermes-agent | A.2 images+videos | [#9](https://github.com/ashneil12/vanilla-hermes-agent/pull/9) |
| vanilla-hermes-agent | B.1 TTS+STT | [#10](https://github.com/ashneil12/vanilla-hermes-agent/pull/10) |
| vanilla-hermes-agent | C.1 image editing | [#11](https://github.com/ashneil12/vanilla-hermes-agent/pull/11) |
| vanilla-hermes-agent | D.1 web search | [#12](https://github.com/ashneil12/vanilla-hermes-agent/pull/12) |
| vanilla-hermes-agent | E.1 embeddings | [#13](https://github.com/ashneil12/vanilla-hermes-agent/pull/13) |
| vanilla-hermes-agent | F.1 audio gen | [#14](https://github.com/ashneil12/vanilla-hermes-agent/pull/14) |
| vanilla-hermes-agent | G.1 config tools | [#15](https://github.com/ashneil12/vanilla-hermes-agent/pull/15) |
| hermes-webui | G.2/G.3 settings UI | [#25](https://github.com/ashneil12/hermes-webui/pull/25) |

## Quick smoke test

Once a VM is on the new images, the LLM should be able to:

```
> generate an image of a cyberpunk skyline at sunset
→ image_generate routes through Venice (qwen-image-2 default), saves
  to $HERMES_HOME/cache/images/

> upscale this to 2x with cinematic enhancement
→ image_upscale with scale=2 + enhance=true

> what model are we using for video?
→ multimodal_get_settings reports active provider + model per modality

> use Veo 3.1 for video from now on
→ multimodal_set_model writes config.yaml; next video_generate uses Veo
```

WebUI side: hit `/static/multimodal.html` directly — cards render per modality, dropdowns + Save work, status shows ok/err.

For managed-Venice users specifically: set `VENICE_BASE_URL=https://hermesos.cloud/api/managed-venice/v1` on the tenant VM. Same proxy key as chat. Usage events land in `managed_venice_usage_events` with `endpoint` capturing which modality was called.
