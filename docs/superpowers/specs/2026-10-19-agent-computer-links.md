# Agent ↔ computer links

**Date:** 2026-10-19

**Status:** Built behind a Canary-only flag (`isAgentLinksEnabled`). Owner
approved the agent command endpoint on 2026-10-19. Verified live on Canary
2026-10-28 (Codex agent → Ubuntu desktop).

**Consistent with:** [the canonical agent-computers design](2026-08-24-hivra-agent-computers-design.md)
("an identity is not the computer itself"; references do not imply ownership)
and [attach](2026-09-24-agent-computer-contract-and-attach.md). Attach installs
a second agent *on* a computer; a link lets an agent that lives on its own
computer *use* another one. Nothing is installed on the linked computer.

## What the owner gets

- Any of their agents can be linked to any of their computers, many to many.
- From the agent's Manage page (Overview: "Computers this agent can use") or the
  computer's (Agents: "Agents that can use this computer"; a Linux sandbox has
  it in Overview). One pair at a time, or "Link all my computers" / "Link all my
  agents".
- Removing a link takes the computer away at the agent's next command.

## What the agent gets (the kit)

Delivered to the agent's own computer over the seed lane it already uses
(Proxmox `ubuntu@guest` + sudo, or the enrolled pin on My cloud):

| File | Purpose |
|---|---|
| `/usr/local/bin/hivra-computers` | CLI: `list`, `run <computer> -- <cmd>`, `push`, `pull`, `screenshot` |
| `~/.hivra/link.json` (0600) | Hivra's endpoint and the agent's key |
| `~/.hivra/COMPUTERS.md` | The linked computers and how to use them |
| `~/.claude/skills`, `~/.agents/skills`, `~/.openclaw/skills` `/hivra-computers/SKILL.md` | So each runtime that reads skills knows, with the computer names in its description |

The kit is re-sent whenever its content would change (a link added or removed,
a rename, a new CLI version): link changes mark it out of date, and the next
link change, Manage read or agent poll delivers it. With no links left the same
program removes the key, `COMPUTERS.md` and the skills; the CLI stays and says
that no computers are linked. Live-checked on Canary 2026-10-28 (link, kit,
`run … -- uname -a` on the desktop, remove, refused with the old key).

## How a command runs

`hivra-computers` → `POST /api/agent-link` with `Authorization: Bearer hvl_…`
→ Hivra checks the key (SHA-256 in `hivra_agent_link_keys`), the agent, and the
link (`hivra_agent_computer_links`) on every request → the computer's lane:

- **Proxmox Linux computers** (Ubuntu desktop, Omarchy): the host checks the VM
  is running and carries this computer's binding tag, then runs one fixed
  program through that VMID's QEMU guest agent. The command, stdin and limit
  travel only as JSON on stdin. The program drops to the computer's own user
  (`bux`, or the desktop owner), runs `bash -lc` in its home with the desktop
  session's `WAYLAND_DISPLAY`/`DISPLAY` when present, and returns exit code and
  output (stdout 256 KB, stderr 64 KB, at most 120 s).
- **Linux sandbox** (gVisor): the existing adapter's `exec`.
- Not yet: Windows, computers in the owner's own cloud (their lane runs only
  fixed Hivra scripts, 8 s), DigitalOcean agents, legacy Hermes instances.

The agent API path is excluded from the Clerk proxy (like the activity
collector) because the key, not a session, is its authority. It never reads a
cookie. Each command is logged without its content (agent, computer, size,
outcome) and stamps the link's `last_used_at`.

## Security notes

- The key is the agent's alone, minted on every delivery. The new key is
  accepted as soon as it is minted (`pending_key_sha256`) and confirmed when
  the computer answers, so a rotation never refuses the agent.
- A linked agent acts as the computer's own user, never root. On Ubuntu
  computers that user has sudo; linking is the owner's grant of that.
- Both tables are service-role only. Rows go with a soft-deleted agent or
  computer (trigger) and with the account (`ACCOUNT_DELETION_TABLES`).

## Not done

- No Computer Contract change: Claude Code and Codex learn about linked
  computers from the skill and `~/.hivra/COMPUTERS.md`, not the contract block.
- No desktop input API beyond what the computer's own tools offer.
- Production stays off until a Promote that includes it.
