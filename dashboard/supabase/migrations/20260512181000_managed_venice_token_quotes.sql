-- Managed Venice $HermesOS deposit quotes.
--
-- Quote rows are deliberately separate from spendable FIFO lots. A quote
-- only becomes wallet credit after settlement proves the token transfer
-- matched the quoted amount inside the 60-second quote window.

alter table public.bankr_deposit_wallet_credentials
  drop constraint if exists bankr_deposit_wallet_credentials_purpose_check;

alter table public.bankr_deposit_wallet_credentials
  add constraint bankr_deposit_wallet_credentials_purpose_check
  check (
    purpose in (
      'credit_deposit',
      'hermesos_lock',
      'yearly_subscription',
      'managed_venice_inference'
    )
  );

create table if not exists public.managed_venice_token_quotes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.managed_venice_wallet_accounts(id) on delete cascade,
  user_id text not null check (btrim(user_id) <> ''),
  token_amount_raw numeric(78, 0) not null check (token_amount_raw > 0),
  snapshot_price_usd text not null check (btrim(snapshot_price_usd) <> ''),
  locked_value_micro_usd bigint not null check (locked_value_micro_usd > 0),
  deposit_address text not null check (btrim(deposit_address) <> ''),
  quoted_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'active'
    check (status in ('active', 'settled', 'expired', 'manual_review_required', 'cancelled')),
  source text not null check (btrim(source) <> ''),
  cross_check_source text,
  cross_check_price_usd text,
  price_last_updated_at timestamptz,
  cross_check_last_updated_at timestamptz,
  transaction_hash text,
  settled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  check (expires_at > quoted_at)
);

create index if not exists managed_venice_token_quotes_user_status_idx
  on public.managed_venice_token_quotes(user_id, status, created_at desc);

create unique index if not exists managed_venice_token_quotes_tx_hash_idx
  on public.managed_venice_token_quotes(transaction_hash)
  where transaction_hash is not null;

drop trigger if exists managed_venice_token_quotes_updated_at
  on public.managed_venice_token_quotes;
create trigger managed_venice_token_quotes_updated_at
  before update on public.managed_venice_token_quotes
  for each row execute function public.update_updated_at();

alter table public.managed_venice_token_quotes enable row level security;

drop policy if exists "users can read own managed_venice_token_quotes"
  on public.managed_venice_token_quotes;
create policy "users can read own managed_venice_token_quotes"
  on public.managed_venice_token_quotes for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "service role full access managed_venice_token_quotes"
  on public.managed_venice_token_quotes;
create policy "service role full access managed_venice_token_quotes"
  on public.managed_venice_token_quotes for all
  to service_role
  using (true)
  with check (true);

revoke all on public.managed_venice_token_quotes from anon;
