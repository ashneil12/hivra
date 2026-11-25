-- The caller proves the current Base balance server-side. Recheck the exact
-- account, wallet selection, and earned thresholds before starting the clock.
create or replace function public.switch_grandfathered_holder(
  p_user_id text, p_expected_tiers jsonb, p_wallet_id uuid, p_proof jsonb,
  p_now timestamptz, p_grace_ends_at timestamptz, p_hivra_address text, p_hermesos_address text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  member public.token_grandfather_cohort%rowtype;
  tier_row public.token_tier_qualifications%rowtype;
  wallet public.user_wallets%rowtype;
  earned jsonb := '{}';
  minimum numeric := 0;
  observed numeric;
begin
  select * into member from public.token_grandfather_cohort
    where user_id = p_user_id for update;
  if not found then return jsonb_build_object('status','not_grandfathered'); end if;
  if member.converted_at is not null then return jsonb_build_object('status','already_converted'); end if;
  if p_now is null or p_grace_ends_at is distinct from p_now + interval '72 hours'
    or p_hermesos_address is distinct from '0x95ccfd2b81a9667b0cc979992632f98fc853eba3'
    or not exists (select from public.platform_token_activations where token_key = 'hivra'
      and chain_id = 8453 and token_address = p_hivra_address and activated_at <= p_now)
    then raise exception 'Platform token activation mismatch'; end if;

  for tier_row in select * from public.token_tier_qualifications
    where user_id = p_user_id order by tier for update loop
    if tier_row.token_key = 'hermesos' and not tier_row.currently_eligible and tier_row.last_suspend_at is not null then
      continue;
    end if;
    if tier_row.token_key <> 'hermesos' or tier_row.tier not in ('pro','power')
      or not tier_row.currently_eligible or tier_row.last_breach_at is not null
      or tier_row.last_suspend_at is not null
      or tier_row.qualifying_threshold_tier not in (upper(tier_row.tier) || '_LAUNCH', upper(tier_row.tier) || '_STANDARD') then
      return jsonb_build_object('status','tier_changed');
    end if;
    minimum := greatest(minimum, tier_row.qualifying_quantity);
    earned := earned || jsonb_build_object(tier_row.tier, jsonb_build_object(
      'amount',tier_row.qualifying_quantity::text,'code',tier_row.qualifying_threshold_tier));
  end loop;
  if earned is distinct from p_expected_tiers then return jsonb_build_object('status','tier_changed'); end if;
  if minimum > 0 then
    -- Stabilize existing wallet roles before selecting a winner. A concurrent
    -- primary demotion can preserve verified_at; a fresh SELECT after acquiring
    -- the locks sees the new primary rather than the pre-wait candidate.
    perform id from public.user_wallets where user_id = p_user_id and chain_type = 'evm'
      order by id for share;
    -- Same priority as getTokenVerificationWallet: the most recently verified
    -- funded legacy lock, otherwise the latest verified EVM primary.
    with latest_lock as (
      select * from public.user_wallets where user_id = p_user_id and chain_type = 'evm'
        and verified_at is not null and verification_method = 'bankr'
        and metadata #>> '{bankr,purpose}' = 'hermesos_lock' order by verified_at desc limit 1
    ), candidates as (
      select w.id, 0 as priority from latest_lock w where (
        select s.balance_raw from public.token_holding_snapshots s where s.user_id = p_user_id
        and s.chain_id = 8453 and s.token_address = p_hermesos_address
        and s.normalized_wallet_address = w.normalized_address order by checked_at desc limit 1
      ) > 0
      union all
      (select id, 1 from public.user_wallets where user_id = p_user_id and chain_type = 'evm'
        and is_primary and verified_at is not null order by verified_at desc limit 1)
    )
    select w.* into wallet from public.user_wallets w where w.id = (
      select id from candidates order by priority limit 1
    );
    if wallet.id is null or wallet.id is distinct from p_wallet_id or wallet.verified_at is null
      or wallet.normalized_address is distinct from (p_proof ->> 'address')
      or not (coalesce(wallet.verification_method in ('signature','admin'),false)
        or coalesce(wallet.verification_method = 'bankr' and wallet.metadata #>> '{bankr,purpose}' = 'hermesos_lock',false))
      then return jsonb_build_object('status','wallet_changed'); end if;
    observed := (p_proof ->> 'balanceRaw')::numeric;
    if observed is null or observed < minimum then return jsonb_build_object('status','insufficient_hivra'); end if;
    -- Persist the observed balance with the same account and token identity.
    insert into public.token_holding_snapshots (user_id,wallet_id,wallet_address,normalized_wallet_address,
      chain_id,token_address,token_symbol,token_decimals,balance_raw,balance_display,qualifies_base_tier,block_number,source)
    values (p_user_id,wallet.id,wallet.address,wallet.normalized_address,8453,p_hivra_address,
      'HIVRA',18,observed,p_proof->>'balanceDisplay',observed >= 1000000000000000000,
      (p_proof->>'blockNumber')::bigint,'base_rpc');
  end if;
  update public.token_tier_qualifications set token_key = 'hivra',
    metadata = coalesce(metadata,'{}') || jsonb_build_object('holder_carryover',jsonb_build_object(
      'qualifiedAt',qualified_at,'amount',qualifying_quantity::text))
    where user_id = p_user_id and earned ? tier;
  update public.token_grandfather_cohort set converted_at = p_now, conversion_grace_ends_at = p_grace_ends_at,
    metadata = coalesce(metadata,'{}') || jsonb_build_object('conversion',jsonb_build_object(
      'source','earned_holder_1_to_1','convertedAt',p_now,'graceHours',72,'hivraThresholds',earned))
    where user_id = p_user_id returning * into member;
  return jsonb_build_object('status','converted','cohort',to_jsonb(member));
end $$;

revoke all on function public.switch_grandfathered_holder(text,jsonb,uuid,jsonb,timestamptz,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.switch_grandfathered_holder(text,jsonb,uuid,jsonb,timestamptz,timestamptz,text,text) to service_role;

-- An evaluator may have read the pre-switch account immediately before this
-- transaction. Serialize first qualifications (and suspended-row revivals)
-- against the same cohort row so an outdated decision cannot add a legacy tier.
create or replace function public.fence_switched_holder_qualification()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  account public.token_grandfather_cohort%rowtype;
begin
  select * into account from public.token_grandfather_cohort where user_id = new.user_id for share;
  if account.converted_at is not null and account.metadata #>> '{conversion,source}' = 'earned_holder_1_to_1' then
    raise exception 'Holder switched during evaluation; reload token access' using errcode = '40001';
  end if;
  return new;
end $$;

create or replace trigger fence_switched_holder_qualification before insert or update of currently_eligible, qualifying_quantity
on public.token_tier_qualifications for each row
when (new.token_key = 'hermesos' and new.currently_eligible)
execute function public.fence_switched_holder_qualification();
