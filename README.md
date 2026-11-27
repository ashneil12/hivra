# Hivra

<img src="docs/brand/hivra-logo.jpg" alt="Hivra" width="160" height="160" />

Hivra is building an open, self-hostable cloud-computing layer for AI agents: one secure computer per agent, accessible from anywhere, with managed operation available for people who do not want to run infrastructure themselves.

## Choose how to run Hivra

- **Run your own control plane (preview):** Start with the [self-host quickstart](docs/self-host/QUICKSTART.md). The install runs the dashboard and database on your machine without a Hivra or Clerk account. Launching an agent also requires supported compute; installing the dashboard doesn't provision it.
- **Keep compute on your own server:** Use the hosted dashboard with a [connected Proxmox VE server](docs/STATUS.md#agents) for supported agents. The one-command Ubuntu connection provides a Linux Sandbox, not an agent launch host.
- **Let Hivra run the compute:** Use [Hivra Cloud](https://hivra.cloud) for [supported managed agents and computers](docs/STATUS.md). Check the status guide for availability and plan requirements.

## Repository status

This is the public source repository for Hivra. Hivra-owned source is licensed under Apache-2.0. The initial source release passed an independent export review, secret scanning, and an exact exported-source installation and recovery rehearsal. Separately distributed runtime images and desktop installers require their own release checks.

Contributions target `main`; `canary` selects the revision being tested. Managed production requires a separate explicit promotion. Hosted credentials stay outside this repository. See the [managed release process](docs/release/MANAGED-HOSTING-RELEASES.md).

Today the codebase contains:

- a Next.js dashboard and API control plane;
- hosted Clerk authentication, installation-owned local operator authentication, and Supabase persistence;
- Hetzner and Proxmox provisioning paths;
- Hermes instances and Hivra agent computers;
- agent catalog support for Hermes, Claude Code, Codex, Aeon, OpenClaw, and Agent Zero (what launches today, and where, is in [`docs/STATUS.md`](docs/STATUS.md));
- lifecycle, recovery, backup, browser, terminal, file, credential, billing, and observability components; and
- a presentation-level unified agent model over otherwise separate backend lanes.

The approved target is to consolidate those capabilities behind canonical agent-computer, runtime-adapter, provider-adapter, execution, event, credential, access, and lifecycle contracts. Target documentation does not imply that consolidation has already shipped.

## Start here

See the [documentation index](docs/README.md) for setup, architecture, contribution, and release guides.

- [Product vision](VISION.md)
- [Approved platform design](docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md)
- [Product architecture](docs/PRODUCT-ARCHITECTURE.md)
- [Open-source and hosted boundary](docs/OPEN-SOURCE-BOUNDARY.md)
- [Security model](docs/SECURITY-MODEL.md)
- [Active roadmap](ROADMAP.md)
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
does not expose hosted billing routes. From the repository root:

```bash
cd dashboard
npm ci
npm run self-host:doctor
npm run self-host:init
npm run self-host:start
```

Open `http://127.0.0.1:3000` and sign in with the operator credentials created
during setup. The installer writes secrets outside the repository and never
prints them. Read the quickstart's [prerequisites](docs/self-host/QUICKSTART.md#requirements)
before installing and [compute setup](docs/self-host/QUICKSTART.md#connect-compute)
before attempting your first agent. The root `docker-compose.yml` is development
wiring for a standalone Hermes agent and sidecar, not a Hivra installer.

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

## Licensing and release boundaries

Hivra-owned source is available under the [Apache License 2.0](LICENSE). Forks and competing hosted services are permitted; [the trademark policy](TRADEMARKS.md) prevents confusion about who operates or endorses a distribution, not competition.

Third-party dependencies, agent runtimes, images, assets, and services keep their own terms. The root license does not relicense them. The initial reviewed source export is published. Do not publish a release artifact until its required notices, exact inventory, and applicable release checks pass. New source revisions and separately distributed runtime images or installers require their own checks; source publication does not approve those artifacts or establish full V1 acceptance. See [the release boundaries](docs/release/PUBLIC-TRANSITION.md).

Never commit credentials, customer data, production host inventory, or live access details.
