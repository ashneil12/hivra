-- Unwind the 2026-04-28 fleet_legacy / command_legacy grandfathering.
--
-- Yesterday's migration (20260428220000_grandfather_fleet_command_legacy.sql)
-- moved 45 paying-but-actually-trialing subs to *_legacy plan keys so they
-- kept the pre-halving caps. Reality: nobody has actually paid past the trial
-- yet, so there's no commitment to honor. Everyone moves to the new lower
-- caps so each provisioned server is something the operator can realistically
-- deploy themselves.
--
-- This migration:
--   1. Renames the `plan` column back from *_legacy to its base key
--      ('fleet_legacy' → 'fleet', 'command_legacy' → 'command').
--   2. Drops total_cpu_budget / total_ram_budget to the new (post-halving)
--      values from dashboard/src/lib/subscription/plans.ts.
--   3. Resets resource_tier on any matching live instances so warden +
--      provisioning code agree on the tier going forward.
--
-- Already-running Proxmox VMs keep their physical CPU/RAM allocation —
-- this migration only realigns the dashboard's per-user budget pool. A user
-- whose existing VM exceeds the new budget will be unable to provision more
-- until they delete or resize, which is the intended behavior.
--
-- The matching Stripe `subscription.metadata.plan` field must be flipped via
-- the Stripe API alongside this migration, so the next webhook event doesn't
-- re-stamp '*_legacy' on these rows.

UPDATE hermes_subscriptions
SET
  plan = CASE plan
    WHEN 'fleet_legacy'   THEN 'fleet'
    WHEN 'command_legacy' THEN 'command'
    ELSE plan
  END,
  total_cpu_budget = CASE plan
    WHEN 'fleet_legacy'   THEN 4
    WHEN 'command_legacy' THEN 8
    ELSE total_cpu_budget
  END,
  total_ram_budget = CASE plan
    WHEN 'fleet_legacy'   THEN 8192
    WHEN 'command_legacy' THEN 16384
    ELSE total_ram_budget
  END,
  updated_at = NOW()
WHERE plan IN ('fleet_legacy', 'command_legacy');

UPDATE hermes_instances
SET
  resource_tier = CASE resource_tier
    WHEN 'fleet_legacy'   THEN 'fleet'
    WHEN 'command_legacy' THEN 'command'
    ELSE resource_tier
  END,
  updated_at = NOW()
WHERE resource_tier IN ('fleet_legacy', 'command_legacy');
