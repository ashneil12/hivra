-- User-set withdraw destinations for the hermesos_lock wallet.
--
-- The original V1 withdraw flow auto-detected the destination from
-- on-chain Transfer history (most recent inbound sender wins). That's
-- unsafe in practice: many users deposit via bundlers, MEV relays,
-- exchanges, or contract proxies. The on-chain "sender" of those
-- transfers is the bundler/proxy address, NOT a wallet the user
-- controls. Withdrawing back to a bundler can lose funds permanently.
--
-- New rule (locked spec, 2026-04-30 evening): users explicitly set ONE
-- withdraw destination on their account before they can withdraw.
-- They must acknowledge it's a Base-network address they control.
-- HermesOS is not responsible for incorrect addresses or addresses on
-- other networks — that's surfaced in the UI copy.
--
-- One row per user. Insert on first set. Update on change.

create table if not exists public.user_withdraw_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  address text not null check (btrim(address) <> ''),
  normalized_address text not null check (btrim(normalized_address) <> ''),
  -- The only network supported today. Future-proof so a multi-chain
  -- world doesn't require renaming columns.
  network text not null default 'base' check (network in ('base')),
  -- Captured at set-time. Becomes the user's auditable acceptance of
  -- the "you are responsible for the address" disclaimer. The UI
  -- gates the Set button on this being true.
  acknowledged_responsibility boolean not null default false,
  set_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

drop trigger if exists user_withdraw_addresses_updated_at on public.user_withdraw_addresses;
create trigger user_withdraw_addresses_updated_at
  before update on public.user_withdraw_addresses
  for each row execute function update_updated_at();

create index if not exists user_withdraw_addresses_user_idx
  on public.user_withdraw_addresses(user_id);

alter table public.user_withdraw_addresses enable row level security;

drop policy if exists "users can read own withdraw address" on public.user_withdraw_addresses;
create policy "users can read own withdraw address"
  on public.user_withdraw_addresses
  for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "service role manages user withdraw addresses" on public.user_withdraw_addresses;
create policy "service role manages user withdraw addresses"
  on public.user_withdraw_addresses
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.user_withdraw_addresses from anon;
