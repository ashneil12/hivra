-- Allow the 'scheduled_for_deletion' value on hermes_instances.status.
--
-- Why: the dashboard already reads + writes this value in three places:
--   1. /api/cron/purge-expired uses .eq("status", "scheduled_for_deletion")
--      to find rows whose deletion deadline has passed.
--   2. StripeWebhookService.scheduleInstancesForDeletion writes that value
--      when a paid subscription is cancelled, with a grace window before
--      the row gets purged.
--   3. The new orphan-instances sweep (/api/cron/check-orphaned-instances)
--      writes that value when a Hermes row's Clerk owner is gone.
--
-- The original CHECK constraint (from 20260325000003_hermes_instances.sql)
-- only allowed: provisioning, running, stopped, failed, error, deleted,
-- redeploying. Any of the three writers above would throw 23514 in prod
-- ("violates check constraint"). This was a latent bug for the stripe path
-- — surfaced only when the orphan sweep tried to use it and we noticed
-- the cancel-subscription deletion queue had been silently empty.

alter table public.hermes_instances
  drop constraint if exists hermes_instances_status_check;

alter table public.hermes_instances
  add constraint hermes_instances_status_check
    check (
      status = any (
        array[
          'provisioning'::text,
          'running'::text,
          'stopped'::text,
          'failed'::text,
          'error'::text,
          'deleted'::text,
          'redeploying'::text,
          'scheduled_for_deletion'::text
        ]
      )
    );
