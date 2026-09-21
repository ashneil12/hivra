# Hivra Vision

**Status:** Canonical product direction

**Approved:** 2026-08-24

**Direction updated:** 2026-09-04

**Approved core-experience direction:** Agent and Computer are sibling entry
choices in one resumable Launch journey. The approved implementation surface is
web/Canary first; this direction does not claim that the current fragmented
routes already implement or pass that journey. See the
[approved reset plan](docs/superpowers/plans/2026-09-04-hivra-core-experience-reset.md).

**Execution authority:** Code implementation, Canary deployment, and bounded
launch tests using clearly identified Hivra-owned Canary capacity are authorized.
The owner's 2026-09-05 weekend continuation expands that authority to local
native/desktop-app work, visual and onboarding improvements, Windows/Omarchy
acceptance work, and a cumulative maximum of GBP 10 in Hetzner test capacity,
including preparation and lifecycle testing of those disposable resources.
Production or public release, PR merge, other purchases, trial-policy changes,
legal-agreement acceptance, and unrelated live mutations remain outside it.
Test-scoped lifecycle actions may affect only disposable resources created for
the approved Canary check and must preserve pre-existing resources and produce
exact cleanup evidence.

The 2026-08-31 remote-computer expansion remains target work within the approved
crosswalk. The [remote-computers addendum](docs/superpowers/specs/2026-08-31-hivra-remote-computers.md)
separates requested outcomes from proposed transports, unmeasured latency budgets,
and outstanding launch acceptance. None of those unaccepted integrations is
made current by the 2026-09-04 approval.

## The product

Hivra is building the open cloud-computing layer for AI agents.

Every agent should be able to run on its own secure computer, remain available when a laptop is closed, and be reached from anywhere without losing the control and immediacy of running locally.

The first audience is developers and AI power users who already use capable agents on their own computers. Hivra is not initially a simplified introduction to AI. It is a better place to run the agents people already trust with serious work.

## The promise

A user can choose an agent or a computer, choose where it runs, authenticate at
the boundary that needs it, and begin working. Product copy presents two
independent choices:

- **Control plane:** Hivra-hosted or Self-hosted Hivra.
- **Capacity:** Hivra Cloud capacity, My cloud, or My server.

For every capacity resource and operation, Hivra records the control-plane
operator, infrastructure-credential custodian, spend owner, capacity operator,
upgrade/monitoring/recovery owner, and support party independently. The legacy
`self-managed` and `hivra-managed` terms may summarize a fully declared
responsibility profile or name an existing acceptance fixture; one binary value
must not silently assign all six facts. Hivra-managed service is convenience and
operational responsibility—not a hidden superior product.

## Product model

- An **agent identity** carries instructions, memory references, runtime choice, policies, credential bindings, and interface preference.
- An **agent computer** provides isolated compute, storage, network, operating system, runtime installation, access surfaces, lifecycle, and recovery.
- An **infrastructure connection** is an operator-owned or Hivra-owned credential binding to a provider, Proxmox environment, or prepared Linux node.
- A **capacity node or pool** describes discovered CPU, memory, storage, networking, supported isolation drivers, and current allocations. Connecting capacity and launching an agent are separate actions.
- A **responsibility assignment** records the control-plane operator, credential
  custodian, spend owner, capacity operator, recovery owner, and support party
  rather than deriving them from one operating-mode label.
- An **isolation driver** is the real execution boundary used by a computer, such as a provider VM, Proxmox KVM guest, gVisor sandbox, or shared-kernel system container.
- A **conversation** is ordinary interaction and requires no project.
- A **run** is one durable execution attempt.
- A **task** is an optional durable objective that may span runs, conversations, agents, approvals, and artifacts.
- A **project** is optional organization for agents, computers, conversations, tasks, repositories, files, and context.

The initial product may operate one primary agent identity per computer. The architecture must not make that a permanent limitation.

## Experience

The approved near-term product presents two sibling entry choices:

- **Launch Agent** creates or selects an agent identity, gives it an agent
  computer, installs the selected runtime through its adapter, and opens the
  existing Hivra or runtime-native interface.
- **Launch Computer** creates an operating-system environment without requiring
  an agent. Attaching a Hivra-managed agent later is a separate, explicit grant.

Both choices use one resumable experience: choose Agent or Computer, select a
runtime or operating-system profile, choose existing accepted capacity, review
the recommended plan and its exact effects, then launch and open the observed
result. Connection, provider purchase, host preparation, target admission,
provisioning, runtime installation, and access remain separate backend operations
and consent boundaries even when the product presents one journey.

This is approved target behavior, not a statement that the present Canary routes
are already unified. The working agent catalogue, original launch path, agent
detail screens, and runtime-native interfaces remain available during migration.
The original portable-agent acceptance contract remains unchanged and cannot be
closed by the sibling shell or managed Ubuntu path.

Simple setup asks for the intended outcome and infrastructure connection, detects the target's real capabilities, and selects the strongest compatible isolation driver and sensible resource allocation. Advanced setup exposes supported drivers, node placement, resource limits, networking, storage, repair access, and spending policy. An advanced choice cannot bypass capability checks, another user's boundary, or a managed host's hypervisor boundary.

Hivra never silently downgrades isolation or buys provider resources. When the requested runtime cannot run with the preferred driver or the selected pool lacks capacity, the UI explains the constraint and offers compatible choices.

This shared launch contract must become portable, reproducible, and easy to
self-host before Hivra replaces working native surfaces with a new universal
workspace. Projects remain optional, and a user does not need a project or task
to talk to an agent.

The focused workspace is a longer-term optional interface over the same real agents and computers. The current workspace can remain available as a secondary canary, but it is not the near-term default and must not create a separate lifecycle, credential system, or runtime path. Hermes, Buzz, Codex, and future runtimes should retain their useful native experiences.

## Non-negotiable principles

### The computer is real

An agent computer is an isolated, inspectable, recoverable computing environment—not a card in a dashboard or a chat wrapper.

### The UI tells the truth

Hivra displays observed state. It does not invent progress percentages, queued work, agents, subagents, completion, or success.

### Security is part of the product

Capable agents receive meaningful access. Isolation, least-privilege credentials, short-lived access, auditable operations, safe failure, revocation, backup security, and recovery are core requirements.

### Open means operationally useful

The intended public platform includes provisioning, lifecycle, runtime and provider adapters, observability, diagnostics, recovery, upgrades, tests, and self-hosting documentation. Private production secrets, customer data, live access details, support communications, and hosted-business administration remain private.

The repository must not be described as open source until an OSI-approved license and third-party distribution review are committed.

### One platform, not another lane

The existing Hermes, Hivra-agent, and Workspace Cloud paths must converge through compatibility adapters and explicit migrations. New work must not create a fourth independent lifecycle or execution system.

## First reference release

The first proof is the existing per-agent launch experience made portable. A user connects a host they control, Hivra inspects it without mutation, and the UI recommends the strongest supported isolation path. Preparation is a separate, explicitly approved action. Proxmox KVM is the first launchable self-managed substrate, not the connection model or a prerequisite the user must understand before connecting a host.

One mature existing runtime may serve as the first acceptance fixture, but that is an engineering test choice rather than a Codex-first, Hermes-first, or other runtime-first product strategy. The current agent catalog remains the product surface, and its provisioners move onto the portable target contract without losing their native interfaces.

The user can provision, authenticate, converse, execute real work, receive durable events and artifacts, use files/Git/terminal/browser, restart safely, snapshot, restore, stop, start, and delete. The flow is not complete until it survives real interruptions without duplicating work or fabricating terminal state.

The initial Proxmox slice proves user-owned infrastructure and the strongest existing VM boundary. A generic host remains unavailable for launch until a supported adapter prepares it and a fresh strict preflight publishes current target evidence. Direct Linux and Hetzner Cloud nodes follow through the same lifecycle contract with truthful isolation classes rather than pretending every target can run Proxmox.

## Approved implementation order

The [core-experience reset](docs/superpowers/plans/2026-09-04-hivra-core-experience-reset.md)
is the approved web/Canary implementation sequence:

1. align product truth and preserve the existing acceptance contracts;
2. establish canonical launch, resource, binding, migration, and state contracts
   behind a gated web shell;
3. prove one mature Agent runtime and Ubuntu Computer on existing Hivra Cloud
   capacity without treating either as whole-catalog support;
4. add explicit attach/detach semantics for a managed agent on an existing
   computer;
5. converge accepted customer-owned capacity without weakening
   `UC-PORTABLE-AGENT-01`;
6. complete self-host control-plane recovery, then computer-data portability,
   then any separately threat-modelled Hivra Cloud account link;
7. prove the daily-driver Linux computer gate, then the separately licensed and
   accepted Windows guest path;
8. consider native-client releases only under separate authority; and
9. add durable multi-agent orchestration only after real single-agent execution,
   authority, recovery, and bounded-stop controls exist.

These slices may overlap where their dependencies permit, but the first
portable-agent reference acceptance below remains unchanged. A managed web path,
Ubuntu desktop, mock, or contract test cannot substitute for it or close a
public-release gate. Omarchy and macOS guests remain separately gated target
work; macOS requires legitimate Apple hardware and a compliant design.

## What this document outranks

This vision supersedes the HermesOS hosting-era product direction and earlier plans that treat billing tiers, token mechanics, marketing backlog, presentation-only agent unification, or separate product lanes as the platform's architectural authority.

The detailed approved design is [`docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md`](docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md).
