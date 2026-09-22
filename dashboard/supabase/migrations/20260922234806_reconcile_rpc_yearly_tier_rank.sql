-- Fix: resolve the yearly $HermesOS tier by tier rank (Power > Pro), not by
-- the newest paid_at, and restrict EXECUTE to service_role.
--
-- Background. reconcile_stale_subscription_state_to_free (migrations
-- 20260603010000, 20260710130000) derives a reset row's fallback entitlement,
-- starting with the live yearly_token_subscriptions row. It picked that row by
--   order by paid_at desc limit 1
-- A user can hold one live ('active'/'grace') row per tier, so with both a Pro
-- and a Power year running the NEWEST payment won, not the larger tier. Since
-- settle_yearly_token_payment (20260922222737) renews by marking the live
-- same-tier row 'renewed' and inserting a new row with paid_at = the renewal,
-- renewing Pro while Power is still paid made Pro the newest row, and this
-- function reset the user's instances to the operator tier. Buying Pro for the
-- first time while Power was live had the same effect.
--
-- The yearly row is now chosen by tier rank, then the later expires_at, then
-- the later paid_at: the same order resolveEffectiveSubscription uses in
-- dashboard/src/lib/billing/instance-entitlement.ts. Keep the two in step.
--
-- Grants. The earlier migrations revoked EXECUTE from PUBLIC only. Supabase's
-- default privileges grant EXECUTE on new public functions to anon and
-- authenticated explicitly, so both API roles could still call this SECURITY
-- DEFINER function (confirmed on canary 2026-09-23). Its only caller is the
-- service-role reconcile cron, so the revoke now names those roles too.
--
-- create or replace keeps existing grants; the revoke/grant/comment below are
-- re-issued so the definition is self-contained on any DB it lands on.

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
      ) then 'power'
      when exists (
        select 1
        from public.token_tier_qualifications
        where user_id = p_user_id
          and tier = 'pro'
          and currently_eligible = true
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
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz
) from public, anon, authenticated;

grant execute on function public.reconcile_stale_subscription_state_to_free(
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz
) to service_role;

comment on function public.reconcile_stale_subscription_state_to_free(
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz
) is
  'CAS-reset stale paid subscription rows to Free and atomically align instance DB caps to token/yearly/free entitlement. Yearly tier resolved by rank (power > pro), then latest expiry. Base tier resolved by token identity (chain_id + token_address), not display symbol.';
