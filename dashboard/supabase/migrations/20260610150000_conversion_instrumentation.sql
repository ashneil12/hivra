-- Conversion-funnel instrumentation columns.
--
-- hermes_subscriptions:
--   upgraded_at        — first free->paid transition, write-once (stamped by
--                        the Stripe webhook / confirm-checkout / change-plan /
--                        yearly token-payment activation paths).
--   upgrade_source     — which path performed the first upgrade.
--   signup_attribution — first-touch UTM/referrer captured client-side at
--                        signup and persisted by /api/billing/subscribe.
--
-- hermes_instances:
--   first_usage_at     — first observed agent session, stamped by the
--                        harvest-agent-usage cron (write-once).
--
-- Rerun-safe: add column if not exists / create index if not exists only.

alter table public.hermes_subscriptions
  add column if not exists upgraded_at timestamptz,
  add column if not exists upgrade_source text,
  add column if not exists signup_attribution jsonb;

comment on column public.hermes_subscriptions.upgraded_at is
  'First free->paid transition (write-once)';
comment on column public.hermes_subscriptions.upgrade_source is
  'stripe_webhook | confirm_checkout | change_plan | token_payment';
comment on column public.hermes_subscriptions.signup_attribution is
  'First-touch UTM/referrer captured at signup';

create index if not exists idx_hermes_subs_upgraded_at
  on public.hermes_subscriptions(upgraded_at)
  where upgraded_at is not null;

alter table public.hermes_instances
  add column if not exists first_usage_at timestamptz;

comment on column public.hermes_instances.first_usage_at is
  'First observed agent session, stamped by harvest cron';
