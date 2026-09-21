-- Hetzner's endpoint is change_type; its receipt command is change_server_type.
-- Do not rewrite old evidence into a provider receipt that was never observed.
do $$
begin
  if exists (
    select 1 from public.hivra_provider_resize_operations
    where provider_action is not null
      and provider_action->>'command' is distinct from 'change_server_type'
  ) then
    raise exception 'Existing resize action evidence requires explicit inspection';
  end if;
end;
$$;

create or replace function public.hivra_provider_resize_action_valid(p_action jsonb, p_server_id text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_resource jsonb;
  v_action_id numeric;
  v_server_id numeric;
begin
  if jsonb_typeof(p_action) is distinct from 'object'
    or (p_action - array['id','command','status','resources']) <> '{}'::jsonb
    or jsonb_typeof(p_action->'id') is distinct from 'number'
    or p_action->>'command' is distinct from 'change_server_type'
    or coalesce(p_action->>'status','') not in ('running','success','error')
    or jsonb_typeof(p_action->'resources') is distinct from 'array'
    or jsonb_array_length(p_action->'resources') <> 1
    or p_server_id !~ '^[1-9][0-9]{0,15}$'
  then
    return false;
  end if;
  v_resource := p_action->'resources'->0;
  if jsonb_typeof(v_resource) is distinct from 'object'
    or (v_resource - array['id','type']) <> '{}'::jsonb
    or jsonb_typeof(v_resource->'id') is distinct from 'number'
    or v_resource->>'type' is distinct from 'server'
  then
    return false;
  end if;
  begin
    v_action_id := (p_action->>'id')::numeric;
    v_server_id := (v_resource->>'id')::numeric;
  exception when others then
    return false;
  end;
  return v_action_id = trunc(v_action_id) and v_action_id between 1 and 9007199254740991
    and v_server_id = trunc(v_server_id) and v_server_id between 1 and 9007199254740991
    and v_server_id = p_server_id::numeric;
end;
$$;
