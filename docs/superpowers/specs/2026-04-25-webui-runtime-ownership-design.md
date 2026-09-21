# WebUI Runtime Ownership Design

Date: 2026-04-25
Status: Approved for implementation

## Goal

Make Hermes dashboard easier to reason about by treating Hermes WebUI as the runtime source of truth for agent behavior, while keeping Hermes dashboard as the product, deployment, billing, auth, and credential control layer.

The user-facing rule should be simple:

- WebUI owns what the running agent does.
- Hermes owns how users deploy, pay for, access, and manage agents.
- Hermes bridges product-level choices into WebUI instead of keeping a second hidden runtime state.

## Current Problem

The dashboard is now able to deploy WebUI-backed instances, but the UI still mixes legacy gateway language, dashboard-owned state, and WebUI-owned state. This creates confusion around basic questions:

- Whether model/provider changes affect WebUI or only Hermes.
- Whether ChatGPT Codex auth is stored in WebUI, Hermes, or the old gateway.
- Which settings are purely visual dashboard preferences.
- Which advanced controls still use SSH/container management rather than WebUI APIs.

The desired end state is not to move every product feature into WebUI. It is to make runtime ownership explicit and consistent.

## Ownership Model

### WebUI-Owned Runtime Surfaces

For instances where `hermes_instances.backend = "webui"`, the dashboard should use WebUI APIs for:

- Chat sends and streaming.
- Session creation, loading, renaming, pinning, archiving, deletion, and history.
- Approval and clarification flows.
- Runtime settings exposed by WebUI `/api/settings`.
- Model catalog and active/default model selection.
- Provider runtime credentials exposed by WebUI provider APIs.
- Profiles exposed by WebUI profile APIs.
- Commands, memory, projects, workspaces, background jobs, personalities, and skills where WebUI has stable APIs.

Hermes should not create a parallel runtime state for these surfaces when a WebUI API exists.

### Hermes-Owned Product Surfaces

Hermes remains the owner of:

- Clerk auth and user access.
- Supabase instance records and lifecycle status.
- Billing, credits, subscriptions, usage accounting, and entitlements.
- Hetzner/Proxmox provisioning and host management.
- API Vault as the cross-agent encrypted credential store.
- Dashboard UI, navigation, onboarding, and plan-specific product flows.
- SFTP/file explorer, advanced console, and server operations until WebUI exposes safer equivalent APIs.
- Product-level integrations and channel setup where Hermes has stronger UX or billing constraints.

### Bridged Surfaces

Some features intentionally cross the boundary:

- API Vault remains in Hermes, but selecting a vault key for a WebUI-backed agent pushes the decrypted key server-side into WebUI's provider store.
- Codex OAuth remains launched and supervised by Hermes where necessary, but the resulting auth/session must be written into the WebUI runtime location that Hermes agent uses.
- Dashboard chat preferences like "show tool calls" remain Hermes UI preferences unless WebUI exposes an equivalent runtime setting.

## UX Rules

The dashboard should make the ownership model visible without adding explanatory clutter:

- WebUI-backed instances should show a small "WebUI runtime connected" state near runtime settings.
- Labels should not say "Gateway" when the request is going to WebUI.
- Controls that are not yet connected should either be hidden or clearly disabled.
- Model sync should say "Sync models from WebUI" instead of "Ping Gateway for Models."
- Runtime errors should say whether the failure came from WebUI, provider auth, server access, or dashboard state.

## Implementation Boundaries

Create one narrow WebUI runtime adapter in the dashboard server layer. Route handlers should call this adapter instead of reaching directly into mixed WebUI, gateway, SSH, and Supabase logic.

The adapter should cover:

- Resolve instance and construct authenticated WebUI client.
- Read/save runtime settings.
- List/set models.
- List/set providers and provider keys.
- List/create/update profiles.
- List/read/update sessions.
- Start/cancel/stream chat.
- Read/respond to approvals and clarifications.
- Expose feature availability for UI gating.

Legacy gateway behavior should stay intact for `backend = "gateway"` instances.

## Initial Wiring Priority

1. Runtime feature matrix and UI labels.
2. Model/provider/key flow.
3. Codex auth flow into WebUI runtime.
4. Profile settings.
5. Chat preferences and approval clarity.
6. Commands, memory, workspaces, projects, background jobs, and skills where WebUI APIs are stable.
7. File explorer and advanced console only after the runtime surfaces are clean.

## Verification

Each step should include:

- Focused unit tests for adapter routing and request payloads.
- Route tests for WebUI-backed and gateway-backed instances.
- UI tests for visible labels and disabled/connected states where practical.
- Full dashboard verification after each committed step.
- Live smoke against a WebUI-backed Hetzner instance before declaring the migration complete.

## Non-Goals

- Do not move billing or vault storage into WebUI.
- Do not remove legacy gateway support in this pass.
- Do not replace server management with WebUI until WebUI has stable APIs for the specific operation.
- Do not delete deployed test instances until the replacement path is verified.
