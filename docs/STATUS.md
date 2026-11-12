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

All seven launch from Launch. Every computer Hivra Cloud runs needs a paid plan;
a free account works with a server the person connects.

| Agent | Status | Where it runs |
| --- | --- | --- |
| Claude Code | Available | Hivra Cloud or a Proxmox server you connected |
| Codex | Available | Hivra Cloud or a Proxmox server you connected |
| Hermes | Available | Hivra Cloud only. Existing Hermes agents keep running on their current lane. New launches go to a Hivra computer running the official Hermes Agent (its own installer and web UI, updated with `hermes update`) on a paid plan. Live on Canary; it reaches hivra.cloud with the next owner-approved production promotion |
| OpenClaw | Available | Hivra Cloud or a Proxmox server you connected |
| Agent Zero | Available | Hivra Cloud or a Proxmox server you connected |
| Aeon | Available | Hivra Cloud or a Proxmox server you connected |
| DeepSeek Harness | Available (alpha) | Hivra Cloud only, on a paid plan. It needs a host on provisioner release 2026.11.10.5 or later |
| OpenBot (CopilotKit) | Preview, off by default | Hivra Cloud only, on a paid plan, when `NEXT_PUBLIC_HIVRA_OPENBOT_AGENT` is `1` on the deployment. It needs provisioner release 2026.11.12.4 or later |

Claude Code can sign in with the person's own Claude account, or run on Hivra
credits: Hivra translates its requests for Venice's Claude models and bills the
credits. Credits need a host on provisioner release 2026.11.10.2 or later.

Hermes on a Hivra computer is the official Hermes Agent, unmodified: Hivra
creates the computer, runs Hermes's own installer, points it at Venice inference
(default model `deepseek-v4-1-flash`, or the person's own Venice key), and opens
Hermes's own web UI behind the Hivra sign-in at `/hermes/`. There is no
Hivra-built image, fork or patch. Owners update it with `hermes update` in
Terminal or the Update Hermes button on the agent's Manage tab. It needs
provisioner release 2026.11.12.1 or later and at least 1 CPU and 2 GB, on a paid
plan like every Hivra-run computer (there is no free compute). There is no
deployment switch for it: what Canary runs is what a production promotion ships.

DeepSeek Harness runs DeepSeek's own coding agent in its own interface, reached
through Hivra's authenticated gateway. It launches with no browser and gets its
model at launch, because DeepSeek's own settings refuse a key from a remote
browser: it runs DeepSeek V4.1 Flash on Hivra credits by default, or on the
person's own Venice API key. It is labelled alpha because the upstream version it runs is pinned
at an alpha release. It has no public agent page yet, and a connected server or
a computer in the owner's own cloud cannot run it. Its Launch tile is not on
the first-run card, which stays at three choices.

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

The one-command Ubuntu connect gives Linux Sandbox only. The agents above, and Ubuntu Desktop, need a Proxmox VE server connected with SSH details to run on your own server.

## Computers

| Computer | Status | Condition |
| --- | --- | --- |
| Ubuntu Desktop | Available | Hivra Cloud or a Proxmox server you connected |
| Linux computer | Available | Hivra Cloud on a paid plan. A headless Ubuntu computer with a terminal and files, no desktop (provisioner release 2026.11.10.4). Attaching an agent to it is not supported yet. |
| Linux Sandbox | Available | A gVisor-ready server you connected |
| Omarchy | Available, with a condition | A prepared computer on Hivra Cloud. A launch claims the one prepared Omarchy computer the site holds, so the tile appears only where that computer is configured. Hivra does not yet build a fresh Omarchy computer per customer. |
| Windows | Available, with a condition | On a Proxmox server you connected, from your own licensed Windows ISO. Hivra-managed Windows is not offered. |
| macOS | Not offered | Planned only. |

Pending release: new Omarchy claims will reserve the prepared computer while
updating to the latest supported official stable v4 release. Desktop stays
blocked until the exact release, migrations and rebooted kernel are verified;
existing owner opens do not trigger upgrades. This requires migration
`20261103010000` and the matching dashboard release. Live rollout is unverified.
See [the rollout and recovery notes](release/OMARCHY-PREPARED-REFRESH.md).

Public copy never calls Omarchy or Windows plainly available, and never calls
them a preview: each always carries its condition, "Omarchy (prepared
computer)" and "Windows on your own server with your licensed image".

## Other surfaces

| Surface | Status |
| --- | --- |
| Buzz agent collaboration | Usable: connect a relay and install the sidecar on an eligible computer. Not a launch target. |
| Self-hosting the whole platform | Preview. `README.md` headlines "Self-host preview" and the roadmap page says so. |
| Canary only, not yet on hivra.cloud | Listed in the "Where things stand" paragraph of [the roadmap](../ROADMAP.md). Nothing reaches hivra.cloud until the owner approves a production promotion. |

## Owner decisions

Newest first. Record a decision here when the owner makes it, with the date,
and update every document it contradicts.

| Date | Decision |
| --- | --- |
| 2026-10-21 | Hivra runs no free computer. Every Hivra Cloud computer is paid; a free account works with a computer the person connects. |
| 2026-09-30 | Windows and Omarchy are offered, not in private preview. Each keeps its condition (see Computers). |
| 2026-09-30 | Copy may call Hivra open source and self-hostable and link the repository. The licence file is authoritative; copy never names the licence and never says "public domain". |

## Where the rest of the documentation fits

See [the documentation index](README.md). In short: current guides and
contracts first, then target designs, then dated records that describe one
moment and are never read as current status.
