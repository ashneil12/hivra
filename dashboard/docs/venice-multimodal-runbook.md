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

The chat path has full per-call pricing (`reserveManagedVeniceChatRequest` → token-level recost → refund-or-flag). Every other modality is **offline-reconciled**:

1. Each successful upstream call writes a row to `managed_venice_usage_events` via [`recordManagedVeniceMultimodalUsage()`](../src/lib/venice/proxy-settlement.ts).
2. The row carries `endpoint` (e.g. `/api/v1/images/generate`), `model` (e.g. `qwen-image-2`), `metadata` (resolution / duration / token counts / etc.), `actual_cost_micro_usd=0`, `charged_micro_usd=0`, and `status='reconciliation_required'`.
3. **No per-call wallet deduction** for multi-modal. The user's proxy key is NOT paused on these rows — that's the explicit difference from `markManagedVeniceReconciliationRequired()`, which is for settlement failures.
4. Settlement happens against Venice's monthly invoice via `/api/ops/managed-venice/invoice-reconciliation` (run on demand by ops).

### Why the chat reconciliation cron skips multi-modal

`/api/cron/managed-venice-reconciliation` (daily 09:00 UTC) is for chat only — it filters at the SQL layer to `endpoint='/api/v1/chat/completions'`. Without that filter, multi-modal rows show up as `unpriceable_model` (their model ids aren't in the chat catalog) and trigger a daily warn-level ops alert. Filter landed in PR #157.

### Adding per-modality pricing (deferred follow-up)

When you're ready to bill multi-modal per call (instead of monthly), the work is:

1. Add price tables: `lib/venice/image-pricing.ts`, `lib/venice/video-pricing.ts`, `lib/venice/audio-pricing.ts`, `lib/venice/embeddings-pricing.ts`, `lib/venice/web-pricing.ts`.
2. Wrap each multi-modal route: replace `recordManagedVeniceMultimodalUsage()` with a per-modality `reserve` → upstream → `capture` flow mirroring `reserveManagedVeniceChatRequest` / `captureManagedVeniceChatUsage`.
3. Extend `/api/cron/managed-venice-reconciliation` to handle each modality (currently scoped to chat by `CHAT_COMPLETIONS_ENDPOINT`).
4. Per-modality drift alerts.

Pricing moves fast on Venice — defer until a model surface stabilizes.

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
