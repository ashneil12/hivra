-- Capacity policy is provider authority, but unlike endpoint or credential
-- identity it may be revised while computers remain bound. The new revision
-- becomes launch authority only after the same target is inspected again.

create or replace function public.update_infrastructure_capacity_policy(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_capacity_policy jsonb
)
returns setof public.infrastructure_connections
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_has_bindings boolean := false;
  v_cpu_density numeric;
  v_memory_density numeric;
  v_memory_reserve numeric;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;
  if not found then return; end if;

  if v_connection.provider not in ('host', 'proxmox') then
    raise exception 'capacity policy is only supported for SSH infrastructure'
      using errcode = '22023';
  end if;
  if v_connection.preflight_run_id is not null then
    raise exception 'infrastructure connection has an active preparation or preflight lease'
      using errcode = '55006';
  end if;
  if v_connection.pending_binding_rebind_from_revision is not null then
    raise exception 'infrastructure connection requires inspection before another capacity policy revision'
      using errcode = '55006';
  end if;
  if exists (
    select 1
    from public.infrastructure_host_discovery_runs discovery_run
    where discovery_run.connection_id = p_connection_id
      and discovery_run.user_id = p_user_id
      and discovery_run.lease_expires_at > now()
  ) then
    raise exception 'infrastructure connection has an active discovery lease'
      using errcode = '55006';
  end if;
  if exists (
    select 1
    from public.hivra_agents agent
    where agent.infrastructure_connection_id = p_connection_id
      and agent.user_id = p_user_id
      and agent.status <> 'deleted'
      and agent.operation_id is not null
  ) then
    raise exception 'infrastructure connection has an active Hivra operation'
      using errcode = '55006';
  end if;

  if p_capacity_policy is not null then
    if jsonb_typeof(p_capacity_policy) <> 'object'
      or not (p_capacity_policy ?& array[
        'mode',
        'hostMemoryReserveMb',
        'cpuCeilingDensity',
        'memoryCeilingDensity'
      ])
      or (p_capacity_policy - array[
        'mode',
        'hostMemoryReserveMb',
        'cpuCeilingDensity',
        'memoryCeilingDensity'
      ]::text[]) <> '{}'::jsonb
      or p_capacity_policy ->> 'mode' not in ('observe', 'enforce')
      or jsonb_typeof(p_capacity_policy -> 'hostMemoryReserveMb') <> 'number'
      or jsonb_typeof(p_capacity_policy -> 'cpuCeilingDensity') <> 'number'
      or jsonb_typeof(p_capacity_policy -> 'memoryCeilingDensity') <> 'number'
    then
      raise exception 'invalid infrastructure capacity policy' using errcode = '22023';
    end if;

    v_memory_reserve := (p_capacity_policy ->> 'hostMemoryReserveMb')::numeric;
    v_cpu_density := (p_capacity_policy ->> 'cpuCeilingDensity')::numeric;
    v_memory_density := (p_capacity_policy ->> 'memoryCeilingDensity')::numeric;
    if v_memory_reserve <> trunc(v_memory_reserve)
      or v_memory_reserve < 512
      or v_memory_reserve > 1048576
      or v_cpu_density < 1
      or v_cpu_density > 4
      or v_cpu_density * 4 <> trunc(v_cpu_density * 4)
      or v_memory_density < 1
      or v_memory_density > 4
      or v_memory_density * 4 <> trunc(v_memory_density * 4)
    then
      raise exception 'invalid infrastructure capacity policy' using errcode = '22023';
    end if;
  end if;

  select exists (
    select 1
    from public.hivra_agents agent
    where agent.infrastructure_connection_id = p_connection_id
      and agent.user_id = p_user_id
      and agent.deployment_mode = 'self-managed'
      and agent.status <> 'deleted'
  ) into v_has_bindings;

  update public.infrastructure_connections
  set config = case
        when p_capacity_policy is null then coalesce(config, '{}'::jsonb) - 'capacityPolicy'
        else jsonb_set(
          coalesce(config, '{}'::jsonb),
          '{capacityPolicy}',
          p_capacity_policy,
          true
        )
      end,
      revision = revision + 1,
      status = 'pending',
      preflight_run_id = null,
      preflight_lease_expires_at = null,
      last_checked_at = null,
      last_error_code = null,
      pending_binding_rebind_from_revision = case
        when v_has_bindings
          then coalesce(pending_binding_rebind_from_revision, p_expected_revision)
        else null
      end
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  returning * into v_connection;

  update public.deployment_targets
  set status = 'unavailable',
      capabilities = jsonb_set(
        coalesce(capabilities, '{}'::jsonb),
        '{launchReady}',
        'false'::jsonb,
        true
      ),
      supported_isolation_drivers = '{}'::text[],
      isolation_class = null,
      last_error_code = 'PREFLIGHT_SUPERSEDED'
  where connection_id = p_connection_id
    and user_id = p_user_id;

  return next v_connection;
end;
$$;

revoke all on function public.update_infrastructure_capacity_policy(
  text, uuid, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.update_infrastructure_capacity_policy(
  text, uuid, bigint, jsonb
) to service_role;

comment on function public.update_infrastructure_capacity_policy(text, uuid, bigint, jsonb) is
  'Revises only capacityPolicy, revokes launch readiness, and preserves bound computers for same-target inspection and revision rebind.';
