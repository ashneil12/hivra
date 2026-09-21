-- Deposit quotes — locks a USD-denominated tier price into a fixed
-- token quantity for 20 minutes so deposits aren't subject to
-- price-move slippage between "I want to qualify" and "tokens arrive
-- on chain."
--
-- Flow:
--   1. User clicks "Get quote for Pro tier" on /dashboard/wallet.
--   2. Backend reads the live $HERMESOS/USD price (CoinGecko) and
--      computes tokens_required = (usd_target_cents / 100) / price.
--   3. A row is inserted with status='active' and expires_at = now+20m.
--      A unique partial index on (user_id, tier) WHERE status='active'
--      ensures there is at most one open quote per tier per user.
--   4. When the next cron tick sees the lock wallet's balance has
--      reached tokens_required, the eligibility evaluator marks the
--      quote 'consumed' and writes a token_tier_qualifications row
--      with qualifying_quantity = quote.tokens_required (NOT the
--      hardcoded threshold constants).
--   5. If 20 minutes pass without enough on-chain balance, the quote
--      auto-expires (status='expired'). User gets a fresh quote at
--      the then-current price.
--
-- Re-using a quote: when a user deposits MORE than the quote, the
-- excess stays in their lock wallet but doesn't change their
-- qualifying quantity (price-move grandfathering still respects the
-- locked-in quote, not the new balance).

create table if not exists public.deposit_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  tier text not null check (tier in ('pro', 'power')),
  -- Tracks which threshold tier the quote was minted against. Lets the
  -- system distinguish a launch-rate quote from a standard-rate quote
  -- if both epochs end up active in different windows for the same
  -- user (e.g. quote minted before the launch promo expired, consumed
  -- after).
  threshold_tier_code text not null
    check (threshold_tier_code in ('PRO_LAUNCH','PRO_STANDARD','POWER_LAUNCH','POWER_STANDARD')),
  -- USD target locked at quote time, in cents to avoid float drift.
  --   Pro launch    = 10000 ($100)
  --   Pro standard  = 14900 ($149)
  --   Power launch  = 19900 ($199)
  --   Power standard= 29900 ($299)
  usd_target_cents integer not null check (usd_target_cents > 0),
  -- $HERMESOS/USD price snapshotted at quote time. Stored as a precise
  -- numeric string (e.g. "0.00000255") so float artifacts never enter
  -- the eligibility math.
  price_usd_at_quote text not null check (btrim(price_usd_at_quote) <> ''),
  -- Tokens required = (usd_target_cents / 100) / price_usd_at_quote,
  -- expressed in base units (× 10^token_decimals). Stored as
  -- numeric(78,0) so values past 2^53 stay exact.
  tokens_required_raw numeric(78, 0) not null check (tokens_required_raw > 0),
  tokens_required_display text not null,
  quoted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active'
    check (status in ('active','consumed','expired','cancelled')),
  -- Captured at consume-time. The actual on-chain balance the cron
  -- saw when it qualified the user. Always >= tokens_required_raw on
  -- consume.
  consumed_balance_raw numeric(78, 0),
  consumed_at timestamptz,
  -- Where the price came from (e.g. 'coingecko_v3') and any extra
  -- diagnostics — last_updated_at, http status, fallback source, etc.
  source text not null default 'coingecko_v3',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists deposit_quotes_updated_at on public.deposit_quotes;
create trigger deposit_quotes_updated_at
  before update on public.deposit_quotes
  for each row execute function update_updated_at();

-- One active quote per (user, tier). When a new quote is minted, the
-- prior active row must be cancelled or expired first.
create unique index if not exists deposit_quotes_user_tier_active_idx
  on public.deposit_quotes(user_id, tier)
  where status = 'active';

create index if not exists deposit_quotes_expires_idx
  on public.deposit_quotes(expires_at)
  where status = 'active';

create index if not exists deposit_quotes_user_idx
  on public.deposit_quotes(user_id, quoted_at desc);

alter table public.deposit_quotes enable row level security;

drop policy if exists "users can read own deposit quotes" on public.deposit_quotes;
create policy "users can read own deposit quotes"
  on public.deposit_quotes
  for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "service role manages deposit quotes" on public.deposit_quotes;
create policy "service role manages deposit quotes"
  on public.deposit_quotes
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.deposit_quotes from anon;
