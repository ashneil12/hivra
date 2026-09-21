# Hivra Product Context

**Status:** Canonical positioning context

**Last updated:** 2026-08-24

## Product

**One line:** Hivra is building the open cloud-computing layer for AI agents.

**Core promise:** Every agent gets its own secure computer, accessible from anywhere, with an experience that feels as capable and immediate as running locally.

**Category:** Agent computers / open infrastructure and workspace for AI agents.

**Product modes:**

- `self-managed` — the user supplies infrastructure credentials and operates the platform;
- `hivra-managed` — Hivra operates the same functional platform for the customer.

Managed service is convenience, operational responsibility, and support. It is not a hidden superior software edition.

## Initial audience

Developers and AI power users who already run Codex, Hermes, Claude-oriented tools, Buzz, or other capable agents locally.

They are not looking for a beginner chatbot. They want to:

- keep work running when their laptop is closed;
- continue from another computer without losing context;
- isolate an agent from their personal machine;
- use terminal, files, Git, browser, and native runtime interfaces;
- choose self-hosted or managed infrastructure; and
- retain the ability to inspect, modify, export, and contribute to the platform.

## Jobs to be done

- “Give this agent a real computer that stays available.”
- “Let me work with the same agent from anywhere.”
- “Keep the power of running locally without tying it to my laptop.”
- “Let me bring my Proxmox infrastructure—or manage it for me.”
- “Give me one excellent workspace without stripping away the runtime's native interface.”
- “Tell me what the agent and computer are actually doing, especially when something fails.”

## Target product model

The approved architecture will use this model; the current repository has not completed the migration:

- Agent identities will be portable definitions of behavior and bindings.
- Agent computers will be isolated environments with compute, storage, network, runtime, access, lifecycle, and recovery.
- Conversations will require no project.
- Runs will be durable execution attempts.
- Tasks and projects will be optional structure for longer work.
- Provider adapters will connect Proxmox, Hetzner, and future infrastructure.
- Runtime adapters will connect Codex, Hermes, assessed Buzz integrations, and future agents.

## Target primary experience

The focused agent workspace will combine:

- conversation and real run events;
- files and Git;
- terminal;
- browser automation and human takeover;
- optional native runtime interface;
- selected-computer status and lifecycle controls; and
- customizable layout and theme.

Quick conversation will come first. Projects and fleet coordination are later zoom levels, not onboarding requirements.

## Target differentiation

Hivra intends to differentiate through:

- real isolated computers rather than stateless chat sessions;
- one consistent shell without flattening the best native runtime experiences;
- self-managed and Hivra-managed operation over the same functional platform;
- provider and runtime independence through public versioned contracts;
- truthful operational state rather than simulated progress; and
- security, access control, backup, recovery, and export treated as core product behavior.

## Open-source positioning

The intended product is fully open and self-hostable, including operationally useful provisioning, lifecycle, observability, diagnostics, recovery, and upgrade tooling.

Hivra-owned source is licensed under Apache-2.0, which permits forks and competing hosted operators. Do not publicly describe the repository or a built artifact as a completed open-source release until the dependency, third-party artifact, credential-rotation, and sensitive-history gates are complete. Hivra Cloud intends to compete through trustworthy operation and support.

## Messaging rules

### Say

- “A secure computer for your agent.”
- “Run it yourself or let Hivra manage it.”
- “Accessible from anywhere.”
- “Keep the native interface when it is the best tool.”
- “Observable, recoverable, and exportable.”
- “Projects are optional.”

### Do not say without verified evidence

- “Open source” before the license and public-release gates pass.
- “Secure” without naming the relevant isolation or access control.
- “Complete,” “finished,” “running,” or “deployed” from a simulated or accepted-only state.
- Percentage complete unless a runtime supplies a finite measurable plan.
- “Supports” a runtime, provider, desktop, or operating system before its acceptance path passes.
- “The same as local” when a required local interface or capability is absent.
- “Only a Microsoft-scale exploit could cause harm” or any equivalent impossible guarantee.

## Current proof and current gaps

The current repository already contains real Hetzner and Proxmox infrastructure paths, Hermes instances, a Hivra agent catalog and agent-box lane, lifecycle and recovery code, browser access, terminal and file surfaces, backups, credentials, metrics, and multiple agent types.

It does not yet contain the canonical agent-computer backend, durable shared run contract, versioned in-repository Hivra host provisioner, complete self-host installer, or the approved focused workspace. Current presentation-level unification must not be marketed as architectural unification.

## Commercial context

Pricing and packaging are not product-architecture authority. Hivra may charge for managed infrastructure, operations, support, convenience, and future enterprise service. Functional self-hosting must not be intentionally crippled to force the hosted purchase.

## Source of truth

1. `VISION.md`
2. `docs/PRODUCT-ARCHITECTURE.md`
3. `docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md`
4. `ROADMAP.md`
5. verified current code and tests

Historical HermesOS pricing, token, growth, and hosting documents are background only.
