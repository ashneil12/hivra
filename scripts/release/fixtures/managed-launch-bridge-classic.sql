begin;
select set_config('bridge_test.epoch', :'epoch', true);
select :'epoch' = 'funding' as funding_only \gset
\if :funding_only
set local role service_role;
do $$
begin
  perform public.insert_hermes_instance_bridge_v1('funding',
    '{"user_id":"bridge-classic","name":"Synthetic Classic","product_surface":"hermesos","infrastructure_provider":"proxmox","status":"provisioning","lifecycle_state":"provisioning","seat_funding":"paid"}',1,false);
  raise exception 'Classic create bypassed reserved capacity in funding-only phase';
exception when sqlstate 'P0058' then null;
end;
$$;
reset role;
delete from public.holder_admissions;
\endif
set local role service_role;
do $$
declare
  epoch text := current_setting('bridge_test.epoch');
  input jsonb := '{"user_id":"bridge-classic","name":"Synthetic Classic","product_surface":"hermesos","infrastructure_provider":"proxmox","status":"provisioning","lifecycle_state":"provisioning","cpu_limit":2,"ram_limit":4096,"disk_size_gb":30,"seat_funding":"paid"}';
  payload jsonb;
  result jsonb;
  vm uuid;
  op uuid := gen_random_uuid();
  retry uuid := gen_random_uuid();
  oversized uuid;
begin
  payload := case when epoch='placement' then input||'{"proxmox_node":"bridge-host"}' else input end;
  result := public.insert_hermes_instance_bridge_v1(case when epoch='legacy' then 'funding' else 'legacy' end,payload,1,false);
  if result->>'status' is distinct from 'bridge_phase_changed' then raise exception 'Classic create did not refuse stale epoch'; end if;
  if exists(select 1 from public.hermes_instances where user_id='bridge-classic') then raise exception 'stale create inserted'; end if;
  insert into public.hermes_instances(user_id,name,status,lifecycle_state,infrastructure_provider,product_surface)
    values('bridge-old-classic','Old writer','provisioning','provisioning','proxmox','hermesos');
  if (select to_jsonb(h)->>'seat_funding' from public.hermes_instances h where user_id='bridge-old-classic') is not null then
    raise exception 'old Classic direct writer was relabeled';
  end if;
  if epoch<>'legacy' then
    begin
      perform public.insert_hermes_instance_bridge_v1(epoch,payload-'seat_funding',1,false);
      raise exception 'new Classic writer accepted missing funding';
    exception when invalid_parameter_value then null;
    end;
  end if;
  result := public.insert_hermes_instance_bridge_v1(epoch,payload,1,false);
  if result->>'status' is distinct from 'inserted'
    or result->'row'->>'seat_funding' is distinct from (case when epoch<>'legacy' then 'paid' end)
    or result->'row'->>'proxmox_node' is distinct from (case when epoch='placement' then 'bridge-host' end)
  then raise exception 'Classic phase create mismatch'; end if;
  vm := (result->'row'->>'id')::uuid;
  result := public.insert_hermes_instance_bridge_v1(epoch,(payload-'seat_funding')||'{"product_surface":"workspace_cloud"}',1,false);
  if result->>'status' is distinct from 'inserted' or result->'row'->>'seat_funding' is not null then
    raise exception 'Workspace Cloud lost separate funding';
  end if;
  if epoch<>'placement' then
    if public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-classic',op,'bridge-host',12001,1,false)->>'status'
       is distinct from 'unavailable' then raise exception 'early Classic Start claim dispatched'; end if;
    return;
  end if;
  begin
    perform public.insert_hermes_instance_bridge_v1(epoch,payload||'{"proxmox_node":"BRIDGE-HOST"}',1,false);
    raise exception 'normalized Classic alias bypassed create accounting';
  exception when sqlstate 'P0058' then null;
  end;
  update public.hermes_instances set lifecycle_state='paused',status='stopped',proxmox_vmid=12001,paused_reason='inactivity'
    where id=vm;
  insert into public.hermes_instances(user_id,name,status,lifecycle_state,proxmox_node,proxmox_vmid,cpu_limit,ram_limit,infrastructure_provider)
    values('bridge-classic','Overcapacity','stopped','paused','bridge-host',12002,999,4096,'proxmox') returning id into oversized;
  begin
    perform public.claim_hermes_instance_start_bridge_v1(epoch,oversized,'bridge-classic',op,'bridge-host',12002,1,false);
    raise exception 'Classic Start exceeded CPU';
  exception when sqlstate 'P0058' then null;
  end;
  if public.claim_hermes_instance_start_bridge_v1('funding',vm,'bridge-classic',op,'bridge-host',12001,1,false)->>'status' is distinct from 'bridge_phase_changed'
    or public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-other',op,'bridge-host',12001,1,false)->>'status' is distinct from 'unavailable'
    or public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-classic',op,'bridge-other',12001,1,false)->>'status' is distinct from 'unavailable'
    or public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-classic',op,'bridge-host',12002,1,false)->>'status' is distinct from 'unavailable'
  then raise exception 'Classic Start did not fence owner, host, VM or epoch'; end if;
  if public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-classic',op,'bridge-host',12001,1,false)->>'status'
    is distinct from 'claimed' then raise exception 'Classic Start did not claim'; end if;
  if not exists(select 1 from public.holder_placement_accounting(array['bridge-host'],false)
     where owner_id='bridge-classic' and cpu=2 and ram_mb=4096 and launching=1) then
    raise exception 'Classic Start claim did not consume registered CPU and RAM';
  end if;
  if public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-classic',op,'bridge-host',12001,1,false)->>'status' is distinct from 'pending'
    or public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-classic',retry,'bridge-host',12001,1,false)->>'status' is distinct from 'pending'
    or public.finish_hermes_instance_start_bridge_v1(vm,'bridge-other',op,'not_started')->>'status' is distinct from 'unavailable'
    or public.finish_hermes_instance_start_bridge_v1(vm,'bridge-classic',retry,'not_started')->>'status' is distinct from 'unavailable'
    or public.finish_hermes_instance_start_bridge_v1(vm,'bridge-classic',op,'unknown')->>'status' is distinct from 'pending'
    or not exists(select 1 from public.hermes_instances where id=vm and lifecycle_state='provisioning' and lifecycle_substate='classic_start')
  then raise exception 'Classic pending hold or receipt fence failed'; end if;
  begin
    update public.hermes_instances set lifecycle_state='paused' where id=vm;
    raise exception 'direct old writer invalidated pending Classic capacity';
  exception when sqlstate 'P0058' then null;
  end;
  result := public.finish_hermes_instance_start_bridge_v1(vm,'bridge-classic',op,'not_started');
  if result->>'status' is distinct from 'released'
    or not exists(select 1 from public.hermes_instances where id=vm and lifecycle_state='paused' and paused_reason='inactivity' and lifecycle_substate is null)
    or public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-classic',op,'bridge-host',12001,1,false)->>'status' is distinct from 'unavailable'
  then raise exception 'Classic positive abort did not restore pause or prevent replay'; end if;
  result := public.claim_hermes_instance_start_bridge_v1(epoch,vm,'bridge-classic',retry,'bridge-host',12001,1,false);
  if result->>'status' is distinct from 'claimed' then raise exception 'fresh operation did not claim after abort'; end if;
  result := public.finish_hermes_instance_start_bridge_v1(vm,'bridge-classic',retry,'started');
  if result->>'status' is distinct from 'awake'
    or not exists(select 1 from public.hermes_instances where id=vm and lifecycle_state='active' and paused_reason is null and lifecycle_substate is null)
  then raise exception 'Classic confirmed Start did not settle'; end if;
end;
$$;
reset role;
do $$
begin
  if has_table_privilege('service_role','managed_launch_bridge_private.classic_start','select')
    or has_table_privilege('service_role','managed_launch_bridge_private.classic_start','update')
    or has_function_privilege('anon','public.claim_hermes_instance_start_bridge_v1(text,uuid,text,uuid,text,integer,numeric,boolean)','execute')
    or has_function_privilege('authenticated','public.finish_hermes_instance_start_bridge_v1(uuid,text,uuid,text)','execute')
  then raise exception 'Classic Start receipt is exposed'; end if;
  raise notice 'PASS Classic phase create, legacy coexistence, and Start receipt invariants at %',current_setting('bridge_test.epoch');
end;
$$;
rollback;
