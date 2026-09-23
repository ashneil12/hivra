-- Dual platform token foundation: $HermesOS (legacy) and $HIVRA (dormant).
--
-- The application reads token identity from
-- dashboard/src/lib/billing/token-registry.ts, and $HIVRA stays dormant until
-- dashboard/src/lib/billing/hivra-token-launch.ts carries its address. This
-- migration only adds the token dimension the code needs; with $HIVRA dormant
-- every existing row is $HermesOS and behaviour is unchanged.
--
--   * token_key ('hermesos' | 'hivra') on every table that holds a token
--     position or payment: token_tier_qualifications, token_entitlement_configs
--     (primary key becomes (tier_key, token_key)), deposit_quotes, yearly_token_quotes,
--     yearly_token_subscriptions, managed_venice_token_quotes and
--     managed_venice_token_lots. Existing rows are $HermesOS through the column
--     default (a metadata-only change, no table rewrite).
--     token_holding_snapshots already carries token_address, its token
--     dimension; readers filter by it. The quote, subscription and lot tables also record
--     the token_address a payment must arrive in.
--   * token_tier_qualifications stays unique on (user_id, tier): a user holds a
--     tier in exactly ONE token at a time, and the row's token_key says which.
--     Readers that ignore token_key still see one row per tier, so the failure
--     that forced the revert in 20260522121000 (a second row per tier leaking
--     into unfiltered entitlement reads) cannot happen. Readers that decide
--     access also check the token is allowed for the user
--     (token_key_allowed_for_user).
--   * wallet_type / default_payment_wallet accept 'hivra'. 'hermesos' and
--     'hivra' are both the token-funded managed-Venice wallet: the reservation
--     balance guard sums every token lot for either.
--   * managed_venice_token_lots.source accepts 'hivra_deposit'.
--   * token_address on yearly_token_reconciliation_items and
--     managed_venice_reconciliation_items, so a wrong-token transfer can be
--     recorded for operator recovery.
--   * platform_token_activations: the durable record that $HIVRA went live
--     (address and instant), written once by the application
--     (record_platform_token_activation) when the registry says it is active.
--   * token_grandfather_cohort: users grandfathered on $HermesOS, recorded at
--     activation from evidence strictly before the activation instant: a
--     $HermesOS tier qualification, a yearly token subscription, a managed
--     Venice token deposit, or a $HermesOS base-tier balance snapshot.
--     converted_at / conversion_grace_ends_at record a member's choice to move
--     to $HIVRA.
--   * token_key_allowed_for_user(user, token_key, now): the one rule both SQL
--     and application readers follow for payments and new holdings. Before
--     activation only 'hermesos'. After: 'hivra' always; 'hermesos' only for
--     cohort members who have not converted, or whose conversion grace is
--     still running. token_tier_row_counts_for_user adds that a member's
--     existing $HermesOS tier row counts until it is moved to $HIVRA.
--   * settle_yearly_platform_token_payment: settle_yearly_token_payment plus
--     the transfer's token address; a transfer in any token other than the
--     quote's is refused ('wrong_token'). settle_yearly_token_payment stays
--     for the running deployment and now settles only $HermesOS quotes.
--   * reconcile_stale_subscription_state_to_free only counts qualifications
--     and base-tier snapshots in tokens the user is allowed.
--
-- Locking: every CHECK constraint this migration replaces is a superset of the
-- old one and is added NOT VALID, so no table is scanned while it is locked;
-- new and updated rows are still checked. Adding a column with a constant
-- default does not rewrite the table.
--
-- Rerun-safe. No existing row is rewritten.

-- ── platform_token_activations ──────────────────────────────────────────

create table if not exists public.platform_token_activations (
  token_key text primary key check (token_key in ('hermesos', 'hivra')),
  chain_id integer not null,
  token_address text not null check (token_address ~ '^0x[0-9a-f]{40}$'),
  activated_at timestamptz not null,
  cohort_recorded_at timestamptz,
  cohort_size integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists platform_token_activations_updated_at on public.platform_token_activations;
create trigger platform_token_activations_updated_at
  before update on public.platform_token_activations
  for each row execute function update_updated_at();

alter table public.platform_token_activations enable row level security;
revoke all on public.platform_token_activations from anon, authenticated;
drop policy if exists "service role manages platform token activations" on public.platform_token_activations;
create policy "service role manages platform token activations"
  on public.platform_token_activations for all to service_role using (true) with check (true);

-- ── token_grandfather_cohort ────────────────────────────────────────────

create table if not exists public.token_grandfather_cohort (
  user_id text primary key check (btrim(user_id) <> ''),
  legacy_token_key text not null default 'hermesos' check (legacy_token_key = 'hermesos'),
  -- Which pre-activation facts put the user in the cohort, and the earliest.
  evidence text[] not null default '{}',
  first_evidence_at timestamptz,
  recorded_at timestamptz not null default now(),
  -- Set when the member chooses to move to $HIVRA. Until
  -- conversion_grace_ends_at, holding either token counts.
  converted_at timestamptz,
  conversion_grace_ends_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((converted_at is null) = (conversion_grace_ends_at is null)),
  check (conversion_grace_ends_at is null or conversion_grace_ends_at >= converted_at)
);

drop trigger if exists token_grandfather_cohort_updated_at on public.token_grandfather_cohort;
create trigger token_grandfather_cohort_updated_at
  before update on public.token_grandfather_cohort
  for each row execute function update_updated_at();

alter table public.token_grandfather_cohort enable row level security;
revoke all on public.token_grandfather_cohort from anon;
drop policy if exists "users can read own token grandfather cohort row" on public.token_grandfather_cohort;
create policy "users can read own token grandfather cohort row"
  on public.token_grandfather_cohort for select to authenticated
  using ((select auth.jwt()->>'sub') = user_id);
drop policy if exists "service role manages token grandfather cohort" on public.token_grandfather_cohort;
create policy "service role manages token grandfather cohort"
  on public.token_grandfather_cohort for all to service_role using (true) with check (true);

-- ── token dimension ─────────────────────────────────────────────────────

alter table public.token_tier_qualifications
  add column if not exists token_key text not null default 'hermesos';
alter table public.token_tier_qualifications
  drop constraint if exists token_tier_qualifications_token_key_check;
alter table public.token_tier_qualifications
  add constraint token_tier_qualifications_token_key_check check (token_key in ('hermesos', 'hivra')) not valid;

alter table public.token_entitlement_configs
  add column if not exists token_key text not null default 'hermesos';
alter table public.token_entitlement_configs
  drop constraint if exists token_entitlement_configs_token_key_check;
alter table public.token_entitlement_configs
  add constraint token_entitlement_configs_token_key_check check (token_key in ('hermesos', 'hivra')) not valid;
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.token_entitlement_configs'::regclass
       and conname = 'token_entitlement_configs_pkey'
       and pg_get_constraintdef(oid) = 'PRIMARY KEY (tier_key)'
  ) then
    alter table public.token_entitlement_configs drop constraint token_entitlement_configs_pkey;
    alter table public.token_entitlement_configs
      add constraint token_entitlement_configs_pkey primary key (tier_key, token_key);
  end if;
end $$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'deposit_quotes',
    'yearly_token_quotes',
    'yearly_token_subscriptions',
    'managed_venice_token_quotes',
    'managed_venice_token_lots'
  ] loop
    execute format('alter table public.%I add column if not exists token_key text not null default %L', v_table, 'hermesos');
    execute format(
      'alter table public.%I add column if not exists token_address text not null default %L',
      v_table, '0x95ccfd2b81a9667b0cc979992632f98fc853eba3'
    );
    execute format('alter table public.%I drop constraint if exists %I', v_table, v_table || '_token_key_check');
    execute format(
      'alter table public.%I add constraint %I check (token_key in (%L, %L)) not valid',
      v_table, v_table || '_token_key_check', 'hermesos', 'hivra'
    );
    execute format('alter table public.%I drop constraint if exists %I', v_table, v_table || '_token_address_check');
    execute format(
      'alter table public.%I add constraint %I check (token_address ~ %L) not valid',
      v_table, v_table || '_token_address_check', '^0x[0-9a-f]{40}$'
    );
  end loop;
end $$;

alter table public.yearly_token_reconciliation_items
  add column if not exists token_address text;
alter table public.managed_venice_reconciliation_items
  add column if not exists token_address text;

-- ── wallet types and lot sources ────────────────────────────────────────

alter table public.managed_venice_wallet_accounts
  drop constraint if exists managed_venice_wallet_accounts_default_payment_wallet_check;
alter table public.managed_venice_wallet_accounts
  add constraint managed_venice_wallet_accounts_default_payment_wallet_check
  check (default_payment_wallet in ('hermesos', 'hivra', 'card')) not valid;

alter table public.managed_venice_reservations
  drop constraint if exists managed_venice_reservations_wallet_type_check;
alter table public.managed_venice_reservations
  add constraint managed_venice_reservations_wallet_type_check
  check (wallet_type in ('hermesos', 'hivra', 'card')) not valid;

alter table public.managed_venice_usage_events
  drop constraint if exists managed_venice_usage_events_wallet_type_check;
alter table public.managed_venice_usage_events
  add constraint managed_venice_usage_events_wallet_type_check
  check (wallet_type in ('hermesos', 'hivra', 'card')) not valid;

alter table public.managed_venice_financial_events
  drop constraint if exists managed_venice_financial_events_wallet_type_check;
alter table public.managed_venice_financial_events
  add constraint managed_venice_financial_events_wallet_type_check
  check (wallet_type in ('hermesos', 'hivra', 'card')) not valid;

alter table public.managed_venice_token_lots
  drop constraint if exists managed_venice_token_lots_source_check;
alter table public.managed_venice_token_lots
  add constraint managed_venice_token_lots_source_check
  check (source in ('hermesos_deposit', 'hivra_deposit', 'launch_promo', 'refund', 'admin')) not valid;

-- Same guard as 20260606140100, with both token wallet types drawing on the
-- one pool of token lots.
create or replace function public.enforce_managed_venice_reservation_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available bigint;
begin
  if new.status is distinct from 'active' then
    return new;
  end if;

  if exists (
    select 1 from public.managed_venice_reservations
    where reference_id = new.reference_id
  ) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || new.user_id));

  if new.wallet_type in ('hermesos', 'hivra') then
    v_available :=
      coalesce((select sum(remaining_value_micro_usd) from public.managed_venice_token_lots
                where user_id = new.user_id and status = 'active'), 0)
      - coalesce((select sum(reserved_micro_usd) from public.managed_venice_reservations
                  where user_id = new.user_id and status = 'active' and wallet_type in ('hermesos', 'hivra')), 0);
  else
    v_available :=
      coalesce((select sum(amount_micro_usd) from public.managed_venice_card_ledger_entries
                where user_id = new.user_id), 0)
      - coalesce((select sum(reserved_micro_usd) from public.managed_venice_reservations
                  where user_id = new.user_id and status = 'active' and wallet_type = 'card'), 0);
  end if;

  if v_available < new.reserved_micro_usd then
    raise exception 'managed_venice_insufficient_balance: available=% requested=%',
      v_available, new.reserved_micro_usd
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- ── access rule ─────────────────────────────────────────────────────────

create or replace function public.token_key_allowed_for_user(
  p_user_id text,
  p_token_key text,
  p_now timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_token_key not in ('hermesos', 'hivra') then false
    when not exists (
      select 1 from public.platform_token_activations
       where token_key = 'hivra' and activated_at <= p_now
    ) then p_token_key = 'hermesos'
    when p_token_key = 'hivra' then true
    else exists (
      select 1 from public.token_grandfather_cohort c
       where c.user_id = p_user_id
         and (c.conversion_grace_ends_at is null or c.conversion_grace_ends_at > p_now)
    )
  end;
$$;

revoke all on function public.token_key_allowed_for_user(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.token_key_allowed_for_user(text, text, timestamptz) to service_role;

-- Whether an EXISTING tier row in p_token_key still counts for p_user_id:
-- the allowed rule, plus a member's $HermesOS rows until the application moves
-- them to $HIVRA after conversion (that move needs a live price and can lag).
-- Mirrors tierRowTokenCounts in dashboard/src/lib/billing/token-access.ts.
create or replace function public.token_tier_row_counts_for_user(
  p_user_id text,
  p_token_key text,
  p_now timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.token_key_allowed_for_user(p_user_id, p_token_key, p_now)
      or (p_token_key = 'hermesos'
          and exists (select 1 from public.token_grandfather_cohort c where c.user_id = p_user_id));
$$;

revoke all on function public.token_tier_row_counts_for_user(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.token_tier_row_counts_for_user(text, text, timestamptz) to service_role;

-- Evidence that p_user_id used $HermesOS before p_activated_at, or null.
create or replace function public.hermesos_grandfather_evidence(
  p_user_id text,
  p_activated_at timestamptz
)
returns table (evidence text[], first_evidence_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with facts as (
    select 'token_tier_qualification'::text as kind, least(q.qualified_at, q.created_at) as at
      from public.token_tier_qualifications q
     where q.user_id = p_user_id and q.token_key = 'hermesos'
       and least(q.qualified_at, q.created_at) < p_activated_at
    union all
    select 'yearly_token_subscription', s.paid_at
      from public.yearly_token_subscriptions s
     where s.user_id = p_user_id and s.token_key = 'hermesos' and s.paid_at < p_activated_at
    union all
    select 'managed_venice_token_deposit', l.created_at
      from public.managed_venice_token_lots l
     where l.user_id = p_user_id and l.token_key = 'hermesos'
       and l.source = 'hermesos_deposit' and l.created_at < p_activated_at
    union all
    select 'hermesos_base_tier_balance', s.checked_at
      from public.token_holding_snapshots s
     where s.user_id = p_user_id
       and lower(s.token_address) = '0x95ccfd2b81a9667b0cc979992632f98fc853eba3'
       and s.qualifies_base_tier
       and s.checked_at < p_activated_at
  )
  select array_agg(distinct kind order by kind), min(at)
    from facts
  having count(*) > 0;
$$;

revoke all on function public.hermesos_grandfather_evidence(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hermesos_grandfather_evidence(text, timestamptz) to service_role;

-- Record p_user_id in the cohort if it has pre-activation evidence. Returns
-- whether the user is a member, converted or not: membership alone does NOT
-- mean $HermesOS is still allowed (see token_key_allowed_for_user).
-- Idempotent; never removes a member.
create or replace function public.ensure_token_grandfather_membership(
  p_user_id text,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activated_at timestamptz;
  v_evidence text[];
  v_first timestamptz;
begin
  if exists (select 1 from public.token_grandfather_cohort where user_id = p_user_id) then
    return true;
  end if;
  select activated_at into v_activated_at
    from public.platform_token_activations where token_key = 'hivra';
  if v_activated_at is null or v_activated_at > p_now then
    return false;
  end if;
  select e.evidence, e.first_evidence_at into v_evidence, v_first
    from public.hermesos_grandfather_evidence(p_user_id, v_activated_at) e;
  if v_evidence is null then
    return false;
  end if;
  insert into public.token_grandfather_cohort (user_id, evidence, first_evidence_at, recorded_at)
  values (p_user_id, v_evidence, v_first, p_now)
  on conflict (user_id) do nothing;
  return true;
end;
$$;

revoke all on function public.ensure_token_grandfather_membership(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ensure_token_grandfather_membership(text, timestamptz) to service_role;

-- Record that $HIVRA went live, the whole grandfather cohort, and the $HIVRA
-- base-tier config, once. The application calls this when the registry says
-- $HIVRA is active. A second call with the same address only (re)records any
-- cohort members still missing; a different address is refused.
create or replace function public.record_platform_token_activation(
  p_token_key text,
  p_chain_id integer,
  p_token_address text,
  p_token_symbol text,
  p_token_decimals integer,
  p_activated_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_address text := lower(btrim(coalesce(p_token_address, '')));
  v_existing public.platform_token_activations%rowtype;
  v_inserted integer := 0;
  v_size integer;
begin
  if p_token_key is distinct from 'hivra' then
    return jsonb_build_object('status', 'unsupported_token');
  end if;
  if v_address !~ '^0x[0-9a-f]{40}$' or v_address = '0x95ccfd2b81a9667b0cc979992632f98fc853eba3' then
    return jsonb_build_object('status', 'invalid_address');
  end if;
  if p_activated_at is null or p_activated_at > p_now then
    return jsonb_build_object('status', 'not_yet_active');
  end if;
  if p_token_decimals is null or p_token_decimals < 0 or p_token_decimals > 36 then
    return jsonb_build_object('status', 'invalid_decimals');
  end if;
  if p_chain_id is distinct from 8453 then
    return jsonb_build_object('status', 'unsupported_chain');
  end if;
  if coalesce(btrim(p_token_symbol), '') = '' then
    return jsonb_build_object('status', 'invalid_symbol');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('platform_token_activation:' || p_token_key, 0));

  select * into v_existing from public.platform_token_activations where token_key = p_token_key;
  if found then
    if v_existing.token_address <> v_address or v_existing.chain_id <> p_chain_id then
      return jsonb_build_object(
        'status', 'address_conflict',
        'recorded_address', v_existing.token_address,
        'recorded_chain_id', v_existing.chain_id
      );
    end if;
    if v_existing.activated_at <> p_activated_at then
      return jsonb_build_object(
        'status', 'activation_instant_conflict',
        'recorded_activated_at', v_existing.activated_at
      );
    end if;
  else
    insert into public.platform_token_activations (token_key, chain_id, token_address, activated_at)
    values (p_token_key, p_chain_id, v_address, p_activated_at);
  end if;

  with users as (
    select user_id from public.token_tier_qualifications where token_key = 'hermesos'
    union select user_id from public.yearly_token_subscriptions where token_key = 'hermesos'
    union select user_id from public.managed_venice_token_lots where token_key = 'hermesos'
    union select user_id from public.token_holding_snapshots
     where lower(token_address) = '0x95ccfd2b81a9667b0cc979992632f98fc853eba3' and qualifies_base_tier
  ), evidence as (
    select u.user_id, e.evidence, e.first_evidence_at
      from users u
      cross join lateral public.hermesos_grandfather_evidence(u.user_id, p_activated_at) e
  ), ins as (
    insert into public.token_grandfather_cohort (user_id, evidence, first_evidence_at, recorded_at)
    select user_id, evidence, first_evidence_at, p_now from evidence
    on conflict (user_id) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  select count(*) into v_size from public.token_grandfather_cohort;

  -- $HIVRA base tier: same limits as the $HermesOS base tier, one whole token.
  insert into public.token_entitlement_configs (
    tier_key, token_key, chain_id, token_address, token_symbol, token_decimals,
    min_balance_raw, max_instances, cpu_limit, ram_limit, active, metadata
  )
  select 'token_base', 'hivra', p_chain_id, v_address, p_token_symbol, p_token_decimals,
         power(10::numeric, p_token_decimals),
         coalesce(c.max_instances, 1), coalesce(c.cpu_limit, 1), coalesce(c.ram_limit, 2048), true,
         jsonb_build_object('description', 'Hold at least 1 $HIVRA token on Base to unlock the base compute tier.')
    from (select 1) one
    left join public.token_entitlement_configs c
      on c.tier_key = 'token_base' and c.token_key = 'hermesos'
  on conflict (tier_key, token_key) do update
     set token_address = excluded.token_address,
         token_symbol = excluded.token_symbol,
         token_decimals = excluded.token_decimals,
         min_balance_raw = excluded.min_balance_raw,
         chain_id = excluded.chain_id;

  update public.platform_token_activations
     set cohort_recorded_at = coalesce(cohort_recorded_at, p_now),
         cohort_size = v_size
   where token_key = p_token_key;

  return jsonb_build_object(
    'status', case when v_existing.token_key is null then 'activated' else 'already_active' end,
    'cohort_inserted', v_inserted,
    'cohort_size', v_size
  );
end;
$$;

revoke all on function public.record_platform_token_activation(text, integer, text, text, integer, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_platform_token_activation(text, integer, text, text, integer, timestamptz, timestamptz)
  to service_role;

-- ── settle_yearly_platform_token_payment ────────────────────────────────
--
-- settle_yearly_token_payment (20260922222737) with the transfer's token:
-- a transfer in any token other than the quote's is refused, and the
-- subscription records the quote's token. A new name, not an overload, so a
-- positional call can never be ambiguous.
create or replace function public.settle_yearly_platform_token_payment(
  p_quote_id uuid,
  p_transaction_hash text,
  p_log_index integer,
  p_amount_raw numeric,
  p_block_timestamp timestamptz,
  p_token_address text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx text := lower(btrim(coalesce(p_transaction_hash, '')));
  v_quote public.yearly_token_quotes%rowtype;
  v_current public.yearly_token_subscriptions%rowtype;
  v_has_current boolean := false;
  v_sub_id uuid;
  v_expires_at timestamptz;
begin
  if v_tx !~ '^0x[0-9a-f]{64}$' or p_log_index is null or p_log_index < 0 then
    return jsonb_build_object('status', 'invalid_transaction');
  end if;
  if p_amount_raw is null or p_amount_raw <= 0 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;

  select * into v_quote
    from public.yearly_token_quotes
   where id = p_quote_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Settlement credits only the token the quote was issued for. A transfer of
  -- any other token is not this quote's payment (the reconciler surfaces it
  -- as a wrong_token item for operator recovery).
  if lower(btrim(coalesce(p_token_address, ''))) is distinct from lower(v_quote.token_address) then
    return jsonb_build_object(
      'status', 'wrong_token',
      'quote_token_address', lower(v_quote.token_address),
      'transfer_token_address', lower(btrim(coalesce(p_token_address, '')))
    );
  end if;

  if v_quote.consumed_tx_hash is not null then
    if lower(v_quote.consumed_tx_hash) = v_tx and v_quote.consumed_log_index is not distinct from p_log_index then
      select id, expires_at into v_sub_id, v_expires_at
        from public.yearly_token_subscriptions
       where yearly_quote_id = v_quote.id;
      return jsonb_build_object(
        'status', 'already_settled',
        'subscription_id', v_sub_id,
        'expires_at', v_expires_at,
        'transaction_hash', v_tx
      );
    end if;
    return jsonb_build_object(
      'status', 'quote_settled_with_other_transaction',
      'transaction_hash', lower(v_quote.consumed_tx_hash)
    );
  end if;

  if v_quote.status not in ('active', 'expired') then
    return jsonb_build_object('status', 'not_settleable', 'quote_status', v_quote.status);
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('yearly_token_subscription:' || v_quote.user_id || ':' || v_quote.tier, 0)
  );

  -- The pre-attribution flow inserted the subscription before consuming the
  -- quote; a row left behind by that flow needs an operator, not a second year.
  if exists (select 1 from public.yearly_token_subscriptions where yearly_quote_id = v_quote.id) then
    return jsonb_build_object('status', 'legacy_subscription_exists');
  end if;

  if exists (
       select 1 from public.yearly_token_quotes q
        where lower(q.consumed_tx_hash) = v_tx
          and (q.consumed_log_index = p_log_index
               or (q.consumed_log_index is null and lower(q.deposit_address) = lower(v_quote.deposit_address)))
     )
     or exists (
       select 1 from public.yearly_token_subscriptions s
        where lower(s.deposit_tx_hash) = v_tx
          and (s.deposit_log_index = p_log_index
               or (s.deposit_log_index is null
                   and lower(coalesce(s.deposit_address, '')) = lower(v_quote.deposit_address)))
     )
     or exists (
       select 1 from public.managed_venice_token_quotes m
        where lower(m.transaction_hash) = v_tx
          and lower(m.deposit_address) = lower(v_quote.deposit_address)
          and m.status <> 'manual_review_required'
     )
     or exists (
       select 1 from public.managed_venice_token_lots l
        where lower(l.transaction_hash) = v_tx
          and l.user_id = v_quote.user_id
     ) then
    return jsonb_build_object('status', 'transaction_already_claimed');
  end if;

  select * into v_current
    from public.yearly_token_subscriptions
   where user_id = v_quote.user_id
     and tier = v_quote.tier
     and status in ('active', 'grace')
   for update;
  v_has_current := found;

  if v_has_current then
    v_expires_at := greatest(v_current.expires_at, p_now) + interval '365 days';
    update public.yearly_token_subscriptions
       set status = 'renewed',
           updated_at = p_now,
           metadata = metadata || jsonb_build_object(
             'renewedAt', p_now,
             'renewedByQuoteId', v_quote.id
           )
     where id = v_current.id;
  else
    v_expires_at := p_now + interval '365 days';
  end if;

  insert into public.yearly_token_subscriptions (
    user_id, tier, yearly_quote_id, paid_at, expires_at,
    deposit_tx_hash, deposit_log_index, deposit_address, amount_received_raw,
    token_key, token_address,
    sweep_status, status, metadata
  )
  values (
    v_quote.user_id, v_quote.tier, v_quote.id, p_now, v_expires_at,
    v_tx, p_log_index, lower(v_quote.deposit_address), p_amount_raw,
    v_quote.token_key, lower(v_quote.token_address),
    'pending', 'active',
    jsonb_strip_nulls(jsonb_build_object(
      'priceUsdAtQuote', v_quote.price_usd_at_quote,
      'usdTargetCents', v_quote.usd_target_cents,
      'tokensRequiredRaw', v_quote.tokens_required_raw::text,
      'depositAddress', lower(v_quote.deposit_address),
      'blockTimestamp', p_block_timestamp,
      'renewsSubscriptionId', case when v_has_current then v_current.id end
    ))
  )
  returning id into v_sub_id;

  if v_has_current then
    update public.yearly_token_subscriptions
       set metadata = metadata || jsonb_build_object('renewedBySubscriptionId', v_sub_id)
     where id = v_current.id;
  end if;

  update public.yearly_token_quotes
     set status = 'consumed',
         consumed_tx_hash = v_tx,
         consumed_log_index = p_log_index,
         consumed_balance_raw = p_amount_raw,
         consumed_at = p_now,
         updated_at = p_now,
         metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
           'consumedLogIndex', p_log_index,
           'consumedBlockTimestamp', p_block_timestamp
         ))
   where id = v_quote.id;

  return jsonb_build_object(
    'status', case when v_has_current then 'renewed' else 'activated' end,
    'subscription_id', v_sub_id,
    'expires_at', v_expires_at,
    'renewed_subscription_id', case when v_has_current then v_current.id end,
    'transaction_hash', v_tx
  );
exception
  when unique_violation then
    return jsonb_build_object('status', 'transaction_already_claimed', 'detail', sqlerrm);
end;
$$;

revoke all on function public.settle_yearly_platform_token_payment(uuid, text, integer, numeric, timestamptz, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.settle_yearly_platform_token_payment(uuid, text, integer, numeric, timestamptz, text, timestamptz)
  to service_role;
comment on function public.settle_yearly_platform_token_payment(uuid, text, integer, numeric, timestamptz, text, timestamptz) is
  'Binds one confirmed platform-token transfer to a yearly quote issued in that same token and activates or renews the tier in one transaction. Service role only.';

-- The previous signature, for the deployment that predates the token
-- registry: it only ever settles $HermesOS transfers.
create or replace function public.settle_yearly_token_payment(
  p_quote_id uuid,
  p_transaction_hash text,
  p_log_index integer,
  p_amount_raw numeric,
  p_block_timestamp timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.settle_yearly_platform_token_payment(
    p_quote_id, p_transaction_hash, p_log_index, p_amount_raw, p_block_timestamp,
    '0x95ccfd2b81a9667b0cc979992632f98fc853eba3', p_now
  );
$$;

revoke all on function public.settle_yearly_token_payment(uuid, text, integer, numeric, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.settle_yearly_token_payment(uuid, text, integer, numeric, timestamptz, timestamptz)
  to service_role;

-- ── reconcile_stale_subscription_state_to_free (token-aware) ────────────
--
-- Body of 20260922234806 with one change: Pro/Power qualifications and the
-- base-tier snapshot count only in tokens that still count for the user.

create or replace function public.reconcile_stale_subscription_state_to_free(
  p_user_id text,
  p_observed_plan text,
  p_observed_status text,
  p_observed_stripe_subscription_id text,
  p_observed_updated_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.hermes_subscriptions%rowtype;
  v_yearly_tier text;
  v_token_tier text;
  v_has_base_token_snapshot boolean := false;
  v_target_tier text := 'credit_base';
  v_cpu_limit numeric := 0.5;
  v_ram_limit integer := 1024;
  v_instances_updated integer := 0;
  v_instances_changed integer := 0;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    return jsonb_build_object(
      'subscription_updated', false,
      'reason', 'missing_user_id',
      'instances_updated', 0,
      'instances_changed', 0,
      'target_tier', null
    );
  end if;

  select *
    into v_sub
  from public.hermes_subscriptions
  where user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'subscription_updated', false,
      'reason', 'missing_subscription',
      'instances_updated', 0,
      'instances_changed', 0,
      'target_tier', null
    );
  end if;

  if v_sub.plan is distinct from p_observed_plan
    or v_sub.status is distinct from p_observed_status
    or v_sub.stripe_subscription_id is distinct from p_observed_stripe_subscription_id
    or v_sub.updated_at is distinct from p_observed_updated_at
  then
    return jsonb_build_object(
      'subscription_updated', false,
      'reason', 'stale_observed_subscription',
      'instances_updated', 0,
      'instances_changed', 0,
      'target_tier', null
    );
  end if;

  update public.hermes_subscriptions
  set
    stripe_subscription_id = null,
    plan = 'free',
    status = 'active',
    instance_limit = 1,
    total_cpu_budget = 0.5,
    total_ram_budget = 1024,
    current_period_start = p_now,
    current_period_end = null,
    grace_period_ends_at = null,
    updated_at = p_now
  where user_id = p_user_id;

  -- Match refresh-token-tiers / resolveEffectiveSubscription precedence for
  -- non-Stripe rows: yearly token sub, Pro/Power token qualification, latest
  -- base-token snapshot (token_base), then Free/credit_base.
  -- The highest-ranked live yearly tier wins, never the newest payment: a Pro
  -- renewal inserts a fresh row while a paid Power year is still running.
  select tier
    into v_yearly_tier
  from public.yearly_token_subscriptions
  where user_id = p_user_id
    and status in ('active', 'grace')
  order by
    case tier when 'power' then 2 when 'pro' then 1 else 0 end desc,
    expires_at desc,
    paid_at desc
  limit 1;

  if v_yearly_tier = 'power' then
    v_target_tier := 'fleet';
    v_cpu_limit := 4;
    v_ram_limit := 8192;
  elsif v_yearly_tier = 'pro' then
    v_target_tier := 'operator';
    v_cpu_limit := 2;
    v_ram_limit := 4096;
  else
    select case
      when exists (
        select 1
        from public.token_tier_qualifications
        where user_id = p_user_id
          and tier = 'power'
          and currently_eligible = true
          and public.token_tier_row_counts_for_user(p_user_id, token_key, p_now)
      ) then 'power'
      when exists (
        select 1
        from public.token_tier_qualifications
        where user_id = p_user_id
          and tier = 'pro'
          and currently_eligible = true
          and public.token_tier_row_counts_for_user(p_user_id, token_key, p_now)
      ) then 'pro'
      else null
    end
      into v_token_tier;

    if v_token_tier = 'power' then
      v_target_tier := 'fleet';
      v_cpu_limit := 4;
      v_ram_limit := 8192;
    elsif v_token_tier = 'pro' then
      v_target_tier := 'operator';
      v_cpu_limit := 2;
      v_ram_limit := 4096;
    else
      -- Base tier keyed on TRUE token identity (chain_id + token_address).
      -- The token_symbol equality that used to live here was dropped: it is a
      -- mutable display field and broke after the HermesOS -> Hivra rename.
      select coalesce(latest.qualifies_base_tier, false)
        into v_has_base_token_snapshot
      from (
        select snapshot.qualifies_base_tier
        from public.token_holding_snapshots snapshot
        join public.token_entitlement_configs config
          on config.tier_key = 'token_base'
         and config.chain_id = snapshot.chain_id
         and lower(config.token_address) = lower(snapshot.token_address)
        where snapshot.user_id = p_user_id
          and public.token_key_allowed_for_user(p_user_id, config.token_key, p_now)
        order by snapshot.checked_at desc
        limit 1
      ) latest;

      if coalesce(v_has_base_token_snapshot, false) then
        v_target_tier := 'token_base';
        v_cpu_limit := 0.5;
        v_ram_limit := 1024;
      end if;
    end if;
  end if;

  with candidates as (
    select id
    from public.hermes_instances
    where user_id = p_user_id
      and status not in ('deleted', 'scheduled_for_deletion')
  ), changed as (
    select id
    from public.hermes_instances
    where user_id = p_user_id
      and status not in ('deleted', 'scheduled_for_deletion')
      and (
        resource_tier is distinct from v_target_tier
        or cpu_limit is distinct from v_cpu_limit
        or ram_limit is distinct from v_ram_limit
      )
  ), update_instances as (
    update public.hermes_instances inst
    set
      resource_tier = v_target_tier,
      cpu_limit = v_cpu_limit,
      ram_limit = v_ram_limit,
      tier_change_pending = case
        when inst.id in (select id from changed) then true
        else inst.tier_change_pending
      end,
      updated_at = p_now
    where inst.id in (select id from candidates)
    returning inst.id
  )
  select
    (select count(*) from update_instances),
    (select count(*) from changed)
  into v_instances_updated, v_instances_changed;

  return jsonb_build_object(
    'subscription_updated', true,
    'reason', 'reconciled',
    'instances_updated', v_instances_updated,
    'instances_changed', v_instances_changed,
    'target_tier', v_target_tier
  );
end;
$$;

revoke all on function public.reconcile_stale_subscription_state_to_free(
  text, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.reconcile_stale_subscription_state_to_free(
  text, text, text, text, timestamptz, timestamptz
) to service_role;
