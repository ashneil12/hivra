# What Hivra offers today

**This is the single source of truth for availability.** It says what a person
can launch today, where it runs, and which owner decision put it there. Other
documents describe target designs (the vision, architecture and specs), the
order of work (the roadmap), acceptance evidence (verification status) or a
moment in history (release packets and snapshots). When any of them disagrees
with this file about whether something is available or in preview, this file
wins: fix the other document in the same change.

Update this file in the same pull request as any change to a launch catalog or
a status label. The code below is what actually decides availability; this file
must match it.

| What decides it | File |
| --- | --- |
| Agents that can be launched | `dashboard/src/lib/hivra/agent-catalog.ts` (`available`) |
| Computers that can be launched | `dashboard/src/lib/hivra/computer-catalog.ts` (`status`, `launchMode`) and the Launch tiles in `dashboard/src/components/launch/LaunchJourney.tsx` |
| Previews that are shown but not launchable (Buzz only) | `dashboard/src/lib/hivra/preview-catalog.ts` |
| Public wording for crawlers and the homepage | `dashboard/src/lib/llms-txt.ts` and `dashboard/src/components/landing/home/content.ts` |

## Agents

All seven launch from Launch. Hivra Cloud requires a paid plan or, for
supported managed computers, [token-holder admission](#token-holder-access).
A free account alone works with a server the person connects.

| Agent | Status | Where it runs |
| --- | --- | --- |
| Claude Code | Available | Hivra Cloud or a Proxmox server you connected |
| Codex | Available | Hivra Cloud or a Proxmox server you connected |
| Hermes | Available | Hivra Cloud only. Existing Hermes agents keep running on their current lane. New launches go to a Hivra computer running the official Hermes Agent (its own installer and web UI, updated with `hermes update`). The paid launch path is live on Canary; it reaches hivra.cloud with the next owner-approved production promotion |
| OpenClaw | Available | Hivra Cloud or a Proxmox server you connected |
| Agent Zero | Available | Hivra Cloud or a Proxmox server you connected |
| Aeon | Available | Hivra Cloud or a Proxmox server you connected |
| DeepSeek Harness | Available (alpha) | Hivra Cloud only, on a paid plan. It needs a host on provisioner release 2026.11.10.5 or later |
| OpenBot (CopilotKit) | Preview, off by default | Hivra Cloud only, on a paid plan, when `NEXT_PUBLIC_HIVRA_OPENBOT_AGENT` is `1` on the deployment. It needs provisioner release 2026.11.12.4 or later |
| Nuphos | Preview, off by default | Hivra Cloud only, on a paid plan, when `NEXT_PUBLIC_HIVRA_NUPHOS_AGENT` is `1` on the deployment. It needs provisioner release 2026.11.12.5 or later |

Claude Code can sign in with the person's own Claude account, or run on Hivra
credits: Hivra translates its requests for Venice's Claude models and bills the
credits. Credits need a host on provisioner release 2026.11.10.2 or later.

The Venice launch promotion is an opt-in on Canary only. Its offer and claims
are unavailable in production; normal Venice model access is separate.

Hermes on a Hivra computer is the official Hermes Agent, unmodified: Hivra
creates the computer, runs Hermes's own installer, points it at Venice inference
(default model `deepseek-v4-1-flash`, or the person's own Venice key), and opens
Hermes's own web UI behind the Hivra sign-in at `/hermes/`. There is no
Hivra-built image, fork or patch. Owners update it with `hermes update` in
Terminal or the Update Hermes button on the agent's Manage tab. It needs
provisioner release 2026.11.12.1 or later and at least 1 CPU and 2 GB. The
runtime itself has no deployment switch: what Canary runs is what a production
promotion ships.

DeepSeek Harness runs DeepSeek's own coding agent in its own interface, reached
through Hivra's authenticated gateway. It launches with no browser and gets its
model at launch, because DeepSeek's own settings refuse a key from a remote
browser: it runs DeepSeek V4.1 Flash on Hivra credits by default, or on the
person's own Venice API key. It is labelled alpha because the upstream version it runs is pinned
at an alpha release. It has no public agent page yet, and a connected server or
a computer in the owner's own cloud cannot run it. Its Launch tile is not on
the first-run card, which stays at three choices.

### Token-holder access

**Gated; not live-verified.** An admitted token holder can launch a supported
managed Hivra computer without a paid subscription. Where holder access is
enabled for the account, a new qualification requires holding $299 worth of
tokens for Pro (2 vCPU and 4 GB RAM) or $599 for Power (4 vCPU and 8 GB RAM).
The token amount is calculated from the live market price at qualification.
The recorded amount, token and tier stay locked rather than being repriced.

Qualification is not admission. New holder admissions are capped at 20% of
scheduler placement capacity, measured separately for vCPU and RAM, and the
requested allocation must fit on an eligible host. Qualified holders wait
when capacity is unavailable. Grandfathered usage can remain above the ceiling.

Managed holder launches require a runtime that can nap and save memory,
`HIVRA_SLEEP_MODE` set to `canary` or `on`, and a configured wake connection.
On eligible computers, the policy naps after four idle minutes and saves
memory after twelve more minutes in nap. Host controls, activity checks and
wake readiness still apply.

New Classic Hermes holder launches are unavailable. Existing Classic computers
with verified holder funding keep their admission and allocation. Classic
holder sleep is off by default. With
`HERMES_CLASSIC_HOLDER_SLEEP_ENABLED=true` on an eligible Proxmox host, it uses
the same four- and twelve-minute timings and resumes on owner access. It
requires a verifiable Classic VM, an idle Docker gateway and dashboard, and the
browser wake route. Uncovered channels and scheduled jobs keep it awake.

OpenBot on a Hivra computer is CopilotKit's official OpenBot image (MIT),
unmodified: Hivra pulls the latest release, runs it on the computer's loopback
in OpenBot's single-user mode, and serves OpenBot's own workspace at the root of
the computer's address behind the Hivra sign-in (the agent page opens
`/openbot/`). OpenBot will not start without a CopilotKit Intelligence key
(CopilotKit has a free plan), so the first open shows a one-step page to paste
it; Hivra keeps it on the computer only. Models run through Venice on Hivra
credits by default, and the owner can change provider in OpenBot's settings.
Owners update with the Update button, which pulls upstream's latest image and
puts the previous image and database back if the new one does not start. It
needs at least 1 CPU and 3 GB. It is not in the Launch list unless the
deployment sets `NEXT_PUBLIC_HIVRA_OPENBOT_AGENT=1`. The other app named
OpenBot (Nightly Labs) is not offered: its licence does not allow a paid host.

Nuphos on a Hivra computer is Nuphos's official runtime image (Apache-2.0,
Claude Code variant), unmodified: Hivra pulls the latest release and serves the
runtime's own console at the root of the computer's address behind the Hivra
sign-in (the agent page opens `/nuphos/`). The owner sets the console password,
presses Connect to Nuphos and then chats from the Nuphos apps with their own
Nuphos account and their own Claude sign-in; Hivra provides the computer, not the
model. Nuphos's servers reach the runtime at `/acp`, which the runtime guards
with each connected team's key. Owners update with the Update button. It is not
in the Launch list unless the deployment sets `NEXT_PUBLIC_HIVRA_NUPHOS_AGENT=1`.

The one-command Ubuntu connect gives Linux Sandbox only. The agents above, and Ubuntu Desktop, need a Proxmox VE server connected with SSH details to run on your own server.

## Computers

| Computer | Status | Condition |
| --- | --- | --- |
| Ubuntu Desktop | Available | Hivra Cloud or a Proxmox server you connected |
| Linux computer | Available | Hivra Cloud on a paid plan. A headless Ubuntu computer with a terminal and files, no desktop (provisioner release 2026.11.10.4). Attaching an agent to it is not supported yet. |
| Linux Sandbox | Available | A gVisor-ready server you connected |
| Omarchy | Available, with a condition | Existing claims only; new claims are paused. A retained guest cannot be assigned again until its clean reset or rebuild can be verified. |
| Windows | Available, with a condition | On a Proxmox server you connected, from your own licensed Windows ISO. Hivra-managed Windows is not offered. |
| macOS | Not offered | Planned only. |

An already-reserved Omarchy refresh continues to require verification of the
exact release, migrations and rebooted kernel before Desktop opens. Refresh
is not a guest reset. Existing owner opens do not start a new refresh.
See [the rollout and recovery notes](release/OMARCHY-PREPARED-REFRESH.md).

Public copy says Omarchy (prepared computer) is paused for new claims.
Windows requires your own server and your licensed image. Neither is a preview.

## Other surfaces

| Surface | Status |
| --- | --- |
| Buzz agent collaboration | Usable: connect a relay and install the sidecar on an eligible computer. Not a launch target. |
| Self-hosting the whole platform | Preview. `README.md` headlines "Self-host preview" and the roadmap page says so. |
| Free agent tools on `/tools` | Canary only. Seven added tools (agent picker, running-cost calculator, free-model finder, job library, Telegram and Discord wizard, security check, SOUL.md builder) show only while `NEXT_PUBLIC_HIVRA_AGENT_TOOLS_ENABLED` is on. The flag is on for Canary and off for hivra.cloud. |
| Card trial | Built, off by default. While `HIVRA_CARD_TRIAL` is `on`, a first-time buyer of the entry plan (monthly) gets 7 days free in Stripe Checkout, with a card required and charged when the trial ends. During the trial the account has one agent with 1 vCPU and 2 GB, its Hivra Cloud agents sleep when idle and can't be kept awake, and the AI starter credit is $1. One trial per account and per card. Billing shows the trial with an "Upgrade to full Pro now" button that ends the trial and charges right away; changing plan during the trial also ends it. Trial accounts get no Venice promo credit or top-up bonus. With either pricing mode, the pricing page offers the trial only when enabled and the monthly entry price, Stripe Checkout, webhooks, and the database are configured. No App Store trial. Needs the `20261119150000_card_trial` migration. |
| Free plan closed to new sign-ups | Built, off by default. While `HIVRA_FREE_PLAN_CLOSED_AT` is set (an ISO time), accounts created at or after it cannot activate the Free plan, connect their own server or launch on it without a paid plan or trial; accounts created before it keep the Free account. The pricing page stops offering the Free plan once that time has passed. |
| Free cloud agent | Preview, off by default. While `NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT` is `1`, `/dashboard/free-agent` lets any signed-in account create one Lite agent: a chat agent with memory notes that lives in Cloudflare Durable Objects (`services/lite-agent-worker`), not on a computer. It has a daily allowance of free messages on Hivra's configured models, or no limit with the owner's own OpenAI-compatible key. It cannot run code or use a computer. It needs the Worker deployed and `HIVRA_LITE_AGENT_URL` and `HIVRA_LITE_AGENT_SECRET` set on the deployment. Hivra-run computers still need a paid plan. |
| Hivra Memory | Preview, off by default. While `NEXT_PUBLIC_HIVRA_MEMORY` is `1`, the public page `/memory` describes a free cloud memory that any agent can share over MCP or HTTPS, and `/dashboard/memory` lets a signed-in account create and revoke memory keys, copy the setup for Claude Code, Codex, other MCP apps and plain HTTPS, see how much is stored and delete everything. Memories live in the memory Worker (`services/memory-worker`), one store per account; agents reach it directly with a key. The dashboard needs `HIVRA_MEMORY_URL` and `HIVRA_MEMORY_SECRET` set on the deployment. Not built yet: an installer, plugins for Hermes and OpenClaw, importing past chats. |
| Setup from a coding agent | Docs live with this merge: `/setup` (the prompt to paste) and `/setup.md` (instructions a coding agent follows to send its person to Launch with an agent preselected). The link-and-code handshake (`POST /api/agent-setup`, the poll and `/dashboard/agent-setup/<code>`) is a preview, off by default: it answers 404 unless the server variable `HIVRA_AGENT_SETUP_HANDSHAKE` is `1` and needs migration `20261119140000`. It grants nothing; the person still signs in and presses Launch. |
| Catalog view of Launch | Preview, off by default. While `NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG` is `1`, Launch's Choose step gains a search, an agents and computers filter and "Browse by job", and each tile opens a page (what it is, who makes it, how you talk to it, good first tasks, a picture) before Review, and Home suggests up to two agents the owner does not run yet under "Try next". It lists exactly what Launch already offers and changes nothing about what can launch. Once use is known, agents more people use are listed first. |
| Universal catalog agents and open-source apps | Canary preview; the flag is on for Canary and off for hivra.cloud. While `NEXT_PUBLIC_HIVRA_UNIVERSAL_CATALOG` is `1`, Hivra exposes declarative, OSI-approved open-source agents and self-hosted apps. The catalog now holds 83 entries: personal agents (Nanobot, ZeroClaw, PicoClaw), coding agents and CLIs (OpenCode, Goose, OpenHands, Aider, Qwen Code), an AI workspace (AnythingLLM), AI infrastructure (Qdrant, Chroma, Ollama, New API), developer tools (Gogs, draw.io, Excalidraw, Mermaid Live Editor, CyberChef, Swagger UI, Node-RED, Kanboard, Kroki, Syncthing, Jenkins, ClickHouse, Appsmith, Dufs, Gotenberg, ConvertX, Termix, Dagu, Apache Solr), productivity (Memos, Wallos, Shiori, Actual Budget, Mealie, Vaultwarden, IT-Tools, TriliumNext Notes, FreshRSS, Nextcloud, Miniflux, Docmost, Wiki.js, Linkwarden, HedgeDoc, RSSHub, ezBookkeeping, PairDrop, Artalk, Apache Answer, SilverBullet, Wakapi, Stump, The Lounge, WeKan, AirTrail, AdventureLog), dashboards (Dashy, Homepage, Flame, Homer, Sun-Panel), monitoring and operations (Uptime Kuma, Grafana, Beszel, OpenSpeedTest, Netdata, Traccar, Umami, OpenObserve, AdGuard Home, Zoraxy, LibreSpeed) and media (Audiobookshelf, Kavita, Calibre-Web, Suwayomi, Komga, Immich, Profilarr, Owncast). Ten entries use the `docker-stack` runtime (an app plus supporting services, with generated shared secrets where configured), including Umami, WeKan, AirTrail and AdventureLog. Candidates that failed the gateway check (apps that build absolute redirects or links from the loopback Host, collide with the reserved `/app/` path, or require admin credentials) were removed from the registry; several are recorded as `needs-secret` or `needs-public-url` in `dashboard/catalog-curation/candidates.jsonl` pending a credential model; the public-origin placeholder (`${HIVRA_PUBLIC_ORIGIN}`, `${HIVRA_PUBLIC_HOST}`) and generated per-app secrets now exist in the manifest schema and guest runner, and a `docker-stack` runtime renders multi-container apps as a hardened Compose project. Provisioner release 2026.11.20.5 carries the runner, the `/login` gateway fix for catalog apps and the matching admission migration `20261121100000_provider_release_admission_2026_11_20_5.sql`. Every expansion entry passed the deterministic local verifier (`dashboard/scripts/catalog-curator/verify-candidate.mjs`: GitHub SPDX licence check, image platform check, boot with guest-runner-equivalent flags, `/app/` gateway proxy emulation including redirect and login-form checks, idle-memory floor) with committed evidence under `dashboard/catalog-curation/evidence/`; this proves local boot and gateway checks, not a live Canary launch or app sign-in. The licence gate accepts all OSI-approved open-source SPDX ids including copyleft (GPL, AGPL, LGPL, MPL); source-available and unclassified licences are still rejected. Manifests are split per category under `dashboard/src/lib/hivra/catalog-manifests/manifests/` and all derived surfaces (launch contracts, resource policies, wake profiles, SQL canonical surfaces/actions, native route grammar, launch sweep, migration metadata) come from the catalog. Backed by the shared `catalog-app` guest runner (`hivra-catalog-app.py`, launch document v5, `/app/` gateway proxy, and generic in-place updates). Needs provisioner release `2026.11.20.4` or later and migrations `20261120160000_universal_catalog_apps`, `20261120161000_provider_release_admission_2026_11_20_2`, `20261120162000_provider_release_admission_2026_11_20_3`, `20261120163000_provider_release_admission_2026_11_20_4` and `20261121090000_catalog_app_slug_surfaces`. Initial live Canary proof has started; see the next row before treating any further entry as certified. |
| Live catalog certification | Canary-only operator evidence, not production approval. On exact served Canary merge `1e5789cec7186852fa80d15ad7d9713255df2a72` with provisioner `2026.11.23.1`, the first bounded matrix proved IT-Tools, Vaultwarden and Umami end-to-end through launch, authenticated app open and clean teardown; ZeroClaw also passed end-to-end in Hivra chat with private-models-only enabled and clean teardown; Nanobot and OpenHands failed their customer-visible proof and are remediation work, not certified entries. The rest of the universal catalog remains uncertified until the serial continuous certifier records a pass for its current manifest and provisioner. The certifier and cheap remediation worker are automation in this repository; they do not change the catalog flag and never promote to production. |
| Maker claims on catalog pages | Preview, off by default, with a switch of its own: `NEXT_PUBLIC_HIVRA_MAKER_CLAIMS` is `1` and the catalog view of Launch is on. A maker proves they run an agent's project by adding a file with a line Hivra gives them to the project's repository. A proven claim marks the page as claimed and shows the maker how the agent is used on Hivra (people, launches, hours, the share still running after two weeks) and a launch button for their README. Maker earnings are shown as not turned on: nothing is paid. Editing a page and proof by DNS record are not built. |
| Direct sign-in to a computer | Usable once a computer runs provisioner release 2026.11.21.1. Opening the computer's address in a browser leads to a sign-in page rather than the bare "box is private" page; the owner can set or clear their own computer password from the agent page (Direct sign-in), or keep using the dashboard sign-in and Connect app links. The computer stores only the password digest, and API clients still get a plain 401. |
| Hermes Desktop remote connection | Requires connection service release 2026.11.22.1 and a compatible Hermes version. On the Hermes agent page, **Connect app** provides the Remote URL and session token for the installed Hermes Desktop app. On the same release, the bare browser address opens the native Hermes or Agent Zero sign-in. |
| Canary only, not yet on hivra.cloud | Listed in the "Where things stand" paragraph of [the roadmap](../ROADMAP.md). Nothing reaches hivra.cloud until the owner approves a production promotion. |

## Owner decisions

Newest first. Record a decision here when the owner makes it, with the date,
and update every document it contradicts.

| Date | Decision |
| --- | --- |
| 2026-11-26 | Supported managed Hivra computers can launch through gated token-holder admission without a paid subscription. See [token-holder access](#token-holder-access) for the requirements and verification status. |
| 2026-11-19 | Hivra offers a free trial instead of a free version: 7 days of the entry plan with a card required, on a smaller computer that sleeps when idle. It ships behind `HIVRA_CARD_TRIAL`, off by default. |
| 2026-10-21 | Hivra runs no free computer; a free account works with a computer the person connects. The paid-plan-only requirement was updated by the token-holder decision above. |
| 2026-09-30 | Windows and Omarchy are offered, not in private preview. Each keeps its condition (see Computers). |
| 2026-09-30 | Copy may call Hivra open source and self-hostable and link the repository. The licence file is authoritative; copy never names the licence and never says "public domain". |

## Where the rest of the documentation fits

See [the documentation index](README.md). In short: current guides and
contracts first, then target designs, then dated records that describe one
moment and are never read as current status.
