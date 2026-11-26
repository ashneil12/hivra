begin;
insert into public.hermes_instances(id,user_id,name,status,lifecycle_state,product_surface,infrastructure_provider,
  proxmox_node,proxmox_vmid,cpu_limit,ram_limit,disk_size_gb,seat_funding)
values('00000000-0000-4000-8000-000000000301','bridge-drain-owner','Synthetic pending classic','stopped','paused',
  'hermesos','proxmox','bridge-host',13002,1,2048,30,'paid');

set local role service_role;
do $$
declare
  result jsonb;
begin
  result := public.claim_hermes_instance_start_bridge_v1('placement','00000000-0000-4000-8000-000000000301',
    'bridge-drain-owner','00000000-0000-4000-8000-000000000302','bridge-host',13002,1,false);
  if result->>'status' is distinct from 'claimed' then raise exception 'could not seed pending Classic claim'; end if;
  result := public.finish_hermes_instance_start_bridge_v1('00000000-0000-4000-8000-000000000301',
    'bridge-drain-owner','00000000-0000-4000-8000-000000000302','unknown');
  if result->>'status' is distinct from 'pending' then raise exception 'unknown Start released its reservation'; end if;
  perform public.reserve_hivra_launch_operation('bridge-drain-owner','00000000-0000-4000-8000-000000000303',
    '00000000-0000-4000-8000-000000000304',repeat('a',64),repeat('b',64),'agent','codex');
  perform public.reconcile_hivra_launch_operation('bridge-drain-owner','00000000-0000-4000-8000-000000000303',
    '00000000-0000-4000-8000-000000000304',repeat('a',64),repeat('b',64));
end;
$$;
reset role;

insert into public.hermes_instances(id,user_id,name,status,lifecycle_state,lifecycle_substate)
values('00000000-0000-4000-8000-000000000306','bridge-drain-holder','Synthetic holder save','stopped','paused','holder_save');
update public.hivra_launch_model_requests
set attempt_id='00000000-0000-4000-8000-000000000307',attempt_expires_at=now()-interval '1 minute',
    attempted_at=now()-interval '2 minutes'
where user_id='bridge-grandfather' and phase='waiting';
select managed_launch_bridge_private.set_writer_drain('placement',true);
do $$
declare
  pending jsonb := managed_launch_bridge_private.writer_drain_pending();
begin
  if pending->>'modelAttempts' is distinct from '1' or pending->>'classicLifecycle' is distinct from '2' then
    raise exception 'drain did not count the waiting custody attempt and holder save: %',pending;
  end if;
end;
$$;
commit;

begin;
set local role service_role;
do $$
begin
  begin
    perform public.claim_hermes_instance_start_bridge_v1('placement','00000000-0000-4000-8000-000000000301',
      'bridge-drain-owner','00000000-0000-4000-8000-000000000305','bridge-host',13002,1,false);
    raise exception 'a new Start escaped quarantine';
  exception when sqlstate 'P0059' then null;
  end;
  perform set_config('hivra.managed_writer_reconcile',pg_current_xact_id()::text,true);
  begin
    perform public.finish_hermes_instance_start_bridge_v1('00000000-0000-4000-8000-000000000301',
      'bridge-drain-owner','00000000-0000-4000-8000-000000000302','not_started');
    raise exception 'application role forged a settlement authorization';
  exception when sqlstate 'P0059' then null;
  end;
  perform set_config('hivra.managed_writer_reconcile','',true);
end;
$$;
reset role;

savepoint attempted_settlement;
select managed_launch_bridge_private.begin_writer_reconciliation('placement');
select public.finish_hermes_instance_start_bridge_v1('00000000-0000-4000-8000-000000000301',
  'bridge-drain-owner','00000000-0000-4000-8000-000000000302','started');
rollback to savepoint attempted_settlement;

do $$
begin
  if not exists(select 1 from managed_launch_bridge_private.classic_start
      where instance_id='00000000-0000-4000-8000-000000000301'
        and operation_id='00000000-0000-4000-8000-000000000302'
        and user_id='bridge-drain-owner' and host_id='bridge-host' and vmid=13002 and outcome is null)
    or not exists(select 1 from public.hermes_instances
      where id='00000000-0000-4000-8000-000000000301' and lifecycle_substate='classic_start')
    or not exists(select 1 from public.hivra_launch_operations
      where request_id='00000000-0000-4000-8000-000000000303'
        and operation_id='00000000-0000-4000-8000-000000000304' and phase='reconciling')
    or not exists(select 1 from public.hivra_launch_model_requests
      where attempt_id='00000000-0000-4000-8000-000000000307' and phase='waiting')
    or not exists(select 1 from public.hermes_instances
      where id='00000000-0000-4000-8000-000000000306' and lifecycle_substate='holder_save')
  then raise exception 'rollback did not preserve the quarantined receipts and their target'; end if;
  begin
    perform managed_launch_bridge_private.set_writer_drain('placement',false);
    raise exception 'unresolved receipts allowed the old writer to return';
  exception when sqlstate 'P0059' then null;
  end;
  if not (select writer_closed_xact is not null from managed_launch_bridge_private.contract where singleton) then
    raise exception 'writer gate reopened';
  end if;
  raise notice 'PASS unresolved native and Classic receipts remain quarantined across rollback; service role cannot settle or replay';
end;
$$;

create temporary table custody_intent_before on commit drop as
select to_jsonb(q)-'attempt_id'-'attempt_expires_at' as receipt
from public.hivra_launch_model_requests q
where user_id='bridge-grandfather' and request_id='00000000-0000-4000-8000-000000000101';

select managed_launch_bridge_private.begin_writer_reconciliation('placement');
do $$
begin
  if managed_launch_bridge_private.release_expired_custody_attempt('bridge-grandfather','00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000305') then
    raise exception 'mismatched attempt lease was released';
  end if;
  if not managed_launch_bridge_private.release_expired_custody_attempt('bridge-grandfather','00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000307') then
    raise exception 'original expired attempt lease could not be released';
  end if;
  if not exists(select 1 from public.hivra_launch_model_requests q
      join custody_intent_before s on s.receipt=(to_jsonb(q)-'attempt_id'-'attempt_expires_at')
      where q.user_id='bridge-grandfather' and q.phase='waiting' and q.attempt_id is null) then
    raise exception 'expired lease release changed the original request intent';
  end if;
end;
$$;

select public.finish_hermes_instance_start_bridge_v1('00000000-0000-4000-8000-000000000301',
  'bridge-drain-owner','00000000-0000-4000-8000-000000000302','started');
select public.fail_hivra_launch_operation('bridge-drain-owner','00000000-0000-4000-8000-000000000303',
  '00000000-0000-4000-8000-000000000304',repeat('a',64),repeat('b',64),503,'synthetic_no_dispatch');
delete from public.hermes_instances where id='00000000-0000-4000-8000-000000000306';
select managed_launch_bridge_private.set_writer_drain('placement',false);
commit;
\echo PASS operator released only an expired, never-promoted custody lease without cancelling the request and reopened after settling all synthetic operations
