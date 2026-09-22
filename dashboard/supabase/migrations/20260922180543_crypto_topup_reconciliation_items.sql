-- USDC top-ups: a manual-review queue for received transfers that automation
-- does not credit.
--
-- The reconciler (src/lib/billing/crypto-reconciliation.ts) credits exactly one
-- exact-amount transfer per top-up intent. Every other USDC transfer it
-- attributes to an intent (under-payments, over-payments, split payments,
-- extra transfers, a transfer whose intent was refunded mid-settlement) used
-- to be dropped silently. It is now written here, one row per on-chain
-- transfer, keyed by
--   dedupe_key = 'crypto_topup_transfer:<chainId>:<lowercased tx>:<logIndex>'
-- The unique constraint makes a repeat insert (every cron tick, a bearer
-- redelivery) fail with 23505, which the code treats as "already surfaced".
--
-- Service-role only. Rerun-safe (if not exists). No existing data is touched.

create table if not exists public.crypto_topup_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  payment_transaction_id uuid references public.payment_transactions(id) on delete set null,
  reference_id text,
  reason text not null check (reason in (
    'underpaid',
    'overpaid',
    'extra_transfer',
    'replayed_after_settlement',
    'intent_closed_during_settlement'
  )),
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  chain_id integer not null,
  token_address text not null check (btrim(token_address) <> ''),
  deposit_address text,
  tx_hash text not null check (btrim(tx_hash) <> ''),
  log_index integer not null check (log_index >= 0),
  block_number bigint,
  observed_amount_minor numeric(78, 0) not null check (observed_amount_minor > 0),
  expected_amount_minor bigint,
  observed_at timestamptz,
  dedupe_key text not null check (btrim(dedupe_key) <> ''),
  operator_notes text,
  metadata jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint crypto_topup_reconciliation_items_dedupe_key_key unique (dedupe_key)
);

drop trigger if exists crypto_topup_reconciliation_items_updated_at
  on public.crypto_topup_reconciliation_items;
create trigger crypto_topup_reconciliation_items_updated_at
  before update on public.crypto_topup_reconciliation_items
  for each row execute function update_updated_at();

create index if not exists crypto_topup_reconciliation_items_open_idx
  on public.crypto_topup_reconciliation_items (created_at)
  where status = 'open';

create index if not exists crypto_topup_reconciliation_items_user_idx
  on public.crypto_topup_reconciliation_items (user_id, created_at desc);

create index if not exists crypto_topup_reconciliation_items_payment_idx
  on public.crypto_topup_reconciliation_items (payment_transaction_id);

alter table public.crypto_topup_reconciliation_items enable row level security;

drop policy if exists "service role full access crypto_topup_reconciliation_items"
  on public.crypto_topup_reconciliation_items;
create policy "service role full access crypto_topup_reconciliation_items"
  on public.crypto_topup_reconciliation_items for all
  to service_role
  using (true)
  with check (true);

revoke all on public.crypto_topup_reconciliation_items from anon;
revoke all on public.crypto_topup_reconciliation_items from authenticated;
