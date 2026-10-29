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
| Previews that are shown but not launchable | `dashboard/src/lib/hivra/preview-catalog.ts` |
| Public wording for crawlers and the homepage | `dashboard/src/lib/llms-txt.ts` and `dashboard/src/components/landing/home/content.ts` |

## Agents

All six launch from Launch. Every computer Hivra Cloud runs needs a paid plan;
a free account works with a server the person connects.

| Agent | Status | Where it runs |
| --- | --- | --- |
| Claude Code | Available | Hivra Cloud or a server you connected |
| Codex | Available | Hivra Cloud or a server you connected |
| Hermes | Available | Hivra Cloud only |
| OpenClaw | Available | Hivra Cloud or a server you connected |
| Agent Zero | Available | Hivra Cloud or a server you connected |
| Aeon | Available | Hivra Cloud or a server you connected |
| DeepSeek Harness | Preview, not launchable | Shown on Agents only |

## Computers

| Computer | Status | Condition |
| --- | --- | --- |
| Ubuntu Desktop | Available | Hivra Cloud or a server you connected |
| Linux Sandbox | Available | A gVisor-ready server you connected |
| Omarchy | Available, with a condition | A prepared computer on Hivra Cloud. A launch claims the one prepared Omarchy computer the site holds, so the tile appears only where that computer is configured. Hivra does not yet build a fresh Omarchy computer per customer. |
| Windows | Available, with a condition | On a Proxmox server you connected, from your own licensed Windows ISO. Hivra-managed Windows is not offered. |
| macOS | Not offered | Planned only. |

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
