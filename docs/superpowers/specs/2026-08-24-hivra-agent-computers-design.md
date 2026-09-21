# Hivra Agent Computers Platform Design

**Date:** 2026-08-24

**Direction update:** 2026-08-25 — preserve the original multi-agent product experience; prioritise portable capacity connections, bring-your-own credentials, and capability-selected isolation before any universal-workspace replacement.

**Expansion update:** 2026-08-31 — the user requested Buzz, DeepSeek Harness,
Omarchy and daily-driver remote-computer performance. The
[remote-computers addendum](2026-08-31-hivra-remote-computers.md) makes desktop
engineering active alongside portable-release closure, without waiting for
projects or a new workspace. Existing lifecycle, security and live-acceptance
gates still govern enabling any new integration.

**Core-experience update:** 2026-09-04 — Agent and Computer are approved as
sibling entry choices in one resumable Launch journey. The
[core-experience direction](../../CORE-EXPERIENCE.md)
describes the accepted product direction while preserving the original
portable-agent acceptance unchanged.

**Execution authority:** Code implementation, Canary deployment, and bounded
launch tests on clearly identified Hivra-owned Canary capacity are authorized.
Native-app work, production or public release, provider-capacity purchase, trial
policy, host preparation, and unrelated or destructive live mutations are
excluded. Test-scoped lifecycle actions may affect only disposable resources
created for an approved Canary check and require exact cleanup and preservation
evidence.

**Status:** Approved; web/Canary implementation scope active

**Scope:** Product model, open-source boundary, runtime and infrastructure architecture, focused workspace, migration sequence, and first end-to-end release

## Executive Decision

Hivra is the open cloud-computing layer for AI agents.

Every agent gets its own secure computer, accessible from anywhere, with an experience that feels as immediate and capable as running the agent locally. The first audience is not people trying AI for the first time. It is developers and AI power users who already run agents on their own computers and want the same control, persistence, interfaces, and freedom without tying the work to one physical machine.

The primary entry presents **Launch Agent** and **Launch Computer** as sibling
choices. Launch Agent creates or selects an agent identity and gives it a
computer. Launch Computer creates an OS environment with no agent required;
later attachment is explicit. Both choices use the same resumable web journey
without collapsing their identities, payloads, or lifecycle contracts. This is
approved target behavior; the current Canary routes remain fragmented until the
named migration and acceptance gates pass.

The complete functional platform will be released under a genuine open-source license and will be self-hostable. Hivra Cloud is the managed operating mode of that same platform: customers pay Hivra to provision, operate, update, secure, monitor, and recover computers on supported infrastructure adapters. The hosted product must not depend on a hidden, functionally superior closed core.

The first reference path is the current per-agent launch experience made portable. A user connects a host they control, Hivra inspects it without mutation, and the UI recommends a supported isolation substrate. Preparation requires explicit consent, and only a fresh strict adapter preflight can publish launch authority. Proxmox KVM is the first launchable self-managed substrate, not the connection model.

One runtime may be selected as the first end-to-end acceptance fixture because its existing path is mature. That fixture is not a Codex-first, Hermes-first, or other runtime-first product decision. The current multi-agent catalog remains the product surface.

All responsibility profiles use the same public Proxmox adapter and
agent-computer contracts. `self-managed` and `hivra-managed` remain stable names
for the existing portable acceptance fixtures, but they are not infrastructure
providers or a sufficient authorization model. Each fixture declares the exact
control-plane operator, infrastructure-credential custodian, spend owner,
capacity operator, upgrade/monitoring/recovery owner, and support party.

That portable path remains a required reference even while the approved managed
Agent and Ubuntu Computer web work proceeds in parallel. A managed launch,
desktop checkpoint, new shell, mock, or contract test cannot substitute for its
end-to-end acceptance or authorize fleet, broad-runtime, or public-release
claims.

## Product Principles

### 1. The computer is real

An agent computer is not a chat wrapper, billing record, or visual metaphor. It is an isolated computing environment with explicit compute, storage, network, operating-system, runtime, credential, access, snapshot, and lifecycle state.

### 2. Immediate use comes before organization

A person can create or select an agent and start talking to it without creating a project. Projects remain available when durable organization becomes useful.

### 3. Hivra unifies without flattening

Hivra unifies provisioning, lifecycle, credentials, events, and computer access
behind one sibling Agent-or-Computer Launch journey. The existing agent catalogue,
agent detail screens, and useful native runtime surfaces remain available during
migration and after launch. A consistent workspace may be offered later, but it
must remain optional until real use proves it better. Hivra preserves the
runtime's best native surface when that surface provides additional value.

Examples:

- Codex and similar code agents can expose their terminal-oriented workflow.
- Hermes can expose its native web or retrofitted desktop interface.
- Buzz can be integrated as a runtime or reused as a core component if a technical and licensing assessment shows that is the cleanest path.
- Every runtime still has a universal Hivra workspace fallback.

### 4. The UI tells the truth

Hivra only displays facts supported by a durable backend or runtime event. It must not invent progress percentages, completion states, subagent activity, queued work, or execution results.

### 5. Open source means operationally useful

Provisioning, lifecycle management, provider adapters, runtime adapters, observability, diagnostics, recovery tools, upgrade paths, and self-hosting documentation belong in the public platform. The private boundary is actual production secrets, customer data, live infrastructure access, and hosted-customer administration—not the machinery required to operate Hivra.

### 6. Security is a product property

The platform is intended to run capable, long-lived agents with meaningful credentials. Isolation, scoped access, auditable actions, recovery, and safe failure behavior are primary architecture concerns, not enterprise add-ons.

## Audience and Jobs to Be Done

### Initial user

The first user is an individual developer or AI power user who currently runs one or more agents locally and needs to:

- continue work from different computers;
- keep agent state and workspaces running while their laptop is closed;
- give an agent a dedicated environment instead of unrestricted access to a personal machine;
- use terminal, files, Git, browser automation, or a native agent interface as appropriate;
- bring their own infrastructure or pay Hivra to manage it; and
- retain a credible path to export, self-host, inspect, modify, and contribute to the entire platform.

### Later users

Teams and enterprises may later need shared projects, policies, audit retention, identity federation, approvals, quotas, and support commitments. Those needs may extend the product, but they must not distort the initial single-user experience or create a closed functional core.

## Product Vocabulary

The following terms are canonical. Product copy, APIs, database models, events, and future-agent instructions should converge on them.

### Agent identity

A portable definition of an agent's behavior and bindings. It can include:

- name and presentation;
- instructions and personality;
- memory references;
- runtime type and runtime configuration;
- policy and approval preferences;
- credential bindings; and
- preferred interaction surface.

An identity is not the computer itself. A Computer may have no managed agent.
The initial product may enforce at most one primary Hivra agent identity per
computer, but the architecture must not make that relationship permanent.

### Agent computer

The isolated environment on which an agent may run. It can exist without an
agent identity or managed runtime installation. It owns:

- provider and placement;
- machine or VM identity;
- operating-system image;
- CPU, memory, and optional accelerator allocation;
- persistent system and workspace storage;
- network identity and policy;
- runtime-installation relationships and observed installation status;
- lifecycle and health;
- access surfaces;
- snapshots, backup, restore, and eventual clone or migration state.

### Infrastructure connection and capacity pool

An infrastructure connection is an owner-scoped binding to a supported provider API, Proxmox endpoint, or prepared node. Reusable credentials are encrypted and referenced rather than returned to clients or placed in agent computers. Discovery records non-secret nodes, available resources, networks, storage, images, supported drivers, and provider spending policy.

A capacity pool groups one or more compatible nodes for placement. Connecting
capacity and launching an Agent or Computer are separate operations. A launch
uses existing capacity unless an explicit, bounded create-capacity policy
authorizes provider spend. The 2026-09-04 execution scope does not authorize
provider-capacity purchase.

### Isolation driver

The versioned execution boundary used by an agent computer. Examples include a provider-created VM, Proxmox KVM guest, gVisor application-kernel sandbox, or unprivileged shared-kernel system container. Each driver declares requirements, workload compatibility, lifecycle support, and one truthful isolation class: `provider-vm`, `hardware-vm`, `application-kernel`, or `shared-kernel`.

### Runtime adapter

The versioned boundary between Hivra and an agent runtime such as Codex, Hermes, Claude Code, or Buzz. An adapter declares capabilities and translates runtime-specific behavior into Hivra's common contracts.

### Provider adapter

The versioned boundary between Hivra and an infrastructure provider such as Proxmox or Hetzner. It handles placement, provisioning, lifecycle operations, networking, volumes, images, snapshots, and health reconciliation according to declared capabilities.

### Responsibility profile and operating-mode compatibility

Product copy presents two independent choices:

- **Control plane:** Hivra-hosted or Self-hosted Hivra.
- **Capacity:** Hivra Cloud capacity, My cloud, or My server.

For each capacity resource and operation, the canonical policy persists the
control-plane operator, infrastructure-credential custodian, spend owner,
capacity operator, upgrade/monitoring/recovery owner, and support party. Those
facts determine permitted actions; no summary label may grant authority that its
fields do not.

`self-managed` and `hivra-managed` remain compatibility summaries and stable
acceptance-profile names. They may be used only with an explicit field mapping,
use the same functional platform contract, and are not provider adapters. This
preserves the original portable scenario names and requirements without making a
binary value silently assign all operational responsibility.

### Conversation

A normal interaction stream between a person and an agent. A conversation does not require a project or task.

### Run

One execution attempt initiated from a conversation, task, schedule, API, or another agent. A run has a durable identity, observable state, events, outputs, and terminal outcome.

### Task

An optional durable objective that may span conversations, runs, agents, artifacts, approvals, and time. Creating a task must never be required just to talk to an agent.

### Project

An optional durable context boundary that can group agents, computers, conversations, tasks, repositories, files, instructions, and shared context. A project can use multiple agent identities across multiple computers.

## Experience Model

Hivra supports complementary zoom levels, but they are not separate products.
The approved primary entry is the sibling Agent-or-Computer Launch journey.
Current agent-first screens remain working compatibility and acceptance surfaces
while that web/Canary target is built and proven; their existence is current,
while a unified journey is not yet current.

### Agent and Computer launch

This is the fastest entry point and the near-term default. A user first chooses
Agent or Computer. The Agent path creates or selects an identity, configures
supported user-owned runtime credentials when desired, provisions on accepted
user-owned or Hivra-managed capacity, and opens the existing Hivra or
runtime-native interface. The Computer path provisions an OS environment and
opens its accepted Desktop, Files, Terminal, or Manage surface without requiring
an agent. A later agent attachment is separately reviewed and authorized.

### Focused agent workspace

This is an optional later working surface over the same real agents and
computers. It must not replace useful agent-specific or runtime-native surfaces
until portable provisioning works and real use proves the new interface more
useful. It can combine:

- conversation and run event stream;
- conversation switcher;
- current agent and selected computer identity;
- files;
- Git;
- terminal;
- browser;
- optional native view;
- computer status and controls; and
- a message composer.

When enabled, the workspace remains usable when auxiliary panels are collapsed. Computer inspection is optional, not permanently dominant. The existing `/dashboard/workspace` implementation is a secondary canary, not the near-term product dependency.

### Project and fleet views

Projects show coordinated durable work. Fleet views show computers, health, placement, capacity, and exceptional states. These views come after the single-computer execution contract is proven.

### Layout behavior

The focused workspace is modular:

- auxiliary computer controls can collapse, resize, or move;
- low-frequency utility icons use a compact horizontal treatment rather than consuming a tall navigation column;
- the user's preferred layout is remembered per workspace;
- the preferred native or universal surface is remembered per agent; and
- Hivra Dark, Vellum, and system-following themes can coexist without changing the information architecture.

The current Hivra visual language remains the reference: dark textured surfaces, restrained red signal color, etched borders, strong typography, and clear operational states. The generated mockups are directional references, not evidence that the corresponding backend functions exist.

## Honest State and Progress Model

### Run states

Run state is represented on two independent axes so transport acknowledgement is never confused with execution.

#### Delivery state

```text
created -> dispatching -> delivered
                    \-> delivery_failed
delivered -> lease_expired -> dispatching | delivery_failed
```

- `created`: durable control-plane record exists but no delivery has been attempted.
- `dispatching`: a delivery attempt and ownership lease are in progress.
- `delivered`: the selected computer durably acknowledged the run and lease.
- `lease_expired`: acknowledgement or heartbeat was lost and reconciliation is required.
- `delivery_failed`: the run cannot be delivered under the current retry or recovery policy.

Redelivery uses the same run id and idempotency key. It must not create a second execution.

#### Execution state

```text
pending -> accepted -> running
running -> waiting_for_input | waiting_for_approval | blocked | recovering
waiting_for_input | waiting_for_approval | blocked | recovering -> running
any nonterminal state -> cancelling -> cancelled | recovering
accepted | running | waiting_for_input | waiting_for_approval | blocked | recovering
  -> succeeded | failed
```

- `pending`: execution has not been accepted by a computer.
- `accepted`: the computer durably owns the run but has not confirmed runtime execution.
- `running`: the runtime confirmed active execution.
- waiting and blocked states require a structured reason and resumption condition.
- `recovering`: the prior execution state is being reconciled after process, computer, control-plane, or network failure.
- `cancelling`: cancellation has been requested and is awaiting a runtime or supervisor outcome.
- `succeeded`, `failed`, and `cancelled` are terminal and immutable.

A run cannot enter `accepted` or `running` before delivery is `delivered`. A terminal execution state does not later change if delayed events arrive. Cancellation is accepted from every nonterminal execution state. Delivery cancellation before acceptance terminates locally. Cancellation after acceptance reaches `cancelled` only after the computer or runtime acknowledges that execution stopped.

If Hivra cannot establish whether accepted work stopped, the run moves from `cancelling` to `recovering` with structured reason `cancellation_indeterminate`. It remains nonterminal, is visibly quarantined, and cannot be retried or replaced while the possibility of continued side effects exists. Reconciliation may return it to `cancelling`, confirm `cancelled`, resume `running`, or record `failed` only when there is positive evidence of a known execution failure and no continuing execution. Operator resolution must preserve the audit evidence and cannot declare uncertainty to be success or ordinary failure. Leases, heartbeats, and reconciliation select the next legal state; they do not silently create a replacement run.

Additional states may be introduced only when their transitions, lease behavior, recovery semantics, and terminal rules are defined.

### What the UI may show

- current observable state;
- elapsed time;
- latest acknowledged action;
- runtime-reported step names and their explicit states;
- approval or input request;
- connection and health state;
- final outcome and produced artifacts.

### What the UI may not infer

- percentage complete from elapsed time or token output;
- a completion estimate from a language model's prose;
- that accepted work is executing;
- that an agent or subagent exists without a durable runtime identity;
- that a run succeeded because a stream disconnected cleanly.

If a runtime supplies a finite, measurable plan, Hivra may display completed steps over total steps. That is not the same as predicting task completion.

## Target Architecture

### Public control plane

The public control plane contains:

- authenticated API and web application;
- canonical agent-computer domain model;
- provider and runtime adapter interfaces;
- provisioning and lifecycle orchestrator;
- durable job and event system;
- capability registry;
- credential-binding service;
- access brokerage for terminal, browser, native view, and future desktop;
- image, volume, snapshot, backup, and restore orchestration;
- observability, audit, diagnostics, and repair tools; and
- self-hosting, upgrade, and operator documentation.

### Computer runtime

Each agent computer runs a small versioned Hivra component that:

- establishes the computer's identity;
- reports health and supported surfaces;
- receives authorized run requests;
- supervises the configured agent runtime;
- emits normalized events and artifacts;
- exposes local terminal, file, browser, and native-surface bridges through authenticated channels;
- persists sufficient execution state for recovery; and
- supports safe upgrades and diagnostics.

The component must not depend on mutable, out-of-repository scripts installed manually on a host.

### Shared contract, specialized capabilities

Adapters expose a capability document rather than pretending every runtime or provider is identical.

Illustrative runtime capabilities include:

```text
conversation
streaming_events
durable_sessions
approvals
background_runs
terminal
files
git
browser
native_web
native_desktop
structured_plan
artifacts
```

Illustrative provider capabilities include:

```text
validate_connection
discover_capacity
discover_isolation_drivers
provision
power_control
resize
volumes
snapshots
backup
restore
clone
migrate
console
private_network
accelerators
```

The UI gates controls from the selected computer and adapter capabilities. It must not use a global hard-coded feature list.

### Simple and advanced setup

Simple mode asks what the user wants to launch and where they want it to run. It performs connection, capacity, driver, runtime, storage, network, and resource preflight, then selects the strongest compatible driver with conservative defaults. If no compatible placement exists, it explains why and offers bounded remedies rather than silently spending money or weakening isolation.

Advanced mode exposes compatible driver, node and pool placement, CPU, memory, disk, storage, network policy, dedicated or shared placement, repair access, and provider-spending controls. It does not expose unsupported combinations or allow a managed guest to escape its hypervisor boundary.

The same target may support different drivers for different runtimes. Detection is advisory and evidence-backed: every runtime-driver pair must pass installation, authentication, PTY, files, Git/SSH, browser, MCP, persistence, resource, restart, and declared nested-container acceptance before Simple mode selects it. A user may choose a weaker compatible shared-kernel driver only after an explicit warning; Hivra never performs an unannounced downgrade.

Independent Proxmox servers or clusters are separate Hivra capacity targets by default. The Hivra control plane coordinates placement and mediated communication above them. It only relies on a native Proxmox cluster when the operator provides an already appropriate low-latency cluster; wide-area Hivra operation must not create ambient Proxmox server-to-server trust.

For a user-owned host, the normative sequence is:

```text
connect host
  -> read-only capability discovery
  -> evidence-backed substrate recommendation
  -> exact preparation plan and explicit consent
  -> install or prepare the selected substrate where supported
  -> reboot or reconnect when required
  -> fresh strict adapter and runtime preflight
  -> publish revision-bound capacity and launch authority
```

Discovery snapshots are informational, sanitized, bounded, and tied to the connection revision. They never create a deployment target by themselves. A generic or partially prepared host stays unavailable until the selected adapter proves its isolation, lifecycle, and runtime contracts.

## Agent Computer Lifecycle Contract

Computer state is also represented on separate axes. One overloaded `status` field is not canonical.

### Desired lifecycle state

The user's or operator's durable intent:

```text
absent | running | stopped | archived
```

- `absent` means no provider resource should remain after applicable retention rules.
- `running` and `stopped` describe desired power state for an active computer.
- `archived` means compute may be absent while retained recoverable state is preserved according to provider capability and policy.

### Observed provider state

The last provider-confirmed reality:

```text
unknown | missing | provisioning | running | stopped | suspended | deleting | error
```

Provider adapters may report richer native values, but they must normalize to this vocabulary and preserve the native value for diagnostics.

### Health state

The Hivra computer component's observed ability to serve work:

```text
unknown | enrolling | healthy | degraded | unreachable | incompatible
```

Provider `running` plus Hivra `unreachable` is a valid and important combination. It must not be collapsed into “online.”

### Operation state

At most one conflicting lifecycle operation owns the computer lease:

```text
idle | provisioning | starting | stopping | resizing | snapshotting | restoring |
archiving | deleting | reconciling | failed
```

Every operation has an id, idempotency key, requested actor, start time, lease, provider operation reference when available, and terminal result. Reads and non-conflicting operations can continue only when their capability contract explicitly permits it.

### Reconciliation rules

- Desired state is durable intent; observed state is never overwritten to make it appear fulfilled.
- Provision creates a canonical computer record before provider mutation and records the provider resource id as soon as one exists.
- Start and stop reach success only after provider observation matches intent; computer health is reported separately.
- Resize records old and requested resources, provider acknowledgement, guest observation where relevant, and a defined rollback or repair state.
- Snapshot reaches success only when the provider or backup system returns a durable snapshot identity and retention metadata.
- Restore creates a distinct operation, records its source, and re-enrolls or revalidates computer identity and credential policy before accepting work.
- Delete reaches success only after provider absence is observed and secret, access-grant, DNS, inventory, and retention cleanup have reached their documented outcomes.
- A provider resource missing while desired state is `running` or `stopped` creates a visible drift incident; it is not silently reprovisioned.
- A provider resource with no canonical computer record is an orphan. Discovery is automatic; adoption or deletion requires an explicit, audited action.
- A crashed or expired operation lease enters `reconciling`; the next action is derived from provider observation and the operation's idempotency semantics, not a blind retry.

Provider adapter conformance tests must cover every supported transition and every unsupported operation must fail before provider mutation.

## Canonical Data Relationships

```text
User
  -> owns AgentIdentity*
  -> owns or can access AgentComputer*
  -> owns Project*

Project (optional)
  -> references AgentIdentity*
  -> references AgentComputer*
  -> groups Conversation*, Task*, Repository*, Artifact*

AgentIdentity
  -> selects RuntimeAdapter
  -> binds CredentialReference*
  -> has primary AgentComputer? initially

AgentComputer
  -> selects ProviderAdapter
  -> has Image + Volume* + NetworkPolicy
  -> hosts RuntimeInstallation*
  -> exposes AccessSurface*

Conversation
  -> targets AgentIdentity
  -> may reference Project
  -> contains Message* and Run*

Task
  -> may reference Project
  -> coordinates Run*, AgentIdentity*, Artifact*, Approval*

Run
  -> targets one AgentComputer and RuntimeInstallation
  -> emits Event*
  -> produces Artifact*
```

References do not imply ownership. Moving an agent identity between computers must not silently transfer secrets, storage, or project authorization.

## Durable Execution Contract

The first release needs one dependable path for work delivery.

### Submission

A run submission includes:

- stable run id and idempotency key;
- authenticated actor;
- agent identity, computer, and runtime target;
- conversation and optional project or task reference;
- input content and permitted attachments;
- credential references, never raw reusable secrets in event payloads;
- execution policy and approval requirements; and
- expected capability version.

### Ownership and acknowledgement

The target computer must durably acknowledge ownership. The control plane distinguishes:

- created but not delivered;
- delivered but not accepted;
- accepted but not running;
- running;
- terminal.

This prevents an HTTP success or queued response from being mistaken for execution.

### Events

Events are append-only, ordered per run, resumable, tenant-scoped, and sanitized. The common envelope includes:

- event id and sequence;
- run id;
- timestamp;
- source component and version;
- event type;
- safe display summary;
- structured payload version; and
- optional artifact or approval reference.

Reconnects resume from the last acknowledged sequence. Duplicate delivery must not create duplicate terminal outcomes or repeated side effects.

### Recovery

After a control-plane, network, or computer restart:

- the computer reconciles accepted and running work;
- the control plane reconciles computer and provider state;
- an interrupted run either resumes, reports a defined failure, or enters a visible recovery state;
- the UI never fabricates the missing end of a conversation; and
- orphaned resources are detected and presented for safe repair or cleanup.

Blind retries are not the recovery model. Retrying a non-idempotent action requires explicit semantics or human approval.

## Access Surfaces

Every access surface is bound to the selected computer and authorized independently.

### Universal workspace

The universal Hivra workspace is available when the runtime supports the required capabilities. It provides consistent navigation and fallback tools.

### Native runtime surface

An adapter can advertise a native web or desktop view. Hivra opens it through an authenticated broker and clearly identifies which agent computer owns it. Native interfaces are preserved because they may contain runtime-specific workflows that a generic UI cannot reproduce well.

### Terminal

CLI-oriented agents can expose a terminal associated with the selected computer and working context. Terminal access is explicit, auditable, revocable, and never assembled from a hard-coded host address.

### Browser

Browser automation and live human takeover are separate permissions over the same selected-computer browser session. The UI shows whether automation or a person currently has control.

### Full graphical desktop

A general Linux desktop is a later surface, after terminal, files, browser, and runtime-native access are reliable. Windows follows Linux. macOS support requires legitimate Apple hardware and a deployment design consistent with Apple's platform rules.

## Buzz Decision

Buzz appears to overlap with parts of Hivra's intended agent orchestration or workspace experience. Hivra should learn from and potentially integrate it instead of duplicating it reflexively.

Before choosing the relationship, complete a bounded assessment covering:

- exact product and repository identity;
- license and redistribution obligations;
- self-hosting and offline behavior;
- runtime, task, session, event, artifact, and computer abstractions;
- API and extension points;
- authentication and credential model;
- native UI quality and embeddability;
- deployment and upgrade model;
- project health and maintenance risk; and
- fit with Hivra's open-source and provider-independent boundary.

Possible outcomes are:

1. **Runtime adapter:** Buzz runs on an agent computer and exposes its native interface through Hivra.
2. **Reusable subsystem:** Hivra adopts a well-bounded Buzz component behind Hivra-owned contracts.
3. **Reference implementation:** Hivra copies product lessons but implements its own contract because direct integration would create coupling or licensing problems.

The default is the runtime-adapter option. Reusing Buzz as a core subsystem requires evidence that Hivra can retain independent computer, provider, identity, security, and lifecycle contracts.

## Security Model

### Trust boundaries

Treat the following as separate trust zones:

- user's browser or local client;
- Hivra control plane;
- infrastructure provider control surface;
- individual agent computer;
- agent runtime and tools;
- external model and integration providers;
- credential store; and
- operator access.

Compromise of one agent computer must not grant control-plane, provider, neighboring-tenant, or unrelated credential access.

### Computer identity and access

- Computers enroll with unique cryptographic identity.
- Control-plane-to-computer commands are authenticated, authorized, replay-resistant, and scoped.
- User-facing terminal, browser, native view, and future desktop access use short-lived grants.
- Reusable passwords or bearer secrets are not placed in query strings.
- Every grant is bound to user, selected computer, surface, audience, and expiry; a grant for one surface or computer cannot open another.
- Revocation takes effect without rebuilding the computer and is verified against a documented maximum propagation time.
- Browser history, referrers, analytics, application logs, and proxy logs must not contain reusable access secrets.

### Credentials

- Secrets are encrypted at rest and in transit.
- The control plane stores references and policy; raw values are disclosed only to the authorized runtime boundary that needs them.
- Bindings are scoped by user, project when applicable, agent identity, computer, runtime, purpose, and environment.
- Logs, events, artifacts, crash reports, backups, and support tooling are treated as potential secret-exfiltration paths.
- Snapshot policy explicitly states whether runtime credentials are excluded, re-bound after restore, or encrypted under a restorable key hierarchy.
- Backups are encrypted with keys separated from backup storage. Restore requires authorization and produces an audit event.
- Rotation invalidates superseded material at the control-plane and runtime boundaries.
- Export, retention, and deletion behavior is explicit and testable, including backups and archived computers.
- Self-hosted installation includes master-key bootstrap, backup, recovery, and rotation procedures that do not require a Hivra-held key.

### Network and isolation

- Each computer starts with a least-privilege network policy.
- Inbound access is brokered rather than exposed by default.
- Provider credentials are not left on guest computers.
- Administrative host access is separate from customer access and auditable.
- Image provenance, updates, and vulnerability response are documented for self-hosters and Hivra Cloud.

### AI-specific safety

Hivra cannot promise that all capable agents are harmless. It can reduce practical risk by making permissions explicit, constraining credentials and network reach, isolating computers, requiring approval at chosen boundaries, retaining useful audit evidence, and supporting rapid revocation and recovery.

Security claims must be testable and narrowly worded. The product must not claim that only nation-state-level or platform-wide exploitation could cause harm.

## Open-Source and Hosted Boundary

### Public

- web application and control-plane services;
- domain and database schemas;
- agent-computer runtime;
- provider and runtime adapters;
- provisioning, images, lifecycle, networking, and storage automation;
- durable execution and event contracts;
- credential-binding implementation;
- access brokers;
- observability and audit components;
- diagnostics and repair tooling;
- backup, restore, upgrade, and migration logic;
- tests, local development tools, and operator runbooks; and
- self-hosting documentation.

### Environment-specific and private

- actual production credentials and keys;
- customer records and customer-generated data;
- live host inventory and access details;
- internal incident records containing customer or infrastructure-sensitive data;
- private support communications; and
- Hivra Cloud billing and business administration that is not needed to operate the open platform.

Hosted-only glue may exist for Hivra's accounts and business operations, but it cannot be required for an independent operator to offer the same functional agent-computer product.

### License decision

The repository must use a genuine OSI-approved open-source license. The exact license is a release-gate decision after checking dependencies, contribution goals, trademark policy, and the user's stated acceptance of competing hosted operators. Phase 0 is not complete until the chosen license is committed at the repository root.

The release also includes:

- a dependency and software-bill-of-materials report;
- required third-party notices and source-offer obligations;
- a trademark policy that distinguishes code rights from Hivra branding; and
- an explicit decision for every third-party runtime about whether Hivra bundles it, downloads it during installation, or only connects to a user-installed copy.

An open Hivra adapter or installer does not make a third-party runtime open source. Product copy and distribution artifacts must preserve that distinction. Do not describe the repository as open source before the license and dependency review are complete.

## Public-Release Audit

Before making the repository public, perform a read-only audit of the complete reachable Git history and current tree for:

- API keys, tokens, passwords, private keys, and credential files;
- live hostnames, IP addresses, inventories, and administrative endpoints;
- customer identifiers, messages, exports, backups, and support material;
- private environment files and build artifacts;
- third-party source or assets with incompatible terms;
- large or generated files that should not be published; and
- documentation that exposes sensitive operational details without adding reusable operator value.

The audit produces a classified report and remediation plan before history is rewritten or a new public repository is created.

Decision rule:

- preserve the repository history when sensitive objects can be removed and rotated with high confidence;
- publish a fresh repository from the cleaned current tree when preserving history creates unacceptable residual risk;
- treat a fresh repository as a security decision, never as a mechanism for withholding functional code.

Any discovered secret is considered compromised and rotated. Removing it from Git is not sufficient.

## Migration from the Current Product

The existing repository contains valuable, proven substrate but several overlapping control paths. The migration must consolidate them instead of adding a fourth path.

### Existing capabilities to preserve

- isolated Proxmox VM provisioning and placement;
- persistent system and workspace storage;
- power, resize, delete, archive, and restore operations;
- browser automation and live browser takeover;
- terminal and file access;
- credential handling;
- backup mechanisms;
- metrics and operational events;
- multiple agent types and multiple computers per user; and
- existing Hermes-native surfaces where they work well.

### Existing fragmentation to remove

- separate Hermes-instance and Hivra-agent lifecycle lanes;
- Workspace Cloud as an independent product model;
- profile records that blur identity and runtime ownership;
- presentation-only unification without a shared backend contract;
- out-of-repository mutable host provisioners;
- hard-coded selected-computer assumptions; and
- public claims that exceed real capabilities.

### Compatibility strategy

Before canonical dual-path implementation begins, Phase 2 produces a migration contract for each canonical entity: agent identity, agent computer, runtime installation, conversation/session, run/event, credential binding, snapshot/backup, and project.

For each entity the contract defines:

- canonical id format and database uniqueness constraints;
- legacy Hermes, Hivra-agent, profile, and Workspace Cloud id mappings;
- canonical source of truth and write authority in each migration phase;
- whether a compatibility path reads through, backfills, dual-writes, or writes through an outbox;
- ordering, deduplication, and retry rules for any replicated write;
- reconciliation queries and parity thresholds;
- conversation/session history mapping and collision behavior;
- credential re-binding rules that never copy raw values through migration events;
- snapshot, backup, artifact, and event lineage;
- cutover and rollback checkpoints; and
- the point after which legacy writes are rejected.

Dual-write is not the default. If it is required, one side remains authoritative and the outbox plus reconciliation behavior is tested before user traffic moves.

1. Preserve the working agent catalogue, current launch flow, agent detail
   screens, native interfaces, and original portable acceptance while the
   sibling web shell is built.
2. Introduce canonical launch, resource, binding, state, and migration contracts
   without immediately deleting existing tables or routes.
3. Add compatibility adapters over existing Hermes, Hivra-agent, Ubuntu, and
   Workspace Cloud paths.
4. Prove one mature Agent path and Ubuntu Computer path on existing Hivra-owned
   Canary capacity without presenting either as whole-catalog support.
5. Add explicit attach/detach/rebind behavior without conflating AgentIdentity,
   RuntimeInstallation, and AgentComputer.
6. Converge customer-owned capacity and pass `UC-PORTABLE-AGENT-01` with its
   original requirements unchanged.
7. Package self-host control-plane recovery, then computer-data portability,
   then any separately threat-modelled Hivra Cloud account link.
8. Consolidate remaining runtimes and complete Linux desktop and later guest-OS
   gates independently.
9. Treat native-client release and public publication as separately authorized
   work.
10. Add orchestration only after durable single-agent execution, authority,
    recovery, and bounded stops are real.
11. Stop new writes to legacy paths only after parity and recovery are verified;
    remove old lanes only after reversible migration and a documented rollback
    window.

## Delivery Sequence

The 2026-09-04 owner approval adopts the following web/Canary implementation
crosswalk. The numbered foundation phases below retain their acceptance
requirements; the crosswalk changes implementation order without marking target
behavior current or weakening a gate.

| Approved reset slice | Relationship to the foundation phases |
| --- | --- |
| Slice 0 | Aligns Phase 0 product truth and governance. |
| Slice 1 | Pulls forward Phase 2 contracts behind a gated web shell while Phase 1 portable closure continues. |
| Slice 2 | Runs a managed Agent path alongside Phases 1/3 and an Ubuntu Computer path alongside Phase 8; neither closes `UC-PORTABLE-AGENT-01`. |
| Slice 2B | Adds explicit Agent-to-Computer binding between runtime consolidation and full Computer use. |
| Slice 3 | Carries the Phase 1/3 customer-owned-capacity path and its unchanged portable acceptance. |
| Slices 4A-4C | Split Phase 4 into self-host control-plane recovery, Computer data portability, and separately threat-modelled optional Cloud linking. |
| Slice 5 | Carries Phase 8 Linux desktop performance acceptance. |
| Slice 6 | Carries the Windows-guest part of Phase 9. |
| Slice 7 | Is a later native-client release track and is outside current execution authority. |
| Slice 8 | Carries Phase 7 durable orchestration after real single-agent execution; the optional focused workspace is not a prerequisite. |

Only code implementation, Canary deployment, and bounded owned-capacity Canary
launch tests are active. Native apps, production/public release,
provider-capacity purchase, trial policy, host preparation, and unrelated or
destructive live mutations remain excluded.

### Phase 0: Canonical truth and release safety

- Commit this design specification.
- Create canonical `VISION.md`, product architecture, open-source boundary, security model, and replacement roadmap.
- Add documentation-precedence guidance for future agents.
- Mark conflicting older plans as historical or superseded.
- Complete the Git-history, secret, sensitive-data, dependency, and license audit.
- Select and commit an OSI-approved root license, third-party notices, dependency/SBOM report, trademark policy, and per-runtime bundle/download/connect decisions.
- Decide whether the public release preserves or restarts history.

**Exit:** one unambiguous current product direction, an evidence-backed public-release decision, and committed licensing and third-party distribution terms sufficient to publish the cleaned tree.

### Phase 1: Portable existing agents and bring your own keys

- Preserve the existing agent-first UI as the portable acceptance flow while the
  sibling web/Canary shell is introduced behind compatibility and parity gates.
- Accept supported user-owned runtime or model API keys.
- Accept supported user-owned Proxmox or provider credentials.
- Store infrastructure connections separately from runtime credentials and discover non-secret node capacity and supported isolation drivers.
- Validate and store credentials without exposing reusable values to the browser, logs, events, or another tenant.
- Let the user choose control plane and capacity independently, then show and
  persist the exact credential, spend, operation, recovery, and support
  responsibility assignment before provisioning. Existing `self-managed` and
  `hivra-managed` acceptance fixtures retain explicit mapped profiles.
- Provide Simple setup with automatic compatible placement and Advanced setup with explicit supported controls.
- Never silently use ambient Hivra fleet credentials, purchase provider capacity, or downgrade isolation for a self-managed launch.
- Preserve the working Hivra or runtime-native interface after launch.
- Keep `/dashboard/workspace` optional.

**Exit:** one supported existing agent launches with user-owned runtime and infrastructure credentials and remains usable without Hivra model credits or Hivra-held infrastructure access.

### Phase 2: Contracts and versioned provisioning

- Define canonical identifiers, state machines, capability documents, events, and adapter interfaces behind the existing UI.
- Commit the per-entity migration and write-authority contract.
- Define control-plane-to-computer identity and command transport.
- Bring required host provisioning, images, and install logic into version control.
- Wrap existing lifecycle paths with compatibility adapters.
- Add a local or fake provider and runtime for contract testing.

**Exit:** the original agent flow uses one versioned model that can describe and reconcile an agent computer without depending on a particular runtime or provider.

### Phase 3: Portable existing-agent reference slice

- Provision through the public Proxmox adapter in both `self-managed` and `hivra-managed` operating modes.
- Connect, own, preflight, and inventory a prepared user-managed Proxmox target before provisioning.
- Select one mature currently supported runtime as the acceptance fixture and support its user-owned credential without routing usage through Hivra credits.
- Support the minimum self-managed provider setup needed for the canary through a documented configuration or CLI path, including credential validation and capacity, image, storage, and network preflight. Phase 4 turns this into the complete operator experience.
- Enroll the computer and install the selected versioned runtime adapter.
- Authenticate without leaking reusable credentials.
- Submit a real run and receive ordered durable events.
- Use files, Git, terminal, and browser where supported.
- Preserve conversation and workspace state across restart.
- Stop, start, snapshot, restore, and delete safely.

**Exit:** the named portable-agent canary scenario passes through the original agent-first UI in both credential-ownership modes against supported Proxmox environments, including target ownership, capacity admission, the specified restart point, event sequence, artifact assertion, terminal outcome, and absence of residual provider resources after deletion or induced failure. The fixture runtime is not presented as the platform's preferred runtime.

### Phase 4: Self-hosting and bring-your-own-cloud

- Accept supported Proxmox connection details or provider API credentials through secure setup flows.
- Run preflight checks for capacity, images, networking, storage, DNS, and permissions.
- Add prepared Linux and Hetzner Cloud nodes through the same connection and capacity contracts.
- Select among provider-VM, gVisor application-kernel, and explicitly labelled shared-kernel drivers according to discovered host and runtime capabilities; do not assume nested KVM exists on a cloud VM.
- Provision a working agent computer from the UI or documented CLI.
- Support upgrades, diagnostics, backups, restore rehearsal, and uninstall/export.
- Document the same public adapter and lifecycle path used in `hivra-managed` mode.

**Exit:** from a documented clean supported target, a fresh operator can bootstrap keys, pass preflight, understand the selected isolation class, provision the reference computer, complete the live-canary scenario, upgrade, run backup/restore rehearsal, and export or uninstall without Hivra-held infrastructure access.

### Phase 5: Runtime consolidation

- Move every currently supported catalog runtime onto the common target, identity, computer, execution, and capability contracts while preserving its native interface.
- Integrate Block's Buzz as an optional mediated identity, communication, and collaboration service rather than treating it as the infrastructure control plane.
- Add DeepSeek Harness and other runtimes incrementally behind pinned, tested adapters.
- Retire overlapping Workspace Cloud and legacy agent lanes after migration gates pass.

**Exit:** multiple runtimes share one computer and execution model without losing their best native workflows.

### Phase 6: Optional focused workspace

- Back every state and control with the real portable contracts.
- Keep direct access to existing agent-specific and runtime-native interfaces.
- Add conversation switching, files, Git, terminal, browser, native view, and collapsible computer controls only when they are backed by the selected computer.
- Persist layout, theme, and preferred-interface choices.
- Test long-running, blocked, approval, disconnection, and recovery states with real runs.

**Exit:** real use shows that the optional workspace improves the portable agent experience without hiding or duplicating runtime capabilities.

### Phase 7: Project expansion, durable tasks, and fleet coordination

- Expand the minimal Project entity with shared repositories, instructions, context, policies, and coordinated views over proven primitive relationships.
- Add durable tasks spanning runs, agents, approvals, and artifacts.
- Add delegation and multi-agent coordination with real ownership and event semantics.
- Add project and fleet views driven by actual computer and run state.

**Exit:** coordinated multi-agent work survives refreshes, disconnections, restarts, and partial failure.

### Phase 8: Full graphical desktop and computer mobility

- Add a general Linux desktop with explicit automation and human-control modes.
- Add snapshot, clone, and move workflows where provider capabilities permit.
- Verify selected-computer isolation across every access surface.

**Exit:** a user can safely treat the environment as a remote Linux computer, not only an agent runtime.

### Phase 9: Additional operating systems

- Add Windows only after Linux lifecycle, access, update, and recovery contracts are mature.
- Add macOS only with legitimate Apple hardware and a compliant operational design.

## Verification Strategy

### Contract verification

- Provider adapters pass a shared lifecycle and reconciliation suite.
- Runtime adapters pass a shared session, run, event, approval, cancellation, and recovery suite for supported capabilities.
- Capability negotiation and version mismatch behavior are tested.
- Infrastructure-connection tests prove owner isolation, encrypted secret references, redacted responses and logs, discovered non-secret capacity, and fail-closed behavior when a caller does not supply an authorized connection.
- Placement tests prove that Simple mode selects the strongest compatible isolation driver, Advanced mode exposes only supported choices, and neither mode silently downgrades isolation or authorizes provider spending.

### Local and continuous integration

- A fake provider and fake runtime exercise control-plane state machines deterministically.
- Tests cover idempotency, duplicate events, missing acknowledgements, stale leases, restart reconciliation, orphan detection, and partial failure.
- Security tests cover authorization boundaries, cross-user access, secret redaction, expired grants, replay, and selected-computer isolation.

### Live canary

The mandatory `UC-PORTABLE-AGENT-01` hot-path scenario uses a versioned supported image, a pinned adapter for one mature currently supported runtime, and a fixture Git repository with one failing test and an expected patch. The runtime is an engineering acceptance fixture and does not gain product priority. The scenario is:

1. create a user-scoped agent identity;
2. create and validate an owner-scoped infrastructure connection without returning its reusable credential to the browser;
3. discover the selected target's capacity, networking, storage, images, and compatible isolation drivers;
4. in Simple mode, select the strongest compatible driver and conservative allocation; in the Advanced variant, accept an explicitly supported driver and allocation;
5. provision a real computer and persist its canonical id, provider resource id, operating mode, selected driver and isolation class, desired state, and observed state;
6. install and authenticate the selected runtime with a user-owned runtime or model credential;
7. submit one idempotent run that asks the selected runtime to diagnose the fixture failure, implement the expected bounded change, run the fixture test, and write a named result artifact;
8. observe delivery move to `delivered`, execution move through `accepted` to `running`, and prove the selected computer owns the run;
9. disconnect and resume the event stream from its last acknowledged sequence with no missing or duplicate event ids;
10. after the first runtime action and before a terminal event, restart the computer supervisor in one variant and the control-plane worker in another;
11. observe `recovering` and reconciliation without creating a second run or repeating the fixture mutation;
12. retrieve the patch, test result, and named artifact and verify their contents against the fixture expectation;
13. observe exactly one immutable `succeeded` terminal event;
14. restart the computer and verify that the conversation, workspace change, artifact metadata, and terminal run remain addressable; and
15. resize and exercise start, stop, snapshot, and restore before deleting the computer and proving that no provider resource or reusable access grant remains.

Run the scenario through the same public Proxmox adapter in `self-managed` and `hivra-managed` credential-ownership modes. The self-managed variant must use the user's explicit connection rather than ambient Hivra fleet credentials. This proves operating-mode parity on supported Proxmox targets; it does not claim parity with Hetzner or any future provider.

### User experience verification

Each focused-workspace scenario has a fixture, an injected event or failure, and an observable result:

| Scenario | Injection | Required result |
| --- | --- | --- |
| `UX-CHAT-01` | Start a conversation with no project | Conversation is created, targeted at the selected agent, and remains unassigned to a project. |
| `UX-RUN-REFRESH-01` | Refresh during a long run | The same run and conversation hydrate; events resume by sequence; no synthetic assistant completion appears. |
| `UX-APPROVAL-01` | Runtime requests approval | Composer and run state show the request; only an authorized response resumes the same run. |
| `UX-INPUT-01` | Runtime requests missing input | The required input and destination run are visible; response returns to `running`. |
| `UX-BLOCKED-01` | Runtime emits a structured block | The reason and recovery action are visible; no percentage or success state is shown. |
| `UX-BROWSER-01` | Automation owns a browser session, then user takes over | Ownership visibly changes and automation cannot continue controlling it until released. |
| `UX-NATIVE-01` | Open an advertised native surface | The grant opens only the selected computer and surface and expires according to policy. |
| `UX-NETWORK-01` | Drop control-plane connectivity during execution | UI reports disconnection, then resumes ordered state without duplicating the run. |
| `UX-COMPUTER-RESTART-01` | Restart the selected computer while running | UI shows recovery and then the reconciled runtime outcome. |
| `UX-PROVIDER-FAIL-01` | Provider rejects snapshot or restore | Operation ends in a visible failed state with provider-safe diagnostics and no false lifecycle transition. |

The evaluation question is not whether the mockup looks complete. It is whether a user can understand what is actually happening and recover safely.

## First-Release Acceptance Criteria

The first reference release is complete only when all of the following are true.
The 2026-09-04 sibling-entry approval does not alter these criteria:

- The chosen OSI-approved license, required notices, dependency/SBOM report, trademark policy, and third-party runtime distribution decisions are committed.
- `UC-PORTABLE-AGENT-01` passes through the original agent-first UI and public Proxmox adapter in both `self-managed` and `hivra-managed` modes without presenting the fixture runtime as preferred.
- The self-managed variant uses user-owned Proxmox credentials and a user-owned runtime/model API key without Hivra model credits or Hivra-held infrastructure access.
- Infrastructure credentials are stored separately from runtime/model credentials; connection responses, discovery records, events, and logs contain no reusable secret.
- Simple mode selects the strongest compatible isolation driver and displays the selected isolation class. Advanced mode exposes only capability-supported choices. Neither mode silently downgrades isolation, purchases provider capacity, or falls back to ambient Hivra fleet credentials.
- `UX-CHAT-01` proves that the user can start with an agent directly and that a project is optional.
- Every access surface advertised by the original agent screen passes its relevant user-experience scenario against real run and lifecycle records.
- The optional focused workspace is not required for first-release acceptance and is not described as the default until its own scenarios pass.
- Provider conformance tests prove start, stop, snapshot, restore, delete, missing-resource drift, orphan discovery, and operation-lease recovery behavior.
- Terminal, files, Git, browser, and any advertised native surface are bound to the selected computer; a cross-computer and cross-user access matrix returns denial for every mismatched grant.
- Interactive access grants are audience, surface, user, and computer bound, expire within five minutes by default, and stop authorizing new connections within 60 seconds of revocation.
- Automated inspection proves reusable access secrets are absent from URLs, browser history, referrers, analytics, application logs, and proxy logs.
- Backup objects are encrypted with keys separated from backup storage; unauthorized restore fails; authorized restore is audited; credential behavior after restore matches the documented snapshot policy.
- Credential rotation invalidates the old value at the control plane and runtime. Deletion tests prove grants are revoked immediately and secrets, snapshots, backups, and archives follow their documented retention and erasure schedule.
- A self-hosted operator can bootstrap, back up, recover, and rotate the master key without a Hivra-held secret.
- Self-hosting uses versioned public code and documentation rather than private host scripts.
- No displayed percentage, task, subagent, queue, or completion state is simulated.
- The Phase 4 clean-host installation and recovery rehearsal passes without private Hivra intervention.
- Public product claims match the verified capability matrix.

## Explicit Non-Goals for the First Release

- Mandatory project creation.
- A complete replacement for every runtime's native interface.
- Multi-agent delegation before durable single-agent execution works.
- Predictive percentage completion.
- A universal workspace replacing the original agent screens before portable provisioning passes acceptance.
- Full Linux desktop before portable agent access surfaces are stable.
- Windows or macOS support.
- Enterprise identity, compliance, procurement, or policy suites.
- Artificial feature withholding to differentiate Hivra Cloud.
- Destructive Git-history rewriting before a classified audit and remediation plan exist.

## Documentation Source of Truth

After Phase 0 documentation is complete, future contributors and agents should use this precedence:

1. current canonical `VISION.md` and product architecture;
2. current approved design specification for the affected subsystem;
3. current implementation plan and capability registry;
4. verified current code and tests;
5. historical roadmaps and plans only as background.

When code and canonical documentation disagree, the discrepancy must be called out and resolved. Historical documents must not silently override this design.

## Plain-English Summary

Present Agent and Computer as sibling choices in one short, resumable web Launch
journey. An Agent gets a distinct identity, computer, and native or Hivra runtime
surface; a Computer can exist without an agent and opens its accepted OS
surfaces. Preserve the working catalogue and native interfaces while canonical
contracts and compatibility adapters replace fragmented backend lanes. The
original user-owned Proxmox portable-agent scenario remains an unchanged
reference gate even while managed Agent and Ubuntu Computer work proceeds on
Canary. Build self-host recovery, computer-data portability, later OS support,
and orchestration only through their named evidence and authority gates. The
current approval covers web code, Canary deployment, and bounded tests on
already-owned Canary capacity—not native apps, provider purchase, trials,
production/public release, or unrelated live mutation.
