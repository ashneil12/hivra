-- Per-computer resource envelopes. Existing rows remain pinned by backfilling
-- their historical allocation as both guarantee and maximum.
alter table public.hivra_agents
  add column if not exists cpu_max numeric,
  add column if not exists ram_max integer;

update public.hivra_agents
set cpu_max = cpu,
    ram_max = ram
where cpu_max is null or ram_max is null;

alter table public.hivra_agents
  drop constraint if exists hivra_agents_cpu_max_valid,
  drop constraint if exists hivra_agents_ram_max_valid;

alter table public.hivra_agents
  add constraint hivra_agents_cpu_max_valid
    check (cpu_max is null or (cpu_max::text not in ('NaN', 'Infinity', '-Infinity') and cpu_max > 0 and cpu_max >= cpu)),
  add constraint hivra_agents_ram_max_valid
    check (ram_max is null or (ram_max > 0 and ram_max >= ram));

-- Resize completion is one exact-operation CAS. CPU/RAM guarantees and their
-- maxima either advance together or remain wholly uncommitted.
create or replace function public.continue_hivra_agent_resize_operation(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_expected_desired_state text,
  p_status text,
  p_cpu numeric,
  p_ram integer,
  p_cpu_max numeric,
  p_ram_max integer
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_updated boolean := false;
begin
  if p_cpu is null or p_ram is null or p_cpu_max is null or p_ram_max is null
    or p_cpu <= 0 or p_ram <= 0 or p_cpu_max < p_cpu or p_ram_max < p_ram
    or p_cpu_max::text in ('NaN', 'Infinity', '-Infinity') then
    return false;
  end if;
  update public.hivra_agents
  set status = p_status,
      cpu = p_cpu,
      ram = p_ram,
      cpu_max = p_cpu_max,
      ram_max = p_ram_max,
      error = null
  where id = p_agent_id and user_id = p_user_id
    and operation_id = p_operation_id and operation_kind = 'resize'
    and desired_state = p_expected_desired_state
    and (operation_payload ->> 'cpu')::numeric = p_cpu
    and (operation_payload ->> 'ram')::integer = p_ram
    and coalesce(operation_payload ->> 'maximumCpu', operation_payload ->> 'cpu')::numeric = p_cpu_max
    and coalesce(operation_payload ->> 'maximumRam', operation_payload ->> 'ram')::integer = p_ram_max
    and status <> 'deleted';
  v_updated := found;
  return v_updated;
end;
$$;

revoke all on function public.continue_hivra_agent_resize_operation(text,uuid,uuid,text,text,numeric,integer,numeric,integer)
  from public,anon,authenticated;
grant execute on function public.continue_hivra_agent_resize_operation(text,uuid,uuid,text,text,numeric,integer,numeric,integer)
  to service_role;

-- Keep the reviewed launch-model reservation RPC intact and wrap it in the
-- same transaction with the two additive envelope columns. The HMAC digest
-- already covers the unstripped intent, so changed maxima replay as conflict.
create or replace function public.reserve_hivra_launch_model_request_v2(
  p_user_id text,p_request_id uuid,p_fingerprints jsonb,p_model_operation_id uuid,
  p_agent jsonb,p_selection jsonb,p_encrypted_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_result jsonb;
  v_cpu numeric;
  v_ram integer;
  v_cpu_max numeric;
  v_ram_max integer;
  v_agent_id uuid;
begin
  if jsonb_typeof(p_agent) is distinct from 'object' then
    return jsonb_build_object('status','invalid_request');
  end if;
  begin
    v_cpu := (p_agent->>'cpu')::numeric;
    v_ram := (p_agent->>'ram')::integer;
    v_cpu_max := coalesce((p_agent->>'cpu_max')::numeric, v_cpu);
    v_ram_max := coalesce((p_agent->>'ram_max')::integer, v_ram);
  exception when others then
    return jsonb_build_object('status','invalid_request');
  end;
  if v_cpu_max::text in ('NaN','Infinity','-Infinity')
    or v_cpu_max < v_cpu or v_ram_max < v_ram then
    return jsonb_build_object('status','invalid_request');
  end if;
  v_result := public.reserve_hivra_launch_model_request(
    p_user_id,p_request_id,p_fingerprints,p_model_operation_id,
    p_agent - 'cpu_max' - 'ram_max',p_selection,p_encrypted_key
  );
  if v_result->>'status' = 'reserved' then
    v_agent_id := (v_result->>'agentId')::uuid;
    update public.hivra_agents
      set cpu_max=v_cpu_max, ram_max=v_ram_max
      where id=v_agent_id and user_id=p_user_id and cpu=v_cpu and ram=v_ram;
    if not found then raise exception 'resource envelope reservation was not persisted'; end if;
  end if;
  return v_result;
end;
$$;

revoke all on function public.reserve_hivra_launch_model_request_v2(text,uuid,jsonb,uuid,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.reserve_hivra_launch_model_request_v2(text,uuid,jsonb,uuid,jsonb,jsonb,text)
  to service_role;
