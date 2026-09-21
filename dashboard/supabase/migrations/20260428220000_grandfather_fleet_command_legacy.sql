-- Grandfather pre-2026-04-28 fleet/command subscribers at the old resource limits.
--
-- On 2026-04-28 we lowered the Fleet plan from 8 vCPU / 16 GB to 4 vCPU / 8 GB
-- and the Command plan from 16 vCPU / 32 GB to 8 vCPU / 16 GB. Existing
-- subscribers keep their old budgets via grandfathered plan keys
-- ('fleet_legacy', 'command_legacy') in dashboard/src/lib/subscription/plans.ts.
--
-- This migration:
--   1. Renames the `plan` column for every currently-paying fleet/command sub
--      to its legacy variant.
--   2. Restores the resource budgets to the old values (defensive — the webhook
--      should have stamped them already at signup time, but we make it explicit
--      so a stale row can't slip through).
--
-- Only paying subs (active + past_due) are grandfathered. Pending = Stripe
-- 'incomplete' (checkout started, first invoice unpaid) — these activate at
-- the new pricing when payment lands. Canceled subs re-subscribe at new
-- pricing. The matching Stripe `subscription.metadata.plan` is updated via
-- the Stripe API before this migration runs, so the webhook can't overwrite
-- the new plan key on the next event.

UPDATE hermes_subscriptions
SET
  plan = plan || '_legacy',
  total_cpu_budget = CASE plan
    WHEN 'fleet'   THEN 8
    WHEN 'command' THEN 16
    ELSE total_cpu_budget
  END,
  total_ram_budget = CASE plan
    WHEN 'fleet'   THEN 16384
    WHEN 'command' THEN 32768
    ELSE total_ram_budget
  END,
  updated_at = NOW()
WHERE plan IN ('fleet', 'command')
  AND status IN ('active', 'past_due');
