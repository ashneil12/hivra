# Cold Storage Orchestration — Dashboard Integration Spec

Companion to `docs/cold-storage.md` (which covers the infrastructure layer that
already exists: Storage Box, archive script, validated restore procedure).

This spec describes the **dashboard-side automation** that turns those building
blocks into a self-running tier system: auto-archive paused VMs, restore on
"Start" click, retention sweeps, customer email lifecycle. It's intended for
Codex (or similar executor) to implement; humans review the design choices
flagged with **DECISION** before kickoff.

---

## 1. Lifecycle state machine

Existing values (in `hermes_instances.lifecycle_state`): `active`, `paused`.
We add four new states. Reasoning for each + why we don't collapse them:

| State | Means | VM exists? | Cold copy? |
|---|---|---|---|
| `active` | running, healthy | yes (running) | optional |
| `paused` | auto-paused by inactivity sweep | yes (stopped) | no |
| `archiving` | archive cron in progress, **lock state** | yes (stopped) | partial / in-flight |
| `cold_archived` | VM destroyed, data on Storage Box | **no** | yes |
| `restoring` | restore in progress, **lock state** | yes (provisioning) | yes |
| `pending_deletion` | notice period before retention delete | no | yes (will be deleted) |

`archiving` and `restoring` are short-lived intermediate states whose sole
purpose is to **prevent double-execution**. If two cron ticks or two "Start"
clicks both pick up the same row, the second one sees `archiving`/`restoring`
and bails. Don't collapse them into the destination state — that loses the
mutex property.

`pending_deletion` is distinct from `cold_archived` so the retention email
sequence has a clear "we will delete this on date X unless you act" trigger.

### Allowed transitions

```
                    ┌─→ archiving ──────────────→ cold_archived ─┐
                    │       │                         │           │
     active ──→ paused      │                         │           ↓
       ↑                    └───→ paused (on fail)    └──→ pending_deletion
       │                                                    │       │
       └────────── restoring ←────────────────────────────  │       ↓
                       │                                    │  (free 60d /
                       └────→ cold_archived (on fail) ←─────┘   paid 30d
                                                              after cancel)
                                                                    │
                                                                    ↓
                                                                 deleted
                                                                 (DB row
                                                                 retained,
                                                                 archive
                                                                 removed)
```

`active → cold_archived` directly is **not allowed** (always pause first; gives
the user the inactivity warning email a chance to act).

`restoring → restoring` is **not allowed** (only one in-flight restore per
instance — the lock).

---

## 2. Anti-corruption invariants

These are the rules everything else has to obey. Codex: don't shortcut these.

### I1. **Archive completion is signalled by the manifest, not the data file.**
Write `meta/<id>/<ts>.json` *last*, with full `archive_sha256` populated. If
the manifest is missing, the archive is considered draft and ignored. This
gives crash safety: if the archiver dies mid-upload, no consumer sees a
half-archive as authoritative.

### I2. **Verify SHA256 before extracting on restore.**
The manifest's `archive_sha256` is the source of truth. Download the archive,
hash it locally, compare. Mismatch → abort restore, do **not** extract, surface
to ops.

### I3. **Don't destroy the source VM until the archive is independently re-verified.**
Pipeline:
1. Archive script runs, returns its own SHA256.
2. Cron downloads a **fresh copy** of the manifest from Storage Box.
3. Cron downloads a **sample slice** (first + last 1MB) of the archive and
   verifies it against expected size and that decompression starts cleanly.
4. Only after these checks pass: `qm destroy <vmid>` and set
   `lifecycle_state='cold_archived'`.

The fresh-fetch step protects against a race where the script reports success
but the upload was actually partial.

### I4. **Manifests are immutable. Multiple archives per tenant are kept.**
Never overwrite a manifest. New archive of the same tenant gets a new
`<ts>.json`. Keep the **last 3** archives per tenant in cold storage. On
restore, use the latest. If the latest fails verification, fall back to the
previous one — and alert ops loudly. (Retention sweep tracks this — it deletes
old archives once 3 newer ones exist, and never deletes a tenant's only
archive without going through `pending_deletion`.)

### I5. **Atomic DB updates.**
Each lifecycle transition is a single transaction:
- `archiving → cold_archived` updates `lifecycle_state`, `archive_uri`,
  `archived_at`, `archive_size_bytes`, `archive_sha256`, *clears*
  `proxmox_vmid`, `proxmox_node`, `ipv4_address` in one statement.
- `restoring → active` updates the same fields in reverse in one statement.

If the VM-side work succeeded but the DB write failed, the state machine
should converge on the next cron tick. Idempotency matters more than
transactional atomicity across the SSH boundary — but **within** the DB,
atomicity is required.

### I6. **One-archive-at-a-time per host.**
Tar+rsync is CPU/disk-heavy. Don't run more than one archive job per PVE host
in parallel — already enforced in tonight's bulk run by serializing within
each host. Codex's cron should use a per-host advisory lock (e.g. Postgres
`pg_try_advisory_lock(hashtext('archive-' || pve_host))`).

### I7. **Weekly cold-storage audit cron.**
Pick a random 5% of cold-archived rows. Download each manifest, fetch the
archive's tail block, verify sha. Anything that fails → log + alert. Catches
bit-rot or accidental deletes early.

### I8. **Capacity alert.**
Quota check daily: when Storage Box `du -sh` total approaches 80% of plan
(currently 8 TB of 10 TB), send ops alert. At 95%, refuse new archives —
mark candidates with `paused_reason='archive_quota_full'`.

---

## 3. Archive cron — `/api/cron/archive-stopped-vms`

Daily at **03:00 UTC** (low-traffic window). Vercel cron in `vercel.json`.

### Candidate query
```sql
SELECT id, proxmox_node, proxmox_vmid, resource_tier, last_lifecycle_transition_at
FROM hermes_instances
WHERE lifecycle_state = 'paused'
  AND status         = 'stopped'
  AND deleted_at     IS NULL
  AND last_lifecycle_transition_at < now() - INTERVAL '48 hours'
  AND archive_uri    IS NULL
ORDER BY last_lifecycle_transition_at ASC
LIMIT 50;
```

LIMIT prevents one cron run from chewing through the whole fleet — 50 archives
× ~100s each = 80 min, comfortable for a 6-host fleet. Future runs pick up the
remainder.

### Per-candidate flow
1. `UPDATE … SET lifecycle_state='archiving' WHERE id=$id AND lifecycle_state='paused'`
   (compare-and-swap: rowcount=0 means another worker grabbed it; skip).
2. Acquire per-host advisory lock for `pve_host`.
3. SSH to that host (via existing `runProxmoxHostScript` plumbing), invoke
   `/usr/local/sbin/archive-vm-cold.sh <vmid>`.
4. Parse the final `MANIFEST` line for sha + size + ts.
5. Re-fetch manifest from Storage Box and verify it parses + sha matches.
6. Slice-verify the archive (first/last 1MB integrity).
7. `qm destroy <vmid>` via SSH.
8. `UPDATE … SET lifecycle_state='cold_archived', archive_uri=…,
   archived_at=…, archive_size_bytes=…, archive_sha256=…, proxmox_vmid=NULL,
   ipv4_address=NULL, paused_reason='cold_archived'`.
9. Release lock.
10. Enqueue welcome-to-cold email (see §6).

### Failure handling
- Archive script returns non-zero: revert `archiving → paused`, log, no destroy.
- Verification fails: revert, do **not** destroy, alert ops.
- Destroy fails: leave `lifecycle_state='archiving'` and alert — manual
  intervention. Don't auto-retry destroy; we already have the archive.

### Paid tier
Free tier first. Paid tier added as a flag-gated extension once free tier is
stable. For paid: replace the data-only tarball with a full `vzdump`-style
qcow2 archive (different script, same cron). **DECISION**: do paid tier in a
second PR after free tier proves itself in production.

---

## 4. Restore on "Start" — modify the start handler

**Discovered 2026-05-16 during Phase 2 build**: the existing start handler is
the `action === "start"` branch of `POST /api/instances/[id]/route.ts`
(line ~2173). It already has a **placeholder for cold-archived state** at
line ~2223 — when `paused_reason === "dormant_reclaimed"` it returns a 409
with `failureType: "instance_dormant_reclaimed"` and message "needs to be
restored from its archive". The dashboard already surfaces this state to the
user; Phase 3's job is to replace that error with an actual restore call.

Phase 3 starter checklist (for whoever picks this up):

1. **Read the Next.js docs**: `node_modules/next/dist/docs/01-app/` —
   the dashboard runs a non-standard Next.js fork per `dashboard/AGENTS.md`.
2. **Export the allocator**: `selectAvailableProxmoxProvisionTarget` is
   currently `async function` (not `export`) in
   `src/lib/services/instance-service.ts:744`. Export it (or extract a
   thin wrapper that picks a host + VMID + IP for an existing instance ID).
3. **Wrap the dormant_reclaimed branch** at route.ts:2223 with an
   isColdLifecycle check that routes cold_archived/pending_deletion rows
   into an async restore call instead of the current 409 error.
4. **Async restore job**: call `restoreInstance()` from
   `src/lib/services/cold-storage-service.ts` inside a `waitUntil()`.
   The service handles the CAS lock, archive verify, host script
   execution, and final DB transition.
5. **Status polling**: dashboard polls
   `GET /api/instances/[id]/status` (new route or extend existing
   `/api/instances/[id]/health`). The route reads `lifecycle_state` +
   `lifecycle_substate` and returns a structured progress payload.
6. **UX**: existing dashboard already shows "dormant_reclaimed" error
   prominently. Update copy + replace the "can't start" button with a
   "Restoring..." spinner that polls.
7. **Tests**: extend `src/app/api/instances/[id]/__tests__/route.test.ts`
   with cases for cold_archived start, restore in-progress lockout,
   restore failure handling.

Today's handler:

```
async function startInstance(instanceId) {
  const inst = await db.lock(instanceId);   // SELECT … FOR UPDATE

  if (inst.lifecycle_state === 'cold_archived' || inst.lifecycle_state === 'pending_deletion') {
    return startFromCold(inst);
  }
  if (inst.lifecycle_state === 'paused' && inst.proxmox_vmid) {
    return startFromHot(inst);   // existing path
  }
  if (inst.lifecycle_state === 'restoring' || inst.lifecycle_state === 'archiving') {
    return { status: 'in_progress', message: 'A previous operation is still running.' };
  }
  // … other states
}
```

### `startFromCold(inst)` server-side job

This is a long-running task (~5 min). Don't do it inline in the HTTP request.
Two options:

- **DECISION A** (simpler): kick off the work in a Vercel serverless function
  with `waitUntil()`, return immediately with a `restoring` status. Client
  polls `/api/instances/:id/status`.
- **DECISION B**: a dedicated worker (e.g. background Vercel cron triggered
  by row state, or a long-lived process on a PVE host).

**Recommendation: A** for v1 — leverages existing Vercel infrastructure, no
new ops surface. Vercel's `waitUntil` ceiling is currently 300s on Pro;
restore observed at ~70s + a few min buffer for image pull → fits comfortably.

### Restore steps (idempotent — safe to re-enter on failure)
1. `UPDATE … SET lifecycle_state='restoring', paused_reason='restoring_from_cold'
   WHERE id=$id AND lifecycle_state='cold_archived'`. If 0 rows: bail.
2. Re-fetch the manifest. Verify sha matches stored `archive_sha256`.
3. Pick destination host via existing `selectAvailableProxmoxProvisionTarget()`.
4. Pick a free VMID in that host's tenant range (use existing allocator).
5. `qm clone <template> <vmid> --full 0`; `qm resize +5G`; `qm set` IP/dns;
   `qm start`. Wait for guest SSH.
6. `rsync cold:<archive_uri> /tmp/restore.tar.zst` on the PVE host.
7. Verify sha256 of `/tmp/restore.tar.zst` matches manifest. **Hard stop on
   mismatch** — destroy the half-built VM, revert to `cold_archived`.
8. Stream `cat … | ssh hermes@<ip> 'sudo zstd -dc | tar -C / -xf -'`.
9. SSH in, declare 3 docker volumes, `docker compose pull && up -d`.
10. Health-check the agent gateway (`curl /health` on internal port).
11. Write the outer Caddy site config on the PVE host (call
    `outerCaddyfileFor` from `proxmox-instance-service.ts`).
12. `UPDATE … SET lifecycle_state='active', proxmox_node, proxmox_vmid,
    ipv4_address, last_lifecycle_transition_at=now(), paused_reason=NULL`.

### Failure handling per step
- 4-5 (provisioning fail): clean up partial VM, revert to `cold_archived`.
- 7 (sha mismatch): see Invariant I4 — try fallback to previous archive
  generation, otherwise alert + revert.
- 9-10 (docker fail): destroy VM, revert. The user gets an error message
  and clicking Start again retries cleanly.

### UX

- Returning from the `POST /api/instances/:id/start` call with
  `{ status: 'restoring', estimated_seconds: 300 }`.
- Client polls `GET /api/instances/:id/status` every 3s.
- Show stages: `Provisioning new host…` → `Downloading from cold storage…`
  → `Verifying integrity…` → `Restoring agent state…` → `Starting agent…`
  → `Ready.`
- These stages map to a `lifecycle_substate` column we add (free text or
  enum); the restore job writes it.

---

## 5. Retention + deletion

### Free tier — 60d after archive
Daily cron `/api/cron/cold-retention-sweep`:

```sql
-- Mark candidates 7 days before deletion as pending_deletion
UPDATE hermes_instances
SET lifecycle_state = 'pending_deletion',
    scheduled_deletion_at = archived_at + INTERVAL '60 days'
WHERE lifecycle_state = 'cold_archived'
  AND resource_tier = 'credit_base'
  AND archived_at  < now() - INTERVAL '53 days'
  AND scheduled_deletion_at IS NULL;

-- Delete on the actual day
SELECT id, archive_uri FROM hermes_instances
WHERE lifecycle_state = 'pending_deletion'
  AND scheduled_deletion_at < now()
  AND deleted_at IS NULL;
-- For each: ssh cold "rm -rf free/<id> meta/<id>"; UPDATE deleted_at=now().
```

The 7-day grace between `pending_deletion` and actual delete gives the user a
window where the email warnings fire and they can still resurrect by clicking
Start.

### Paid tier — 30d after entitlement cancellation
Same cron, different filter: `resource_tier != 'credit_base'
AND entitlement_state IN ('cancelled','past_due') AND archived_at < now() -
INTERVAL '23 days'`.

### Idempotency
Deletion must be safe to retry. Check archive existence before `rm`. If row
already shows `deleted_at != null`, skip.

### Trash safety net
**DECISION**: instead of `rm -rf free/<id>`, move to `trash/<id>-<ts>/`. Keep
trash for 14 days, then purge. Gives one human-error escape hatch.

---

## 6. Email sequences (via Resend)

Use existing `RESEND_API_KEY`. New module `src/lib/services/cold-storage-emails.ts`.

| Trigger | Subject | Audience |
|---|---|---|
| **Cold archive complete** | "We've paused your Hermes agent" | All tiers, on archive |
| **Cold day 30** (free) | "Your agent has been idle 30 days" | Free tier, 30d after archive |
| **Cold day 53** (free) | "Action required: your agent will be deleted in 7 days" | Free tier, when `pending_deletion` fires |
| **Cold day 58** (free) | "Final notice: 2 days until deletion" | Free tier |
| **Deletion complete** | "Your agent has been deleted" | Free tier, after delete |
| **Restore in progress** | "Bringing your agent back online" | All tiers, when restore starts (in-app only is fine; email is overkill) |
| **Restore complete** | "Your agent is ready at <url>" | All tiers, after restore |
| **Paid cancel - day 1** | "We've archived your agent. 30 days to reactivate" | Paid tier on entitlement cancel |
| **Paid cancel - day 25** | "5 days left to reactivate before permanent deletion" | Paid tier |
| **Paid deletion complete** | "Your subscription data has been deleted" | Paid tier |

### Tracking
Add `notifications_sent JSONB DEFAULT '{}'` on `hermes_instances`. Each email
sets a key: `notifications_sent['cold_day_53'] = '2026-07-12T…Z'`. Cron filter
includes `(notifications_sent->>'cold_day_53') IS NULL` to ensure send-once.

### Tone
Honest about what's happening + clear action: "Click Start to bring your agent
back — it takes about 5 minutes the first time." Don't hide that it was
archived; that's the value prop (free storage of agents you're not using).

---

## 7. DB schema migration

Single migration, `2026_xx_xx_cold_storage_lifecycle.sql`:

```sql
-- 1. Drop old check constraint on lifecycle_state, add new one
ALTER TABLE hermes_instances DROP CONSTRAINT IF EXISTS hermes_instances_lifecycle_state_check;
ALTER TABLE hermes_instances ADD CONSTRAINT hermes_instances_lifecycle_state_check
  CHECK (lifecycle_state IN ('active','paused','archiving','cold_archived','restoring','pending_deletion','deleted'));

-- 2. New columns for cold storage
ALTER TABLE hermes_instances
  ADD COLUMN archive_uri          TEXT,
  ADD COLUMN archived_at          TIMESTAMPTZ,
  ADD COLUMN archive_size_bytes   BIGINT,
  ADD COLUMN archive_sha256       TEXT,
  ADD COLUMN archive_count        INTEGER DEFAULT 0,
  ADD COLUMN lifecycle_substate   TEXT,
  ADD COLUMN notifications_sent   JSONB DEFAULT '{}'::jsonb;

-- 3. Index for cron sweeps
CREATE INDEX idx_hermes_instances_lifecycle_paused
  ON hermes_instances (last_lifecycle_transition_at)
  WHERE lifecycle_state = 'paused' AND deleted_at IS NULL;

CREATE INDEX idx_hermes_instances_cold_archived
  ON hermes_instances (archived_at)
  WHERE lifecycle_state IN ('cold_archived', 'pending_deletion');
```

Existing data: all current `paused` rows stay `paused`. Tonight's 10 manually-
archived tenants don't get retroactively flagged — backfill in a one-shot
script after the migration lands (we have the manifests; script reads them and
populates the new columns).

---

## 8. File-level work list (for Codex)

- `dashboard/scripts/migrations/2026_xx_xx_cold_storage_lifecycle.sql` — §7
- `dashboard/src/lib/services/cold-storage-service.ts` — new module:
  - `archiveInstance(instanceId)`
  - `restoreInstance(instanceId)`
  - `verifyArchiveIntegrity(instanceId, archive_uri, expected_sha256)`
  - `purgeArchive(instanceId)`
- `dashboard/src/app/api/cron/archive-stopped-vms/route.ts` — §3
- `dashboard/src/app/api/cron/cold-retention-sweep/route.ts` — §5
- `dashboard/src/app/api/cron/cold-storage-audit/route.ts` — §2 I7
- `dashboard/src/app/api/instances/[id]/start/route.ts` — wrap with §4 logic
- `dashboard/src/app/api/instances/[id]/status/route.ts` — return lifecycle +
  substate for polling
- `dashboard/src/lib/services/cold-storage-emails.ts` — §6
- `dashboard/vercel.json` — register the three new crons
- `dashboard/scripts/ops/backfill-cold-archived.ts` — one-shot, populate DB
  for tonight's 10 manual archives

### Modifications to existing services

- `dashboard/src/lib/services/proxmox-instance-service.ts` —
  `outerCaddyfileFor` is now called from restore as well; ensure it's a pure
  function that doesn't assume "fresh provision" semantics.
- `dashboard/src/lib/services/instance-service.ts` — auto-pause sweep
  (existing) should not race with archive cron; ensure `paused` → `archiving`
  is the only path that owns the row.

---

## 9. Operational runbook (for ops/future-you)

### Recovering one tenant from cold (manual)
See the validated procedure in `docs/cold-storage.md` § "Manual restore".

### Tenant says "I can't restore my agent"
1. Find the row: `SELECT id, lifecycle_state, archive_uri, archive_sha256
   FROM hermes_instances WHERE user_id=…`.
2. Check the archive exists: `ssh cold "ls -la <archive_uri>"`.
3. Verify the manifest: `ssh cold "cat meta/<id>/<ts>.json"`.
4. If sha mismatch: try the previous archive generation
   `ssh cold "ls meta/<id>/"` for older `<ts>.json` files; manually edit the
   DB row to point at an older one, retry restore.
5. If no archive exists at all: tenant's data is lost (shouldn't happen given
   §2 invariants). Apologize, refund if paid, offer fresh start.

### Storage Box at 80%
- Inspect: `ssh cold "du -sh free paid"`.
- Identify largest tenants: `ssh cold "du -sh free/* | sort -rh | head"`.
- Either upgrade to bx41 (20 TB, $55/mo) or accelerate retention by lowering
  the 60d → 45d threshold for inactive free tier.

### Restore loop (user clicks Start, fails, clicks again, fails)
Inspect `lifecycle_state` and `paused_reason`. If stuck in `restoring` for
>10 min, manually flip back: `UPDATE … SET lifecycle_state='cold_archived',
paused_reason=NULL WHERE id=…`. Then they can click Start fresh.

---

## 10. Phasing for Codex

| Phase | Days | Deliverable | Verification gate |
|---|---|---|---|
| 1 | 1-2 | DB migration + backfill of tonight's 10 archives | `SELECT count(*) FROM hermes_instances WHERE lifecycle_state='cold_archived'` = 10 |
| 2 | 2-3 | `cold-storage-service.ts` archive/restore/verify functions | Unit tests against a staging Storage Box, one round-trip works |
| 3 | 1 | Wrap start handler with cold-detect + `restoreInstance()` call | Tonight's archived VM `fixturecase02…`: click Start in staging dashboard → comes back live |
| 4 | 1-2 | Archive cron, run weekly first (not daily) | One run, look at the 10 tonight, confirm DB flips, no destroy errors |
| 5 | 1 | Retention sweep + `pending_deletion` flow | Manually backdate one row's `archived_at`, watch sweep fire, trash move works |
| 6 | 2 | Email sequences (Resend integration) | Test send to ops email at each stage |
| 7 | 1 | Audit cron + capacity alerts | Pre-mortem: corrupt an archive (zero a byte on Storage Box), audit cron must catch it |
| 8 | 2 | Paid tier full-disk archive | Separate PR, same patterns |

Verification gates are firm — don't proceed past a failed gate. Phase 4 is
weekly-first specifically because the first production run is the highest-risk
moment.

---

## Open DECISIONs (for human review)

- **D1**: `waitUntil()` vs dedicated worker for restore jobs (§4). Recommend `waitUntil`.
- **D2**: Free tier retention exactly 60 days, or shorter (45d/30d)? Affects cold storage growth rate. Recommend 60d for v1, tune down if needed.
- **D3**: Paid tier in v1 or v2? Recommend v2 (after free tier proves it).
- **D4**: One Storage Box shared (current) or paid/free split into two boxes (your original instinct)? Recommend one box with prefix separation for now; revisit at 5 TB.
- **D5**: Trash safety net of 14 days (§5) — agree?
- **D6**: Stages exposed to UX via `lifecycle_substate` (§4) — or just opaque "Restoring, ~5min"? Recommend exposing stages; users tolerate slow more when they can see progress.
