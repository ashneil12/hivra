# Hermes Cold Storage (Hetzner Storage Box)

**TL;DR**: paused free-tier tenants get tar+zstd archived to a Hetzner Storage Box.
The original VM stays in place until dashboard-side restore is built. This doc
covers the archive layout, the manifest schema, the archive script, and the
manual restore procedure for one tenant.

## Provisioning state

- **Storage Box**: `u594993.your-storagebox.de:23`
- **Username**: `u594993`
- **Capacity**: 10 TB (BX31), Helsinki HEL1, eu-central network zone
- **Pubkey authorized**: `/path/to/cold-storage-key` (also registered in
  Hetzner Cloud as `hermes-deploy-2026-05-16`, key id `112370034`)
- **SSH config** on each PVE host (`/root/.ssh/config`) has aliases `cold` and
  `hermes-cold-storage` pointing at the box with `StrictHostKeyChecking accept-new`.

## Directory layout (Storage Box root = user home)

```
free/<instance-id>/data-<ts>.tar.zst    # tar of config + 3 docker volumes (free tier)
paid/<instance-id>/disk-<vmid>-<ts>.qcow2.zst   # full vzdump qcow2 (paid tier, future)
meta/<instance-id>/<ts>.json            # manifest JSON, one per archive
```

`<ts>` format: UTC `YYYYMMDDTHHMMSSZ`. Multiple archives per instance are kept
side-by-side (no auto-cleanup yet — that's the 60-day retention cron, not built).

## Manifest schema (`meta/<instance-id>/<ts>.json`)

```json
{
  "schema_version": 1,
  "archived_at": "2026-05-16T10:29:40Z",
  "vmid": 216,
  "pve_host": "fixturenodea",
  "instance_id": "11111111-1111-4111-8111-111111111111",
  "archive_path": "free/fixturecase02-…/data-20260516T102940Z.tar.zst",
  "archive_size_bytes": 917665644,
  "archive_sha256": "10977054c9de258a9e9011d812c562bcaf6fc8fd02a60bdcba9747040e356e22",
  "tier": "free",
  "contents": [
    "/opt/hermes/instances/<id>",
    "/var/lib/docker/volumes/agent-<id>_agent-source",
    "/var/lib/docker/volumes/agent-<id>_webui-state",
    "/var/lib/docker/volumes/agent-<id>_webui-workspace"
  ]
}
```

## Free-tier archive: what's saved, what's NOT

**Archived** (the irreplaceable state):
- `/opt/hermes/instances/<id>/` — config tree (env, docker-compose, Caddyfile, sidecar)
- `agent-<id>_agent-source` volume — agent workspace (~1.9 GB typical)
- `agent-<id>_webui-state` volume — chat history, WebUI persisted state (~1.4 GB)
- `agent-<id>_webui-workspace` volume — small, but kept for completeness

**NOT archived** (rebuildable):
- Docker images (re-pulled from GHCR on restore)
- `hermes_caddy_config` / `hermes_caddy_data` — shared per-host
- Anonymous docker volumes (small, transient)
- OS, system packages

A typical paused free-tier tenant compresses ~3.3 GB raw to ~880 MB (~26%).
Tar+zstd-3 walltime is ~95s per VM, upload to Storage Box ~8s on HEL1 internal
network. End-to-end ~105s per tenant.

## Archive script

Lives at `/usr/local/sbin/archive-vm-cold.sh` on every PVE host (deployed
2026-05-16). Source in repo: `scripts/archive-vm-cold.sh`.

Usage from any PVE host:
```bash
/usr/local/sbin/archive-vm-cold.sh <vmid>
```

What it does:
1. Discovers the VM's IP from `qm config`, remembers its original power state.
2. Starts the VM if stopped (we need running guest to read docker volume contents).
3. Waits up to ~2½ min for guest SSH.
4. Discovers the instance UUID from `/opt/hermes/instances/`.
5. Stops the agent containers (consistency guarantee).
6. Streams `tar | zstd -3` from the VM through SSH back to the PVE host's `/tmp`.
7. Restarts the agent containers.
8. `rsync`s the archive to `cold:free/<instance-id>/data-<ts>.tar.zst`.
9. Writes the JSON manifest to `cold:meta/<instance-id>/<ts>.json`.
10. Restores the VM's original power state (shuts back down if it was stopped).
11. Prints a final `MANIFEST sha256=… size=… iid=… ts=…` line for log scraping.

The original VM is **not** destroyed. Pool space isn't reclaimed until the
dashboard supports cold-restore and we cut over.

## Manual restore (no dashboard support yet)

Validated with a disposable sandbox restore using placeholder instance identities onto
a fresh disposable VMID. All 3 docker volumes restored, 3 of 4 containers came
up healthy within 15s. (The 4th — the webui — would have come healthy too; the
test VM ran out of disk mid-image-pull because it was a linked clone without
the 30 GB resize step. In production, freshly-provisioned tenant VMs already
have 30 GB and this isn't a concern.)

Run all of this **from the PVE host** that's the restore destination:

```bash
INSTANCE_ID=<from manifest>
TS=<from manifest>
NEW_VMID=<unused, in the host's tenant range>
TEMPLATE_VMID=9004
GUEST_IP=10.250.X.Y    # X = host subnet (20/21/22/23), Y = unused last octet

# 1. Provision + size the destination VM
qm clone $TEMPLATE_VMID $NEW_VMID --full 0
qm resize $NEW_VMID scsi0 +5G   # bring above template size if not already
qm set $NEW_VMID --ipconfig0 ip=$GUEST_IP/24,gw=10.250.X.1 \
  --nameserver "185.12.64.1 185.12.64.2 1.1.1.1 8.8.8.8"
qm start $NEW_VMID

# 2. Wait for guest SSH (~15-30s on Hetzner internal)
for _ in $(seq 1 30); do
  ssh -i /etc/hivra/keys/vm-orchestrator -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null hermes@$GUEST_IP true 2>/dev/null && break
  sleep 5
done

# 3. Pull the archive to the PVE host first, then push to the VM
#    (decoupling the two ssh streams; piping cold→VM directly hangs in our env)
TMP=$(mktemp -d /tmp/restore-XXXX)
rsync -a -e ssh "cold:free/$INSTANCE_ID/data-$TS.tar.zst" "$TMP/data.tar.zst"

# 4. Stream archive PVE → VM and extract in one shot (zstd is on the template)
cat "$TMP/data.tar.zst" | ssh -i /etc/hivra/keys/vm-orchestrator \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  hermes@$GUEST_IP "sudo -n bash -c 'zstd -dc | tar -C / -xf -'"
rm -rf "$TMP"

# 5. Inside the VM: declare the 3 docker volumes, bring up compose
ssh hermes@$GUEST_IP bash <<EOS
sudo docker volume create agent-${INSTANCE_ID}_agent-source
sudo docker volume create agent-${INSTANCE_ID}_webui-state
sudo docker volume create agent-${INSTANCE_ID}_webui-workspace
cd /opt/hermes/instances/$INSTANCE_ID
sudo docker compose pull
sudo docker compose up -d
EOS

# 6. Update the dashboard DB to point at the new VMID + host + IP
#    UPDATE hermes_instances
#       SET proxmox_vmid=$NEW_VMID, proxmox_node='pveX', ipv4_address='$GUEST_IP',
#           status='running', lifecycle_state='active', paused_reason=NULL
#     WHERE id='$INSTANCE_ID';

# 7. Add the per-tenant outer Caddy site on the PVE host (the template's
#    provisioning bash normally does this; restore must replicate). See
#    proxmox-instance-service.ts `outerCaddyfileFor` for the canonical body.
```

End-to-end timing observed on the validated run:
- archive download cold → fixturenodea: ~9s for 875 MB
- fixturenodea → guest extract: 12s
- docker compose pull (on a fresh template): ~30s
- docker compose up + container health: ~15s
- **total ~70s from `qm clone` to healthy agent** (excluding the boot time)

The restore should be lifted into the dashboard's start handler in a follow-up
PR (see `Open work` below).

## Open work to fully close the loop

1. **DB schema**: add `cold_archived` to the `lifecycle_state` check constraint
   on `hermes_instances`; add `archive_uri`, `archived_at`, `archive_size_bytes`
   columns to store manifest references.
2. **Archive cron**: `/api/cron/archive-stopped-vms` — daily sweep, find
   `lifecycle_state='paused' AND last_lifecycle_transition_at < now() - 48h
   AND resource_tier='credit_base'`, dispatch `archive-vm-cold.sh` per VM via
   the PVE host SSH path. Mark row `cold_archived` on success.
3. **Restore in start handler**: when the dashboard's "Start" flow finds a row
   in `cold_archived`, run the restore procedure above on a freshly-provisioned
   VM, then flip to `active`. Surface UX ("Restoring from cold storage, ~15
   min").
4. **Retention**: nightly job. `archived_at < now() - 60d AND tier='free'` →
   delete from Storage Box + drop DB row.
5. **Paid tier full-disk archive**: separate script doing `vzdump` of the qcow2,
   not just the data volumes. Path: `paid/<instance-id>/disk-<vmid>-<ts>.qcow2.zst`.
6. **`qm destroy` step after successful archive** — once dashboard restore is
   live, the archive script can destroy the VM and free its host LV. Today it
   stays in place; archives are pure backups.

## Operational notes

- The restricted shell on the Storage Box doesn't support `find`, `du`, `stat`,
  `sha256sum`. Test sha matching by downloading the archive back to a PVE host
  and running `sha256sum` locally (the manifest's `archive_sha256` is the source
  of truth).
- The PVE → Storage Box transfer happens over the Helsinki internal network at
  ~100 MB/s observed. Free of egress charges.
- All 6 PVE hosts have the same private key (`/etc/hivra/keys/cold-storage`); the
  same single registered pubkey on the Storage Box authorizes them all. If you
  want per-host isolation later, generate per-PVE keys and register each.
- The `cold` and `hermes-cold-storage` Host aliases on each PVE host are
  equivalent; the latter is the canonical name, `cold` is the short alias.
