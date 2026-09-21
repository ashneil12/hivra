create table if not exists public.crypto_deposit_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  payment_transaction_id uuid references public.payment_transactions(id) on delete set null,
  provider text not null default 'bankr' check (provider in ('bankr', 'manual')),
  reference_id text not null check (btrim(reference_id) <> ''),
  chain_id integer not null,
  token_address text not null check (btrim(token_address) <> ''),
  token_symbol text not null check (btrim(token_symbol) <> ''),
  token_decimals integer not null check (token_decimals >= 0),
  deposit_address text not null check (btrim(deposit_address) <> ''),
  normalized_deposit_address text not null check (btrim(normalized_deposit_address) <> ''),
  amount_minor integer not null check (amount_minor >= 0),
  tx_hash text not null check (btrim(tx_hash) <> ''),
  log_index integer not null check (log_index >= 0),
  block_number bigint not null check (block_number >= 0),
  block_hash text,
  confirmations integer not null default 0 check (confirmations >= 0),
  status text not null default 'detected' check (status in ('detected', 'confirmed', 'settled', 'ignored', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default timezone('utc'::text, now()),
  confirmed_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  unique (chain_id, tx_hash, log_index),
  unique (provider, reference_id)
);

create trigger crypto_deposit_receipts_updated_at
  before update on public.crypto_deposit_receipts
  for each row execute function update_updated_at();

create index if not exists crypto_deposit_receipts_user_created_idx
  on public.crypto_deposit_receipts(user_id, created_at desc);

create index if not exists crypto_deposit_receipts_reference_idx
  on public.crypto_deposit_receipts(provider, reference_id);

create index if not exists crypto_deposit_receipts_status_idx
  on public.crypto_deposit_receipts(status, detected_at desc);

create index if not exists crypto_deposit_receipts_deposit_address_idx
  on public.crypto_deposit_receipts(chain_id, normalized_deposit_address, detected_at desc);

alter table public.crypto_deposit_receipts enable row level security;

drop policy if exists "Users can read own crypto deposit receipts" on public.crypto_deposit_receipts;
create policy "Users can read own crypto deposit receipts"
  on public.crypto_deposit_receipts for select
  using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

drop policy if exists "Service role full access crypto_deposit_receipts" on public.crypto_deposit_receipts;
create policy "Service role full access crypto_deposit_receipts"
  on public.crypto_deposit_receipts for all to service_role
  using (true) with check (true);
