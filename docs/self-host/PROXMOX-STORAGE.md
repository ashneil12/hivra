# Proxmox fleet storage and recovery

## Core Rule

Treat Hermes Proxmox work as production incident work. Prove the root cause with measurements, canary the fix on one VM, verify host-level impact, then roll out in small waves. Never claim storage is fixed from guest `df` alone.

## First Moves

1. Confirm the host and key mapping before SSH. Prefer clearly scoped key names such as `hermes-proxmox-admin-<host-id>`; do not guess through random keys.
2. Start read-only: `qm list`, host pool usage, VM disk sizes, Caddy status, and recent task logs.
3. For storage issues, capture four numbers before and after any canary:
   - guest root usage: `df -h /`
   - guest containerd overlay size
   - VM thin volume usage on the host
   - host thin pool usage
4. If guest usage drops but host pool does not, stop and diagnose discard/reclaim. Never assume guest cleanup returned host space until host-pool measurements prove it.

## Hivra Standup Baseline

Every PVE intended for Hivra or Claude Code agent placement must pass this host baseline before it is added to `HERMES_PROXMOX_TARGETS` or marked `active` in `proxmox_hosts`.

Read-only checks first:

```sh
command -v qm
qm list
test -d /root/hivra-provisioner
test -f /root/hivra-provisioner/hivra-provision-on-host.sh
test -f /root/hivra-provisioner/hivra-start-on-host.sh
test -f /root/hivra-provisioner/provision-claude-code-box.sh
test -f /root/hivra-provisioner/hivra-chat/server.js
test -r "$HIVRA_CLOUD_IMAGE"
test -r "$HIVRA_VM_PRIVATE_KEY"
test -r "$HIVRA_VM_PUBLIC_KEY"
ip link show vmbr1
pvesm status | awk '$1=="local-lvm"{found=1} END{exit found?0:1}'
sha256sum "$HIVRA_CLOUD_IMAGE"
```

Resolve `HIVRA_VM_PRIVATE_KEY`, `HIVRA_VM_PUBLIC_KEY`, and `HIVRA_CLOUD_IMAGE`
on the selected host from its own configuration before these checks. Paths in
this runbook describe the historical Proxmox lane; use the current provisioner
manifest and host preparation contract for a new install. Install the committed,
verified provisioner bundle if missing. Download images from the approved upstream
and verify the exact release checksum before activation; never activate partial files.

Only after the host baseline passes:

- add the host-specific `PROXMOX_PVE*_...` env values in Vercel Production
- add the host to `HERMES_PROXMOX_TARGETS`
- upsert the host in `proxmox_hosts` with measured CPU/RAM/thin-pool capacity
- keep dedicated-lane overrides such as `HIVRA_CLAUDE_CODE_PROXMOX_HOST` unset unless ops intentionally wants one agent type pinned to one host

For lifecycle correctness, each PVE needs a non-overlapping VMID range and matching IP last-octet start. Hivra start/restart/resize maps IP octet as:

```text
PROXMOX_IP_LAST_OCTET_START + (vmid - PROXMOX_VMID_START)
```

Do not reuse the old test-only VMID window as the fleet default.

## Mixed Hermes + Hivra Host Baseline

A mixed host is not a Hivra-only exception. Resolve its current identity and
capacity from the private host registry at run time; do not copy hostnames,
addresses, key paths, VMID lanes, subnets, template IDs, or capacity figures
into this public runbook.

Before activating a mixed host, verify:

- the selected host credential is explicitly mapped and authorized;
- Hivra and Hermes VMID lanes do not overlap;
- the private address lane maps one-to-one with the VMID lane;
- the expected template and VM orchestrator public key exist;
- Caddy is active with the required DNS provider and certificate material;
- measured CPU, RAM, thin-pool, and tenant limits match the private registry;
- the deployed control plane resolves the host-specific environment as configured.

Use environment variables populated from the private registry when running SSH
checks. Never commit a real host address or administrative key path:

```sh
test -n "${HIVRA_AUDIT_HOST:-}"
test -n "${HIVRA_AUDIT_KEY:-}"
ssh -i "$HIVRA_AUDIT_KEY" "root@$HIVRA_AUDIT_HOST" \
  'hostname; qm list; caddy version; systemctl is-active caddy'
```

Keep a mixed host launchable only after the deployed target resolver reports it
configured. Do not assign workloads to legacy or overlapping VMID lanes.

## Safe Cleanup Pattern

Docker's time-filtered image prune can report no reclaimed bytes while dangling image layers remain. Inventory and review explicit dangling image IDs before a scoped cleanup.

Safe:

```sh
docker image ls -a --filter dangling=true -q 2>/dev/null | sort -u | while IFS= read -r image_id; do
  [ -n "$image_id" ] || continue
  docker image rm "$image_id" 2>/dev/null || true
done
ctr -n moby content prune references 2>/dev/null || true
fstrim -av 2>/dev/null || true
```

Never use:

```sh
docker system prune --volumes
docker volume prune
```

Hermes volumes hold user state, workspaces, agent source, and chat data. Cleanup must remove dead images/layers, logs, build cache, old temp files, and unused networks only.

## Canary Rules

Use one old, bloated VM first. A valid canary must prove:

- containers stay running
- private VM HTTP probe returns 200
- host Caddy probe returns 200
- public hostname returns 200
- guest overlay shrinks
- host thin pool shrinks, or the reclaim gap is explicitly diagnosed

If host reclaim does not move after cleanup and `fstrim`, do not roll fleet-wide on that host. Relieve pressure by migration or draining instead.

## Pressure Relief

If a host pool is above 85%, treat it as urgent. If it is above 95%, stop cleanup experiments and move load off the host.

For non-clustered Proxmox hosts:

1. Pick the largest running VMs first.
2. Stage the target host's Caddy route before migration.
3. Use Proxmox remote migration with a short-lived API token, online mode, local disks, and source deletion only after success.
4. Set the migrated VM's target private IP in both Proxmox config and guest networking.
5. Replace the old host's route with a bridge to the target host, preserving Host/SNI and long stream timeouts.
6. Verify private, target-host, source-bridge, and public HTTP paths.
7. Remove temporary API tokens and re-check host storage.

After any migration, reconcile the application database metadata (`host_id`, Proxmox VMID, private IP, and related lifecycle fields). Caddy bridges keep traffic working, but dashboard lifecycle actions can target the old host until metadata is updated.

## Operational failure modes

- Some hosts returned cleaned guest blocks to the thin pool; others did not, so pressure relief required moving VMs. Re-measure every host rather than relying on its past behavior.
- Existing running VMs may still carry old cleanup scripts even after the codebase is fixed. Retrofit them explicitly; do not assume a pushed provisioning change rewrites live guests.
- Check for unsafe old scripts with `--volumes`; replace immediately.
- A VM with low RAM and no swap can crash-loop WebUI even when storage looks fine. Install/verify the Hermes memory guard and swap repair.
- WebUI can restart-loop on stale writable-layer files under `/tmp`; the compose service should clear stale env files and mount `/tmp` as tmpfs.

## Codebase Hardening Checklist

When production work reveals a recurring failure mode:

1. Patch the provisioning/update code path, not only the live VM.
2. Add or update tests that assert the dangerous command cannot return.
3. Preserve detailed logs in `/var/log/hermes-*.log`, but do not use logging as a substitute for fixing the root cause.
4. Run targeted tests, then the repo's full verification command when practical.
5. Commit the confirmed fix.

For this incident class, tests should assert:

- no `--volumes` cleanup in Hermes VM/host cleanup scripts
- explicit dangling-image cleanup exists
- `fstrim.timer` or `fstrim` is enabled where expected
- WebUI has tmpfs `/tmp` and removes stale startup files
- memory guard/swap repair is provisioned

## Reporting

Report in this shape:

- per-host: running/stopped/total VMs, pool %, RAM pressure, Caddy status
- per-action: VM moved/cleaned, before/after numbers, verification result
- anomalies: broken guest agent, failed reclaim, containerd metadata inconsistency, unsafe cleanup scripts, DB reconciliation gaps
- plain English summary: what changed, what is safe now, what still needs follow-up

## Existing-VM discard repair

[The aio repair tool](../../dashboard/scripts/fleet-fix-aio-threads.ts) repairs
existing VMs; changing a template only affects future provisioning. It defaults
to dry-run, supports host/instance scoping, preserves other disk options, excludes
template VMIDs, and records original disk settings. Review its plan and take a
backup before `--apply`: running targets are rebooted and may trim their disks.
Use a maintenance window and verify both guest and host reclaim measurements.
The tool assumes the documented Proxmox `scsi0`/thin-pool layout; inspect the
script and host storage configuration before use on other layouts.
