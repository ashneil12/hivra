create table if not exists public.user_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  chain_type text not null check (chain_type in ('evm')),
  chain_id integer,
  address text not null,
  normalized_address text not null,
  label text,
  is_primary boolean not null default false,
  verified_at timestamptz,
  verification_method text check (verification_method in ('signature', 'bankr', 'admin')),
  verification_reference text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, chain_type, normalized_address)
);

create trigger user_wallets_updated_at
  before update on public.user_wallets
  for each row execute function update_updated_at();

create index if not exists user_wallets_user_id_idx
  on public.user_wallets(user_id);

create index if not exists user_wallets_verified_idx
  on public.user_wallets(user_id, verified_at)
  where verified_at is not null;

create unique index if not exists user_wallets_one_primary_idx
  on public.user_wallets(user_id, chain_type)
  where is_primary;

alter table public.user_wallets enable row level security;

drop policy if exists "users can read own wallets" on public.user_wallets;
create policy "users can read own wallets"
  on public.user_wallets
  for select
  using (auth.uid()::text = user_id);

drop policy if exists "service role manages wallets" on public.user_wallets;
create policy "service role manages wallets"
  on public.user_wallets
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

revoke all on public.user_wallets from anon;

create table if not exists public.token_entitlement_configs (
  tier_key text primary key,
  chain_id integer not null,
  token_address text not null,
  token_symbol text not null,
  token_decimals integer not null,
  min_balance_raw numeric(78, 0) not null,
  max_instances integer not null,
  cpu_limit integer not null,
  ram_limit integer not null,
  active boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger token_entitlement_configs_updated_at
  before update on public.token_entitlement_configs
  for each row execute function update_updated_at();

insert into public.token_entitlement_configs (
  tier_key,
  chain_id,
  token_address,
  token_symbol,
  token_decimals,
  min_balance_raw,
  max_instances,
  cpu_limit,
  ram_limit,
  metadata
)
values (
  'token_base',
  8453,
  '0x95ccfd2b81a9667b0cc979992632f98fc853eba3',
  'HermesOS',
  18,
  1000000000000000000,
  1,
  1,
  2048,
  '{"description":"Hold at least 1 $HermesOS token on Base to unlock the base compute tier."}'::jsonb
)
on conflict (tier_key) do nothing;

alter table public.token_entitlement_configs enable row level security;

drop policy if exists "users can read token entitlement configs" on public.token_entitlement_configs;
create policy "users can read token entitlement configs"
  on public.token_entitlement_configs
  for select
  using (true);

drop policy if exists "service role manages token entitlement configs" on public.token_entitlement_configs;
create policy "service role manages token entitlement configs"
  on public.token_entitlement_configs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

revoke all on public.token_entitlement_configs from anon;

create table if not exists public.token_holding_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  wallet_id uuid references public.user_wallets(id) on delete set null,
  wallet_address text not null,
  normalized_wallet_address text not null,
  chain_id integer not null,
  token_address text not null,
  token_symbol text not null,
  token_decimals integer not null,
  balance_raw numeric(78, 0) not null,
  balance_display text not null,
  qualifies_base_tier boolean not null default false,
  block_number bigint,
  source text not null check (source in ('base_rpc', 'bankr', 'admin')),
  metadata jsonb not null default '{}',
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists token_holding_snapshots_user_checked_idx
  on public.token_holding_snapshots(user_id, checked_at desc);

create index if not exists token_holding_snapshots_wallet_checked_idx
  on public.token_holding_snapshots(normalized_wallet_address, chain_id, checked_at desc);

create index if not exists token_holding_snapshots_entitlement_idx
  on public.token_holding_snapshots(user_id, qualifies_base_tier, checked_at desc);

alter table public.token_holding_snapshots enable row level security;

drop policy if exists "users can read own token snapshots" on public.token_holding_snapshots;
create policy "users can read own token snapshots"
  on public.token_holding_snapshots
  for select
  using (auth.uid()::text = user_id);

drop policy if exists "service role manages token snapshots" on public.token_holding_snapshots;
create policy "service role manages token snapshots"
  on public.token_holding_snapshots
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

revoke all on public.token_holding_snapshots from anon;
