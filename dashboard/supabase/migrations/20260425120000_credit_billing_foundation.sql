-- HermesOS v2 credits billing foundation.
-- Credits are display-only until entitlement enforcement and usage debits ship.

create table if not exists public.credit_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique check (btrim(user_id) <> ''),
  stripe_customer_id text,
  balance_cached_credits integer not null default 0,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.credit_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.credit_accounts(id) on delete restrict,
  user_id text not null check (btrim(user_id) <> ''),
  amount_credits integer not null check (amount_credits <> 0),
  source text not null check (source in ('stripe', 'bankr', 'admin', 'system')),
  actor text not null check (btrim(actor) <> ''),
  reason text not null check (
    reason in (
      'stripe_topup',
      'subscription_grant',
      'admin_adjustment',
      'refund',
      'bonus_credit',
      'compute_debit',
      'llm_debit',
      'crypto_topup'
    )
  ),
  reference_id text not null check (btrim(reference_id) <> ''),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  unique (source, reference_id, reason)
);

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  provider text not null check (provider in ('stripe', 'bankr', 'manual')),
  provider_reference_id text not null check (btrim(provider_reference_id) <> ''),
  idempotency_reference text,
  status text not null check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  asset text not null default 'USD',
  amount_minor integer not null check (amount_minor >= 0),
  package_credits integer check (package_credits is null or package_credits > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  unique (provider, provider_reference_id)
);

create table if not exists public.compute_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  instance_id uuid references public.hermes_instances(id) on delete set null,
  credits_delta integer not null default 0,
  usage_kind text not null default 'compute',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  account_id uuid not null references public.credit_accounts(id) on delete restrict,
  amount_credits integer not null check (amount_credits > 0),
  status text not null default 'active' check (status in ('active', 'released', 'captured', 'expired')),
  reason text not null check (btrim(reason) <> ''),
  reference_id text not null check (btrim(reference_id) <> ''),
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists credit_ledger_entries_user_created_idx
  on public.credit_ledger_entries (user_id, created_at desc);

create index if not exists payment_transactions_user_created_idx
  on public.payment_transactions (user_id, created_at desc);

create index if not exists compute_usage_events_user_created_idx
  on public.compute_usage_events (user_id, created_at desc);

create index if not exists credit_reservations_user_status_idx
  on public.credit_reservations (user_id, status);

create or replace function public.prevent_credit_ledger_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'credit_ledger_entries is append-only';
end;
$$;

drop trigger if exists prevent_credit_ledger_update on public.credit_ledger_entries;
create trigger prevent_credit_ledger_update
  before update on public.credit_ledger_entries
  for each row execute function public.prevent_credit_ledger_mutation();

drop trigger if exists prevent_credit_ledger_delete on public.credit_ledger_entries;
create trigger prevent_credit_ledger_delete
  before delete on public.credit_ledger_entries
  for each row execute function public.prevent_credit_ledger_mutation();

alter table public.credit_accounts enable row level security;
alter table public.credit_ledger_entries enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.compute_usage_events enable row level security;
alter table public.credit_reservations enable row level security;

drop policy if exists "Users can read own credit accounts" on public.credit_accounts;
create policy "Users can read own credit accounts"
  on public.credit_accounts for select
  using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

drop policy if exists "Users can read own credit ledger" on public.credit_ledger_entries;
create policy "Users can read own credit ledger"
  on public.credit_ledger_entries for select
  using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

drop policy if exists "Users can read own payment transactions" on public.payment_transactions;
create policy "Users can read own payment transactions"
  on public.payment_transactions for select
  using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

drop policy if exists "Users can read own compute usage events" on public.compute_usage_events;
create policy "Users can read own compute usage events"
  on public.compute_usage_events for select
  using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

drop policy if exists "Users can read own credit reservations" on public.credit_reservations;
create policy "Users can read own credit reservations"
  on public.credit_reservations for select
  using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

drop policy if exists "Service role full access credit_accounts" on public.credit_accounts;
create policy "Service role full access credit_accounts"
  on public.credit_accounts for all to service_role
  using (true) with check (true);

drop policy if exists "Service role full access credit_ledger_entries" on public.credit_ledger_entries;
create policy "Service role full access credit_ledger_entries"
  on public.credit_ledger_entries for all to service_role
  using (true) with check (true);

drop policy if exists "Service role full access payment_transactions" on public.payment_transactions;
create policy "Service role full access payment_transactions"
  on public.payment_transactions for all to service_role
  using (true) with check (true);

drop policy if exists "Service role full access compute_usage_events" on public.compute_usage_events;
create policy "Service role full access compute_usage_events"
  on public.compute_usage_events for all to service_role
  using (true) with check (true);

drop policy if exists "Service role full access credit_reservations" on public.credit_reservations;
create policy "Service role full access credit_reservations"
  on public.credit_reservations for all to service_role
  using (true) with check (true);
