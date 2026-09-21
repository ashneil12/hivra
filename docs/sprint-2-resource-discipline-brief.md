# Sprint-2 Resource Discipline Brief

Status: drafted 2026-05-07. Owner: Ash.

The original audit (Pro upgrade flow + agent-start activation) flagged
five resource-discipline gaps. One — Hetzner tier resize — shipped in
the same diff that landed this brief (see commit history around
2026-05-07 / `tier_change_pending` column). The remaining four are
described here so they're ready to ship the moment the embedded product
decisions are made.

These are NOT code I should ship autonomously: each one bakes in
product calls (cap numbers, soft vs hard delete, throttle vs block,
grandfathering policy). Make the calls below, then either:

- Tell me to crank through them in one session, or
- Hand this file to Forge as a brief.

---

## 1. Free user cap + waitlist

### Why it matters
Reservations infrastructure (`hermes_reservations` table, `/api/reserve`
route) exists but is NOT enforced anywhere in the signup or first-deploy
path. With a single viral post, free signups can outpace AX41-NVMe
capacity overnight. Cost math from May 6 (5 boxes, 250 free + 30 Pro
slots, ~$250/mo) only holds if 250 is actually capped.

### Decisions needed (block the brief until answered)

1. **Cap number.** May 6 plan said 250. Still 250?
2. **Gate location.** Two options:
   - (a) At signup — Clerk redirects to `/reserve` if free intent and
     capacity full. Cleaner UX but blocks people from creating an
     account at all.
   - (b) At first deploy — user can sign up freely; the deploy form
     shows "you're #N on the waitlist" if at capacity. Lets people
     explore the dashboard but creates a soft commitment that breaks
     when they try to use it.
   - Recommend (b): lower friction, captures email + lets them learn
     about the product before bouncing.
3. **Grandfathering.** Existing free users at the moment of cutover —
   counted toward the cap, or grandfathered indefinitely?
   - Recommend grandfather (treats existing users fairly, cap only
     applies to new joins).
4. **Cap variable.** Static (env var) or dynamic (count active free
   users + spare capacity headroom)?
   - Recommend env var `FREE_USER_CAP` defaulting to 250.
5. **Waitlist communication.** When someone hits the cap:
   - Silent "we'll let you know" — set & forget.
   - Position-N email weekly so they feel progress.
   - Position-N email when they move 25+ slots.
   - Recommend: email at signup with position, then re-email on
     invitation. No interim updates (avoids "still 23" annoyance).

### Implementation shape (once decisions land)

- New migration: indexes for fast `count(*) where status='active' and plan='free'`.
- New service: `src/lib/services/free-user-cap.ts` with `isFreeCapacityAvailable()`.
- Wire into `/api/instances` POST (gate (b)) or `/api/reserve` (gate (a)).
- UI: extend `/get-started/activate/page.tsx` to show waitlist position
  when at cap. Use existing `/reserve` page styling for consistency.
- Feature flag: `FREE_USER_CAP_ENABLED` (default off until verified).
- Unit tests: cap arithmetic, gate behaviour at exactly cap, off-by-one.
- Manual test: deploy with `FREE_USER_CAP=2`, verify 3rd signup hits
  the gate.

### Files to touch (predicted)
- new: `dashboard/src/lib/services/free-user-cap.ts`
- new: `dashboard/supabase/migrations/2026XXXX_free_user_cap_indexes.sql`
- new: `dashboard/src/components/dashboard/welcome/CapacityWaitlistPanel.tsx`
- modify: `dashboard/src/app/api/instances/route.ts` (or `/api/reserve`)
- modify: `dashboard/src/app/get-started/activate/page.tsx`

### Risk
Medium. Misconfigured cap (off-by-one, race) could lock out new users
entirely. Feature flag mitigates this; verify with `FREE_USER_CAP=999999`
in prod before flipping the flag if you're nervous.

---

## 2. 14-day idle reclaim

### Why it matters
Without this, free users who sign up and never deploy permanently
occupy a slot in the cap (once the cap exists). Audit confirmed there
is no such cron today.

### Decisions needed (irreversible if wrong)

1. **Trigger condition.** Three candidates:
   - (a) 14 days since signup with zero instances ever deployed.
   - (b) 14 days since their last instance was deleted.
   - (c) Both.
   - Recommend (a) for v1 — simplest, lowest false-positive rate.
     User who signs up and ghosts is an obvious reclaim target. User
     who deployed once and stopped paying for compute is a different
     problem (handled by 7-day deployed-but-inactive, future).
2. **Action.** Two flavours:
   - Soft delete: mark account deleted in DB but keep the row for 30
     days, then hard delete on a follow-up cron. Recoverable.
   - Hard delete: drop the user row + Clerk account. Gone.
   - **Strongly recommend soft delete** — the 30-day grace lets you
     manually un-delete if a reclaim catches the wrong person.
3. **Warning email.**
   - At day 12 only, with a 48h grace.
   - Or day 7 + day 12 (heads-up + last-call).
   - Recommend day 12 only. Day 7 is too early to feel real to a user
     who's forgotten about the product.
4. **Pro/Power exemption.** Trivially yes — only run reclaim on rows
   where `subscription.plan = 'free'` (or no subscription at all).
5. **Failed-payment-then-lapsed users.** Edge case: a Pro user whose
   payment failed and got downgraded to free. Should they get reclaimed
   after 14 days idle on free?
   - Recommend yes, but the 12-day warning email is doubly important
     for this case (they paid us once; we should give them a chance to
     fix payment before deleting).

### Implementation shape

- New cron: `/api/cron/reclaim-idle-free-users`, daily at 03:00 UTC.
- Logic per run:
  1. Query: `select user_id from clerk_users where created_at < now() - interval '14 days' and not exists (select 1 from hermes_instances where user_id = clerk_users.user_id)`.
  2. Filter to free-tier (no active paid subscription).
  3. If `warning_sent_at` is null and `created_at < now() - interval '12 days'`: send warning email, stamp `warning_sent_at`.
  4. If `warning_sent_at < now() - interval '48 hours'`: soft delete.
- New table or column: `hermes_user_reclaim_state` tracking `warning_sent_at`, `soft_deleted_at`.
- Vercel cron schedule: `0 3 * * *`.
- Feature flag: `IDLE_RECLAIM_ENABLED` (default off; ship code, flip
  flag after one round of dry-run logging).
- New email template: `dashboard/src/lib/email/idle-reclaim-warning.ts`.
- Tests:
  - Selects users created >14d ago with zero instances.
  - Skips paid users.
  - Skips users who already received warning <48h ago.
  - Soft-delete sets the right columns.
  - Dry-run mode (env flag) logs without writing.

### Files to touch
- new: `dashboard/src/app/api/cron/reclaim-idle-free-users/route.ts`
- new: `dashboard/src/lib/email/idle-reclaim-warning.ts`
- new: `dashboard/supabase/migrations/2026XXXX_user_reclaim_state.sql`
- modify: `dashboard/vercel.json` (add cron entry)

### Risk
HIGH. Account deletion is the most dangerous thing on this list. Run
in dry-run mode for a full week before flipping `IDLE_RECLAIM_ENABLED=true`,
then check the soft-delete log before each daily run for the first
month. Soft delete + 30-day grace mitigates but does not eliminate
the risk of catching the wrong user.

---

## 3. Storage caps

### Why it matters
Schema is in place (`disk_size_gb int` column). No enforcement, no
metering. A free user could fill 500GB and we'd be the last to know.

### Two layers

#### Layer A — Monitor + warn (low risk, fast to ship)

**Decisions needed:**
- Sample frequency: every 5 min (using existing
  `sample-instance-metrics` cron) or hourly?
  - Recommend extend the existing 5-min cron, not a new one.
- Warn threshold: 80%? 95%? Both?
  - Recommend both: 80% = banner with "approaching cap"; 95% = banner
    with "cap will be enforced soon."
- Banner action: link to /dashboard/billing, link to docs on cleaning
  up, or both?
  - Recommend both — give the user a non-billing option.

**Implementation:**
- Extend `sample-instance-metrics` cron to capture disk usage via SSH
  (`df -B1 / | awk 'NR==2 {print $3}'`).
- Store `disk_used_bytes` in `hermes_instance_metrics` table.
- New banner in HermesChat: shows when `disk_used_bytes / disk_size_gb*1e9 > 0.8`.
- Tests: threshold arithmetic, banner render conditions.

**Risk:** Very low. Pure visibility.

#### Layer B — Enforcement (decisions needed)

**Decisions needed:**
- Cap value for free tier. May 6 plan said ~5GB. Confirm.
- Action when over cap:
  - (a) Block new chat-engine writes (read-only mode).
  - (b) Refuse new instance deploys until under cap.
  - (c) Email + grace period before any block.
  - (d) All of (a)+(b)+(c) staged.
  - Recommend staged: email at 95%, block new deploys at 100%, never
    block reads/chat continuation (would feel punitive given the
    user's data is *theirs*).
- Cleanup mechanism: user-initiated only? Auto-prune logs older than
  N days? Recommend user-initiated for v1.

**Risk:** Medium. Blocking writes on a paying-adjacent user is a
support-ticket generator. Worth shipping Layer A first, watching
real usage distribution for a month, then deciding the enforcement
threshold based on data.

### Files to touch (Layer A)
- modify: `dashboard/src/app/api/cron/sample-instance-metrics/route.ts`
- modify: `dashboard/supabase/migrations/2026XXXX_disk_used_bytes_metric.sql`
- new: `dashboard/src/components/chat/StorageCapBanner.tsx`
- modify: `dashboard/src/components/chat/HermesChat.tsx` (mount banner)

---

## 4. Bandwidth caps

### Why it matters
`probe-instance-egress` cron exists but only probes connectivity to
a few hardcoded API hosts. There's no metering of actual egress bytes,
no per-tier cap, no enforcement. A free user could pull 10 TB and the
Hetzner bill would land before anyone noticed.

### Decisions needed (lots of them)

1. **Source of truth for bandwidth measurement.**
   - (a) Hetzner traffic API: `GET /servers/{id}` returns `incoming_traffic`/`outgoing_traffic` in bytes since server creation. Coarse but free.
   - (b) Sample at agent runtime via warden — finer granularity but
     requires warden changes.
   - (c) Both: (a) for billing-period accounting, (b) for real-time
     enforcement.
   - Recommend (a) for v1. Daily sampling, monthly reset on Hetzner's
     side already.

2. **Cap value for free tier.** No prior decision. Hetzner gives 20 TB
   per CX server before overage charges kick in. Per-user free cap
   suggestions:
   - 100 GB/month: tight, generous for typical agent workloads, leaves
     headroom for many free users on a shared host.
   - 50 GB/month: tighter, matches most "free tier" SaaS cap norms.
   - 10 GB/month: very tight, would block users doing media/web tools.
   - Recommend 100 GB/month for v1, watch usage, adjust.

3. **Action when over cap.** Three flavours:
   - Throttle: rate-limit egress at firewall level. Container still
     works but slowly. Most user-friendly.
   - Block egress: outbound network blackholed. Container appears
     broken. Worst UX.
   - Pause instance: `hetznerShutdownServer`. User sees "instance
     paused due to bandwidth cap, upgrade to resume."
   - Recommend pause instance, with an "Upgrade to resume" banner.
     Throttling at firewall level is a real engineering project on
     its own; pause is a single API call.

4. **Reset cycle.** Calendar month, billing-period (varies per user),
   or rolling 30-day window?
   - Recommend calendar month. Matches Hetzner's reporting cycle.

5. **Pro/Power caps.** No cap, or 1 TB and 5 TB respectively to prevent
   one user from blowing the Hetzner allowance?
   - Recommend soft cap (alert at threshold, no automatic action) for
     paid tiers. They paid; let support intervene if abuse.

### Implementation shape

- New cron: `/api/cron/sample-instance-egress`, daily at 02:00 UTC.
- Reads Hetzner `outgoing_traffic` per server, diffs against last
  sample, accumulates per user per month.
- New table: `hermes_instance_egress_samples (instance_id, sampled_at,
  outgoing_bytes_total, monthly_outgoing_bytes)`.
- New service: `src/lib/services/bandwidth-cap.ts` with cap check.
- When over cap: pause instance via `hetznerShutdownServer`, set
  `hermes_instances.paused_reason = 'bandwidth_cap'`.
- New banner: `BandwidthCapBanner` shown when `paused_reason ===
  'bandwidth_cap'`, with upgrade CTA.
- Feature flag: `BANDWIDTH_CAP_ENABLED`.

### Files to touch
- new: `dashboard/src/app/api/cron/sample-instance-egress/route.ts`
- new: `dashboard/src/lib/services/bandwidth-cap.ts`
- new: `dashboard/supabase/migrations/2026XXXX_egress_samples.sql`
- new: `dashboard/src/components/chat/BandwidthCapBanner.tsx`
- modify: `dashboard/src/lib/hetzner/client.ts` (add traffic stat fetch)
- modify: `dashboard/vercel.json`

### Risk
Medium-high. Pausing instances is user-visible and can interrupt
real work. Run in dry-run mode (log "would pause inst-X") for a full
month before flipping the enforcement flag. Build a "Pro upgrade
restores instance immediately" recovery path so users who hit the
cap have an obvious unstuck.

---

## Order of attack (recommended)

1. **Storage Layer A (monitor + warn)** — small, additive, ships in a
   day. No product decisions needed beyond the warn thresholds.
2. **Free user cap + waitlist (gate-at-first-deploy variant)** — needed
   before the next viral moment to keep the budget intact.
3. **14-day idle reclaim with soft delete + 12-day warning** — only
   matters once the cap exists and you have idle slot pressure. Run
   in dry-run mode first.
4. **Bandwidth Layer + cap enforcement** — most engineering effort,
   most decisions. Defer to last; build only if usage data from
   Storage Layer A and from Hetzner billing shows actual abuse.

The moment you make the decisions above, all four are well-scoped and
can ship inside a week.

---

## What's NOT here (already shipped 2026-05-07)

- **Hetzner tier resize (`tier_change_pending` flag + `TierMismatchBanner` + redeploy clears flag).** Done. Pro/Power upgraders on Hetzner now see an "Apply Now" banner that triggers a container recreate to pick up their new caps. See `tier-change-service.ts` Hetzner/Proxmox split and `TierMismatchBanner.tsx`.
