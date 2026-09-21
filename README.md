# Hivra

<img src="docs/brand/hivra-logo.jpg" alt="Hivra" width="160" height="160" />

Hivra is building an open, self-hostable cloud-computing layer for AI agents: one secure computer per agent, accessible from anywhere, with managed operation available for people who do not want to run infrastructure themselves.

## Repository status

This repository contains the current Hivra dashboard and control-plane implementation. Hivra-owned source is licensed under Apache-2.0, but the repository has not yet completed the architecture, third-party artifact, and sensitive-history gates required for its first public release.

Today the codebase contains:

- a Next.js dashboard and API control plane;
- hosted Clerk authentication, installation-owned local operator authentication, and Supabase persistence;
- Hetzner and Proxmox provisioning paths;
- Hermes instances and a separate Hivra agent-computer pilot;
- agent catalog support including Hermes, Claude Code, Codex, Aeon, OpenClaw, and Agent Zero at varying availability levels;
- lifecycle, recovery, backup, browser, terminal, file, credential, billing, and observability components; and
- a presentation-level unified agent model over otherwise separate backend lanes.

The approved target is to consolidate those capabilities behind canonical agent-computer, runtime-adapter, provider-adapter, execution, event, credential, access, and lifecycle contracts. Target documentation does not imply that consolidation has already shipped.

## Start here

- [Product vision](VISION.md)
- [Approved platform design](docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md)
- [Product architecture](docs/PRODUCT-ARCHITECTURE.md)
- [Open-source and hosted boundary](docs/OPEN-SOURCE-BOUNDARY.md)
- [Security model](docs/SECURITY-MODEL.md)
- [Active roadmap](ROADMAP.md)
- [Phase 0 implementation plan](docs/superpowers/plans/2026-08-24-hivra-agent-computers-phase-0.md)
- [Dependency inventory and runtime-distribution gaps](docs/release/DEPENDENCIES.md)
- [Runtime distribution decisions](docs/release/RUNTIME-DISTRIBUTION.md)
- [Dashboard development guide](dashboard/README.md)
- [Self-host quickstart](docs/self-host/QUICKSTART.md)
- [Contributing](CONTRIBUTING.md) and [reporting vulnerabilities](SECURITY.md)
- [Public repository and hosted-service transition](docs/release/PUBLIC-TRANSITION.md)

## Self-host preview

The first independent single-operator setup path is now implemented for review.
It uses a local Docker-compatible runtime, a local Supabase stack and
installation-owned credentials; it does not require a Hivra or Clerk account and
does not expose hosted billing routes. From `dashboard/`:

```bash
npm ci
npm run self-host:doctor
npm run self-host:init
npm run self-host:start
```

Open `http://127.0.0.1:3000` and sign in with the operator credentials created
during setup. The installer writes secrets outside the repository and never
prints them. See the [self-host quickstart](docs/self-host/QUICKSTART.md) for
requirements, lifecycle commands, provider onboarding and the exact acceptance
boundary. A live acceptance run from this source checkout created a fresh
Hetzner computer with the operator's token, prepared it, launched Codex through
the original agent flow, opened its native interfaces, captured installed-state
evidence, and removed every provider resource. Repeating that run from the exact
committed public-source candidate on a clean machine is still a gate; this
section describes implemented behavior, not final V1 approval.

## First reference path

The first end-to-end release target is the original multi-agent flow made portable
on supported user-owned infrastructure. A mature runtime can serve as the first
Ubuntu/Proxmox acceptance fixture; that is not a Codex-first product decision.
The same adapter must work in both:

- `self-managed` mode with user-owned provider credentials; and
- `hivra-managed` mode with Hivra-owned provider credentials.

Projects are optional. A user can select an agent and begin a conversation directly. Project, task, fleet, and full-desktop capabilities build on the proven single-computer execution path.

## Repository layout

- `dashboard/` — Next.js control plane, API routes, Supabase migrations, tests, and deployment configuration.
- `docs/` — current specifications, architecture, security, operational plans, and historical technical documents.
- `scripts/` — repository-owned operational and verification scripts.
- `contracts/` — existing smart-contract workspace; not the target agent-computer API contract layer.

## Development

Dashboard development commands are documented in [`dashboard/README.md`](dashboard/README.md). At minimum:

```bash
cd dashboard
npm install
npm run dev
```

Use the risk-based verification rules in [`AGENTS.md`](AGENTS.md) before committing changes.

## Licensing and public-release warning

Hivra-owned source is available under the [Apache License 2.0](LICENSE). Forks and competing hosted services are permitted; [the trademark policy](TRADEMARKS.md) prevents confusion about who operates or endorses a distribution, not competition.

Third-party dependencies, agent runtimes, images, assets, and services keep their own terms. The root license does not relicense them. Do not publish a release artifact or claim that the complete public-release gate has passed until the required notices, exact artifact inventories, credential rotation, and cleaned-history review in [the roadmap](ROADMAP.md) are complete.

Never commit credentials, customer data, production host inventory, or live access details.
