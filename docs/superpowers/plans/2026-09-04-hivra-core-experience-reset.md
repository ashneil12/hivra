# Hivra Core Experience Reset

**Date:** 2026-09-04

**Status:** Approved for the web/Canary execution scope below; Slice 0 complete

**Design authority:** [`../specs/2026-08-24-hivra-agent-computers-design.md`](../specs/2026-08-24-hivra-agent-computers-design.md)

**Supporting designs:** [`../specs/2026-08-26-hivra-infrastructure-onboarding-design.md`](../specs/2026-08-26-hivra-infrastructure-onboarding-design.md) and [`../specs/2026-08-31-hivra-remote-computers.md`](../specs/2026-08-31-hivra-remote-computers.md)

**Baseline:** private Canary revision `2ab6e31ac6a0dd6d59d9fb6cf46744c5929d021f`

**Owner approval:** 2026-09-04

**Authority:** Code implementation, Canary deployment, and bounded launch tests
on clearly identified Hivra-owned Canary capacity are authorized. Within those
checks, lifecycle actions may affect only disposable guest resources created for
the approved test and must produce exact cleanup and preservation evidence.
Native-app work, production or public release, provider-capacity purchase, trial
policy, host preparation, and unrelated or destructive live mutations are
excluded. This plan does not authorize deleting or modifying pre-existing hosts,
VMs, volumes, data, provider projects, or credentials.

## Outcome

Hivra should feel like one product with one obvious promise:

> Choose an agent or a computer, choose where it runs, and start using it.

A new user should not need to understand Proxmox, Docker, gVisor, nested
virtualization, pool arithmetic, or Hivra's internal product lanes before the
first launch. Hivra should select a safe compatible default, explain the result
in plain English, and expose technical controls only when the user asks for
them.

The simplification is an experience-layer decision, not permission to combine
unrelated identities, hide spending, mutate a server without consent, or treat
all isolation technologies as equivalent.

## Approved decisions

1. **Agent and Computer are sibling entry choices.** Launch Agent creates or
   selects an agent identity and gives it a computer. Launch Computer creates an
   OS environment with no agent required; attaching an agent later is explicit.
2. **There is one resumable Launch journey.** Runtime or OS selection, capacity,
   recommended setup, review, observed launch, and opening the result use one
   coherent flow.
3. **There is not one giant launch side effect.** Connection, provider purchase,
   host preparation, target admission, and resource launch retain separate
   confirmation and evidence boundaries.
4. **Hivra Cloud is the fastest default when available.** A user can instead use
   their provider account or a server they control without entering a separate
   product lane.
5. **Self-hosted Hivra requires no Hivra Cloud account.** It still has a local
   operator identity and login. Optional Cloud linking must not silently merge
   local identity, data, or secrets.
6. **Simple mode is genuinely simple.** It uses a workload-aware recommended
   allocation and strongest accepted isolation. Advanced mode is a disclosure,
   not a parallel wizard.
7. **The existing agent catalogue and native runtime surfaces remain.** The
   revamp does not flatten Codex, Hermes, Claude Code, or other runtimes into one
   generic chat UI.
8. **Ubuntu is the first complete computer path.** Omarchy follows its own native
   interaction and performance gate. Windows follows a separate licensing,
   image, RDP, recovery, and cleanup gate. macOS guests require legitimate Apple
   hardware and a compliant operating design.
9. **Web Canary is the reference product first.** The existing Mac Alpha remains
   a thin client of the same control plane. Signing, notarization, Windows client
   work, and deeper native transport are later delivery gates.
10. **Multi-agent orchestration follows real single-resource primitives.** It is
    an operator surface over durable tasks, runs, agents, and computers, not a
    new simulated agent model.

## Inputs and current baseline

This approved plan was derived from the owner's 2026-09-04 end-to-end brief, prior
Hivra product conversations, `VISION.md`, `docs/PRODUCT-ARCHITECTURE.md`, the
canonical designs, `ROADMAP.md`, `WHITEPAPER.md`, `LITEPAPER.md`, current code,
and a read-only Canary walkthrough.

### Current and verified

- The dashboard already has a top-level Launch entry with separate Agent and
  Computer columns.
- The current agent catalogue exposes established runtime choices and preserves
  their native paths.
- Launch is not yet one implementation. The large Welcome flow still contains
  separate legacy Hermes, CLI-agent, dashboard-agent, and Ubuntu-computer paths.
- The current infrastructure surface represents Hivra Cloud, a Hetzner project,
  and an existing SSH/Proxmox host.
- Hivra Cloud and bounded Hetzner-to-agent paths have real lifecycle evidence at
  their recorded revisions.
- Ubuntu Desktop has a managed/Proxmox launch path and a bounded Selkies browser
  video, input, reconnect, restart, revocation, and teardown checkpoint.
- Self-hosted Hivra already uses installation-local operator authentication and
  encrypted `.hivra` backup/restore without requiring a Hivra Cloud account.
- A thin Mac Alpha exists and can point at Local Hivra, Canary, or a custom
  control plane. It is not a signed and notarized public release.
- Apache-2.0 is committed. Public-source publication still requires the exact
  immutable-export review and final release-approval gate.
- The current Ubuntu computer is still represented through the Hivra-agent
  storage lane. The UI mentions adding an agent later, but no attach-agent API or
  completed user path currently exists.

### Current experience problem

The top-level model is close, but the next screens expose too much at once.
During the 2026-09-04 Canary walkthrough:

- Codex setup showed model-auth variants, naming, destination selection,
  browser automation, CPU choices, RAM choices, capacity arithmetic, security
  detail, and launch on one long surface.
- Ubuntu setup mixed the active launch form, capacity selection, computer
  inventory, and future OS catalogue on one page.
- The code has separate and partially overlapping agent and computer catalogues,
  while the more canonical AgentComputer layer remains a compatibility
  projection rather than the persisted write authority.
- Infrastructure correctly preserved safety boundaries, but its primary view
  mixed summary metrics, operational caveats, managed-plan detail, and three
  connection journeys before the user had chosen a goal.
- Empty Home devoted large areas to empty recent-session, attention, inventory,
  and activity panels instead of leading the first useful action.

The immediately preceding attempt to unify launch and fleet presentation was
reverted by `2ab6e31ac`. It increased density, mixed agent and desktop
categories, and added infrastructure explanation to the catalogue. This plan
does not restore that commit.

### Target, not current capability

- A beginner-complete first-run experience across every operating mode.
- Generic Linux/bare-metal automatic preparation across arbitrary hosts.
- A portable whole-computer export including remote disks and snapshots.
- Attaching an agent to an existing computer.
- Daily-driver, sub-100-ms remote-computer performance.
- Launchable Omarchy, Windows, macOS, or arbitrary custom OS images.
- A Windows client or signed/notarized public Mac app.
- Linking a self-hosted control plane to Hivra-managed capacity or account-bound
  services.
- Conductor-style durable multi-agent orchestration.
- A free trial or approved card/abuse/billing policy.

## Keep the operating axes separate

The UI can make these choices feel related without conflating them in data or
authorization:

| Axis | Choices |
| --- | --- |
| Client | Web/PWA, Mac Alpha, future signed Mac client, future Windows client |
| Control plane | Hivra-hosted, self-hosted |
| Capacity owner | Hivra, customer's cloud project, customer's existing host |
| Resource | Agent, Computer |
| Payload | Runtime profile, OS profile |
| Access surface | Native runtime UI, chat, terminal, files, browser, desktop |

The present `self-managed` versus `hivra-managed` vocabulary is insufficient on
its own because a customer can use Hivra's hosted control plane with
customer-owned capacity. Product copy should use two independent choices:

- **Control plane:** Hivra-hosted or Self-hosted Hivra.
- **Capacity:** Hivra Cloud capacity, My cloud, or My server.

The supported matrix is capability-gated:

| Control plane | Capacity | Current boundary |
| --- | --- | --- |
| Hivra-hosted | Hivra Cloud capacity | Existing managed paths |
| Hivra-hosted | My cloud | Bounded Hetzner agent-on-direct-provider-VM path |
| Hivra-hosted | My server | Prepared Proxmox path; exact target acceptance still applies |
| Self-hosted Hivra | My cloud or My server | Only adapters accepted by the self-host release contract |
| Self-hosted Hivra | Hivra Cloud capacity | Target integration; not current behavior |

This matrix states responsibility rather than assuming that Hivra operates the
control plane whenever the customer supplies capacity.

Those UI labels are projections over independently persisted responsibility,
not replacement operating modes by themselves. For each capacity resource and
operation, the contract records the control-plane operator, infrastructure-
credential custodian, spend owner, capacity operator, upgrade/monitoring/recovery
owner, and support party. Defaults may come from an approved offering, but no
single `self-managed` or `hivra-managed` value may silently assign all six. Keep
the legacy labels as compatibility inputs until their records are migrated and
reconciled.

## Core experience

### 1. First arrival

Hosted web users authenticate because the hosted service is multi-tenant and may
manage paid resources. A first-time empty Home shows one short explanation and
two actions:

- **Launch an agent**
- **Launch a computer**

It does not show empty fleet analytics, activity history, or an infrastructure
course before the first choice. Returning users instead see Continue, resources
that need attention, and recent agents/computers. Empty sections disappear.

Self-hosted setup creates an installation-local operator. Copy must say **No
Hivra Cloud account required**, not **No login required**. Linking a Hivra Cloud
account is optional and appears only when the user asks to use Hivra-managed
capacity or another account-bound service.

### 2. One Launch journey

The journey is resumable and has five conceptual stages. The UI may combine
stages when a safe default makes a choice unnecessary.

```text
Agent or Computer
  -> runtime or OS profile
  -> where it runs
  -> review the recommended plan
  -> launch and open
```

Rules:

- Select the resource type before showing a catalogue.
- Show only agent runtimes after Agent and only OS profiles after Computer.
- If one accepted capacity source is available, preselect it and show a compact
  `Runs on ... · Change` row.
- If capacity is missing, add it inline and return to the same saved draft.
- Autogenerate a useful name. Rename remains available before or after launch.
- Show one recommended resource allocation. A `Change` disclosure opens
  compatible choices; the default is not the maximum available capacity.
- Collect a model or runtime credential only at the boundary where it is needed.
  Prefer a runtime's supported native sign-in when that avoids copying a secret
  through Hivra.
- Keep exact cost, isolation class, data location, expected mutations, and any
  downtime visible on the final review.
- The primary action has one stable label: **Launch**. Preparation or purchase
  that needs its own consent receives its own preceding confirmation.
- Progress comes from durable provider/runtime events. Never infer a percentage
  from elapsed time or optimistic copy.
- On success, open the best accepted surface immediately. Do not return the user
  to an inventory page and make them find the new resource.

### 3. Agent result

Launching an agent creates or selects an agent identity, creates or selects a
computer, persists an explicit primary binding, installs the selected runtime
adapter, and opens its Hivra or native interface. A computer has at most one
primary agent identity in the first release; zero remains valid. The identity,
computer, binding, and runtime installation are distinct records so each can be
recovered, revoked, upgraded, or migrated without inventing another resource.

An identity already bound to a computer is never silently rebound. The journey
offers either to open/use its existing computer or to begin an explicit
migration. Migration review names the source and target computers; the user-data,
artifact, secret, and credential-binding transfer policy; stale-access
revocation; the old computer's preserve, stop, or separately confirmed delete
disposition; and rollback before any mutation.

The first release permits at most one primary Hivra agent identity and its
selected runtime installation per isolated computer in either operating mode.
Installing another user-managed tool inside a desktop does not create a
separately isolated Hivra agent. Any future Advanced same-trust-domain
multi-runtime mode needs its own design and must not be described as equivalent
to per-agent isolation.

### 4. Computer result

Launching a computer creates an OS environment with Desktop, Files, Terminal,
and Manage where those capabilities are accepted. No agent is required.
Attaching an agent later is a separate explicit action that shows the access the
agent will gain.

### 5. Return and manage

Home and inventory show the same canonical resources regardless of where they
were launched. Each resource has one primary **Open** action. Lower-frequency
operations live under Manage:

- start, stop, restart;
- resize when the adapter supports it;
- snapshot, backup, and restore when supported;
- update or repair;
- export or move when supported; and
- delete with exact provider-residue reconciliation.

Controls are derived from the selected resource's capabilities. An unavailable
operation is not rendered as an optimistic button.

### 6. Visual and interaction rules

- Preserve Hivra's dark textured/Vellum language, restrained red signal color,
  etched borders, and distinctive typography. The reset is not a generic SaaS
  reskin.
- Fit the current decision, its short explanation, and the primary action in the
  initial desktop viewport. Large type must not push the task below the fold.
- Use spacing, type, and disclosure for hierarchy before adding another card,
  eyebrow, status tag, metric, or divider.
- Show one primary action per state. Repeated Launch, Manage, or Continue actions
  with the same destination are removed.
- Reserve status colors for observed state. Decorative red must not make a safe
  idle surface look failed or urgent.
- Design empty, loading, blocked, expired, failed, resumed, cleanup, and partial-
  capability states with the same care as the successful launch.
- Keep keyboard order, visible focus, screen-reader names, contrast, reduced
  motion, zoom, and 360-pixel mobile operation in every acceptance pass.
- Do not render empty analytics or disabled future catalogues in the first-run
  path. Preview and planned products live in an optional Explore surface.

## Approved target launch contract

One UX should be backed by one provider/runtime-neutral orchestration contract,
with compatibility adapters around current lanes rather than a ground-up
rewrite.

### Persisted domain before cutover

The product label **Computer** maps to the canonical `AgentComputer` entity with
zero bound agent identities and zero agent runtime installations. It must not
create another backend Computer lane. Launch Agent creates or selects an
`AgentIdentity`, creates or selects its `AgentComputer`, and persists an explicit
binding and runtime installation.

Before the compatibility projection becomes write authority, define and migrate:

- canonical computer and agent-identity IDs;
- resource kind, OS profile, runtime installation, capacity target, and current
  primary-agent binding;
- legacy Hermes/Hivra ID mappings and backfill rules;
- one per-entity write authority during every migration stage;
- transaction/outbox rules for provider operations and normalized events;
- continuous reconciliation and parity evidence;
- cutover gates, rollback, and legacy-write retirement; and
- capability-gated lifecycle commands, including resize, snapshot, and restore
  rather than optimistic global controls.

The current `dashboard/src/lib/agent-computers/` model remains a compatibility
adapter until those gates pass.

### `LaunchDraft`

Client-safe, resumable intent:

- schema version and draft revision/hash;
- control-plane/installation binding and, after authentication, owner binding;
- resource kind: `agent` or `computer`;
- runtime or OS profile;
- agent identity intent: create new or bind an existing owner-visible identity;
- selected capacity reference, if any;
- recommended or explicit resources;
- optional presentation name; and
- outstanding prerequisites.

It contains references, not reusable provider or model secrets. A pre-auth draft
may remain local to the client; a server-persisted draft is installation- and
owner-bound and cannot be claimed by another account.

### `LaunchPlan`

A short-lived server-generated review of the exact draft:

- target and current capability evidence;
- provider/runtime/OS adapter revisions;
- selected isolation class;
- resource allocation and remaining headroom;
- live or contractually fixed price evidence where spending applies;
- credentials or native sign-ins still required;
- connection, purchase, preparation, and launch operations required;
- expected host/provider mutations and downtime; and
- blockers, expiry, and safe alternatives.

The plan binds the owner, control plane/installation, draft hash, adapter
revisions, evidence revisions, schema version, and expiry. Any material input
change invalidates it and requires a new review.

### `LaunchOperation`

Every side effect has its own owner-bound, idempotent operation identity and
receipt. The user experiences one journey, while Hivra preserves distinct
operations for:

1. connection validation and discovery;
2. capacity purchase, when explicitly requested;
3. host preparation, when explicitly approved;
4. strict target admission;
5. computer provisioning;
6. runtime installation or agent binding; and
7. access issuance and opening.

The target invariant is that retries resume the same operation and never create
another server, computer, agent, DNS record, credential, or billable resource by
accident. This is not assumed from an idempotency field; it must pass the real
resume acceptance below.

`LaunchOperation` complements rather than replaces the canonical computer
desired/observed/health/operation axes and the run delivery/execution axes. The
simplified flow must not introduce another overloaded `status` field.

## Capacity and isolation

### Hivra Cloud

- Default when the account has accepted managed capacity.
- Present a friendly recommended size rather than physical-host inventory.
- Reuse the same launch, lifecycle, backup, access, and recovery contracts used
  by self-managed adapters.
- State honestly that Hivra operators retain infrastructure access; do not make a
  cryptographic zero-access promise the architecture does not provide.

### My cloud: Hetzner first

- A project token first validates and discovers; connection alone spends
  nothing.
- Existing servers remain separate from the in-product create-capacity action.
- Creating a server requires a current price observation and explicit billing
  confirmation.
- Ordinary Hetzner Cloud VMs are direct provider VMs, not nested Proxmox hosts.
- Workloads use only the isolation drivers accepted for that exact node and
  runtime. Docker/OCI describes packaging and process machinery, not the
  isolation class. The disclosed boundary comes from the provider VM, KVM guest,
  gVisor application-kernel sandbox, or shared-kernel container actually used.
- Provider resize remains hidden until the complete resize, persistence,
  rollback, billing, and recovery contract passes.

### My server: existing Proxmox, Linux, or bare metal

```text
connect
  -> read-only inspect
  -> explain what is supported
  -> show an exact preparation plan
  -> obtain approval for mutations or reboot
  -> prepare
  -> strict fresh readiness check
  -> publish launchable capacity
```

An existing Proxmox target can use the current KVM adapter after that exact
target passes strict admission. A generic Linux or bare-metal host stays
unavailable until an adapter proves its real isolation and lifecycle. Hivra may
recommend Proxmox, a provider VM, an application-kernel sandbox, or an
explicitly labelled shared-kernel option based on facts; it does not hard-code
one answer from the provider name.

If no approved real bare-metal test host is available, build contract tests and
the disabled UX, then label the path **Unverified**. “Should theoretically work”
is not a launch claim.

## Self-host identity and recovery

Retain and productize the implemented primitives before inventing a second
identity system:

- installation-local operator authentication;
- local master-key creation and rotation;
- encrypted authenticated `.hivra` export protected by a user-held passphrase;
- deterministic restore into a fresh supported installation; and
- explicit cleanup of owned temporary state.

The recovery experience separates two truthful artifacts:

1. **Hivra recovery backup** — control-plane database, agent identities,
   configuration, local storage, encrypted credential bindings, and manifests.
2. **Computer data backup** — provider snapshots, volumes, or portable archives
   for each actual remote computer.

The first artifact does not currently contain remote computer disks. Hivra must
not promise “take everything anywhere” until both artifacts can be restored,
provider credentials can be rebound, computers can re-enrol under fresh
identity, stale access can be revoked, and old resources can be reconciled or
removed.

An optional Hivra account may store or synchronize a client-encrypted backup in
the future, but that needs a separate threat model and recovery design. It must
not create a universal Hivra master key.

## Remote computers and operating systems

### Ubuntu

Ubuntu is the golden computer profile. Its complete release gate includes real
launch, desktop, terminal, files, restart, reconnect, saved data, access
revocation, recovery, supported resize/snapshot behavior, and zero-residue
deletion. Attaching a Hivra-managed agent is a separate acceptance gate.

The current browser desktop checkpoint is valuable but does not establish
daily-driver performance. Run the existing `UC-DESKTOP-01` comparison with raw
input-to-frame and physical input-to-visible evidence. Prefer accepted Selkies
for browser access, an accepted Sunshine/Moonlight path for the native
performance reference, and the current console only for repair.

### Omarchy

Keep Omarchy visibly in Preview until its actual compositor, native private
route, pairing, video, input, audio, reconnect, revocation, reboot, recovery,
latency, and teardown pass on the exact image and transport revision. Do not
claim that a separate X11 session exposes the real Hyprland desktop.

### Windows

Windows is the next guest OS after the Linux computer contract is stable. It
requires a licensed reproducible image, update policy, activation handling,
guest identity, RDP hardening, browser gateway and native-client paths,
clipboard/file policy, lifecycle, persistence, recovery, resize, and teardown.
No Windows card becomes launchable before `UC-WINDOWS-01` passes.

### macOS and custom images

macOS guests remain later work on legitimate Apple hardware. Debian, custom
Linux, and user-supplied images belong in Advanced mode only after image trust,
boot, identity, networking, update, access, recovery, and cleanup contracts are
reusable.

## Multi-agent orchestration

Use publicly documented Conductor behavior only as competitive research input.
Independently design Hivra's terminology, UI, contracts, and implementation; do
not copy Conductor code, assets, prose, exact layouts, shortcuts, or trade dress,
and do not imply affiliation or compatibility.

Its public release history suggests a useful sequence: create, work, inspect,
steer, and verify before adding cloud, APIs, collaboration, and desktop control.
That is an inference from releases, not Conductor's stated roadmap. Hivra's
intended differentiator is that each agent can operate inside a persistent,
provider-neutral computer with an infrastructure-enforced boundary.

The products are not equivalent. Conductor's Cloud Computer is an
organisation-wide development base environment, not Hivra's intended
per-resource cloud-computer model. Its local workspaces isolate Git state rather
than the Mac user's system authority, and its September 2026 remote desktop
control remains experimental.

Later orchestration should provide:

- one obvious dispatcher;
- durable tasks and runs with distinct delivery and execution state;
- orchestration truth persisted outside chat transcripts;
- attention states such as needs input, review ready, failed, and asleep;
- persistent conversations, terminal state, logs, artifacts, and build history;
- steering without losing the original run identity;
- explicit computer, branch, authority, budget, network, and credential scope;
- isolated computers by default, with shared state only when deliberately
  selected; and
- API primitives for create, prompt, status, events, cancel, follow-up, sleep,
  archive, and restore.

An agent may never create another agent/computer with more authority than it was
given. Agent-created spending, networking, credentials, persistence, and
replication require explicit policy and remain independently revocable. Models
may propose risky mutations, but deterministic policy code gates spending,
deployment, merge, deletion, networking, and replication. The orchestration UI,
scheduler, task/run state, and APIs belong in the self-hostable functional core,
not a hosted-only edition. This surface stays out of the core release until
durable single-agent execution and recovery are real.

Research references: [Conductor changelog](https://www.conductor.build/changelog),
[workflow](https://www.conductor.build/docs/concepts/workflow),
[parallel agents](https://www.conductor.build/docs/concepts/parallel-agents),
[cloud computer](https://www.conductor.build/docs/cloud/cloud-computer),
[security and permissions](https://www.conductor.build/docs/reference/security-and-permissions),
and [API](https://www.conductor.build/docs/api).

## Client delivery

- Build and accept the experience on Canary web/PWA first.
- Preserve the Mac Alpha as a thin client with separate Local, Hivra Cloud, and
  Custom profiles.
- Do not fork launch rules, identity, provider logic, or resource state into the
  native app.
- Harden, sign, notarize, install, update, and recover the Mac client only after
  the web path is stable.
- A future Windows client uses the same API and state contracts. Windows client
  support and Windows guest support are separate milestones.
- Native streaming, fullscreen, keyboard, display, audio, and reconnect logic
  can be platform-specific where a web wrapper cannot deliver the accepted
  experience.

## Trial and pricing decision

A free trial is a separate commercial and abuse-risk decision, not an assumed
feature of this plan. Before implementation, decide and test:

- whether a card or payment-method verification is required;
- trial duration, compute allowance, region, and accepted profiles;
- concurrent computer, CPU, RAM, storage, network, and model-spend limits;
- abuse, fraud, crypto-mining, outbound-network, and signup controls;
- warning, suspension, backup, conversion, deletion, and charge timing;
- the exact price shown before launch and resize; and
- what happens to work at trial end.

The first technical slice may use an allowlisted internal plan. Public trial
copy stays absent until the commercial contract and destructive end-of-trial
behavior are approved and accepted.

## Relationship to the active roadmap

The owner approved this delivery order for web/Canary execution on 2026-09-04.
The canonical design and active `ROADMAP.md` now carry the same crosswalk. The
original agent-first portable path and its Phase 1/3 acceptance gates remain
unchanged. A new shell, managed Agent launch, or Ubuntu launch may run behind a
flag or in parallel, but may not remove the working original path before parity,
replace `UC-PORTABLE-AGENT-01`, or close any public-release gate with visual or
simulated evidence.

| Approved slice | Active-roadmap relationship |
| --- | --- |
| Slice 0 | Phase 0 product truth and governance; completed by the aligned 2026-09-04 source-of-truth amendments. |
| Slice 1 | Consolidates Phase 2 contracts and adds a gated presentation shell; Phase 1 portable closure continues independently. |
| Slice 2 | Runs the managed-agent part alongside Phases 1/3 and the Ubuntu-computer part alongside Phase 8; neither substitutes for `UC-PORTABLE-AGENT-01`. |
| Slice 2B | Adds a binding milestone between Phase 5 runtime consolidation and Phase 8 computer use; it does not collapse Computer into Agent. |
| Slice 3 | Carries forward the Phase 1/3 customer-owned-capacity reference path and its unchanged acceptance. |
| Slices 4A–4C | Split Phase 4 into control-plane recovery, computer-data portability, and optional account linking; Slice 4B also supplies evidence needed by Phase 8 mobility. |
| Slice 5 | Carries forward Phase 8 Linux desktop acceptance. |
| Slice 6 | Carries forward the Windows-guest part of Phase 9. |
| Slice 7 | Is a client-release track over accepted APIs; it does not make a guest OS or backend capability available. |
| Slice 8 | Carries forward Phase 7 durable tasks and coordination after real single-agent execution; changing its relationship to optional Phase 6 needs explicit documentation approval. |

Slice 0 aligned `VISION.md`, `docs/PRODUCT-ARCHITECTURE.md`, the canonical design,
`ROADMAP.md`, and this plan. Slice 1 and later remain target work until their
implementation and evidence gates pass.

## Delivery slices

Each slice leaves a usable vertical path and has an evidence gate. UI work,
adapter work, and performance experiments may run in parallel, but a later slice
cannot claim support from an earlier mock.

### Slice 0 — Reconcile product truth

**Status:** Complete — 2026-09-04

- [x] Approve this decision record for the bounded web/Canary execution scope.
- [x] Amend `VISION.md`, `docs/PRODUCT-ARCHITECTURE.md`, the canonical design,
  and `ROADMAP.md` to make Computer a first-class sibling entry, adopt the
  accepted slice order, and retain separate Agent and Computer semantics.
- [x] Preserve the original portable acceptance unchanged and label unimplemented
  Agent, Computer, provider, recovery, OS, client, and orchestration work as target.
- [x] Record exact execution authority and excluded live, commercial, native-app,
  production, and publication actions in every source-of-truth document.
- [x] Keep whitepaper ecosystem ideas and token policy outside the core build plan.

**Exit passed:** one approved journey, vocabulary, capability-status scheme,
execution crosswalk, authority boundary, and acceptance matrix are aligned; no
source-of-truth document markets target behavior as current.

### Slice 1 — Launch contract and state-aware shell

- Define `LaunchDraft`, `LaunchPlan`, and receipt-bearing operations.
- Define the canonical Computer, AgentIdentity, runtime-installation, capacity,
  and binding schema plus migrations, legacy-ID mapping, outbox, per-entity write
  authority, reconciliation, cutover, and rollback.
- Extend the existing `dashboard/src/lib/agent-computers/` compatibility
  projections with truthful `linux-desktop` and capability handling; promote
  them to the inventory/lifecycle boundary only after backfill and parity gates
  pass.
- Wrap the current Hermes, Hivra-agent, and Ubuntu routes with compatibility
  adapters; do not merge their backing stores before parity evidence exists.
- Persist the draft across authentication, capacity setup, refresh, and retry.
- Build the state-aware empty/returning Home and the five-stage Launch shell.
- Put technical settings behind one Advanced disclosure.
- Add loading, blocked, expired-plan, failed, cancelled, resumed, and cleanup
  states before polishing the successful state.

**Exit:** `UC-DOMAIN-MIGRATION-01` proves the real schema/backfill/cutover/rollback
contract on representative Hermes, Hivra-agent, and `linux-desktop` rows. Fake-
provider/runtime conformance tests prove both resource kinds use one contract
without sharing identity or side effects. Browser tests prove one primary action
per stage and resumable prerequisites. This is not yet real provider idempotency
acceptance.

### Slice 2 — Hivra Cloud golden paths

- Run Agent through one mature catalogue runtime and its native interface.
- Run Computer through Ubuntu Desktop.
- Reuse the same computer inventory and capability-gated Manage surface.
- Add recommended sizing and post-launch resize only where accepted.
- Exercise model/native login at the exact supported boundary.

**Exit:** `UC-FIRST-RUN-01`, `UC-LAUNCH-AGENT-01`,
`UC-LAUNCH-COMPUTER-01`, and `UC-LAUNCH-RESUME-01` pass on the exact Canary
revision with persistence, restart, revocation, and cleanup evidence. The same
contracts also pass the bounded self-host conformance harness so the write model
cannot become hosted-only.

### Slice 2B — Attach an agent to an existing computer

- Add explicit owner-visible agent identity selection and binding persistence.
- Show the files, terminal, browser, network, credentials, and other computer
  access the runtime will receive before confirmation.
- Enforce at most one primary Hivra agent identity in v1, with its selected
  runtime installation represented and revoked separately.
- Implement attach, detach, revoke, restart, recovery, export, and deletion
  semantics without deleting the computer or losing unrelated user data.
- Distinguish a Hivra-managed agent binding from software the user installs
  manually inside their desktop.

**Exit:** `UC-ATTACH-AGENT-01` proves the exact binding, disclosed authority,
runtime work, competing-attach rejection, cross-owner denial, detach/revoke,
restart/recovery, and preservation of the computer's pre-existing user bytes.

### Slice 3 — Customer-owned capacity

- Integrate the saved Launch draft with Hetzner discovery and explicit
  create-capacity review.
- Converge existing Proxmox launch through the same plan and operation receipts.
- Keep generic Linux/bare metal in inspected/preparation/unverified states until
  real adapters and targets pass.
- Make spending, preparation, and reboot confirmations explicit without turning
  them into separate product journeys.

**Exit:** `UC-PORTABLE-AGENT-01`, `UC-HETZNER-CAPACITY-01`, and
`UC-EXISTING-HOST-01` pass on explicitly approved disposable targets, including
failure recovery, removal of every resource created or owned by each test
operation, and proof that pre-existing hosts, VMs, volumes, and data were
preserved.

### Slice 4A — Self-host control plane

- Turn the current self-host scripts into the supported guided installation.
- Finish clean-install, upgrade, encrypted backup, restore, key rotation,
  diagnostics, export, and uninstall UX.
- Verify uninstall removes only installation-owned local state and preserves
  external provider capacity unless the operator separately requests and
  authorizes its deletion.

**Exit:** `UC-SELFHOST-RECOVERY-01` restores the encrypted `.hivra`
control-plane artifact on a fresh installation, verifies its expected database
and object bytes, rotates identity, and reconnects to preserved external
capacity without private Hivra intervention or ambient Hivra credentials.
`UC-SELFHOST-LAUNCH-01` then uses a fresh supported installation, local operator,
approved real capacity, and user-owned credentials to launch a supported agent,
open its real interface, perform useful work, reconnect/restart, and delete it
with scoped cleanup and no Hivra Cloud account.

### Slice 4B — Computer data portability

- Define provider-specific snapshot, volume, and portable-archive contracts.
- Back up one supported computer's user data and bind the artifact to its exact
  source identity, adapter, encryption, and integrity evidence.
- Restore onto a fresh supported computer, re-enrol it under fresh identity,
  revoke stale access, and verify persisted user bytes.
- Keep removal of the old computer/resources a separate, explicitly scoped
  operation after restore acceptance.

**Exit:** `UC-COMPUTER-RECOVERY-01` separately restores a supported remote
volume/snapshot/archive, verifies expected user-byte hashes after reboot and
reconnect, and preserves every unrelated provider resource.

### Slice 4C — Optional Hivra Cloud linking

- Write the account-link threat model first. It must define installation-to-
  tenant/account mapping; authentication and token scope, audience, expiry, and
  rotation; resource and operation ownership; infrastructure, provider, model,
  and backup-key custody; the exact metadata/content uploaded or synchronized;
  billing and spend responsibility; and support or break-glass access.
- Link a self-hosted installation only for explicitly selected account-bound
  services; do not merge local owner identity or upload secrets by default.
- Define offline, partial-link, service-outage, account-compromise, lost-token,
  unlink, revocation, relink, and disaster-recovery behavior before integration.
- Prove revocation/unlink removes Hivra-side authority and stale access while
  leaving the self-hosted installation, local identity, and locally owned data
  usable. Provider/model credentials remain where the approved custody contract
  places them; linking does not silently transfer them to Hivra.

**Exit:** `UC-SELFHOST-CLOUD-LINK-01` passes the approved threat model and
link/unlink/offline/compromise/recovery journeys, billing attribution, ownership
reconciliation, and data-transfer audit without creating a universal Hivra
master key.

### Slice 5 — Daily-driver Linux computer

- Run `UC-DESKTOP-01` on equal disposable guests and relevant network
  conditions.
- Select browser and native transports from real capability and measurements.
- Validate real work: terminal typing, IDE/browser use, scrolling, scaling,
  clipboard opt-in, fullscreen, reconnect, sleep/wake, restart, and saved data.
- Admit Omarchy only after its separate native route passes.

**Exit:** Ubuntu has a recorded, revision-bound supported performance profile;
all other profiles remain labelled with their measured limits. Publicizing the
result remains a separate release action.

### Slice 6 — Windows guest

- Resolve image/licensing/distribution and operational policy.
- Implement the Windows provider, guest identity, RDP, browser/native access,
  update, recovery, and teardown contracts.
- Verify agent installation/attachment separately from plain computer use.

**Exit:** `UC-WINDOWS-01` passes launch through cleanup and the user can evaluate
real interaction speed on the accepted client/region profile.

### Slice 7 — Native client release

- Harden and release the Mac client against the accepted shared APIs.
- Build a Windows client only where it improves installation, native transport,
  keyboard/display handling, or local self-host control over the web/PWA.
- Keep local and hosted profiles visibly separate.

**Exit:** signed artifacts install, update, reconnect, preserve profiles, and
complete the same accepted journeys without client-specific product state.

### Slice 8 — Orchestrate

- Define durable Task, Run, delegation, authority-lineage, budget, and attention
  contracts.
- Build one real two-agent/two-computer workflow before any fleet theatre.
- Add shared-project state only where explicit coordination needs it.
- Enforce cost, wall-time, concurrency, repeated-error, stale-heartbeat, and
  no-progress stops outside model discretion.

**Exit:** `UC-ORCHESTRATE-01` survives refresh, disconnect, one agent failure,
steering, approval, bounded-stop activation, and recovery with factual events
and one terminal outcome per run.

## Acceptance matrix

These checks are additive to the canonical acceptance definitions. In
particular, `UC-PORTABLE-AGENT-01` remains unchanged and includes both operating
modes, user-owned runtime/model credentials, full lifecycle, durable
delivery/execution events and artifacts, induced failure/recovery, and scoped
cleanup. A short row here does not weaken that contract.

| Check | Required behavior |
| --- | --- |
| `UC-DOMAIN-MIGRATION-01` | Migrate representative Hermes, Hivra-agent, and `linux-desktop` rows to stable canonical IDs, relationships, and capabilities; preserve lifecycle/access/history; reconcile parity; cut over with one write authority; reject duplicate writes; and roll back safely. |
| `UC-FIRST-RUN-01` | Fresh hosted user reaches a real useful resource from the empty state without visiting a separate infrastructure dashboard or opening Advanced settings. |
| `UC-LAUNCH-AGENT-01` | Select one supported agent, use recommended capacity, authenticate through its accepted path, perform real work, reconnect, restart, and delete cleanly. |
| `UC-LAUNCH-COMPUTER-01` | Launch Ubuntu with recommended capacity, open the real desktop/files/terminal, persist a file, reconnect/restart, revoke access, and delete cleanly. |
| `UC-LAUNCH-RESUME-01` | On a real disposable target, survive double submit, lost acknowledgement after allocation, refresh, authentication handoff, stale/expired plan, concurrent retry, and cross-account replay rejection without duplicate or leaked resources. |
| `UC-ATTACH-AGENT-01` | Bind one owner-visible agent identity to an existing computer after access review, perform real work, reject a competing attach and a cross-owner binding, detach/revoke it, and preserve the computer and its pre-existing user bytes. |
| `UC-PORTABLE-AGENT-01` | Apply the full canonical definition unchanged; this plan adds the simplified Launch journey without replacing any BYOK, runtime, lifecycle, event, artifact, failure, or cleanup requirement. |
| `UC-HETZNER-CAPACITY-01` | Prove the supported agent-on-direct-provider-VM path: connect without spend; show current price; create only after confirmation; prepare, launch, recover, remove every test-operation-owned resource, and preserve all pre-existing project resources. Ubuntu graphical desktop remains a separate adapter/gate. |
| `UC-EXISTING-HOST-01` | On a prepared Proxmox target: read-only inspect; exact preparation review; explicit mutation authority; strict readiness; launch; lifecycle; rollback/cleanup; preserve unrelated VMs, volumes, host configuration, and data. Generic Linux/bare metal remains unverified. |
| `UC-SELFHOST-RECOVERY-01` | Install without a Hivra Cloud account, export the encrypted `.hivra` control-plane artifact, restore it on a clean controller, verify expected database/object bytes, rotate identity, reconnect preserved capacity, and prove no hidden Hivra dependency. |
| `UC-SELFHOST-LAUNCH-01` | From a fresh supported self-host installation, use a local operator, approved real capacity, and user-owned provider/runtime credentials to launch one supported agent, open the real interface, do useful work, reconnect/restart, delete with scoped cleanup, and prove no Hivra Cloud account or ambient Hivra credential was used. |
| `UC-COMPUTER-RECOVERY-01` | Separately restore one supported remote volume/snapshot/archive onto a fresh computer, re-enrol it, revoke stale access, verify expected user-byte hashes after reboot/reconnect, and preserve unrelated resources. |
| `UC-SELFHOST-CLOUD-LINK-01` | Link only approved account-bound services after threat-model review, then revoke/unlink and prove local identity, data ownership, recovery, and standalone operation remain intact. |
| `UC-RESIZE-01` | Show supported change and downtime/cost, reject over-allocation, preserve data, reconcile actual capacity, and recover or roll back failure. |
| `UC-DESKTOP-01` | Preserve the canonical raw browser and optical latency, quality, reconnect, isolation, and teardown evidence requirements. |
| `UC-WINDOWS-01` | Licensed image, identity, secure RDP/browser/native input, update, persistence, restart, recovery, revoke, and teardown on one exact revision. |
| `UC-ORCHESTRATE-01` | Two real agents on two identified computers execute a durable task with bounded authority, factual state, steer/recovery, artifacts, and no duplicate terminal outcome. |

Every user-facing flow gets desktop and mobile browser acceptance. High-risk
paths additionally require focused contract tests, real approved infrastructure,
revision-bound deployment evidence, persistence/recovery, and unconditional
cleanup. A build, health endpoint, visual click-through, simulated provider, or
agent assurance alone cannot close a launch gate.

## Likely implementation surfaces

The exact change map should be refreshed at the start of each slice. Current
high-probability owners include:

- `dashboard/src/app/dashboard/launch/`
- `dashboard/src/app/dashboard/welcome/`
- `dashboard/src/app/dashboard/computers/`
- `dashboard/src/app/dashboard/infrastructure/`
- `dashboard/src/components/dashboard/home/`
- `dashboard/src/components/dashboard/welcome/WelcomeFlow.tsx`
- `dashboard/src/components/computers/`
- `dashboard/src/components/infrastructure/`
- `dashboard/src/components/hivra/`
- `dashboard/src/app/api/instances/`
- `dashboard/src/app/api/hivra/agents/`
- `dashboard/src/app/api/hivra/agent-launches/`
- `dashboard/src/app/api/infrastructure/`
- `dashboard/src/lib/agent-computers/`
- `dashboard/src/lib/hivra/`
- `dashboard/src/lib/infrastructure/`
- `dashboard/src/lib/services/instance-service.ts`
- `dashboard/supabase/migrations/`
- `dashboard/provisioner/`
- `dashboard/runtime-adapters/`
- `dashboard/scripts/hivra-self-host.mjs`
- `apps/macos/HivraMac/`

## Explicit non-goals of the core reset

- Rewriting the mature control plane from scratch.
- Restoring the reverted dense launch/fleet page.
- Replacing native agent interfaces before evidence shows a better shared one.
- Requiring a project, repository, or task before conversation.
- Purchasing capacity as a side effect of pasting a provider key.
- Silently installing Proxmox or rebooting an existing server.
- Defaulting every launch to the largest possible resource allocation.
- Treating Docker/OCI packaging as an isolation class, or treating a gVisor
  application-kernel sandbox, provider VM, shared-kernel container, and Proxmox
  KVM guest as interchangeable boundaries. Firecracker is research, not a
  supported driver, until a versioned adapter passes equivalent lifecycle and
  security acceptance.
- Calling preview cards, mocks, installed packages, or contract tests shipped
  OS/provider support.
- Copying Conductor's code, assets, prose, exact UI/layouts, trade dress,
  closed-cloud boundary, or Mac-user permission model.
- Pulling Gate, Exchange, token mechanics, Foundry, Missions, Colony, or other
  exploratory ecosystem ideas into this release.

## Decisions still requiring separate owner approval

The sibling Agent/Computer entry, independent responsibility labels, two golden
web paths, and delivery crosswalk above are approved. The following are not:

1. Decide whether to pursue a public trial after a separate unit-economics,
   abuse, payment, suspension, and data-retention proposal.
2. Decide the public name for the later orchestration surface; `Orchestrate` is a
   neutral working name, while `Conductor mode` risks confusing inspiration with
   product identity.
3. Supply and explicitly authorize a disposable real bare-metal target and host
   preparation before
   that path can pass live acceptance.
4. Decide whether self-hosted Hivra should ever link to Hivra Cloud capacity or
   other account-bound services after the separate threat-model proposal.
5. Authorize any native-app work, production deployment, public-source or client
   publication, provider-capacity purchase, trial implementation, or other work
   outside the bounded web/Canary scope separately. Canary deployment alone is
   authorized; it is not production or publication authority.

## Functional experience acceptance

The core is finished when a first-time user can launch a supported agent or an
Ubuntu computer on Hivra Cloud through the same short journey, open the real
result, return later, resize where supported, recover work, and delete it cleanly;
when the same contract works on at least one accepted customer-owned capacity
path; and when a fresh self-hosted installation can perform that path without a
Hivra Cloud account. A portability claim additionally requires separate restore
of the `.hivra` control-plane artifact and one supported remote
volume/snapshot/archive, with persisted user-byte verification, fresh
re-enrolment, stale-access revocation, and preservation of unrelated resources.

This is the functional-core completion definition. Calling that core publicly
open source or released additionally requires the exact immutable-export review,
final release-approval combiner, publication authority, and any separately
distributed runtime/image/client artifact gates.

Omarchy guest support, Windows guest support, macOS guest support on legitimate
Apple hardware, a signed/notarized Mac client, a Windows client, a free trial,
and multi-agent orchestration are separate milestones. Each is finished only
when its own named acceptance and, where applicable, distribution/release gates
pass. Its presence in this plan is sequence, not a claim of availability.

## 2026-09-07 onboarding checkpoint

The computer-profile step now groups unavailable Omarchy/Windows previews in a
closed, labelled disclosure while retaining their disabled states and readiness
links. The UI-only change is deployed to Canary as `8e500089c` over the prior
live baseline; unapplied attachment backend work is excluded. Seventeen focused
tests and independent review pass. In the actual 980×690 Mac app with expanded
sidebar, Continue is visible after Ubuntu selection, advances to Capacity and
Back preserves selection. Readiness navigation and the unchanged four-running
computer inventory were checked. No launch or new spend occurred. See
`docs/release/2026-09-07-launch-preview-disclosure.md`; core completion remains open.

## 2026-09-07 launch focus checkpoint

Step changes now focus their heading without stealing focus during name edits.
Source `51aa62804`, UI-only Canary release `a0510a81d`; 18 launch tests,
TypeScript, lint and independent source review pass. Actual Mac-app accessibility
snapshots confirm focused headings on Back/Continue and a still-focused edited
name field. Retained inventory remains four Running. No launch, backend migration
or new spend. See `docs/release/2026-09-07-launch-step-focus.md` for exact deployment,
cleanup and limits. Full core/attachment and OS-specific acceptance remain open.

## 2026-09-07 sidebar persistence checkpoint

Full app refresh previously discarded an expanded sidebar. The device-local
choice is now saved by desktop toggles and restored after hydration, independently
of mobile drawer visibility. Source `6ed5861fe`, UI-only Canary `ddf11e93b`.
Thirty-eight sidebar/launch tests, typecheck, lint and independent review pass.
Actual Mac-app refreshes preserved both expanded and collapsed choices; original
expanded view and dark theme restored. No new resources or spend. Exact release,
limits and rollback: `docs/release/2026-09-07-sidebar-persistence.md`.

## 2026-09-07 capacity-layout rejection

A desktop sticky Back/Continue footer passed local tests but obscured the focused
name input in actual Mac-app acceptance. It was rejected, reverted in source
(`8f40acb1d`) and rolled back to accepted Canary `ddf11e93b` / deployment
`dpl_DP9fmpYx879wtrRyYEHf79APFSgo`. Fresh UI inspection confirmed the input was
unobscured again; no Launch was sent. Do not repeat this overlay approach as a
proof loop. A non-overlapping small-window layout remains future work. See
`docs/release/2026-09-07-capacity-footer-rejected.md` for the failed evidence and
completed rollback. Full core goal remains open.

## 2026-09-07 current Ubuntu reconnect check

The retained aligned Ubuntu computer rendered its real public desktop in the Mac
app, then rendered again after leaving and reopening. Individual secure-setup
readings were 12.7s and 4.8s. Both exact viewing sessions were revoked and their
controller input recorded released; no guest input or lifecycle mutation was
performed. Final inventory remained four Running. No spend or deployment.
See `docs/release/2026-09-07-ubuntu-open-reconnect.md` for source/binary identity,
session cleanup and deliberately untested paths. This is current open/reconnect
evidence, not completion of fresh launch, attachment or all operating systems.
