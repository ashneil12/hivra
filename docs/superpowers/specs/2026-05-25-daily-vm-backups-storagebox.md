# Daily VM Backups to Hetzner Storage Box

Date: 2026-05-25
Owner: Benedict
Reviewer: Augustine
Status: canary design + script staged

## Decision

Do **not** reuse the cold-archive/reclaim lane for daily backups.

Reason: cold archive is a lifecycle/reclamation system for paused/inactive VMs. It may transition rows to `cold_archived`, clear Proxmox routing, and eventually reclaim/destroy the source VM after verification.

Daily backups need a separate non-destructive lane:

```txt
active paid VM → snapshot backup → Storage Box → manifest written last → retention
```

No lifecycle transition. No source destroy. No DB routing mutation.

## Tier policy

Recommended default:

```txt
paid/power/pro: daily VM backups (`operator`, `fleet`, `command`; Workspace Cloud equivalents can be added via env)
free: no daily full backups; keep inactivity cold archive only
```

Why not free daily backups by default:

- free-tier density is RAM/disk constrained already
- daily full backups for every free VM would turn the Storage Box into a cost sink
- free users already have a recoverability path through inactive cold archive
- paid users are the ones with reliability expectation and margin to fund retention

Possible later free-tier compromise:

```txt
free: weekly or last-known-good config-only backup, not daily full VM backup
```

## Storage Box

Verified from this runtime:

```txt
host: u594993.your-storagebox.de
user: u594993
ssh port: 23
rsync over SSH: works
round-trip checksum probe: passed
```

The password is stored locally outside the repo under:

```txt
~/.hermes/secrets/hermesos-storagebox.env
```

Do not commit the password.

## Script

```txt
dashboard/scripts/ops/backup-vm-daily.sh
```

Usage from a PVE host with the existing `cold` SSH alias:

```bash
/usr/local/sbin/backup-vm-daily.sh <vmid> <instance-id> <tier> --apply
```

Dry-run is default:

```bash
/usr/local/sbin/backup-vm-daily.sh <vmid> <instance-id> <tier>
```

## Backup method

Use Proxmox `vzdump` snapshot mode:

```txt
vzdump <vmid> --mode snapshot --compress zstd --dumpdir <tmp>
```

Then upload using rsync:

```txt
daily/paid/<instance-id>/vzdump-qemu-<vmid>-<ts>.vma.zst
daily-meta/<instance-id>/<ts>.json
```

Manifest is written last and includes:

- schema version 2
- kind `daily_vm_backup`
- instance id
- VMID
- PVE host
- backup path
- size
- sha256
- source_destroyed=false
- retention settings

## Retention recommendation

Initial default:

```txt
paid daily: keep 7 daily + 4 weekly
free daily: disabled
```

Before auto-purge, implement manifest-aware retention and alerting.

## Rollout plan

1. Keep script in repo and deploy to PVE hosts.
2. Run dry-run against one canary paid/test VM.
3. Run one apply backup against one approved canary VM.
4. Download and verify sha256 from Storage Box.
5. Prove restore into a disposable VM.
6. Only then schedule paid daily backup cron.
7. Add dashboard status and restore UX after restore proof.

## Gates

Autonomous now:

- Storage Box probe
- script/dry-run implementation
- canary docs
- deployment PR to PVE host scripts
- dry-run inventory

Needs explicit approval before live broad run:

- daily backups for every paid VM
- any backup of free-tier VMs
- any restore into live user routing
- any retention purge
- any source VM destroy
