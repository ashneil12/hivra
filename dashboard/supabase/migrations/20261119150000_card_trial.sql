-- The card trial (owner decision 2026-11-19): a 7-day Stripe trial of the entry
-- plan with a card collected at Checkout. Off unless HIVRA_CARD_TRIAL=on.
--
-- hermes_subscriptions.trial_ends_at is set while a card trial runs and cleared
-- by the first paid subscription event. hermes_trial_usage records one row per
-- trial so an account, or a card, gets one trial.

alter table public.hermes_subscriptions
  add column if not exists trial_ends_at timestamptz;

comment on column public.hermes_subscriptions.trial_ends_at is
  'When the running card trial ends; null when the account is not in a trial.';

alter table public.hermes_trial_usage
  add column if not exists stripe_subscription_id text,
  add column if not exists card_fingerprint text;

create unique index if not exists idx_hermes_trial_usage_subscription
  on public.hermes_trial_usage(stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Unique: two trials started at once on the same card cannot both be recorded.
create unique index if not exists idx_hermes_trial_usage_card_fingerprint
  on public.hermes_trial_usage(card_fingerprint)
  where card_fingerprint is not null;

create index if not exists idx_hermes_trial_usage_user
  on public.hermes_trial_usage(user_id);
