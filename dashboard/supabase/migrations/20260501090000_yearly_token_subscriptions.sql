-- Yearly token subscriptions — pay one year of Pro/Power upfront with
-- $HermesOS instead of holding to qualify or paying monthly via Stripe.
--
-- Two tables:
--
--   yearly_token_quotes        — short-lived (20 min) USD-target lock at
--                                live $HERMESOS price. User clicks
--                                "Pay yearly with $HermesOS", quote is
--                                minted, deposit address shown.
--
--   yearly_token_subscriptions — long-lived activation row, written
--                                when the cron detects a matching
--                                deposit landing in the user's
--                                credit_deposit wallet. expires_at =
--                                paid_at + 365d.
--
-- Sweep flow: once a deposit is matched and the subscription row is
-- inserted, the cron sweeps the deposited tokens from the user's
-- credit_deposit wallet to HERMES_TREASURY_ADDRESS. The sweep status
-- is tracked separately from activation so a transient sweep failure
-- doesn't block the user's tier.
--
-- Distinct from `deposit_quotes` (the existing tier-eligibility lock
-- table) because the lifecycle is different: tier-eligibility quotes
-- match against an ongoing balance and never sweep, yearly token quotes
-- match against an incoming transfer and always sweep to treasury.

create table if not exists public.yearly_token_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  tier text not null check (tier in ('pro', 'power')),
  -- USD targets locked in BUILD_PLAN.md (yearly):
  --   Pro   = 4900 ($49/yr in $HermesOS, vs $79/yr card)
  --   Power = 9900 ($99/yr in $HermesOS, vs $149/yr card)
  -- The discount vs card pricing is the carrot for paying with token.
  usd_target_cents integer not null check (usd_target_cents > 0),
  -- $HERMESOS/USD price snapshotted at quote time. Stored as a precise
  -- numeric string (e.g. "0.00000255") to keep the eligibility math exact.
  price_usd_at_quote text not null check (btrim(price_usd_at_quote) <> ''),
  tokens_required_raw numeric(78, 0) not null check (tokens_required_raw > 0),
  tokens_required_display text not null,
  -- The credit_deposit wallet address the user must send tokens to,
  -- snapshotted at quote time so the UI keeps showing a stable address
  -- even if the wallet record is later rotated for some reason.
  deposit_address text not null check (btrim(deposit_address) <> ''),
  quoted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active'
    check (status in ('active','consumed','expired','cancelled')),
  -- Captured at consume-time when the cron matches an incoming transfer.
  consumed_balance_raw numeric(78, 0),
  consumed_at timestamptz,
  consumed_tx_hash text,
  source text not null default 'dexscreener',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists yearly_token_quotes_updated_at on public.yearly_token_quotes;
create trigger yearly_token_quotes_updated_at
  before update on public.yearly_token_quotes
  for each row execute function update_updated_at();

-- One active quote per (user, tier). Mirror the deposit_quotes table's
-- invariant — re-clicking "Get quote" while one is still open returns
-- the existing quote rather than minting a duplicate.
create unique index if not exists yearly_token_quotes_user_tier_active_idx
  on public.yearly_token_quotes(user_id, tier)
  where status = 'active';

create index if not exists yearly_token_quotes_expires_idx
  on public.yearly_token_quotes(expires_at)
  where status = 'active';

create index if not exists yearly_token_quotes_user_idx
  on public.yearly_token_quotes(user_id, quoted_at desc);

alter table public.yearly_token_quotes enable row level security;

drop policy if exists "users can read own yearly token quotes" on public.yearly_token_quotes;
create policy "users can read own yearly token quotes"
  on public.yearly_token_quotes
  for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "service role manages yearly token quotes" on public.yearly_token_quotes;
create policy "service role manages yearly token quotes"
  on public.yearly_token_quotes
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.yearly_token_quotes from anon;

-- ────────────────────────────────────────────────────────────────────
-- Activated yearly subscriptions
-- ────────────────────────────────────────────────────────────────────

create table if not exists public.yearly_token_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  tier text not null check (tier in ('pro', 'power')),
  -- The quote that minted this subscription. Lets us audit the
  -- USD-target / price / token-amount that the user paid against.
  yearly_quote_id uuid references public.yearly_token_quotes(id),
  -- Activation timestamp = the moment the cron matched the deposit.
  -- Subscription expires 365 days later. Renewal is manual — user has
  -- to mint a new quote and pay again.
  paid_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- The on-chain transfer that funded this subscription, plus the
  -- amount actually received (may be slightly higher than tokens
  -- required if the user rounded up — we keep the excess as overpay).
  deposit_tx_hash text,
  amount_received_raw numeric(78, 0) not null check (amount_received_raw > 0),
  -- Sweep tracking. The cron moves tokens from credit_deposit →
  -- HERMES_TREASURY_ADDRESS after activation. Sweep failure does not
  -- block the subscription itself — we'd rather a stuck sweep than a
  -- user who paid and didn't get their tier.
  sweep_status text not null default 'pending'
    check (sweep_status in ('pending','swept','failed','skipped')),
  sweep_tx_hash text,
  sweep_attempted_at timestamptz,
  sweep_error text,
  -- Renewal-related fields — populated by the expiry cron.
  expiry_warning_email_sent_at timestamptz,
  expired_email_sent_at timestamptz,
  -- 'active' until paid_at + 365d, then 'grace' for 7 days, then 'expired'.
  -- The cron flips this on schedule.
  status text not null default 'active'
    check (status in ('active','grace','expired','cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists yearly_token_subscriptions_updated_at on public.yearly_token_subscriptions;
create trigger yearly_token_subscriptions_updated_at
  before update on public.yearly_token_subscriptions
  for each row execute function update_updated_at();

-- A user can have at most one ACTIVE yearly sub per tier at a time.
-- Re-paying inside the active window extends rather than stacking is
-- application-level logic; the constraint just prevents accidental
-- duplicate inserts from a retried cron job.
create unique index if not exists yearly_token_subscriptions_user_tier_active_idx
  on public.yearly_token_subscriptions(user_id, tier)
  where status in ('active','grace');

-- Used by the expiry cron to find subs about to enter grace / expire.
create index if not exists yearly_token_subscriptions_expires_idx
  on public.yearly_token_subscriptions(expires_at)
  where status in ('active','grace');

-- Used by the sweep cron to find pending sweeps to retry.
create index if not exists yearly_token_subscriptions_sweep_pending_idx
  on public.yearly_token_subscriptions(sweep_status, paid_at)
  where sweep_status = 'pending';

create index if not exists yearly_token_subscriptions_user_idx
  on public.yearly_token_subscriptions(user_id, paid_at desc);

alter table public.yearly_token_subscriptions enable row level security;

drop policy if exists "users can read own yearly token subs" on public.yearly_token_subscriptions;
create policy "users can read own yearly token subs"
  on public.yearly_token_subscriptions
  for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "service role manages yearly token subs" on public.yearly_token_subscriptions;
create policy "service role manages yearly token subs"
  on public.yearly_token_subscriptions
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.yearly_token_subscriptions from anon;
