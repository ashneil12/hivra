# Plan: sleeping agents that wake on any server

**Status:** plan only. No code, config, builder or release has changed.

> **Hard review required.** This plan touches the sandbox boundary, tenant
> isolation, snapshot handling of customer memory, and network egress. Every
> step that leaves the planning stage needs a security review before code,
> and the bake-off runs only on a host that carries no customer agents.

**Terminology.** The research that started this plan calls a running agent a
"Mono". In Hivra that is a Hivra-run **agent** or **computer**: one Proxmox
virtual machine per agent (`hivra_agents`, `deployment_mode = 'hivra-managed'`),
plus the older Hermes lane (`hermes_instances`). This doc says "agent".

**Goal.** An idle agent is put to sleep (memory and disk saved) and woken by
its next message, request or scheduled job, on whichever server has room. The
owner sees the same address, the same files and, ideally, the same running
session. Freed memory lets the same servers hold several times more agents.

**No free compute.** Sleeping agents still live on Hivra's servers, so they
still need a paid plan. Sleep changes what a plan holds, not who can use
Hivra-run computers.

---

## 1. How agents run today

| Area | Today | Where |
| --- | --- | --- |
| Machine | One KVM virtual machine per agent, created by `qm create ... --cpu host` | `dashboard/provisioner/hivra-provision-on-host.sh` |
| Disk | 40 GB thin volume on the host's own `local-lvm` (LVM-thin), not shared | same file (`HIVRA_STORAGE`, `HIVRA_DISK_GB`) |
| Network | Private range `10.251.20.x` behind bridge `hivra0` on **every** host, so an address is only meaningful on its own host | same file (`HIVRA_SUBNET_PREFIX`, `HIVRA_BRIDGE`) |
| Inbound traffic | Per-agent Caddy site on the host, `reverse_proxy <private IP>:80`; the box gateway inside the VM routes to chat, terminal, desktop and the upstream agent UI | `dashboard/src/lib/services/proxmox-gateway-caddy-site.ts`, `dashboard/provisioner/bux-*.service` |
| Memory | Pinned: `--memory` equals the plan's RAM and the balloon floor equals memory. Burst is built but off | `dashboard/src/lib/services/ram-burst.ts` (`HERMES_RAM_BURST_ENABLED`) |
| Plan limits | Pro 2 vCPU / 4 GB / 3 agents, Power 4 / 8 / 5, Command 8 / 16 / 8, enforced as a shared pool | `dashboard/src/lib/subscription/plans.ts`, `dashboard/src/lib/hivra/resource-gate.ts` |
| Host capacity | `proxmox_hosts`: production on 12 Nov 2026 had 4 active hosts at 12 cores / 128 GB each (2 cores and 4 GB reserved, 8 GB wake headroom, 48 to 54 tenants), plus 6 in maintenance | `supabase/migrations/20260510120000_proxmox_hosts_registry.sql` |
| Idle handling | Older Hermes lane only: an hourly sweep shuts machines down after 4 idle days, for the old free tier; paid tiers are exempt | `dashboard/src/lib/recovery/inactivity-sweep.ts` |
| Wake on open | Older Hermes lane only: Caddy turns a 502 from a parked machine into a redirect to `/wake/<id>`, which starts it | `dashboard/src/lib/services/caddy-wake-fallback.ts`, `dashboard/src/app/wake/[instanceId]/` |
| Activity signal | Hourly probe of the agent's own last chat time, including Telegram and Discord | `harvest-agent-usage`, read by the inactivity sweep |
| Restore elsewhere | Cold-storage restore already picks any host with room, a new VMID and a new IP, and rebuilds the Caddy site. It takes minutes | `dashboard/src/lib/services/cold-storage-restore-orchestrator.ts`, `cold-storage-restore-routing.ts` |
| gVisor | Already shipped for "Linux Sandbox" on servers owners connect, via a root-only adapter | `dashboard/provisioner/gvisor/hivra-gvisor-adapter.py` |

Agents are full Ubuntu machines with systemd, browsers, optional desktops, and
official upstream installs (Hermes's own installer, OpenClaw, Claude Code,
Codex). Owners update them with the agent's own command. Any sleep design has
to keep that: it saves and restores whole machines, it never repackages the
agent.

### Corrections to the research's assumptions

- **Servers.** The research assumes 3 × AX41 (6 cores, 64 GB). The capacity
  table above shows 4 active hosts at 12 cores / 128 GB. Confirm the real
  models, CPU generation and data centre of each host before any cluster or
  cross-host step.
- **Memory per agent.** The research infers about 2 GB each. Paid agents are
  pinned at 1 to 8 GB, most at 4 GB. Real resident memory inside the guest is
  unmeasured; phase 0 measures it.
- **Workload shape.** Substrate, E2B and Spawnbox are built for sandbox images
  of a few GB. Hivra's are 40 GB general-purpose machines, some with desktops.
  Snapshot sizes and move times will be larger than their published figures.

## 2. When an agent may sleep

An agent sleeps only when **every** check passes for 15 minutes (tunable).
Unknown always means awake.

1. **Nothing in flight.** No model call streaming, no agent turn running, no
   tool or shell command running, no browser job, no file transfer. Read from
   the agent's own process state on the box (agent CLI processes, the browser
   sidecar, open PTYs), never from dashboard silence.
2. **Nobody attached.** No open chat socket, terminal, desktop stream or
   upstream web UI session.
3. **Quiet machine.** CPU under 5% and disk I/O near zero over the window.
4. **No job due.** No scheduled job in the next 10 minutes. Next-run times are
   read from outside the agent: Hermes cron in its own config, OpenClaw
   heartbeat and cron, Agent Zero's scheduler, Aeon's schedule. If the time
   can't be read, the agent stays awake.
5. **No live channel.** Agents holding a long-lived connection (Discord
   gateway, WhatsApp, Slack socket mode) cannot sleep, because nothing outside
   can receive for them. They are labelled **Always on**. Telegram can switch
   to webhook delivery through the front door and so can sleep (verify upstream
   Hermes and OpenClaw support before relying on it).
6. **Owner choice.** An owner can pin an agent Always on.

Before the snapshot: flush page cache in the guest (`drop_caches`) to shrink
the memory image, and record the next wake time if a job is scheduled.

## 3. Snapshot format and storage

**Format, by option** (see section 8):

- Proxmox: `qm suspend --todisk` writes a `vm-<id>-state-*` volume holding
  used guest memory; the disk stays where it is.
- Firecracker or Cloud Hypervisor: memory file plus diff against the template,
  restored lazily through userfaultfd; disk as a copy-on-write overlay or diff.
- gVisor: `runsc checkpoint` image plus the container's volume.

**Storage, in order:**

1. **Local NVMe first.** Most wakes happen on the same host, so the snapshot
   stays on it and wakes stay fast.
2. **Durable copy, asynchronous.** After a few minutes asleep, copy the
   snapshot to S3-compatible storage (Hetzner Object Storage, or MinIO on a
   separate box), encrypted with a per-agent key held by the control plane.
   This is also the disaster-recovery copy and replaces part of today's cold
   storage path.
3. **Buddy replica, optional.** On sleep, send the diff to one second host
   (`zfs send -i`, or rsync of diff files), so two hosts can wake it from local
   disk. Doubles snapshot disk use.
4. **Long sleep.** After 7 days asleep, drop the memory image and keep only
   the disk; the next wake is a normal boot. After the existing cold-storage
   window, archive as today.

**Disk budget per host.** Reserve a fixed share of each host's thin pool for
memory images (start at 20%), and refuse new sleeps that would exceed it (the
agent stays awake and the host is marked full). Hosts already overcommit thin
disk 1.5 to 2.7 times (`proxmox_hosts.thinpool_overcommit_ratio`); memory
images count against the real free space, not the overcommitted figure.

## 4. Placement and a stable address

**Stable address.** Every agent keeps its public hostname. It points at every
host (or at a small edge tier), never at one host. Whichever host receives the
request looks up `agent → current host and state` in the control plane
(cached), then:

1. **Awake on this host:** forward as today.
2. **Awake on another host:** forward over the private network.
3. **Asleep:** hold the request open (browser navigations get the existing
   "Waking" page instead), ask the control plane to wake, then forward. Give up
   after 30 seconds with a 503 and `Retry-After`, as `caddy-wake-fallback.ts`
   does today.

**Choosing the host at wake,** in order:

1. a host that already has the snapshot on local disk and has free memory;
2. otherwise the host with the most free memory above `wake_headroom_ram_mb`;
3. otherwise queue the wake and tell the owner capacity is full.

Wakes are admitted through the same per-host capacity lock the launch path
uses (`hivra-host-capacity-admission`), with a limit on wakes running at once
per host, because restores are CPU-bound.

**Plan accounting.** The plan gate counts **awake** agents against the plan's
CPU and memory, and counts all agents against a higher agent limit. If a wake
would exceed the plan's awake share, the owner's longest-idle agent sleeps
first; if none can, the wake waits and the owner sees why.

## 5. Rules for waking on a different host

- **Same CPU and versions.** Every host in the pool runs the same CPU model
  setting for guests (replace `--cpu host` with one common model such as
  `x86-64-v3`, or a Firecracker CPU template), the same kernel, and the same
  hypervisor version. Upgrades wake or boot every sleeping agent first, or
  treat old snapshots as boot-only.
- **Fixed guest address.** Each agent keeps one private IP wherever it runs:
  either a per-agent network namespace with NAT on each host (the E2B
  pattern), or one flat private network across hosts (Proxmox SDN over a
  Hetzner vSwitch) with globally unique addresses. Today's per-host
  `10.251.20.x` reuse must end before cross-host wakes.
- **Egress IP changes.** Outbound traffic leaves from the new host's IP.
  Document it; route through a shared egress gateway only if owners rely on IP
  allowlists.
- **After every wake:** force a clock sync (guest agent or chrony step), reseed
  the kernel RNG from the host, and restart or nudge long-lived connections
  (gateway sockets, Telegram webhook registration, MCP sessions). Agents are
  expected to see connection resets once.
- **Proxmox limit.** Proxmox refuses to migrate a machine with a suspend lock.
  On Proxmox, a wake on a different host therefore boots from the replicated
  disk (20 to 60 seconds) instead of resuming memory.

## 6. Safety

- **Isolation stays at least VM-grade.** Every agent stays in its own KVM
  machine, Firecracker or Cloud Hypervisor microVM, or gVisor sandbox. No
  plain containers.
- **No memory sharing across customers.** KSM stays off, or limited to one
  owner's agents. Shared read-only base images (DAX or copy-on-write) are fine
  because they hold no customer data.
- **Snapshots are customer memory.** They can hold tokens, keys and chat
  content. Encrypt at rest on local disk and in object storage, with keys
  scoped per agent; delete all copies when the agent is deleted; never copy a
  snapshot to a host outside the pool.
- **Credentials outside the sandbox where possible.** Where an upstream agent
  allows it, inject provider keys at an egress proxy instead of the guest.
  Where it doesn't (most official upstream installs keep their own config),
  note that the snapshot contains them.
- **Egress rules survive the move.** Per-agent firewall rules (the host
  perimeter guard and anti-spoof rules) are recreated on the target host
  before the agent's network comes up, and checked after.
- **Clone safety.** A snapshot is never resumed twice. The control plane holds
  one owner of each agent's state (a lease) and refuses a second resume.

## 7. Bake-off on one spare server

Use one of the hosts currently in `maintenance`, taken fully out of customer
placement, running bare Debian with KVM. No customer data.

**Contenders:**

1. Proxmox hibernate (`qm suspend --todisk`) on the current host build, as
   the baseline.
2. E2B runtime, single-node Embed package.
3. Spawnbox (ideas and measurements only; its README says not for production).
4. Agent Substrate on single-node k3s, microVM class, if time allows.

**Workloads,** each built from the official upstream installers as today:
Claude Code agent, Hermes with its gateway and one cron job, and one Ubuntu
Desktop (Proxmox baseline only, to confirm desktops stay on Proxmox).

**Measure,** for each contender:

| Measure | Target |
| --- | --- |
| Time to sleep | Under 10 s for a 4 GB agent |
| Wake to first chat reply, p50 and p95 | p95 under 3 s same host |
| Snapshot size on disk, memory and disk diff | Report per workload |
| 20 wakes at once, p95 | Under 10 s |
| Cross-host wake, snapshot local vs pulled over 1 Gbit | Report both |
| After wake: chat, terminal, cron, Telegram webhook, clock, outbound HTTPS | All pass |
| Upstream update after wake (`hermes update`, `claude update`) | Passes |

Record results in this doc. Stop the bake-off if any contender needs changes
inside the upstream agents.

## 8. Options

| Option | What changes | Wake same host | Wake other host | Risk | Rollback |
| --- | --- | --- | --- | --- | --- |
| **A. Stay on Proxmox: hibernate plus wake on open** | Add sleep checks, `qm suspend --todisk`, extend the Caddy wake path to `hivra_agents`, awake-based plan gate. Later: join hosts in one cluster over vSwitch, ZFS replication, one CPU model, one private network | Seconds (estimate 3 to 10 s for 4 GB) | Boot from replica, 20 to 60 s | Low; reuses current stack and isolation | Switch off; agents stay awake as today |
| **B. Agent Substrate on k3s** | Move headless agents to a Kubernetes pool of bare-metal nodes with Cloud Hypervisor or gVisor; its router, snapshots and egress gateway | Under 500 ms (project's claim) | Under 1 s cached, seconds pulled | High: new platform, new isolation and operations model, desktops likely stay on Proxmox, project is months old | Keep Proxmox pool running; move agents back by restore |
| **C. Own Firecracker orchestrator (E2B pattern)** | Write placement, node orchestrator, uffd restore, edge proxy | Under 1 s | About 1 s cached | High: most code to own; same desktop gap | As B |
| **D. Proxmox plus Sablier-style wake** | Not applicable: Sablier wakes stopped containers or LXC, and Hivra runs VMs with its own wake page already | | | | |

**Recommendation.**

1. **Now:** phase 0 measurement (how often agents are really awake, resident
   memory) and option A on the current hosts, behind a switch that is off by
   default, Canary first. This captures most of the density gain with the
   least risk.
2. **In parallel:** the bake-off in section 7 on one maintenance host.
3. **Decide after the bake-off:** whether headless agents (Claude Code, Codex,
   Hermes, OpenClaw, Agent Zero, Aeon, DeepSeek Harness) move to a microVM
   pool (B or C) while desktops stay on Proxmox. Cross-host pooling on
   Proxmox (cluster, replication, shared private network) is worth doing only
   if B and C are rejected.

## Open questions

- Exact host models, CPU generations and data centres (a Proxmox cluster
  needs under 5 ms between nodes).
- Thin pool sizes per host, which set the disk budget for memory images.
- Whether upstream Hermes and OpenClaw support Telegram webhook mode.
- Plan copy: Pro currently promises "never paused for inactivity"; that
  wording changes before any paid agent sleeps.

## Sources

- Agent Substrate: https://github.com/agent-substrate/substrate (Apache-2.0)
- E2B runtime: https://github.com/e2b-dev/runtime (Apache-2.0)
- Spawnbox: https://github.com/TulipFarm/spawnbox (Apache-2.0, early)
- Proxmox `qm` hibernate and migration: https://pve.proxmox.com/pve-docs/qm.1.html
- Proxmox suspend lock blocks migration: https://lists.proxmox.com/pipermail/pve-devel/2019-March/036029.html
- Hetzner vSwitch: https://docs.hetzner.com/robot/dedicated-server/network/vswitch/
- Hetzner 10G uplink: https://docs.hetzner.com/robot/dedicated-server/network/10g-uplink/
- Firecracker snapshot compatibility: https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
