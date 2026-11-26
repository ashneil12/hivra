create schema managed_launch_bridge_private;
revoke all on schema managed_launch_bridge_private from public, anon, authenticated, service_role;

create table managed_launch_bridge_private.contract (
  singleton boolean primary key check (singleton),
  epoch text not null check (epoch in ('legacy', 'funding', 'placement'))
);
revoke all on managed_launch_bridge_private.contract from public, anon, authenticated, service_role;

create function managed_launch_bridge_private.schema_epoch()
returns text language sql stable set search_path=pg_catalog,pg_temp as $$
  with canonical as (
    select p.*, l.lanname
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    join pg_language l on l.oid=p.prolang
    where n.nspname='public'
      and p.proname in ('insert_hivra_managed_agent','reserve_hivra_launch_model_request_v3')
  ), expected(epoch,signature,arguments,body_md5,defaults) as (
    values
      ('legacy','public.insert_hivra_managed_agent(jsonb,integer)',
        'p_row,p_agent_limit','ac54f6f6b3e20689c4af0cd1d3974594',0),
      ('legacy','public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer)',
        'p_user_id,p_request_id,p_fingerprints,p_model_operation_id,p_agent,p_selection,p_encrypted_key,p_agent_limit',
        '603b8192d46d2b9e51166c6e2fd0507d',0),
      ('funding','public.insert_hivra_managed_agent(jsonb,integer)',
        'p_row,p_agent_limit','08d3275cc88f7f4a88901cb134404461',0),
      ('funding','public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer)',
        'p_user_id,p_request_id,p_fingerprints,p_model_operation_id,p_agent,p_selection,p_encrypted_key,p_agent_limit',
        'c0eaf1d56738b41a2b3ece36fcc53562',0),
      ('placement','public.insert_hivra_managed_agent(jsonb,integer,numeric,boolean)',
        'p_row,p_agent_limit,p_cpu_overcommit_ratio,p_skip_sleep','16dffe4eeff105a805b89a601214e2de',2),
      ('placement','public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer,numeric,boolean)',
        'p_user_id,p_request_id,p_fingerprints,p_model_operation_id,p_agent,p_selection,p_encrypted_key,p_agent_limit,p_cpu_overcommit_ratio,p_skip_sleep',
        '2033e5e4320b10c6355fb9c123123690',2)
  ), matched as (
    select e.epoch
    from expected e
    join canonical p on p.oid=to_regprocedure(e.signature)
    where (select count(*) from canonical)=2
      and md5(p.prosrc)=e.body_md5
      and array_to_string(p.proargnames,',')=e.arguments
      and p.pronargdefaults=e.defaults
      and (e.defaults=0 or pg_get_expr(p.proargdefaults,0)='NULL::numeric, false')
      and p.pronargs=cardinality(p.proargnames)
      and p.proargmodes is null and p.provariadic=0
      and p.lanname='plpgsql' and p.prokind='f' and p.provolatile='v'
      and p.prorettype='jsonb'::regtype and not p.proretset and not p.proisstrict
      and p.prosecdef and p.proconfig=array['search_path=pg_catalog, pg_temp']
      and has_function_privilege('service_role',p.oid,'execute')
      and not has_function_privilege('anon',p.oid,'execute')
      and not has_function_privilege('authenticated',p.oid,'execute')
      and not exists (
        select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee<>p.proowner
          and (a.grantee<>'service_role'::regrole or a.is_grantable)
      )
    group by e.epoch having count(*)=2
  ), dependencies as (
    select
      to_regclass('public.holder_admissions') is not null as holder_table,
      to_regprocedure('public.holder_seat_funding_valid(text,numeric,numeric,uuid,uuid,numeric,numeric)') as holder_check,
      to_regprocedure('public.assert_proxmox_placement_capacity(text,text,text,numeric,numeric,numeric,uuid,uuid,numeric,boolean,boolean,boolean)') as placement_check,
      (select count(*) from pg_attribute
       where attrelid in ('public.hivra_agents'::regclass,'public.hermes_instances'::regclass)
         and attname='seat_funding' and attnum>0 and not attisdropped) as funding_columns,
      (select count(*) from pg_attribute
       where attrelid in ('public.hivra_agents'::regclass,'public.hermes_instances'::regclass)
         and attname='seat_funding' and attnum>0 and not attisdropped
         and atttypid='text'::regtype and not attnotnull) as nullable_funding_columns,
      (select count(*) from pg_trigger
       where (tgrelid='public.hivra_agents'::regclass and tgname='hivra_agents_enforce_seat_funding')
          or (tgrelid='public.hermes_instances'::regclass and tgname='hermes_instances_enforce_seat_funding')) as funding_triggers,
      (select count(*) from pg_trigger
       where tgenabled='O' and not tgisinternal and tgtype=23 and tgnargs=0 and tgqual is null and (
         (tgrelid='public.hivra_agents'::regclass and tgname='hivra_agents_enforce_seat_funding'
           and tgfoid=to_regprocedure('public.enforce_hivra_agent_seat_funding()')
           and (select md5(p.prosrc) from pg_proc p where p.oid=tgfoid)='6e6928576efa002c65008607ae7e5eed')
         or (tgrelid='public.hermes_instances'::regclass and tgname='hermes_instances_enforce_seat_funding'
           and tgfoid=to_regprocedure('public.enforce_hermes_instance_seat_funding()'))
       )) as active_funding_triggers
  )
  select m.epoch from matched m cross join dependencies d
  where (select md5(p.prosrc) from pg_proc p
    where p.oid=to_regprocedure('public.reserve_hivra_launch_model_request(text,uuid,jsonb,uuid,jsonb,jsonb,text)'))='8a6b1c8a2e5bcab2c56639853855af24'
    and (select md5(p.prosrc) from pg_proc p
      where p.oid=to_regprocedure('public.reserve_hivra_launch_model_request_v2(text,uuid,jsonb,uuid,jsonb,jsonb,text)'))='0cafc1360791044b1ca38ae01ddeb81c'
    and case when m.epoch='legacy' then
      not d.holder_table and d.holder_check is null and d.placement_check is null and d.funding_triggers=0
        and d.funding_columns in (0,2) and d.funding_columns=d.nullable_funding_columns
    else
      d.holder_table and d.funding_columns=2 and d.nullable_funding_columns=2 and d.active_funding_triggers=2
        and (select md5(p.prosrc) from pg_proc p where p.oid=d.holder_check)='fcdd3dfeccd85fc94d9314860d5ea04a'
        and case when m.epoch='placement' then
          (select md5(p.prosrc) from pg_proc p where p.oid=d.placement_check)='4276e7e376197cab6337129625cdac2f'
          and exists(
            select 1 from pg_proc p where p.oid=to_regprocedure('public.insert_hermes_instance(jsonb,numeric,boolean)')
              and md5(p.prosrc)='5eb825a93d94b2c8139a87e7b65c898b'
              and p.proargnames=array['p_row','p_cpu_overcommit_ratio','p_skip_sleep']
              and p.prosecdef and p.provolatile='v' and p.prorettype='jsonb'::regtype
              and p.proconfig=array['search_path=pg_catalog, pg_temp']
              and has_function_privilege('service_role',p.oid,'execute')
              and not has_function_privilege('anon',p.oid,'execute')
              and not has_function_privilege('authenticated',p.oid,'execute')
          )
          and (select md5(p.prosrc) from pg_proc p
            where p.oid=to_regprocedure('public.holder_placement_accounting(text[],boolean)'))='838d3fc01ec324c2ffa79e831b7f8c81'
        else d.placement_check is null end
    end;
$$;

do $$
declare
  v_epoch text := managed_launch_bridge_private.schema_epoch();
begin
  if v_epoch is null or v_epoch not in ('legacy','placement') then
    raise exception 'managed launch bridge requires the reviewed legacy or placement schema';
  end if;
  insert into managed_launch_bridge_private.contract values (true,v_epoch);
end;
$$;

create function public.managed_launch_bridge_epoch()
returns text language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_epoch text;
begin
  select epoch into strict v_epoch from managed_launch_bridge_private.contract where singleton;
  if v_epoch is distinct from managed_launch_bridge_private.schema_epoch() then
    raise exception 'managed launch bridge epoch does not match the reviewed schema';
  end if;
  return v_epoch;
end;
$$;

create function managed_launch_bridge_private.lock_epoch()
returns text language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_epoch text;
begin
  select epoch into strict v_epoch from managed_launch_bridge_private.contract where singleton for share;
  if v_epoch is distinct from managed_launch_bridge_private.schema_epoch() then
    raise exception 'managed launch bridge epoch does not match the reviewed schema';
  end if;
  return v_epoch;
end;
$$;

create function managed_launch_bridge_private.begin_transition(p_expected text,p_next text)
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
begin
  if ((p_expected='legacy' and p_next='funding') or (p_expected='funding' and p_next='placement')) is not true then
    raise exception 'invalid managed launch bridge transition';
  end if;
  if (select epoch from managed_launch_bridge_private.contract where singleton for update) is distinct from p_expected
    or managed_launch_bridge_private.schema_epoch() is distinct from p_expected then
    raise exception 'managed launch bridge transition predecessor does not match';
  end if;
  perform set_config('hivra.managed_launch_bridge_transition',
    pg_current_xact_id()::text||':'||p_expected||':'||p_next,true);
end;
$$;

create function managed_launch_bridge_private.finish_transition(p_expected text,p_next text)
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
begin
  if ((p_expected='legacy' and p_next='funding') or (p_expected='funding' and p_next='placement')) is not true
    or current_setting('hivra.managed_launch_bridge_transition',true) is distinct from
      (pg_current_xact_id()::text||':'||p_expected||':'||p_next) then
    raise exception 'managed launch bridge transition must be locked in this transaction';
  end if;
  if managed_launch_bridge_private.schema_epoch() is distinct from p_next then
    raise exception 'managed launch bridge transition successor does not match';
  end if;
  update managed_launch_bridge_private.contract set epoch=p_next where singleton and epoch=p_expected;
  if not found then raise exception 'managed launch bridge transition predecessor does not match'; end if;
  perform set_config('hivra.managed_launch_bridge_transition','',true);
end;
$$;

create function public.insert_hivra_managed_agent_bridge_v1(
  p_epoch text, p_row jsonb, p_agent_limit integer, p_cpu_overcommit_ratio numeric, p_skip_sleep boolean
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_epoch text := managed_launch_bridge_private.lock_epoch();
begin
  if p_epoch is distinct from v_epoch then
    return jsonb_build_object('status','bridge_phase_changed');
  end if;
  if v_epoch='legacy' then
    return public.insert_hivra_managed_agent(
      case when jsonb_typeof(p_row)='object' then p_row-'seat_funding' else p_row end,p_agent_limit);
  elsif v_epoch='funding' then
    return public.insert_hivra_managed_agent(p_row,p_agent_limit);
  end if;
  return public.insert_hivra_managed_agent(p_row,p_agent_limit,p_cpu_overcommit_ratio,p_skip_sleep);
end;
$$;

create function public.reserve_hivra_launch_model_bridge_v1(
  p_epoch text,p_user_id text,p_request_id uuid,p_fingerprints jsonb,p_model_operation_id uuid,
  p_agent jsonb,p_selection jsonb,p_encrypted_key text,p_agent_limit integer,p_cpu_overcommit_ratio numeric,p_skip_sleep boolean
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_epoch text := managed_launch_bridge_private.lock_epoch();
begin
  if p_epoch is distinct from v_epoch then
    return jsonb_build_object('status','bridge_phase_changed');
  end if;
  if v_epoch='legacy' then
    return public.reserve_hivra_launch_model_request_v3(p_user_id,p_request_id,p_fingerprints,
      p_model_operation_id,
      case when p_agent->>'deployment_mode'='hivra-managed' then p_agent-'seat_funding' else p_agent end,
      p_selection,p_encrypted_key,p_agent_limit);
  elsif v_epoch='funding' then
    return public.reserve_hivra_launch_model_request_v3(p_user_id,p_request_id,p_fingerprints,
      p_model_operation_id,p_agent,p_selection,p_encrypted_key,p_agent_limit);
  end if;
  return public.reserve_hivra_launch_model_request_v3(p_user_id,p_request_id,p_fingerprints,
    p_model_operation_id,p_agent,p_selection,p_encrypted_key,p_agent_limit,p_cpu_overcommit_ratio,p_skip_sleep);
end;
$$;

revoke all on all functions in schema managed_launch_bridge_private from public, anon, authenticated, service_role;
revoke all on function public.managed_launch_bridge_epoch(),
  public.insert_hivra_managed_agent_bridge_v1(text,jsonb,integer,numeric,boolean),
  public.reserve_hivra_launch_model_bridge_v1(text,text,uuid,jsonb,uuid,jsonb,jsonb,text,integer,numeric,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.managed_launch_bridge_epoch(),
  public.insert_hivra_managed_agent_bridge_v1(text,jsonb,integer,numeric,boolean),
  public.reserve_hivra_launch_model_bridge_v1(text,text,uuid,jsonb,uuid,jsonb,jsonb,text,integer,numeric,boolean)
  to service_role;
