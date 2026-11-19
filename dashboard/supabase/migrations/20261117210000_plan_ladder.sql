-- Plan ladder (behind HIVRA_PLAN_LADDER, off by default).
--
-- 1. hermes_subscriptions learns which ladder a subscription was bought on,
--    how many agents it may keep awake, and its monthly AI allowance. Rows
--    from before the ladder keep plan_ladder = null and change in no way.
-- 2. The card ledger (the managed AI balance) may carry the allowance and its
--    expiry: reasons 'plan_allowance' and 'plan_allowance_expiry'.
-- 3. plan_ai_allowance_state keeps one running figure per owner: how much of
--    the allowance is still unspent, so one month of it can roll over.
-- 4. grant_plan_ai_allowance pays one month's allowance, idempotent per
--    period key, and first removes any unspent allowance older than the one
--    month that may roll over.
--
-- Class: additive, plus a widened check on the card ledger (reason).
-- Rerun-safe: add column if not exists, create table if not exists, drop
-- constraint if exists, create or replace.

-- 1. Subscription columns.
alter table public.hermes_subscriptions
  add column if not exists plan_ladder text,
  add column if not exists always_on_limit integer,
  add column if not exists always_on_extra integer not null default 0,
  add column if not exists ai_allowance_micro_usd bigint not null default 0;

alter table public.hermes_subscriptions
  drop constraint if exists hermes_subscriptions_always_on_limit_check;
alter table public.hermes_subscriptions
  add constraint hermes_subscriptions_always_on_limit_check
  check (always_on_limit is null or always_on_limit >= 0);

alter table public.hermes_subscriptions
  drop constraint if exists hermes_subscriptions_ai_allowance_check;
alter table public.hermes_subscriptions
  add constraint hermes_subscriptions_ai_allowance_check
  check (ai_allowance_micro_usd >= 0 and always_on_extra >= 0);

comment on column public.hermes_subscriptions.plan_ladder is
  'Which plan ladder this subscription was bought on (e.g. 2026-11). Null = bought before the ladder: limits come from the code''s plan table and never change.';
comment on column public.hermes_subscriptions.always_on_limit is
  'How many agents the owner may keep awake (Keep awake). Null = no limit (subscriptions from before the ladder).';
comment on column public.hermes_subscriptions.always_on_extra is
  'Always-on extras paid for on top of the plan (included in always_on_limit).';
comment on column public.hermes_subscriptions.ai_allowance_micro_usd is
  'Managed AI paid into the owner''s card wallet each month while the plan is active.';

-- 2. Card ledger reasons.
alter table public.managed_venice_card_ledger_entries
  drop constraint if exists managed_venice_card_ledger_entries_reason_check;
alter table public.managed_venice_card_ledger_entries
  add constraint managed_venice_card_ledger_entries_reason_check
  check (reason in (
    'stripe_topup',
    'admin_adjustment',
    'refund',
    'managed_venice_debit',
    'overcharge_refund',
    'promo_grant',
    'promo_expiry',
    'starter_credit',
    'plan_allowance',
    'plan_allowance_expiry'
  ));

-- 3. Running allowance state, one row per owner.
create table if not exists public.plan_ai_allowance_state (
  user_id text primary key check (btrim(user_id) <> ''),
  -- Unspent allowance as of last_granted_at, after that grant was added.
  remaining_micro_usd bigint not null default 0 check (remaining_micro_usd >= 0),
  last_amount_micro_usd bigint not null default 0 check (last_amount_micro_usd >= 0),
  last_period_key text,
  last_granted_at timestamptz,
  updated_at timestamptz not null default timezone('utc'::text, now())
);

alter table public.plan_ai_allowance_state enable row level security;
revoke all on table public.plan_ai_allowance_state from anon, authenticated;

comment on table public.plan_ai_allowance_state is
  'Plan AI allowance bookkeeping. Spending is taken from the allowance first; at each monthly grant, unspent allowance beyond one month''s worth expires. Service role only.';

-- 4. Pay one month's allowance.
--      spent since the last grant = managed_venice_debit entries since then
--      remaining  = max(0, state.remaining - spent)
--      rollover   = min(remaining, last month's allowance)   (one month rolls over)
--      expire     = remaining - rollover, removed from the wallet but never
--                   more than the wallet's available balance
--      new state  = rollover + this month's allowance
--    Idempotent by (user, period key): the grant entry's reference_id is
--    'plan_allowance:<user>:<period>'. Takes the wallet lock the balance
--    guards take, so a debit cannot slip in between the read and the writes.
create or replace function public.grant_plan_ai_allowance(
  p_user_id text,
  p_period_key text,
  p_amount_micro_usd bigint,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reference_id text;
  v_state public.plan_ai_allowance_state%rowtype;
  v_has_state boolean;
  v_spent bigint := 0;
  v_remaining bigint := 0;
  v_rollover bigint := 0;
  v_expire bigint := 0;
  v_available bigint;
  v_remove bigint := 0;
  v_account_id uuid;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'plan_allowance_invalid: user id is required' using errcode = '22023';
  end if;
  if p_period_key is null or btrim(p_period_key) = '' then
    raise exception 'plan_allowance_invalid: period key is required' using errcode = '22023';
  end if;
  if p_amount_micro_usd is null or p_amount_micro_usd <= 0 then
    raise exception 'plan_allowance_invalid: amount must be positive' using errcode = '22023';
  end if;

  v_reference_id := 'plan_allowance:' || p_user_id || ':' || p_period_key;

  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || p_user_id));

  if exists (
    select 1 from public.managed_venice_card_ledger_entries
     where source = 'system' and reason = 'plan_allowance' and reference_id = v_reference_id
  ) then
    return jsonb_build_object('granted', false, 'status', 'already_granted');
  end if;

  insert into public.managed_venice_wallet_accounts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  select id into v_account_id from public.managed_venice_wallet_accounts where user_id = p_user_id;

  select * into v_state from public.plan_ai_allowance_state where user_id = p_user_id for update;
  v_has_state := found;

  if v_has_state and v_state.last_granted_at is not null then
    select coalesce(-sum(amount_micro_usd), 0) into v_spent
      from public.managed_venice_card_ledger_entries
     where user_id = p_user_id
       and reason = 'managed_venice_debit'
       and amount_micro_usd < 0
       and created_at >= v_state.last_granted_at;
    v_spent := greatest(v_spent, 0);
    v_remaining := greatest(v_state.remaining_micro_usd - v_spent, 0);
    v_rollover := least(v_remaining, v_state.last_amount_micro_usd);
    v_expire := v_remaining - v_rollover;
  end if;

  if v_expire > 0 then
    v_available :=
      coalesce((select sum(amount_micro_usd) from public.managed_venice_card_ledger_entries
                where user_id = p_user_id), 0)
      - coalesce((select sum(reserved_micro_usd) from public.managed_venice_reservations
                  where user_id = p_user_id and status = 'active' and wallet_type = 'card'), 0);
    v_remove := least(v_expire, greatest(v_available, 0));
    if v_remove > 0 then
      insert into public.managed_venice_card_ledger_entries
        (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id, metadata)
      values
        (v_account_id, p_user_id, -v_remove, 'system', 'plan_allowance', 'plan_allowance_expiry',
         'plan_allowance_expiry:' || p_user_id || ':' || p_period_key,
         jsonb_build_object('periodKey', p_period_key, 'unspentMicroUsd', v_remaining,
                            'rolloverMicroUsd', v_rollover, 'expiredMicroUsd', v_expire))
      on conflict (source, reference_id, reason) do nothing;
    end if;
  end if;

  insert into public.managed_venice_card_ledger_entries
    (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id, metadata)
  values
    (v_account_id, p_user_id, p_amount_micro_usd, 'system', 'plan_allowance', 'plan_allowance',
     v_reference_id, jsonb_build_object('periodKey', p_period_key, 'grantedAt', p_now,
                                        'rolloverMicroUsd', v_rollover));

  insert into public.plan_ai_allowance_state
    (user_id, remaining_micro_usd, last_amount_micro_usd, last_period_key, last_granted_at, updated_at)
  values
    (p_user_id, v_rollover + p_amount_micro_usd, p_amount_micro_usd, p_period_key, p_now, p_now)
  on conflict (user_id) do update
    set remaining_micro_usd = excluded.remaining_micro_usd,
        last_amount_micro_usd = excluded.last_amount_micro_usd,
        last_period_key = excluded.last_period_key,
        last_granted_at = excluded.last_granted_at,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'granted', true,
    'status', 'granted',
    'amountMicroUsd', p_amount_micro_usd,
    'spentSinceLastMicroUsd', v_spent,
    'rolloverMicroUsd', v_rollover,
    'expiredMicroUsd', v_expire,
    'removedMicroUsd', v_remove
  );
end;
$$;

revoke all on function public.grant_plan_ai_allowance(text, text, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.grant_plan_ai_allowance(text, text, bigint, timestamptz)
  to service_role;

comment on function public.grant_plan_ai_allowance(text, text, bigint, timestamptz) is
  'Pays one month of a plan''s AI allowance into the managed card wallet, idempotent per (user, period key). Unspent allowance beyond one month''s worth expires first. Service role only.';
