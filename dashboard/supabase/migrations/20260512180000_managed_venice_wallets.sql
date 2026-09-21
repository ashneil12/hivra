-- Managed Venice wallet accounting foundation.
--
-- This schema intentionally sits beside the existing compute credit
-- ledger. Managed Venice has different units (USD microdollars and
-- token-backed FIFO lots), different safety requirements, and an
-- immutable financial event trail for accounting.

create table if not exists public.managed_venice_wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique check (btrim(user_id) <> ''),
  default_payment_wallet text not null default 'hermesos'
    check (default_payment_wallet in ('hermesos', 'card')),
  hermesos_enabled boolean not null default true,
  card_enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.managed_venice_token_lots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.managed_venice_wallet_accounts(id) on delete cascade,
  user_id text not null check (btrim(user_id) <> ''),
  quote_id uuid,
  source text not null default 'hermesos_deposit'
    check (source in ('hermesos_deposit', 'launch_promo', 'refund', 'admin')),
  token_amount_raw numeric(78, 0) not null check (token_amount_raw > 0),
  remaining_token_amount_raw numeric(78, 0) not null check (remaining_token_amount_raw >= 0),
  snapshot_price_usd text not null check (btrim(snapshot_price_usd) <> ''),
  original_value_micro_usd bigint not null check (original_value_micro_usd > 0),
  remaining_value_micro_usd bigint not null check (remaining_value_micro_usd >= 0),
  quote_source text not null check (btrim(quote_source) <> ''),
  quoted_at timestamptz not null,
  quote_expires_at timestamptz,
  transaction_hash text,
  status text not null default 'active'
    check (status in ('active', 'depleted', 'voided', 'manual_review')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  check (remaining_token_amount_raw <= token_amount_raw),
  check (remaining_value_micro_usd <= original_value_micro_usd)
);

create table if not exists public.managed_venice_card_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.managed_venice_wallet_accounts(id) on delete cascade,
  user_id text not null check (btrim(user_id) <> ''),
  amount_micro_usd bigint not null check (amount_micro_usd <> 0),
  source text not null check (source in ('stripe', 'admin', 'refund', 'system')),
  actor text not null check (btrim(actor) <> ''),
  reason text not null check (
    reason in (
      'stripe_topup',
      'admin_adjustment',
      'refund',
      'managed_venice_debit'
    )
  ),
  reference_id text not null check (btrim(reference_id) <> ''),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  unique (source, reference_id, reason)
);

create table if not exists public.managed_venice_proxy_keys (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.managed_venice_wallet_accounts(id) on delete cascade,
  user_id text not null check (btrim(user_id) <> ''),
  name text not null default 'Managed Venice key' check (btrim(name) <> ''),
  key_hash text not null unique check (btrim(key_hash) <> ''),
  key_prefix text not null check (btrim(key_prefix) <> ''),
  status text not null default 'active'
    check (status in ('active', 'revoked', 'paused')),
  paused_reason text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.managed_venice_reservations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.managed_venice_wallet_accounts(id) on delete cascade,
  user_id text not null check (btrim(user_id) <> ''),
  proxy_key_id uuid references public.managed_venice_proxy_keys(id) on delete set null,
  wallet_type text not null check (wallet_type in ('hermesos', 'card')),
  status text not null default 'active'
    check (status in ('active', 'captured', 'released', 'expired', 'reconciliation_required')),
  reference_id text not null unique check (btrim(reference_id) <> ''),
  estimated_cost_micro_usd bigint not null check (estimated_cost_micro_usd >= 0),
  reserved_micro_usd bigint not null check (reserved_micro_usd > 0),
  captured_micro_usd bigint not null default 0 check (captured_micro_usd >= 0),
  released_micro_usd bigint not null default 0 check (released_micro_usd >= 0),
  discount_rate_bps integer not null default 0 check (discount_rate_bps >= 0 and discount_rate_bps <= 10000),
  discount_micro_usd bigint not null default 0 check (discount_micro_usd >= 0),
  model text,
  endpoint text not null default '/api/v1/chat/completions',
  expires_at timestamptz,
  captured_at timestamptz,
  released_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  check (captured_micro_usd + released_micro_usd <= reserved_micro_usd)
);

create table if not exists public.managed_venice_usage_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.managed_venice_wallet_accounts(id) on delete cascade,
  user_id text not null check (btrim(user_id) <> ''),
  reservation_id uuid references public.managed_venice_reservations(id) on delete set null,
  proxy_key_id uuid references public.managed_venice_proxy_keys(id) on delete set null,
  wallet_type text not null check (wallet_type in ('hermesos', 'card')),
  provider text not null default 'venice' check (provider = 'venice'),
  endpoint text not null check (btrim(endpoint) <> ''),
  model text not null check (btrim(model) <> ''),
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  total_tokens integer check (total_tokens is null or total_tokens >= 0),
  estimated_cost_micro_usd bigint not null default 0 check (estimated_cost_micro_usd >= 0),
  actual_cost_micro_usd bigint not null default 0 check (actual_cost_micro_usd >= 0),
  charged_micro_usd bigint not null default 0 check (charged_micro_usd >= 0),
  discount_micro_usd bigint not null default 0 check (discount_micro_usd >= 0),
  status text not null default 'recorded'
    check (status in ('recorded', 'voided', 'reconciliation_required')),
  upstream_status integer,
  upstream_request_id text,
  reference_id text not null unique check (btrim(reference_id) <> ''),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.managed_venice_financial_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  account_id uuid references public.managed_venice_wallet_accounts(id) on delete set null,
  wallet_type text check (wallet_type in ('hermesos', 'card')),
  event_type text not null check (
    event_type in (
      'token_deposit',
      'card_topup',
      'reservation_created',
      'reservation_captured',
      'reservation_released',
      'usage_capture',
      'subsidy_applied',
      'refund_exception',
      'reconciliation_adjustment'
    )
  ),
  reference_id text not null check (btrim(reference_id) <> ''),
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  token_amount_raw numeric(78, 0),
  token_price_usd text,
  amount_micro_usd bigint not null default 0,
  venice_cost_micro_usd bigint not null default 0 check (venice_cost_micro_usd >= 0),
  discount_micro_usd bigint not null default 0 check (discount_micro_usd >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.managed_venice_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  account_id uuid references public.managed_venice_wallet_accounts(id) on delete set null,
  proxy_key_id uuid references public.managed_venice_proxy_keys(id) on delete set null,
  reservation_id uuid references public.managed_venice_reservations(id) on delete set null,
  usage_event_id uuid references public.managed_venice_usage_events(id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'resolved', 'ignored')),
  reason text not null check (btrim(reason) <> ''),
  operator_notes text,
  metadata jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.managed_venice_platform_state (
  id text primary key check (btrim(id) <> ''),
  launch_wave_enabled boolean not null default true,
  weekly_kill_switch_active boolean not null default false,
  weekly_subsidy_used_micro_usd bigint not null default 0 check (weekly_subsidy_used_micro_usd >= 0),
  weekly_subsidy_limit_micro_usd bigint not null default 1000000000 check (weekly_subsidy_limit_micro_usd > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create unique index if not exists managed_venice_financial_events_idempotency_idx
  on public.managed_venice_financial_events(idempotency_key);

create index if not exists managed_venice_token_lots_user_active_idx
  on public.managed_venice_token_lots(user_id, created_at)
  where status = 'active' and remaining_value_micro_usd > 0;

create index if not exists managed_venice_card_ledger_user_created_idx
  on public.managed_venice_card_ledger_entries(user_id, created_at desc);

create index if not exists managed_venice_proxy_keys_user_status_idx
  on public.managed_venice_proxy_keys(user_id, status);

create index if not exists managed_venice_reservations_user_status_idx
  on public.managed_venice_reservations(user_id, status);

create index if not exists managed_venice_usage_events_user_created_idx
  on public.managed_venice_usage_events(user_id, created_at desc);

create index if not exists managed_venice_usage_events_model_created_idx
  on public.managed_venice_usage_events(model, created_at desc);

create index if not exists managed_venice_reconciliation_open_idx
  on public.managed_venice_reconciliation_items(created_at)
  where status = 'open';

create or replace function public.prevent_managed_venice_financial_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'managed_venice_financial_events is append-only';
end;
$$;

drop trigger if exists prevent_managed_venice_financial_events_update
  on public.managed_venice_financial_events;
create trigger prevent_managed_venice_financial_events_update
  before update on public.managed_venice_financial_events
  for each row execute function public.prevent_managed_venice_financial_event_mutation();

drop trigger if exists prevent_managed_venice_financial_events_delete
  on public.managed_venice_financial_events;
create trigger prevent_managed_venice_financial_events_delete
  before delete on public.managed_venice_financial_events
  for each row execute function public.prevent_managed_venice_financial_event_mutation();

drop trigger if exists managed_venice_wallet_accounts_updated_at
  on public.managed_venice_wallet_accounts;
create trigger managed_venice_wallet_accounts_updated_at
  before update on public.managed_venice_wallet_accounts
  for each row execute function public.update_updated_at();

drop trigger if exists managed_venice_token_lots_updated_at
  on public.managed_venice_token_lots;
create trigger managed_venice_token_lots_updated_at
  before update on public.managed_venice_token_lots
  for each row execute function public.update_updated_at();

drop trigger if exists managed_venice_proxy_keys_updated_at
  on public.managed_venice_proxy_keys;
create trigger managed_venice_proxy_keys_updated_at
  before update on public.managed_venice_proxy_keys
  for each row execute function public.update_updated_at();

drop trigger if exists managed_venice_reservations_updated_at
  on public.managed_venice_reservations;
create trigger managed_venice_reservations_updated_at
  before update on public.managed_venice_reservations
  for each row execute function public.update_updated_at();

drop trigger if exists managed_venice_reconciliation_items_updated_at
  on public.managed_venice_reconciliation_items;
create trigger managed_venice_reconciliation_items_updated_at
  before update on public.managed_venice_reconciliation_items
  for each row execute function public.update_updated_at();

alter table public.managed_venice_wallet_accounts enable row level security;
alter table public.managed_venice_token_lots enable row level security;
alter table public.managed_venice_card_ledger_entries enable row level security;
alter table public.managed_venice_proxy_keys enable row level security;
alter table public.managed_venice_reservations enable row level security;
alter table public.managed_venice_usage_events enable row level security;
alter table public.managed_venice_financial_events enable row level security;
alter table public.managed_venice_reconciliation_items enable row level security;
alter table public.managed_venice_platform_state enable row level security;

drop policy if exists "users can read own managed_venice_wallet_accounts"
  on public.managed_venice_wallet_accounts;
create policy "users can read own managed_venice_wallet_accounts"
  on public.managed_venice_wallet_accounts for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "users can read own managed_venice_token_lots"
  on public.managed_venice_token_lots;
create policy "users can read own managed_venice_token_lots"
  on public.managed_venice_token_lots for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "users can read own managed_venice_proxy_keys"
  on public.managed_venice_proxy_keys;
create policy "users can read own managed_venice_proxy_keys"
  on public.managed_venice_proxy_keys for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "users can read own managed_venice_usage_events"
  on public.managed_venice_usage_events;
create policy "users can read own managed_venice_usage_events"
  on public.managed_venice_usage_events for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "service role full access managed_venice_wallet_accounts"
  on public.managed_venice_wallet_accounts;
create policy "service role full access managed_venice_wallet_accounts"
  on public.managed_venice_wallet_accounts for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role full access managed_venice_token_lots"
  on public.managed_venice_token_lots;
create policy "service role full access managed_venice_token_lots"
  on public.managed_venice_token_lots for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role full access managed_venice_card_ledger_entries"
  on public.managed_venice_card_ledger_entries;
create policy "service role full access managed_venice_card_ledger_entries"
  on public.managed_venice_card_ledger_entries for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role full access managed_venice_proxy_keys"
  on public.managed_venice_proxy_keys;
create policy "service role full access managed_venice_proxy_keys"
  on public.managed_venice_proxy_keys for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role full access managed_venice_reservations"
  on public.managed_venice_reservations;
create policy "service role full access managed_venice_reservations"
  on public.managed_venice_reservations for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role full access managed_venice_usage_events"
  on public.managed_venice_usage_events;
create policy "service role full access managed_venice_usage_events"
  on public.managed_venice_usage_events for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role full access managed_venice_financial_events"
  on public.managed_venice_financial_events;
create policy "service role full access managed_venice_financial_events"
  on public.managed_venice_financial_events for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role full access managed_venice_reconciliation_items"
  on public.managed_venice_reconciliation_items;
create policy "service role full access managed_venice_reconciliation_items"
  on public.managed_venice_reconciliation_items for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service role full access managed_venice_platform_state"
  on public.managed_venice_platform_state;
create policy "service role full access managed_venice_platform_state"
  on public.managed_venice_platform_state for all
  to service_role
  using (true)
  with check (true);

revoke all on public.managed_venice_wallet_accounts from anon;
revoke all on public.managed_venice_token_lots from anon;
revoke all on public.managed_venice_card_ledger_entries from anon;
revoke all on public.managed_venice_proxy_keys from anon;
revoke all on public.managed_venice_reservations from anon;
revoke all on public.managed_venice_usage_events from anon;
revoke all on public.managed_venice_financial_events from anon;
revoke all on public.managed_venice_reconciliation_items from anon;
revoke all on public.managed_venice_platform_state from anon;
