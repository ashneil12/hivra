-- Per-instance Bankr wallets. One row per Hermes agent instance.
-- Mirrors the bankr_deposit_wallet_credentials pattern but scoped to
-- a specific hermes_instances row instead of a billing purpose.
--
-- Bankr custodies the wallet's private keys; we hold an API key that
-- lets the agent (running on its own VM) call Bankr's wallet API.
-- The API key is encrypted at rest with @/lib/crypto and decrypted
-- in memory at config-sync time before being pushed to the agent.

create or replace function public.set_current_timestamp_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.instance_bankr_wallets (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.hermes_instances(id) on delete cascade,
  user_id text not null,
  bankr_wallet_id text not null,
  evm_address text not null,
  normalized_evm_address text generated always as (lower(evm_address)) stored,
  api_key_encrypted text,
  api_key_preview text,
  api_key_status text not null default 'active'
    check (api_key_status in ('active', 'missing', 'revoked', 'rotating', 'failed')),
  withdrawal_destination_evm text,
  withdrawal_destination_set_at timestamptz,
  status text not null default 'active'
    check (status in ('active', 'pending', 'failed', 'revoked')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index instance_bankr_wallets_instance_id_idx
  on public.instance_bankr_wallets(instance_id);

create index instance_bankr_wallets_user_id_idx
  on public.instance_bankr_wallets(user_id);

create index instance_bankr_wallets_normalized_evm_idx
  on public.instance_bankr_wallets(normalized_evm_address);

create trigger instance_bankr_wallets_set_updated_at
  before update on public.instance_bankr_wallets
  for each row
  execute function public.set_current_timestamp_updated_at();

alter table public.instance_bankr_wallets enable row level security;

create policy "Service role can manage instance Bankr wallets"
  on public.instance_bankr_wallets
  for all
  to service_role
  using (true)
  with check (true);
