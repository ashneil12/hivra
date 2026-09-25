-- USDC top-up reconciliation: a round-robin queue position per intent.
--
-- Why: the reconcile-crypto-topups cron read only the 50 NEWEST open top-up
-- intents. A burst of new intents (one account racing the session check, or a
-- few accounts) before each tick kept every older intent out of the batch, so
-- a user who had paid was never credited while the burst continued.
--
-- reconcile_queued_at is when an intent joined the back of the reconcile
-- queue: its insert (the column default), then every time the reconciler picks
-- it. The reconciler takes the intents that have waited longest (plus a small
-- share of the newest, so a fresh payment is credited on the next run), and
-- moves each one it picks to the back. Every open intent is therefore checked
-- within ceil(open intents / queue slots) runs, however many arrive meanwhile.
--
-- Additive and rerun-safe. The default is non-volatile, so existing rows take
-- the time of this statement without a table rewrite; ties are broken by
-- created_at. Other providers' rows carry the column but never use it.

alter table public.payment_transactions
  add column if not exists reconcile_queued_at timestamptz default now();

comment on column public.payment_transactions.reconcile_queued_at is
  'Crypto top-up reconciler queue position: insert time, then the time of each reconciler pick. Oldest first.';

-- The reconciler's queue read: open USDC/Base top-up intents, oldest queue
-- position first.
create index if not exists ix_payment_transactions_crypto_topup_reconcile_queue
  on public.payment_transactions (reconcile_queued_at asc nulls first, created_at asc)
  where provider = 'bankr' and asset = 'usdc_base' and status = 'pending';
