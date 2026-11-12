-- Starter credit: a one-time grant of Hivra credits (the managed Venice CARD
-- wallet) for a paid account. One grant per user, ever, keyed by the ledger
-- reference_id 'starter_credit:<user_id>'. The application decides who is
-- eligible (an active paid plan) and how much; this function only makes the
-- grant atomic and idempotent.
--
-- Class: additive, plus a widened check on the card ledger (reason).
-- Rerun-safe: drop constraint if exists, create or replace.

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
    'starter_credit'
  ));

create or replace function public.grant_starter_credit(
  p_user_id text,
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
  v_account_id uuid;
  v_existing_amount bigint;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'starter_credit_invalid: user id is required' using errcode = '22023';
  end if;
  if p_amount_micro_usd is null or p_amount_micro_usd <= 0 then
    raise exception 'starter_credit_invalid: amount must be positive' using errcode = '22023';
  end if;

  v_reference_id := 'starter_credit:' || p_user_id;

  -- Same lock the wallet debit path takes, so a grant and a spend serialise.
  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || p_user_id));

  select amount_micro_usd into v_existing_amount
    from public.managed_venice_card_ledger_entries
   where user_id = p_user_id
     and reason = 'starter_credit'
   limit 1;
  if found then
    return jsonb_build_object('granted', false, 'status', 'already_granted',
                              'amountMicroUsd', v_existing_amount);
  end if;

  -- Only accounts created once starter credit existed: accounts that were
  -- already paying before then are not "new" and get nothing.
  if not exists (
    select 1 from public.profiles
     where user_id = p_user_id and created_at >= timestamptz '2026-11-12 00:00:00+00'
  ) then
    return jsonb_build_object('granted', false, 'status', 'not_new_account');
  end if;

  insert into public.managed_venice_wallet_accounts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  select id into v_account_id from public.managed_venice_wallet_accounts where user_id = p_user_id;

  insert into public.managed_venice_card_ledger_entries
    (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id, metadata)
  values
    (v_account_id, p_user_id, p_amount_micro_usd, 'system', 'starter_credit', 'starter_credit',
     v_reference_id, jsonb_build_object('grantedAt', p_now))
  on conflict (source, reference_id, reason) do nothing;

  if not found then
    return jsonb_build_object('granted', false, 'status', 'already_granted',
                              'amountMicroUsd', p_amount_micro_usd);
  end if;

  return jsonb_build_object('granted', true, 'status', 'granted',
                            'amountMicroUsd', p_amount_micro_usd);
end;
$$;

revoke all on function public.grant_starter_credit(text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.grant_starter_credit(text, bigint, timestamptz) to service_role;

comment on function public.grant_starter_credit(text, bigint, timestamptz) is
  'One-time starter credit into the managed Venice card wallet. Idempotent per user (ledger reference_id starter_credit:<user_id>). Service role only.';
