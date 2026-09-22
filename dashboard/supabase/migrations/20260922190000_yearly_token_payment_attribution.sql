-- Yearly $HermesOS payments: attribute a specific on-chain transfer to each
-- quote, settle it atomically, support renewals, surface payments that need
-- review, and make the treasury sweep a compare-and-set claim.
--
-- Why: the quote route hands the user their SHARED credit_deposit Bankr wallet
-- (the same wallet managed-Venice $HermesOS top-ups land in), but detection
-- counted the wallet's whole balance and the sweep read a different
-- (yearly_subscription) wallet. One deposit could fund a managed-Venice lot and
-- a yearly subscription, yearly revenue was never swept, and leftover tokens
-- funded later quotes. Detection now binds exactly one Transfer log (tx hash)
-- inside the quote's own window to the quote, and the sweep moves that
-- transfer's amount out of the wallet the quote pointed the user at.
--
-- Changes:
--   yearly_token_quotes
--     * status 'manual_review' — a payment was seen but cannot be credited
--       automatically (under-paid, far over-paid, or late); the transfer is in
--       yearly_token_reconciliation_items.
--     * consumed_log_index, and (consumed_tx_hash, consumed_log_index) is
--       unique: one Transfer log pays at most one quote. Keyed per log, not per
--       tx, because one transaction (a multi-send, an exchange batch
--       withdrawal) can pay several users' wallets.
--     * attribution_closed_at — set once the quote's whole attribution range
--       (quotedAt .. min(expiresAt + late grace, next session)) has been
--       scanned at full confirmations. Until then the reconciler keeps
--       watching the range, even after the quote settled or went to review,
--       so a duplicate payment or a late top-up is always surfaced. Quotes the
--       pre-attribution flow already finished (cancelled, or consumed with no
--       tx recorded) are closed by this migration.
--   yearly_token_subscriptions
--     * status 'renewed' — superseded by a renewal row that carries the
--       extended period (one row per paid year, each with its own sweep).
--     * sweep_status 'sweeping' (claimed by one sweeper) and 'needs_operator'
--       (terminal: the sweep outcome is unknown or cannot be automated).
--     * deposit_address / deposit_log_index record the attributed transfer;
--       sweep_submitted_at marks that a treasury transfer was submitted under
--       the current claim, so a stale claim is only retried when nothing was
--       sent.
--     * (deposit_tx_hash, deposit_log_index) and yearly_quote_id are unique.
--   yearly_token_reconciliation_items — one row per on-chain transfer that
--     needs an operator (dedupe_key is unique, so cron ticks racing a user's
--     check surface each transfer once).
--   settle_yearly_token_payment(...) — claim + activate/renew + consume in one
--     transaction (see the function comment).
--
-- Rerun-safe. The only data changes are backfills: deposit_address from the
-- metadata the old code already recorded, and attribution_closed_at for quotes
-- the old flow finished (a rerun cannot close a range the new flow still
-- watches: new-flow consumed quotes always carry consumed_tx_hash).

-- ── yearly_token_quotes ─────────────────────────────────────────────────

alter table public.yearly_token_quotes
  drop constraint if exists yearly_token_quotes_status_check;
alter table public.yearly_token_quotes
  add constraint yearly_token_quotes_status_check
  check (status in ('active', 'consumed', 'expired', 'cancelled', 'manual_review'));

alter table public.yearly_token_quotes
  add column if not exists consumed_log_index integer,
  add column if not exists attribution_closed_at timestamptz;

create unique index if not exists uq_yearly_token_quotes_consumed_transfer
  on public.yearly_token_quotes (lower(consumed_tx_hash), consumed_log_index)
  where consumed_tx_hash is not null and consumed_log_index is not null;

-- Quotes the pre-attribution (balance-based) flow finished: their ranges are
-- never rescanned. That flow never recorded a tx, so a consumed quote with no
-- consumed_tx_hash is always one of its settlements.
update public.yearly_token_quotes
   set attribution_closed_at = coalesce(consumed_at, updated_at, now())
 where attribution_closed_at is null
   and (status = 'cancelled' or (status = 'consumed' and consumed_tx_hash is null));

-- Reconciler candidates (quotes whose attribution range may still hold a
-- transfer) and the next-session attribution boundary lookup.
create index if not exists ix_yearly_token_quotes_attribution_open
  on public.yearly_token_quotes (quoted_at desc)
  where attribution_closed_at is null;

create index if not exists ix_yearly_token_quotes_user_quoted_at
  on public.yearly_token_quotes (user_id, quoted_at);

-- ── yearly_token_subscriptions ──────────────────────────────────────────

alter table public.yearly_token_subscriptions
  drop constraint if exists yearly_token_subscriptions_status_check;
alter table public.yearly_token_subscriptions
  add constraint yearly_token_subscriptions_status_check
  check (status in ('active', 'grace', 'expired', 'cancelled', 'renewed'));

alter table public.yearly_token_subscriptions
  drop constraint if exists yearly_token_subscriptions_sweep_status_check;
alter table public.yearly_token_subscriptions
  add constraint yearly_token_subscriptions_sweep_status_check
  check (sweep_status in ('pending', 'sweeping', 'swept', 'failed', 'skipped', 'needs_operator'));

alter table public.yearly_token_subscriptions
  add column if not exists deposit_address text,
  add column if not exists deposit_log_index integer,
  add column if not exists sweep_submitted_at timestamptz;

update public.yearly_token_subscriptions
   set deposit_address = lower(btrim(metadata->>'depositAddress'))
 where deposit_address is null
   and coalesce(btrim(metadata->>'depositAddress'), '') <> '';

-- Rows written by settle_yearly_token_payment always carry the log index;
-- manual/legacy rows (no log index) are not constrained.
create unique index if not exists uq_yearly_token_subscriptions_deposit_transfer
  on public.yearly_token_subscriptions (lower(deposit_tx_hash), deposit_log_index)
  where deposit_tx_hash is not null and deposit_log_index is not null;

create unique index if not exists uq_yearly_token_subscriptions_yearly_quote_id
  on public.yearly_token_subscriptions (yearly_quote_id)
  where yearly_quote_id is not null;

-- Sweep candidates: fresh pending rows first, then failed rows by least
-- recently attempted, and stale 'sweeping' claims.
create index if not exists ix_yearly_token_subscriptions_sweep_queue
  on public.yearly_token_subscriptions (sweep_status, sweep_attempted_at)
  where sweep_status in ('pending', 'failed', 'sweeping');

-- ── yearly_token_reconciliation_items ───────────────────────────────────

create table if not exists public.yearly_token_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  quote_id uuid references public.yearly_token_quotes(id) on delete set null,
  subscription_id uuid references public.yearly_token_subscriptions(id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'resolved', 'ignored')),
  -- underpaid | overpaid | late_payment | unattributed_late_transfer |
  -- extra_transfer | payment_after_review | legacy_subscription_exists |
  -- contested_by_managed_venice_review
  reason text not null check (btrim(reason) <> ''),
  transaction_hash text,
  log_index integer,
  token_amount_raw numeric(78, 0),
  tokens_required_raw numeric(78, 0),
  deposit_address text,
  observed_at timestamptz,
  -- 'yearly_token_transfer:<lowercased tx>:<logIndex>'
  dedupe_key text,
  operator_notes text,
  metadata jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists yearly_token_reconciliation_items_updated_at
  on public.yearly_token_reconciliation_items;
create trigger yearly_token_reconciliation_items_updated_at
  before update on public.yearly_token_reconciliation_items
  for each row execute function update_updated_at();

create unique index if not exists uq_yearly_token_reconciliation_items_dedupe_key
  on public.yearly_token_reconciliation_items (dedupe_key)
  where dedupe_key is not null;

create index if not exists ix_yearly_token_reconciliation_items_open
  on public.yearly_token_reconciliation_items (created_at)
  where status = 'open';

create index if not exists ix_yearly_token_reconciliation_items_user_id
  on public.yearly_token_reconciliation_items (user_id);

create index if not exists ix_yearly_token_reconciliation_items_quote_id
  on public.yearly_token_reconciliation_items (quote_id);

create index if not exists ix_yearly_token_reconciliation_items_subscription_id
  on public.yearly_token_reconciliation_items (subscription_id);

alter table public.yearly_token_reconciliation_items enable row level security;

drop policy if exists "service role manages yearly token reconciliation items"
  on public.yearly_token_reconciliation_items;
create policy "service role manages yearly token reconciliation items"
  on public.yearly_token_reconciliation_items
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.yearly_token_reconciliation_items from anon, authenticated;

-- ── settle_yearly_token_payment ─────────────────────────────────────────
--
-- Binds one confirmed on-chain Transfer log (tx hash + log index) to a yearly
-- quote and grants the year it paid for, all in one transaction:
--   1. lock the quote; a quote already bound to this log is an idempotent
--      replay, bound to another one is a conflict, and only 'active' /
--      'expired' quotes can settle;
--   2. serialise per (user, tier) and refuse a transfer another flow already
--      owns: the same log bound to another yearly quote or subscription, or
--      the tx bound on THIS wallet by a managed-Venice quote (which binds per
--      tx) or on this user by a managed-Venice lot. Bindings on other wallets
--      are other Transfer logs of a multi-send and never block. A
--      managed-Venice quote in 'manual_review_required' does NOT own its
--      transaction_hash: the pre-attribution Venice flow wrote REJECTED
--      transfers there;
--   3. no live subscription for the tier -> a new 365-day row. A live
--      ('active' / 'grace') one -> it becomes 'renewed' and a new row runs
--      365 days from max(its expires_at, now);
--   4. mark the quote consumed with the tx.
-- A concurrent claim of the same tx trips a unique index and the whole call
-- rolls back to 'transaction_already_claimed'.
create or replace function public.settle_yearly_token_payment(
  p_quote_id uuid,
  p_transaction_hash text,
  p_log_index integer,
  p_amount_raw numeric,
  p_block_timestamp timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx text := lower(btrim(coalesce(p_transaction_hash, '')));
  v_quote public.yearly_token_quotes%rowtype;
  v_current public.yearly_token_subscriptions%rowtype;
  v_has_current boolean := false;
  v_sub_id uuid;
  v_expires_at timestamptz;
begin
  if v_tx !~ '^0x[0-9a-f]{64}$' or p_log_index is null or p_log_index < 0 then
    return jsonb_build_object('status', 'invalid_transaction');
  end if;
  if p_amount_raw is null or p_amount_raw <= 0 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;

  select * into v_quote
    from public.yearly_token_quotes
   where id = p_quote_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_quote.consumed_tx_hash is not null then
    if lower(v_quote.consumed_tx_hash) = v_tx and v_quote.consumed_log_index is not distinct from p_log_index then
      select id, expires_at into v_sub_id, v_expires_at
        from public.yearly_token_subscriptions
       where yearly_quote_id = v_quote.id;
      return jsonb_build_object(
        'status', 'already_settled',
        'subscription_id', v_sub_id,
        'expires_at', v_expires_at,
        'transaction_hash', v_tx
      );
    end if;
    return jsonb_build_object(
      'status', 'quote_settled_with_other_transaction',
      'transaction_hash', lower(v_quote.consumed_tx_hash)
    );
  end if;

  if v_quote.status not in ('active', 'expired') then
    return jsonb_build_object('status', 'not_settleable', 'quote_status', v_quote.status);
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('yearly_token_subscription:' || v_quote.user_id || ':' || v_quote.tier, 0)
  );

  -- The pre-attribution flow inserted the subscription before consuming the
  -- quote; a row left behind by that flow needs an operator, not a second year.
  if exists (select 1 from public.yearly_token_subscriptions where yearly_quote_id = v_quote.id) then
    return jsonb_build_object('status', 'legacy_subscription_exists');
  end if;

  if exists (
       select 1 from public.yearly_token_quotes q
        where lower(q.consumed_tx_hash) = v_tx
          and (q.consumed_log_index = p_log_index
               or (q.consumed_log_index is null and lower(q.deposit_address) = lower(v_quote.deposit_address)))
     )
     or exists (
       select 1 from public.yearly_token_subscriptions s
        where lower(s.deposit_tx_hash) = v_tx
          and (s.deposit_log_index = p_log_index
               or (s.deposit_log_index is null
                   and lower(coalesce(s.deposit_address, '')) = lower(v_quote.deposit_address)))
     )
     or exists (
       select 1 from public.managed_venice_token_quotes m
        where lower(m.transaction_hash) = v_tx
          and lower(m.deposit_address) = lower(v_quote.deposit_address)
          and m.status <> 'manual_review_required'
     )
     or exists (
       select 1 from public.managed_venice_token_lots l
        where lower(l.transaction_hash) = v_tx
          and l.user_id = v_quote.user_id
     ) then
    return jsonb_build_object('status', 'transaction_already_claimed');
  end if;

  select * into v_current
    from public.yearly_token_subscriptions
   where user_id = v_quote.user_id
     and tier = v_quote.tier
     and status in ('active', 'grace')
   for update;
  v_has_current := found;

  if v_has_current then
    v_expires_at := greatest(v_current.expires_at, p_now) + interval '365 days';
    update public.yearly_token_subscriptions
       set status = 'renewed',
           updated_at = p_now,
           metadata = metadata || jsonb_build_object(
             'renewedAt', p_now,
             'renewedByQuoteId', v_quote.id
           )
     where id = v_current.id;
  else
    v_expires_at := p_now + interval '365 days';
  end if;

  insert into public.yearly_token_subscriptions (
    user_id, tier, yearly_quote_id, paid_at, expires_at,
    deposit_tx_hash, deposit_log_index, deposit_address, amount_received_raw,
    sweep_status, status, metadata
  )
  values (
    v_quote.user_id, v_quote.tier, v_quote.id, p_now, v_expires_at,
    v_tx, p_log_index, lower(v_quote.deposit_address), p_amount_raw,
    'pending', 'active',
    jsonb_strip_nulls(jsonb_build_object(
      'priceUsdAtQuote', v_quote.price_usd_at_quote,
      'usdTargetCents', v_quote.usd_target_cents,
      'tokensRequiredRaw', v_quote.tokens_required_raw::text,
      'depositAddress', lower(v_quote.deposit_address),
      'blockTimestamp', p_block_timestamp,
      'renewsSubscriptionId', case when v_has_current then v_current.id end
    ))
  )
  returning id into v_sub_id;

  if v_has_current then
    update public.yearly_token_subscriptions
       set metadata = metadata || jsonb_build_object('renewedBySubscriptionId', v_sub_id)
     where id = v_current.id;
  end if;

  update public.yearly_token_quotes
     set status = 'consumed',
         consumed_tx_hash = v_tx,
         consumed_log_index = p_log_index,
         consumed_balance_raw = p_amount_raw,
         consumed_at = p_now,
         updated_at = p_now,
         metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
           'consumedLogIndex', p_log_index,
           'consumedBlockTimestamp', p_block_timestamp
         ))
   where id = v_quote.id;

  return jsonb_build_object(
    'status', case when v_has_current then 'renewed' else 'activated' end,
    'subscription_id', v_sub_id,
    'expires_at', v_expires_at,
    'renewed_subscription_id', case when v_has_current then v_current.id end,
    'transaction_hash', v_tx
  );
exception
  when unique_violation then
    return jsonb_build_object('status', 'transaction_already_claimed', 'detail', sqlerrm);
end;
$$;

revoke all on function public.settle_yearly_token_payment(uuid, text, integer, numeric, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.settle_yearly_token_payment(uuid, text, integer, numeric, timestamptz, timestamptz)
  to service_role;

comment on function public.settle_yearly_token_payment(uuid, text, integer, numeric, timestamptz, timestamptz) is
  'Binds one confirmed $HermesOS transfer to a yearly quote and activates or renews the tier in one transaction. Service role only.';
