-- Managed-Venice wallet debits, each in one transaction (security review 2026-09).
--
-- Until now the application debited a wallet in several PostgREST calls: read
-- the token lots, write each lot, then mark the reservation captured.
--   * Concurrent captures on the default $HermesOS wallet lost debits (the
--     MEDIUM "token-lot debit race"). #161 made each lot write a
--     compare-and-set, but a debit spanning several lots could still land in
--     part, and nothing tied a debit to the hold it paid for.
--   * A capture that failed after the debit and before the reservation was
--     marked captured left an active hold whose money had already moved.
--     Retrying it, by hand or from the stale-hold sweep, debited it again.
--
-- These functions do the whole debit in one transaction, under the per-user
-- advisory lock the reservation and card balance guards already take
-- (20260606140100, 20260923150000), with the token lots row-locked in FIFO
-- order:
--   capture_managed_venice_reservation  debits a hold's wallet and marks the
--                                        hold captured. A hold that is no
--                                        longer active is left alone and
--                                        reported, so a retry never charges
--                                        twice.
--   debit_managed_venice_wallet         a debit with no hold behind it (chat
--                                        overage, multimodal backlog).
-- Either the whole amount lands or the call raises
-- managed_venice_insufficient_balance and nothing changes.
--
-- The two indexes serve the stale-hold sweep (lib/venice/reservation-sweep.ts):
-- active holds past their expires_at, and open reconciliation items by the
-- hold they reference.
--
-- Class: additive (new functions and partial indexes). Code before this
-- migration never calls the functions, so apply it before the code that does.
-- Rerun-safe: create or replace, if not exists.

create or replace function public.managed_venice_debit_wallet_locked(
  p_user_id text,
  p_wallet_type text,
  p_amount_micro_usd bigint,
  p_reference_id text,
  p_account_id uuid,
  p_exclude_reservation_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed bigint := p_amount_micro_usd;
  v_take bigint;
  v_next bigint;
  v_lot record;
  v_available bigint;
  v_account_id uuid := p_account_id;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'managed_venice_debit_invalid: user id is required' using errcode = '22023';
  end if;
  if p_reference_id is null or btrim(p_reference_id) = '' then
    raise exception 'managed_venice_debit_invalid: reference id is required' using errcode = '22023';
  end if;
  if p_amount_micro_usd is null or p_amount_micro_usd <= 0 then
    raise exception 'managed_venice_debit_invalid: amount must be a positive number of micro-USD'
      using errcode = '22023';
  end if;

  -- Reentrant within the transaction: callers may already hold it.
  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || p_user_id));

  if p_wallet_type in ('hermesos', 'hivra') then
    -- Oldest lot first. Both platform tokens draw on the one pool of lots,
    -- as in the reservation balance guard.
    for v_lot in
      select id, remaining_value_micro_usd, remaining_token_amount_raw
        from public.managed_venice_token_lots
       where user_id = p_user_id
         and status = 'active'
         and remaining_value_micro_usd > 0
       order by created_at, id
       for update
    loop
      exit when v_owed <= 0;
      v_take := least(v_lot.remaining_value_micro_usd, v_owed);
      v_next := v_lot.remaining_value_micro_usd - v_take;
      update public.managed_venice_token_lots
         set remaining_value_micro_usd = v_next,
             -- The token amount shrinks in proportion to the value, rounded
             -- down (the same integer division the application used).
             remaining_token_amount_raw = case
               when v_next = 0 then 0
               else div(v_lot.remaining_token_amount_raw * v_next, v_lot.remaining_value_micro_usd)
             end,
             status = case when v_next = 0 then 'depleted' else 'active' end
       where id = v_lot.id;
      v_owed := v_owed - v_take;
    end loop;

    if v_owed > 0 then
      raise exception 'managed_venice_insufficient_balance: token lots short by % of %',
        v_owed, p_amount_micro_usd
        using errcode = 'P0001';
    end if;
    return;
  end if;

  if p_wallet_type is distinct from 'card' then
    raise exception 'managed_venice_debit_invalid: unknown wallet type %', p_wallet_type
      using errcode = '22023';
  end if;

  if v_account_id is null then
    select id into v_account_id
      from public.managed_venice_wallet_accounts
     where user_id = p_user_id;
  end if;

  -- Every other active card hold stays covered. A capture passes its own
  -- hold as p_exclude_reservation_id: it spends the money that hold backs.
  v_available :=
    coalesce((select sum(amount_micro_usd) from public.managed_venice_card_ledger_entries
              where user_id = p_user_id), 0)
    - coalesce((select sum(reserved_micro_usd) from public.managed_venice_reservations
                where user_id = p_user_id
                  and status = 'active'
                  and wallet_type = 'card'
                  and (p_exclude_reservation_id is null or id <> p_exclude_reservation_id)), 0);

  if v_account_id is null or v_available < p_amount_micro_usd then
    raise exception 'managed_venice_insufficient_balance: card available=% debit=%',
      v_available, p_amount_micro_usd
      using errcode = 'P0001';
  end if;

  insert into public.managed_venice_card_ledger_entries
    (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id, metadata)
  values
    (v_account_id, p_user_id, -p_amount_micro_usd, 'system', 'managed_venice_proxy',
     'managed_venice_debit', p_reference_id, '{}'::jsonb);
end;
$$;

create or replace function public.capture_managed_venice_reservation(
  p_user_id text,
  p_reference_id text,
  p_capture_micro_usd bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.managed_venice_reservations%rowtype;
  v_released bigint;
begin
  if p_capture_micro_usd is null or p_capture_micro_usd < 0 then
    raise exception 'managed_venice_capture_invalid: capture must be a non-negative number of micro-USD'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || p_user_id));

  select * into v_hold
    from public.managed_venice_reservations
   where user_id = p_user_id
     and reference_id = p_reference_id
   for update;

  if not found then
    raise exception 'managed_venice_reservation_not_found: %', p_reference_id using errcode = 'P0002';
  end if;

  -- Already captured or released: report it and move no money.
  if v_hold.status <> 'active' then
    return jsonb_build_object(
      'captured', false,
      'status', v_hold.status,
      'walletType', v_hold.wallet_type,
      'reservedMicroUsd', v_hold.reserved_micro_usd,
      'capturedMicroUsd', v_hold.captured_micro_usd,
      'releasedMicroUsd', v_hold.released_micro_usd
    );
  end if;

  if p_capture_micro_usd > v_hold.reserved_micro_usd then
    raise exception 'managed_venice_capture_exceeds_reservation: reserved=% capture=%',
      v_hold.reserved_micro_usd, p_capture_micro_usd
      using errcode = '22023';
  end if;

  if p_capture_micro_usd > 0 then
    perform public.managed_venice_debit_wallet_locked(
      p_user_id, v_hold.wallet_type, p_capture_micro_usd, p_reference_id, v_hold.account_id, v_hold.id
    );
  end if;

  v_released := v_hold.reserved_micro_usd - p_capture_micro_usd;
  update public.managed_venice_reservations
     set status = 'captured',
         captured_micro_usd = p_capture_micro_usd,
         released_micro_usd = v_released,
         captured_at = now(),
         released_at = case when v_released > 0 then now() else null end
   where id = v_hold.id;

  return jsonb_build_object(
    'captured', true,
    'status', 'captured',
    'walletType', v_hold.wallet_type,
    'reservedMicroUsd', v_hold.reserved_micro_usd,
    'capturedMicroUsd', p_capture_micro_usd,
    'releasedMicroUsd', v_released
  );
end;
$$;

create or replace function public.debit_managed_venice_wallet(
  p_user_id text,
  p_wallet_type text,
  p_amount_micro_usd bigint,
  p_reference_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.managed_venice_debit_wallet_locked(
    p_user_id, p_wallet_type, p_amount_micro_usd, p_reference_id, null, null
  );
  return jsonb_build_object(
    'debited', true,
    'walletType', p_wallet_type,
    'amountMicroUsd', p_amount_micro_usd
  );
end;
$$;

revoke all on function public.managed_venice_debit_wallet_locked(text, text, bigint, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.managed_venice_debit_wallet_locked(text, text, bigint, text, uuid, uuid)
  to service_role;
comment on function public.managed_venice_debit_wallet_locked(text, text, bigint, text, uuid, uuid) is
  'Debits one managed-Venice wallet (token lots FIFO, or the card ledger) under the per-user wallet lock. Raises managed_venice_insufficient_balance and changes nothing when the wallet cannot cover it. Service role only.';

revoke all on function public.capture_managed_venice_reservation(text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.capture_managed_venice_reservation(text, text, bigint)
  to service_role;
comment on function public.capture_managed_venice_reservation(text, text, bigint) is
  'Debits an active managed-Venice hold''s wallet and marks the hold captured, in one transaction. A hold that is no longer active is reported with captured=false and no money moves. Service role only.';

revoke all on function public.debit_managed_venice_wallet(text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.debit_managed_venice_wallet(text, text, bigint, text)
  to service_role;
comment on function public.debit_managed_venice_wallet(text, text, bigint, text) is
  'Debits a managed-Venice wallet with no hold behind it (chat overage, multimodal backlog), in one transaction. Service role only.';

create index if not exists managed_venice_reservations_active_expiry_idx
  on public.managed_venice_reservations (expires_at)
  where status = 'active' and expires_at is not null;

create index if not exists managed_venice_reconciliation_items_open_reference_idx
  on public.managed_venice_reconciliation_items ((metadata->>'referenceId'))
  where status = 'open';
