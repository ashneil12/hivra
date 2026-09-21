create table if not exists public.wallet_verification_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  chain_type text not null default 'evm' check (chain_type in ('evm')),
  chain_id integer not null,
  address text not null,
  normalized_address text not null,
  nonce text not null unique,
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'verified', 'expired', 'failed')),
  expires_at timestamptz not null,
  verified_at timestamptz,
  consumed_at timestamptz,
  failure_reason text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists wallet_verification_challenges_updated_at on public.wallet_verification_challenges;
create trigger wallet_verification_challenges_updated_at
  before update on public.wallet_verification_challenges
  for each row execute function update_updated_at();

create index if not exists wallet_verification_challenges_user_status_idx
  on public.wallet_verification_challenges(user_id, status, created_at desc);

create index if not exists wallet_verification_challenges_address_idx
  on public.wallet_verification_challenges(normalized_address, chain_id, created_at desc);

create index if not exists wallet_verification_challenges_expires_idx
  on public.wallet_verification_challenges(expires_at)
  where status = 'pending';

alter table public.wallet_verification_challenges enable row level security;

drop policy if exists "users can read own wallet verification challenges" on public.wallet_verification_challenges;
create policy "users can read own wallet verification challenges"
  on public.wallet_verification_challenges
  for select
  using (auth.uid()::text = user_id);

drop policy if exists "service role manages wallet verification challenges" on public.wallet_verification_challenges;
create policy "service role manages wallet verification challenges"
  on public.wallet_verification_challenges
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

revoke all on public.wallet_verification_challenges from anon;
