-- Keep the original resources from the create response, separately from
-- mutable inventory. Legacy orders remain NULL; a later GET is not proof of
-- which independently billable Primary IPs the original POST created.
create or replace function public.is_valid_hetzner_creation_receipt(p_receipt jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = public, pg_temp
as $$
declare
  v_action jsonb;
  v_resource jsonb;
  v_action_ids text[] := '{}';
  v_resource_ids text[];
  v_main boolean := true;
  v_id text;
begin
  if jsonb_typeof(p_receipt) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_receipt)) <> 6
     or p_receipt->'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_receipt->'serverId') is distinct from 'string'
     or jsonb_typeof(p_receipt->'primaryIpv4') is distinct from 'object'
     or jsonb_typeof(p_receipt->'primaryIpv6') is distinct from 'object'
     or jsonb_typeof(p_receipt->'action') is distinct from 'object'
     or jsonb_typeof(p_receipt->'nextActions') is distinct from 'array'
     or jsonb_array_length(p_receipt->'nextActions') > 10 then
    return false;
  end if;
  foreach v_id in array array[
    p_receipt->>'serverId',
    p_receipt#>>'{primaryIpv4,id}',
    p_receipt#>>'{primaryIpv6,id}'
  ] loop
    if v_id is null or v_id !~ '^[1-9][0-9]{0,15}$'
       or v_id::numeric > 9007199254740991 then return false; end if;
  end loop;
  if p_receipt#>>'{primaryIpv4,id}' = p_receipt#>>'{primaryIpv6,id}' then
    return false;
  end if;
  for v_resource in select value from jsonb_array_elements(jsonb_build_array(
    p_receipt->'primaryIpv4', p_receipt->'primaryIpv6'
  )) loop
    if (select count(*) from jsonb_object_keys(v_resource)) <> 2
       or jsonb_typeof(v_resource->'id') is distinct from 'string'
       or jsonb_typeof(v_resource->'ip') is distinct from 'string' then
      return false;
    end if;
  end loop;
  if length(p_receipt#>>'{primaryIpv4,ip}') > 15
     or p_receipt#>>'{primaryIpv4,ip}' !~ '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$'
     or family((p_receipt#>>'{primaryIpv4,ip}')::inet) <> 4
     or length(p_receipt#>>'{primaryIpv6,ip}') > 43
     or p_receipt#>>'{primaryIpv6,ip}' !~ '/64$'
     or family((p_receipt#>>'{primaryIpv6,ip}')::inet) <> 6
     or masklen((p_receipt#>>'{primaryIpv6,ip}')::inet) <> 64 then
    return false;
  end if;
  for v_action in select value from jsonb_array_elements(
    jsonb_build_array(p_receipt->'action') || (p_receipt->'nextActions')
  ) loop
    if jsonb_typeof(v_action) is distinct from 'object'
       or (select count(*) from jsonb_object_keys(v_action)) <> 4
       or jsonb_typeof(v_action->'id') is distinct from 'string'
       or jsonb_typeof(v_action->'command') is distinct from 'string'
       or jsonb_typeof(v_action->'status') is distinct from 'string'
       or v_action->>'id' !~ '^[1-9][0-9]{0,15}$'
       or (v_action->>'id')::numeric > 9007199254740991
       or v_action->>'command' !~ '^[a-z][a-z0-9_]{0,63}$'
       or v_action->>'status' not in ('running', 'success', 'error')
       or v_action->>'id' = any(v_action_ids)
       or jsonb_typeof(v_action->'resources') is distinct from 'array'
       or jsonb_array_length(v_action->'resources') not between 1 and 2 then
      return false;
    end if;
    v_action_ids := array_append(v_action_ids, v_action->>'id');
    if v_main and (
      v_action->>'command' <> 'create_server'
      or jsonb_array_length(v_action->'resources') <> 1
    ) then return false; end if;
    if not v_main and v_action->>'command' in ('poweron', 'start_resource') then
      return false;
    end if;
    v_resource_ids := '{}';
    for v_resource in select value from jsonb_array_elements(v_action->'resources') loop
      if jsonb_typeof(v_resource) is distinct from 'object'
         or (select count(*) from jsonb_object_keys(v_resource)) <> 2
         or jsonb_typeof(v_resource->'id') is distinct from 'string'
         or jsonb_typeof(v_resource->'type') is distinct from 'string'
         or v_resource->>'id' = any(v_resource_ids)
         or (v_main and (
           v_resource->>'type' <> 'server'
           or v_resource->>'id' <> p_receipt->>'serverId'
         ))
         or (not v_main and (
           v_resource->>'type' <> 'primary_ip'
           or v_resource->>'id' not in (
             p_receipt#>>'{primaryIpv4,id}', p_receipt#>>'{primaryIpv6,id}'
           )
         )) then return false; end if;
      v_resource_ids := array_append(v_resource_ids, v_resource->>'id');
    end loop;
    v_main := false;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

alter table public.infrastructure_capacity_orders
  add column provider_creation_receipt jsonb,
  add constraint infrastructure_capacity_orders_creation_receipt_check check (
    provider_creation_receipt is null or (
      public.is_valid_hetzner_creation_receipt(provider_creation_receipt) is true
      and (provider_creation_receipt->>'serverId' = provider_resource_id) is true
      and (provider_creation_receipt#>>'{action,id}' = provider_action_id) is true
      and (provider_action_command = 'create_server') is true
    )
  );

create or replace function public.guard_hetzner_creation_receipt()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.provider_creation_receipt is not null
     and new.provider_creation_receipt is distinct from old.provider_creation_receipt then
    raise exception 'Original provider resource receipt is immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger infrastructure_capacity_orders_immutable_creation_receipt
  before update on public.infrastructure_capacity_orders
  for each row execute function public.guard_hetzner_creation_receipt();

-- Initial receipt + progress commit atomically. This uses the existing strict
-- monotonic action gate and shares the connection -> order lock ordering with
-- claim/disconnect. It cannot attach evidence to an old completed order or to
-- a rotated/detached provider credential. Replays must have the exact receipt.
create or replace function public.record_hetzner_cloud_capacity_creation_progress(
  p_user_id text,
  p_connection_id uuid,
  p_order_id uuid,
  p_idempotency_key uuid,
  p_provider_resource_id text,
  p_provider_action_id text,
  p_provider_action_command text,
  p_provider_action_status text,
  p_provider_next_actions jsonb,
  p_provider_observed_at timestamptz,
  p_observed_server_status text,
  p_expected_revision bigint,
  p_creation_receipt jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order public.infrastructure_capacity_orders%rowtype;
  v_progress jsonb;
  v_next_actions jsonb;
begin
  if public.is_valid_hetzner_creation_receipt(p_creation_receipt) is not true
     or (p_creation_receipt->>'serverId') is distinct from p_provider_resource_id
     or (p_creation_receipt#>>'{action,id}') is distinct from p_provider_action_id
     or (p_creation_receipt#>>'{action,command}') is distinct from p_provider_action_command
     or (p_creation_receipt#>>'{action,status}') is distinct from p_provider_action_status then
    raise exception 'Invalid original provider receipt' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(action.value - 'resources' order by action.ordinality), '[]'::jsonb)
    into v_next_actions
  from jsonb_array_elements(p_creation_receipt->'nextActions') with ordinality as action(value, ordinality);
  if v_next_actions is distinct from p_provider_next_actions then
    raise exception 'Original action receipt mismatch' using errcode = '22023';
  end if;

  perform id from public.infrastructure_connections
  where id = p_connection_id and user_id = p_user_id
    and provider = 'hetzner-cloud' and status = 'ready'
    and revision = p_expected_revision
  for update;
  if not found then return null; end if;

  select * into v_order from public.infrastructure_capacity_orders
  where id = p_order_id and user_id = p_user_id
    and connection_id = p_connection_id and active_connection_id = p_connection_id
    and connection_revision = p_expected_revision and provider = 'hetzner-cloud'
    and idempotency_key = p_idempotency_key and status in ('creating', 'ambiguous')
  for update;
  if not found then return null; end if;
  if v_order.provider_creation_receipt is not null
     and v_order.provider_creation_receipt is distinct from p_creation_receipt then
    raise exception 'Original provider resource receipt changed' using errcode = '22023';
  end if;
  -- Receipt-less progress from an older process or a reconciliation is never
  -- promoted into evidence of the initial POST's resource set.
  if v_order.provider_creation_receipt is null
     and (v_order.provider_resource_id is not null or v_order.provider_action_id is not null) then
    return null;
  end if;
  v_progress := public.record_hetzner_cloud_capacity_order_progress(
    p_user_id, p_connection_id, p_order_id, p_idempotency_key,
    p_provider_resource_id, p_provider_action_id, p_provider_action_command,
    p_provider_action_status, p_provider_next_actions,
    p_provider_observed_at, p_observed_server_status
  );
  if v_progress is null then return null; end if;
  update public.infrastructure_capacity_orders
  set provider_creation_receipt = p_creation_receipt
  where id = p_order_id
  returning * into v_order;
  return to_jsonb(v_order);
end;
$$;

revoke all on function public.is_valid_hetzner_creation_receipt(jsonb)
  from public, anon, authenticated;
revoke all on function public.guard_hetzner_creation_receipt()
  from public, anon, authenticated;
revoke all on function public.record_hetzner_cloud_capacity_creation_progress(
  text, uuid, uuid, uuid, text, text, text, text, jsonb, timestamptz, text, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.is_valid_hetzner_creation_receipt(jsonb) to service_role;
grant execute on function public.guard_hetzner_creation_receipt() to service_role;
grant execute on function public.record_hetzner_cloud_capacity_creation_progress(
  text, uuid, uuid, uuid, text, text, text, text, jsonb, timestamptz, text, bigint, jsonb
) to service_role;
