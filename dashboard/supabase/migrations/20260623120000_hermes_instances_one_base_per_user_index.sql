-- Backstop the per-user single-base-instance limit at the DB level.
--
-- assertFreeInstanceCreatable() (src/lib/services/instance-service.ts) is a
-- check-then-insert with a large gap (entitlement/host/capacity resolution +
-- backend provisioning) between the SELECT and the INSERT, so two concurrent
-- POST /api/instances can both pass the check and both create a base-tier VM,
-- defeating the one-account-one-base-instance abuse control. This partial
-- unique index makes "one non-deleted base instance per user" atomic; the
-- create path maps the resulting 23505 back to FreeInstanceLimitError so the
-- race loser gets the same clean 403 as the pre-check.
--
-- ⚠️ APPLY ONLY AFTER de-duplicating existing data. If any user currently has
-- more than one non-deleted base instance (possible from the very race this
-- fixes, or from legacy rows), CREATE UNIQUE INDEX will FAIL. Verify first:
--
--   SELECT user_id, count(*)
--   FROM hermes_instances
--   WHERE resource_tier IN ('free', 'credit_base', 'token_base')
--     AND status <> 'deleted'
--   GROUP BY user_id
--   HAVING count(*) > 1;
--
-- Soft-delete the extras (status = 'deleted') for any user it returns before
-- applying this migration.
--
-- The resource_tier set mirrors SINGLE_INSTANCE_BASE_RESOURCE_TIER_VALUES in
-- src/lib/resource-tiers.ts ('free', 'credit_base', 'token_base'); keep them in
-- sync. Paid-tier instance-count limits are NOT enforceable by a unique index
-- (the cap is N, not 1) and need a separate per-user advisory-lock guard.

CREATE UNIQUE INDEX IF NOT EXISTS uq_hermes_instances_one_base_per_user
  ON hermes_instances (user_id)
  WHERE resource_tier IN ('free', 'credit_base', 'token_base')
    AND status <> 'deleted';
