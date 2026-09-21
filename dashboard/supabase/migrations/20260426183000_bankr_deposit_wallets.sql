alter table public.crypto_deposit_receipts
  alter column amount_minor type bigint;

alter table public.crypto_deposit_receipts
  add column if not exists deposit_mode text not null default 'checkout'
    check (deposit_mode in ('checkout', 'open_credit', 'token_lock')),
  add column if not exists base_credit_amount integer,
  add column if not exists bonus_credit_amount integer,
  add column if not exists total_credit_amount integer,
  add column if not exists sweep_status text not null default 'not_required'
    check (sweep_status in ('not_required', 'pending', 'submitted', 'confirmed', 'failed', 'skipped')),
  add column if not exists sweep_tx_hash text;

create index if not exists crypto_deposit_receipts_tx_log_idx
  on public.crypto_deposit_receipts(chain_id, tx_hash, log_index);

create index if not exists crypto_deposit_receipts_open_mode_idx
  on public.crypto_deposit_receipts(deposit_mode, status, detected_at desc);

create table if not exists public.bankr_deposit_wallet_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  wallet_id uuid references public.user_wallets(id) on delete cascade,
  bankr_wallet_id text not null check (btrim(bankr_wallet_id) <> ''),
  evm_address text not null check (btrim(evm_address) <> ''),
  normalized_evm_address text not null check (btrim(normalized_evm_address) <> ''),
  api_key_encrypted text,
  api_key_preview text,
  api_key_status text not null default 'missing'
    check (api_key_status in ('active', 'missing', 'revoked', 'rotating', 'failed')),
  allowed_recipient_evm text,
  allowed_ips jsonb not null default '[]'::jsonb,
  permissions jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id),
  unique (wallet_id),
  unique (bankr_wallet_id),
  unique (normalized_evm_address)
);

drop trigger if exists bankr_deposit_wallet_credentials_updated_at on public.bankr_deposit_wallet_credentials;
create trigger bankr_deposit_wallet_credentials_updated_at
  before update on public.bankr_deposit_wallet_credentials
  for each row execute function update_updated_at();

alter table public.bankr_deposit_wallet_credentials enable row level security;

drop policy if exists "service role manages bankr deposit wallet credentials" on public.bankr_deposit_wallet_credentials;
create policy "service role manages bankr deposit wallet credentials"
  on public.bankr_deposit_wallet_credentials
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

revoke all on public.bankr_deposit_wallet_credentials from anon;
revoke all on public.bankr_deposit_wallet_credentials from authenticated;

create table if not exists public.crypto_wallet_sweeps (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  deposit_wallet_credential_id uuid references public.bankr_deposit_wallet_credentials(id) on delete set null,
  crypto_deposit_receipt_id uuid references public.crypto_deposit_receipts(id) on delete cascade,
  provider text not null default 'bankr' check (provider in ('bankr')),
  chain_id integer not null,
  token_address text not null check (btrim(token_address) <> ''),
  token_symbol text not null check (btrim(token_symbol) <> ''),
  token_decimals integer not null check (token_decimals >= 0),
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  amount_display text not null check (btrim(amount_display) <> ''),
  source_address text not null check (btrim(source_address) <> ''),
  destination_address text not null check (btrim(destination_address) <> ''),
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'confirmed', 'failed', 'skipped')),
  tx_hash text,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (crypto_deposit_receipt_id)
);

drop trigger if exists crypto_wallet_sweeps_updated_at on public.crypto_wallet_sweeps;
create trigger crypto_wallet_sweeps_updated_at
  before update on public.crypto_wallet_sweeps
  for each row execute function update_updated_at();

create index if not exists crypto_wallet_sweeps_user_created_idx
  on public.crypto_wallet_sweeps(user_id, created_at desc);

create index if not exists crypto_wallet_sweeps_status_idx
  on public.crypto_wallet_sweeps(status, created_at desc);

alter table public.crypto_wallet_sweeps enable row level security;

drop policy if exists "users can read own crypto wallet sweeps" on public.crypto_wallet_sweeps;
create policy "users can read own crypto wallet sweeps"
  on public.crypto_wallet_sweeps
  for select
  using (auth.uid()::text = user_id);

drop policy if exists "service role manages crypto wallet sweeps" on public.crypto_wallet_sweeps;
create policy "service role manages crypto wallet sweeps"
  on public.crypto_wallet_sweeps
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

revoke all on public.crypto_wallet_sweeps from anon;

