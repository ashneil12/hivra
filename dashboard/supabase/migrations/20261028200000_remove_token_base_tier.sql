-- Hosted computers are paid only: remove the 1-token Starter tier
-- (resource_tier 'token_base', "Starter (Token Holder)").
--
-- 1. The stale-state reset stops granting token_base. Body of
--    20260923203000's reconcile_stale_subscription_state_to_free with the
--    base-token snapshot branch removed: yearly token sub, then Pro/Power
--    token qualification, then credit_base. Grants re-issued.
-- 2. Computers still on token_base move to credit_base (Free). The two tiers
--    have the same spec (0.5 vCPU, 1024 MB), so no resize is pending; the
--    app no longer knows token_base at all. The tier crons apply the same
--    rule from now on, so nothing writes token_base again.
--
-- token_entitlement_configs keeps its token_base rows: they register each
-- platform token (address, decimals, minimum) for balance reads and the
-- $HIVRA activation, and grant nothing on their own any more.
-- Rerun-safe.

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
  -- non-Stripe rows: yearly token sub, Pro/Power token qualification, then
  -- Free/credit_base. Holding a token below the Pro threshold gives nothing.
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

update public.hermes_instances
set
  resource_tier = 'credit_base',
  updated_at = now()
where resource_tier = 'token_base';
