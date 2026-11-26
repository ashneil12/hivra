begin;
select set_config('bridge_test.epoch', :'epoch', true),
  set_config('bridge_test.raw_insert', :'raw_insert', true),
  set_config('bridge_test.raw_reserve', :'raw_reserve', true);
select :'epoch' <> 'legacy' as has_holder \gset
\if :has_holder
update public.holder_admissions set assigned_host_id='bridge-host' where user_id='bridge-grandfather';
\endif

set local role service_role;
do $$
declare
  epoch text := current_setting('bridge_test.epoch');
  row jsonb := jsonb_build_object('id',gen_random_uuid(),'user_id','bridge-direct','name','Direct',
    'type','codex','status','provisioning','cpu',1,'ram',2,'deployment_mode','hivra-managed',
    'computer_substrate','proxmox-kvm','proxmox_host','bridge-host');
  request uuid := gen_random_uuid();
  operation uuid := gen_random_uuid();
  agent jsonb := jsonb_build_object('id',gen_random_uuid(),'name','Receipt',
    'type','codex','cpu',1,'ram',2,'deployment_mode','hivra-managed',
    'computer_substrate','proxmox-kvm','proxmox_host','bridge-host','operation_id',gen_random_uuid(),
    'infrastructure_binding_token_hash',repeat('c',64));
  fingerprints jsonb := jsonb_build_array(jsonb_build_object('version',2,'keyTag',repeat('a',64),'digest',repeat('b',64)));
  selection jsonb := '{"provider":"venice","mode":"managed","model":"synthetic","walletType":"card"}';
  result jsonb;
  expected_funding text := case when epoch<>'legacy' then 'paid' end;
begin
  if public.managed_launch_bridge_epoch() is distinct from epoch then raise exception 'wrong epoch'; end if;
  result := public.insert_hivra_managed_agent(p_row => row, p_agent_limit => 2);
  if result->>'status' is distinct from current_setting('bridge_test.raw_insert') then
    raise exception 'raw insert at %: %',epoch,result;
  end if;
  result := public.reserve_hivra_launch_model_request_v3(
    p_user_id => 'bridge-raw', p_request_id => gen_random_uuid(), p_fingerprints => fingerprints,
    p_model_operation_id => gen_random_uuid(), p_agent => agent, p_selection => selection, p_encrypted_key => null, p_agent_limit => 2);
  if result->>'status' is distinct from current_setting('bridge_test.raw_reserve') then
    raise exception 'raw reserve at %: %',epoch,result;
  end if;

  row := row || jsonb_build_object('id',gen_random_uuid(),'user_id','bridge-paid','seat_funding','paid');
  agent := agent || jsonb_build_object('id',gen_random_uuid(),'operation_id',gen_random_uuid(),'seat_funding','paid');
  result := public.insert_hivra_managed_agent_bridge_v1(epoch,row,1,1,false);
  if result->>'status' is distinct from 'inserted' or result->'row'->>'seat_funding' is distinct from expected_funding then
    raise exception 'bridge insert at %: %',epoch,result;
  end if;
  result := public.insert_hivra_managed_agent_bridge_v1(epoch,row || jsonb_build_object('id',gen_random_uuid()),1,1,false);
  if result->>'status' is distinct from 'plan_agent_limit' then raise exception 'slot check: %',result; end if;
  result := public.insert_hivra_managed_agent_bridge_v1(epoch,'"scalar"',1,1,false);
  if result->>'status' is distinct from 'invalid_request' then raise exception 'non-object direct row: %',result; end if;
  result := public.reserve_hivra_launch_model_bridge_v1(epoch,'bridge-receipt',request,fingerprints,operation,agent,selection,null,1,1,false);
  if result->>'status' is distinct from 'reserved' then raise exception 'bridge reserve at %: %',epoch,result; end if;
  result := public.reserve_hivra_launch_model_bridge_v1(epoch,'bridge-receipt',request,fingerprints,operation,agent,selection,null,0,1,false);
  if result->>'status' is distinct from 'existing' or result->>'agentId' is distinct from agent->>'id' then
    raise exception 'same request did not replay at %: %',epoch,result;
  end if;
  result := public.reserve_hivra_launch_model_bridge_v1(epoch,'bridge-receipt',request,
    jsonb_set(fingerprints,'{0,digest}',to_jsonb(repeat('d',64))),operation,agent,selection,null,1,1,false);
  if result->>'status' is distinct from 'request_conflict' then raise exception 'fingerprint conflict: %',result; end if;

  if epoch <> 'legacy' then
    result := public.insert_hivra_managed_agent_bridge_v1('legacy',row,1,1,false);
    if result->>'status' is distinct from 'bridge_phase_changed' then raise exception 'stale direct epoch: %',result; end if;
    result := public.reserve_hivra_launch_model_bridge_v1('legacy','bridge-stale',gen_random_uuid(),fingerprints,
      operation,agent,selection,null,1,1,false);
    if result->>'status' is distinct from 'bridge_phase_changed' then raise exception 'stale receipt epoch: %',result; end if;
    result := public.insert_hivra_managed_agent_bridge_v1(epoch,row-'seat_funding',1,1,false);
    if result->>'status' is distinct from 'invalid_request' then raise exception 'missing direct funding: %',result; end if;
    result := public.reserve_hivra_launch_model_bridge_v1(epoch,'bridge-missing',gen_random_uuid(),fingerprints,
      operation,agent-'seat_funding',selection,null,1,1,false);
    if result->>'status' is distinct from 'invalid_request' then raise exception 'missing receipt funding: %',result; end if;

    result := public.reserve_hivra_launch_model_bridge_v1(epoch,'bridge-grandfather','00000000-0000-4000-8000-000000000101',
      fingerprints,operation,agent || '{"seat_funding":"holder"}',selection,null,0,1,false);
    if result->>'status' is distinct from 'existing' or result->>'agentId' is distinct from '00000000-0000-4000-8000-000000000102' then
      raise exception 'pre-cutover request did not replay at %: %',epoch,result;
    end if;
    result := public.reserve_hivra_launch_model_bridge_v1(epoch,'bridge-grandfather',gen_random_uuid(),fingerprints,gen_random_uuid(),
      agent || jsonb_build_object('id',gen_random_uuid(),'operation_id',gen_random_uuid(),'seat_funding','holder'),selection,null,3,1,false);
    if result->>'status' is distinct from 'reserved' then raise exception 'admitted holder reserve: %',result; end if;
    begin
      perform public.reserve_hivra_launch_model_bridge_v1(epoch,'bridge-waitlisted',gen_random_uuid(),fingerprints,gen_random_uuid(),
        agent || jsonb_build_object('id',gen_random_uuid(),'operation_id',gen_random_uuid(),'seat_funding','holder'),selection,null,1,1,false);
      raise exception 'waitlisted holder reserved';
    exception when sqlstate 'P0057' or sqlstate 'P0058' then
      if sqlstate is distinct from (case when epoch='funding' then 'P0057' else 'P0058' end) then raise; end if;
    end;
  end if;

  if epoch = 'placement' then
    begin
      perform public.insert_hivra_managed_agent_bridge_v1(epoch,
        row || jsonb_build_object('id',gen_random_uuid(),'user_id','bridge-over-capacity','cpu',999),1,1,false);
      raise exception 'bridge bypassed placement';
    exception when sqlstate 'P0058' then null;
    end;
    result := public.insert_hivra_managed_agent(p_row => row || jsonb_build_object('id',gen_random_uuid(),'user_id','combined-app'),
      p_agent_limit => 1,p_cpu_overcommit_ratio => 1,p_skip_sleep => false);
    if result->>'status' is distinct from 'inserted' then raise exception 'explicit final direct RPC: %',result; end if;
    result := public.reserve_hivra_launch_model_request_v3(
      p_user_id => 'combined-receipt',p_request_id => gen_random_uuid(),p_fingerprints => fingerprints,
      p_model_operation_id => gen_random_uuid(),p_agent => agent || jsonb_build_object('id',gen_random_uuid(),'operation_id',gen_random_uuid()),
      p_selection => selection,p_encrypted_key => null,p_agent_limit => 1,p_cpu_overcommit_ratio => 1,p_skip_sleep => false);
    if result->>'status' is distinct from 'reserved' then raise exception 'explicit final receipt RPC: %',result; end if;
  end if;
end;
$$;
reset role;

do $$
declare
  epoch text := current_setting('bridge_test.epoch');
begin
  if epoch <> 'legacy' then
    if (select a.seat_funding from public.hivra_agents a where a.user_id='bridge-receipt') is distinct from 'paid'
      or not exists(select 1 from public.holder_admissions where user_id='bridge-grandfather' and grandfathered and state='admitted')
      or (select count(*) from public.hivra_agents a where a.user_id='bridge-grandfather' and a.seat_funding='holder') <> 2
      or (select a.state from public.holder_admissions a where a.user_id='bridge-waitlisted') is distinct from 'waitlisted'
      or exists(select 1 from public.hivra_launch_model_requests where user_id in ('bridge-waitlisted','bridge-missing','bridge-stale'))
      or exists(select 1 from public.hivra_agents where user_id in ('bridge-waitlisted','bridge-missing','bridge-stale','bridge-over-capacity'))
    then raise exception 'funding, grandfathering, or atomic failure invariant'; end if;
  end if;
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('managed_launch_bridge_epoch','insert_hivra_managed_agent_bridge_v1',
        'reserve_hivra_launch_model_bridge_v1','insert_hivra_managed_agent','reserve_hivra_launch_model_request_v3')
      and (not p.prosecdef
        or not has_function_privilege('service_role',p.oid,'execute')
        or has_function_privilege('anon',p.oid,'execute')
        or has_function_privilege('authenticated',p.oid,'execute')
        or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0))
  ) then raise exception 'writer security definer or ACL invariant'; end if;
  if exists(
    select 1 from unnest(array['anon','authenticated','service_role']) as role(name)
    where has_schema_privilege(role.name,'managed_launch_bridge_private','usage')
      or has_table_privilege(role.name,'managed_launch_bridge_private.contract','update')
      or has_function_privilege(role.name,'managed_launch_bridge_private.begin_transition(text,text)','execute')
      or has_function_privilege(role.name,'managed_launch_bridge_private.finish_transition(text,text)','execute')
  ) then raise exception 'private bridge state or transition hook is exposed'; end if;
  raise notice 'PASS epoch=% historical raw insert/reserve=%/%; bridge writer, replay and role assertions passed',
    epoch,current_setting('bridge_test.raw_insert'),current_setting('bridge_test.raw_reserve');
end;
$$;
rollback;
