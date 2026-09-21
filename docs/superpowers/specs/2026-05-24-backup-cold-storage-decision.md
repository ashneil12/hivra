# Backup and Cold Storage Decision Spec — 2026-05-24

## Verdict

**ACTION, but do not automate destructive backup changes yet.** AEON is recoverable through GitHub, but the fleet and secrets are not yet verifiably recoverable.

## Current known state

- AEON repo, skills, memory, and runbooks are in Git.
- Fleet is roughly 319 Hermes VMs across 11 Hetzner/Proxmox hosts.
- No verified Proxmox Backup Server, vzdump, or restic policy is visible in repo outputs.
- Around 30 operational secrets live in GitHub Actions with no confirmed encrypted offline export.
- No restore drill has been run.

## Risk

If GitHub, a Proxmox host, or a credentials store is lost, HermesOS may not be able to recover quickly even if code is intact.

Biggest risks:

1. Total fleet lockout if Proxmox/Hetzner/operator credentials are lost.
2. VM data loss without offsite backups.
3. False confidence from “backup scripts” that have never restored.
4. Secret sprawl across GitHub, local env, Vercel, Supabase, and instance env.

## Safe default architecture

### Tier 1 — Source of truth backups

- GitHub repos remain source of truth for code, runbooks, AEON skills, and non-secret config.
- Mirror critical repos to a second Git remote or periodic archive.

### Tier 2 — Secret escrow

- Export secret names and encrypted values to an offline encrypted store.
- Recommended bootstrap target: age-encrypted archive stored in two places:
  - operator local/offline copy
  - cold object storage bucket
- Do not print or commit secret values.
- Include restore instructions and required scopes.

### Tier 3 — VM/data backups

Pick one:

A. Proxmox Backup Server offsite
- Best fit for Proxmox VM restore.
- Needs PBS target, retention, encryption, and bandwidth planning.

B. Restic/Borg inside VMs
- Easier to start.
- More application-aware.
- Can miss VM-level state unless standardized.

C. Hetzner Storage Box/Object Storage target
- Good cold target.
- Needs encryption client-side.

Recommended v0:

```txt
PBS or vzdump for VM-level recovery
+ restic for critical app/runtime volumes if needed
+ age-encrypted secret escrow
+ quarterly restore drill
```

## Retention defaults

For bootstrap:

```txt
hourly: 24h for critical control-plane only
daily: 14 days
weekly: 8 weeks
monthly: 6 months
```

Free-tier user VMs may need lower retention or opt-in paid backup to control cost.

## Restore drill

Quarterly minimum. First drill should restore one non-prod/canary instance.

Drill checklist:

- [ ] Restore VM or runtime volume to isolated network.
- [ ] Restore env/secrets from encrypted escrow.
- [ ] Boot WebUI/gateway.
- [ ] Verify login/session access.
- [ ] Verify agent can run a harmless command.
- [ ] Verify no prod DNS/customer traffic is pointed at restored copy.
- [ ] Record RTO/RPO and missing steps.

## Decisions needed from Ash

1. Cold target:
   - Hetzner Storage Box
   - S3-compatible object storage
   - Backblaze B2
   - Cloudflare R2
   - other
2. Backup scope for launch:
   - operator/control-plane only
   - all paid VMs
   - all VMs including free tier
3. Secret escrow tool:
   - age
   - SOPS
   - Bitwarden/1Password service account later
4. Restore cadence:
   - monthly until stable, then quarterly
   - quarterly from start

## Implementation plan after decisions

1. Inventory VM storage and critical volumes.
2. Pick backup target and create encrypted bucket/repo.
3. Write non-destructive backup scripts.
4. Run first canary restore drill.
5. Only then schedule recurring backups.

## Acceptance criteria

- At least one canary VM or equivalent runtime can be restored from backup.
- Required secrets can be restored from encrypted escrow without GitHub access.
- Restore runbook has exact commands and expected verification output.
- AEON/Benedict monitors backup freshness and reports only stale/failing backups.
