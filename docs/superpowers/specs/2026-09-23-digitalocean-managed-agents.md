# DigitalOcean Managed Agents as Hivra capacity

**Date:** 2026-09-23

**Status:** Implemented on branch `claude/digitalocean-managed-agents` with unit,
route, and real-schema (local Postgres + PostgREST) evidence against a faked
DigitalOcean API. **No call has been made to the real DigitalOcean API.** Live
acceptance needs a DigitalOcean team enrolled in the Managed Agents public
preview, a write-scope token, and a positive Harness Runtime prepaid balance.
DigitalOcean's API is itself a public preview and may change.

## What DigitalOcean shipped (2026-09-22)

DigitalOcean Managed Agents is two services:

- **Harness Runtime** — each agent *session* runs in its own Firecracker microVM
  with a persistent `/workspace`, pause/resume (~0.3 s resume), idle auto-pause
  (15 min default), checkpoints/forks, an exec API, port forwarding, and a
  canonical event stream. Adapters: `claude-code`, `codex`, `opencode`, `hermes`,
  `cursor`, `langgraph`, `custom` (OCI image). Billing is per active vCPU-second
  plus peak memory; waiting on the model costs no CPU.
- **Action Gateway** — a managed MCP endpoint with 16,000+ brokered tools.

The shipped entry points are the control panel and `doctl harness-runtime`,
which attaches a *terminal* to the session. The HTTP API behind `doctl` is
`/v2/agents/*` (reference: `digitalocean/godo` `hosted_agents.go`, and doctl's
event renderer). Hivra uses that API directly.

## What Hivra adds: no terminal

A user pastes one DigitalOcean token. From then on everything happens in the
Hivra web UI:

1. **Connect** (`Infrastructure → Use my cloud account → DigitalOcean Managed
   Agents`). Hivra validates the token with a free, read-only call
   (`GET /v2/agents/sessions/sandbox/sizes`), encrypts it in the existing
   owner/connection/revision-bound v2 envelope, and publishes one serverless
   deployment target.
2. **Launch** Claude Code, Codex, or Hermes with a size, a model credential
   (vendor key, or DigitalOcean Inference key + model), and an optional first
   task. Hivra creates the session from a manifest with `permissions.default:
   ask`, waits for DigitalOcean to report READY, and sends the first task.
3. **Chat** on the agent page. Hivra relays DigitalOcean's SSE event stream
   (sanitized, resumable by `Last-Event-ID`), forwards messages, and shows
   approval requests as Approve/Reject buttons (DigitalOcean's HITL API,
   `RESOLUTION_SOURCE_OUT_OF_BAND`).
4. **Pause / resume / delete** from the same page. Sending a message resumes a
   paused session.

## Architecture (one platform, not another lane)

| Vision concept | DigitalOcean mapping |
| --- | --- |
| Infrastructure connection | `infrastructure_connections.provider = 'digitalocean'` (no SSH endpoint) |
| Capacity target | one `deployment_targets` row, `external_id = 'do-harness-runtime'`, `capabilities.kind = 'digitalocean-managed-agents'` |
| Isolation driver / class | `do-harness-microvm` / `provider-microvm` — **provider-attested**; Hivra did not measure the boundary, so it never claims `hardware-vm` |
| Agent computer | one `hivra_agents` row, `computer_substrate = 'do-managed-session'`, bound to the connection + target at the evidence revision |
| Run | one DigitalOcean run (`run_id` from `POST …/input`) |
| Responsibility | control plane: Hivra; credential custodian: Hivra (encrypted); spend owner and capacity operator: the user's DigitalOcean team |

Database guarantees (migration `20260923120000`):

- A dedicated `guard_hivra_do_managed_session` trigger admits a DigitalOcean row
  only as a fresh provisioning reservation against a ready DigitalOcean target at
  the current connection revision offering that harness and size. Identity is
  immutable; a session id binds once; a deleted row cannot be reused; the binding
  is released only with a cleanup receipt naming the bound connection, target,
  revision, and session.
- The session name is deterministic (`hivra-<agent id>`), so a lost create
  response is reconciled by name instead of creating a second billable session.
  Absence found by name is trusted only after a two-minute create window.
- DigitalOcean rows never carry `operation_id`, so the Proxmox stuck-operation
  sweeper cannot pick them up; the idle-park and error-purge sweepers already
  skip bound rows.
- The shared Proxmox authority trigger and every other substrate's constraints
  are unchanged; the substrate identity matrix is restated verbatim with one
  added branch (verified byte-for-byte against the previous definition).
- Hivra records each prompt it forwarded (`hivra_do_session_inputs`, service
  role only) because DigitalOcean's event log carries output, not the prompt.
- Disconnecting is refused while any agent on the connection is not deleted.

Security:

- The DigitalOcean token is decrypted only inside the session service for one
  call sequence and is never logged, returned, or put in an error message.
- Model keys go to DigitalOcean as write-only session secrets; Hivra never
  stores them. Vendor keys are pre-checked against Anthropic/OpenAI (as `doctl`
  does) so an unusable key does not create a billable session.
- Every mutation is same-origin, JSON, size-bounded, and rate-limited. The event
  relay whitelists event kinds and fields; native `source_raw` frames and
  unknown fields never leave the server.

## Known gaps

- **Unverified against the live API.** Wire shapes follow DigitalOcean's own
  Go client and doctl. Live acceptance steps: connect a preview team token; launch
  Codex with a first task; confirm streaming, a `bash` approval round trip,
  pause/idle/resume, delete, and absence in the DigitalOcean console.
- OpenCode, Cursor, LangGraph, and custom images are not offered (no Hivra
  catalog entries yet). Action Gateway tools, GitHub repo attach, checkpoints,
  forks, file transfer, and port forwarding (for example the Hermes dashboard on
  9119) are available in the API but not surfaced.
- One continuous conversation per agent, matching DigitalOcean's session model.
- History shows DigitalOcean's newest replay window (default 200 events,
  capped here at 1,000).
- The event relay reconnects every ~280 s (function duration); `EventSource`
  resumes from the last delivered id.

## Can Hivra build something similar?

Yes, and most of the substrate already exists. What DigitalOcean packaged is a
*session API*: create → stream canonical events → send input → HITL approvals →
pause/resume/fork → destroy, with per-second metering. Hivra has the pieces but
not that contract:

| DigitalOcean capability | Hivra today | Gap to close |
| --- | --- | --- |
| Isolated per-session sandbox | Proxmox KVM guests, provider VMs, gVisor sandboxes | Boot time: minutes for KVM clones vs ~0.9 s. gVisor (`runsc`) or Firecracker on the existing Proxmox hosts would get close |
| Pause / resume with memory | Stop/start (cold boot) | KVM `virsh suspend`/snapshot-to-RAM, or Firecracker snapshots, plus idle auto-pause |
| Canonical event stream | Per-runtime NDJSON adapters (`agent-adapters.ts`: claude stream-json, codex --json, generic) | Promote those adapters into one server-side `run.*` event schema with durable, resumable ids — the same schema this relay already renders |
| HITL approvals | None across runtimes | A box-side policy hook (Claude Code `PreToolUse` hooks, Codex approval policy) that emits `run.human_input_requested` and blocks until Hivra answers |
| Per-second billing | Plan/slot based | Meter active CPU from cgroup accounting on the host |
| Tool gateway | Per-box MCP seeding (`tool-mcp-seed.ts`) | A Hivra-hosted MCP broker with brokered credentials |

**Recommendation:** treat this integration's contract — `ManagedSessionEvent`,
the transcript reducer, approvals, and `ManagedSessionChat` — as the reference
"Hivra session API". Build a Hivra-native implementation behind the same
interface on the gVisor substrate first (fast start, application-kernel
boundary, already launchable), adding idle pause via checkpoint and a
Claude Code hook bridge for approvals. The chat UI and approval flow then work
unchanged for both DigitalOcean capacity and Hivra's own, which keeps the
"one platform" rule: the user picks where the session runs, not a different
product. This is target work and needs its own design review before it is
scheduled.
