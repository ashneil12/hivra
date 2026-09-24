-- Plan agent limit, enforced in the database (migration A of two, additive).
--
-- Design: docs/superpowers/specs/2026-09-24-agent-computer-contract-and-attach.md
-- section 5.1 and threat T35. An attached agent has no hivra_agents row, so a
-- count of rows alone would let an owner at the limit add one more agent. One
-- SQL count now feeds launch, billing usage and attach, and every writer that
-- adds a Hivra-managed agent counts under one per-owner advisory lock.
--
-- Rollout: apply this migration BEFORE the code that calls these functions.
-- Migration B (20260924221000) revokes the unlocked reservations and adds the
-- writer trigger; apply it only once that code is serving on the environment.

-- The owner's agent slots, exactly as loadCurrentComputeUsage() counted them
-- (Hivra-managed hivra_agents rows and legacy hermes_instances rows that hold
-- compute, including the asymmetry that every hermes_instances product surface
-- counts), plus attachments on Hivra-managed computers that are claimed,
-- dispatched or attached. Cancelled, failed and detached attachments count
-- nothing. An attachment on My server uses the owner's own capacity and does
-- not count, matching agents on the owner's own infrastructure.
create or replace function public.hivra_owner_agent_slot_count(p_owner text)
returns integer language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select (
    (select count(*) from public.hivra_agents a
      where a.user_id=p_owner and a.deployment_mode='hivra-managed'
        and a.status in ('provisioning','running','stopped'))
    + (select count(*) from public.hermes_instances h
      where h.user_id=p_owner and h.status in ('provisioning','running','stopped')
        and h.lifecycle_state not in ('deleted','cold_archived','pending_deletion'))
    + (select count(*) from public.hivra_agent_attachments p
      join public.hivra_agents c on c.id=p.source_id and c.user_id=p.user_id
      where p.user_id=p_owner and p.phase in ('claimed','dispatched','attached')
        and c.deployment_mode='hivra-managed')
  )::integer;
$$;

-- The one key every slot writer locks before it counts. Transaction scoped.
create or replace function public.lock_hivra_owner_agent_slots(p_owner text)
returns void language sql volatile security definer set search_path=pg_catalog,pg_temp as $$
  select pg_advisory_xact_lock(hashtextextended('hivra-agent-slots-v1:' || p_owner, 0));
$$;

-- The only way to write a Hivra-managed hivra_agents row outside a launch-model
-- reservation. Columns absent from p_row keep their defaults; unknown keys are
-- refused. At or over the limit nothing is written and the result says so.
create or replace function public.insert_hivra_managed_agent(p_row jsonb, p_agent_limit integer)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_owner text;
  v_count integer;
  v_columns text;
  v_unknown integer;
  v_inserted jsonb;
begin
  if jsonb_typeof(p_row) is distinct from 'object' or octet_length(p_row::text)>65536
    or p_agent_limit is null or p_agent_limit<0 or p_agent_limit>100000
    or jsonb_typeof(p_row->'user_id') is distinct from 'string'
    or p_row->>'deployment_mode' is distinct from 'hivra-managed'
  then return jsonb_build_object('status','invalid_request'); end if;
  v_owner := p_row->>'user_id';
  if length(v_owner) not between 1 and 256 or btrim(v_owner)='' then
    return jsonb_build_object('status','invalid_request');
  end if;
  select count(*) into v_unknown from jsonb_object_keys(p_row) k
    where not exists(select 1 from pg_attribute where attrelid='public.hivra_agents'::regclass
      and attnum>0 and not attisdropped and attname=k);
  if v_unknown<>0 then return jsonb_build_object('status','invalid_request'); end if;

  perform public.lock_hivra_owner_agent_slots(v_owner);
  v_count := public.hivra_owner_agent_slot_count(v_owner);
  if v_count>=p_agent_limit then
    return jsonb_build_object('status','plan_agent_limit','activeCount',v_count,'limit',p_agent_limit);
  end if;

  select string_agg(quote_ident(k), ',' order by k) into v_columns from jsonb_object_keys(p_row) k;
  perform set_config('hivra.agent_slot_checked','on',true);
  execute format('insert into public.hivra_agents(%s) select %s from jsonb_populate_record(null::public.hivra_agents,$1) returning to_jsonb(hivra_agents.*)',
    v_columns, v_columns) into v_inserted using p_row;
  perform set_config('hivra.agent_slot_checked','off',true);
  return jsonb_build_object('status','inserted','row',v_inserted);
end;
$$;

-- The launch-model reservation under the same lock. A replay of an existing
-- request is answered by v2 without counting, because its row already counts.
create or replace function public.reserve_hivra_launch_model_request_v3(
  p_user_id text,p_request_id uuid,p_fingerprints jsonb,p_model_operation_id uuid,
  p_agent jsonb,p_selection jsonb,p_encrypted_key text,p_agent_limit integer
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_count integer;
  v_result jsonb;
begin
  if p_user_id is null or length(p_user_id) not between 1 and 256 or btrim(p_user_id)=''
    or p_agent_limit is null or p_agent_limit<0 or p_agent_limit>100000
    or jsonb_typeof(p_agent) is distinct from 'object'
  then return jsonb_build_object('status','invalid_request'); end if;
  if p_request_id is not null and exists(select 1 from public.hivra_launch_model_requests
      where user_id=p_user_id and request_id=p_request_id)
    or p_agent->>'deployment_mode' is distinct from 'hivra-managed' then
    return public.reserve_hivra_launch_model_request_v2(p_user_id,p_request_id,p_fingerprints,
      p_model_operation_id,p_agent,p_selection,p_encrypted_key);
  end if;
  perform public.lock_hivra_owner_agent_slots(p_user_id);
  -- A concurrent reservation of the same request may have won while we waited.
  if p_request_id is not null and exists(select 1 from public.hivra_launch_model_requests
      where user_id=p_user_id and request_id=p_request_id) then
    return public.reserve_hivra_launch_model_request_v2(p_user_id,p_request_id,p_fingerprints,
      p_model_operation_id,p_agent,p_selection,p_encrypted_key);
  end if;
  v_count := public.hivra_owner_agent_slot_count(p_user_id);
  if v_count>=p_agent_limit then
    return jsonb_build_object('status','plan_agent_limit','activeCount',v_count,'limit',p_agent_limit);
  end if;
  perform set_config('hivra.agent_slot_checked','on',true);
  v_result := public.reserve_hivra_launch_model_request_v2(p_user_id,p_request_id,p_fingerprints,
    p_model_operation_id,p_agent,p_selection,p_encrypted_key);
  perform set_config('hivra.agent_slot_checked','off',true);
  return v_result;
end;
$$;

revoke all on function public.hivra_owner_agent_slot_count(text),
  public.lock_hivra_owner_agent_slots(text),
  public.insert_hivra_managed_agent(jsonb,integer),
  public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.hivra_owner_agent_slot_count(text),
  public.insert_hivra_managed_agent(jsonb,integer),
  public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer)
  to service_role;

comment on function public.hivra_owner_agent_slot_count(text) is
  'Service-only plan slot count shared by launch, billing usage and attach. Counts only; takes no lock.';
comment on function public.insert_hivra_managed_agent(jsonb,integer) is
  'Service-only writer of Hivra-managed hivra_agents rows under the per-owner slot lock.';
