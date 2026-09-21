-- Agent wallet withdrawal recipients.
--
-- V1 stored a single withdrawal_destination_evm on instance_bankr_wallets.
-- The wallet can now withdraw any supported Base token to an explicit
-- recipient per request, while keeping a recent-address history and one
-- primary recipient for safer defaults.

create table if not exists public.instance_bankr_wallet_recipients (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.instance_bankr_wallets(id) on delete cascade,
  instance_id uuid not null references public.hermes_instances(id) on delete cascade,
  user_id text not null,
  address text not null,
  normalized_address text not null,
  label text,
  is_primary boolean not null default false,
  use_count integer not null default 0,
  first_used_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists instance_bankr_wallet_recipients_wallet_address_idx
  on public.instance_bankr_wallet_recipients(wallet_id, normalized_address);

create unique index if not exists instance_bankr_wallet_recipients_one_primary_idx
  on public.instance_bankr_wallet_recipients(wallet_id)
  where is_primary = true;

create index if not exists instance_bankr_wallet_recipients_instance_recent_idx
  on public.instance_bankr_wallet_recipients(instance_id, last_used_at desc);

create index if not exists instance_bankr_wallet_recipients_user_recent_idx
  on public.instance_bankr_wallet_recipients(user_id, last_used_at desc);

create trigger instance_bankr_wallet_recipients_set_updated_at
  before update on public.instance_bankr_wallet_recipients
  for each row
  execute function public.set_current_timestamp_updated_at();

alter table public.instance_bankr_wallet_recipients enable row level security;

create policy "Service role can manage instance Bankr wallet recipients"
  on public.instance_bankr_wallet_recipients
  for all
  to service_role
  using (true)
  with check (true);

insert into public.instance_bankr_wallet_recipients (
  wallet_id,
  instance_id,
  user_id,
  address,
  normalized_address,
  is_primary,
  use_count,
  first_used_at,
  last_used_at
)
select
  id,
  instance_id,
  user_id,
  lower(withdrawal_destination_evm),
  lower(withdrawal_destination_evm),
  true,
  0,
  coalesce(withdrawal_destination_set_at, updated_at, created_at, now()),
  coalesce(withdrawal_destination_set_at, updated_at, created_at, now())
from public.instance_bankr_wallets
where withdrawal_destination_evm is not null
on conflict (wallet_id, normalized_address) do update
set
  is_primary = true,
  last_used_at = excluded.last_used_at,
  updated_at = now();

alter table public.bankr_withdrawals
  add column if not exists chain text,
  add column if not exists token_symbol text,
  add column if not exists token_address text,
  add column if not exists token_decimals integer;

create index if not exists idx_bankr_withdrawals_user_token
  on public.bankr_withdrawals(user_id, chain, token_symbol, created_at desc);
