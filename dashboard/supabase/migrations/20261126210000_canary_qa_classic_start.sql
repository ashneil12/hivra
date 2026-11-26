create table canary_qa_writer_private.classic_starts (
  operation_id uuid primary key references canary_qa_writer_private.dispatches(operation_id),
  instance_id uuid not null
);

create or replace function canary_qa_writer_private.guard_owner()
returns trigger language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_before text;
  v_after text;
  v_role text := canary_qa_writer_private.request_role();
  v_is_qa boolean := v_role ~ '^hivra_canary_qa_[a-z0-9]{1,40}$';
  v_is_settlement boolean := false;
  v_scope canary_qa_writer_private.scope%rowtype;
begin
  if tg_op<>'INSERT' and tg_op<>'TRUNCATE' then v_before := old.user_id; end if;
  if tg_op<>'DELETE' and tg_op<>'TRUNCATE' then v_after := new.user_id; end if;
  select * into strict v_scope from canary_qa_writer_private.scope where singleton;
  if v_scope.owner_id is null or v_scope.owner_id in (v_before,v_after) or v_is_qa or tg_op='TRUNCATE' then
    select * into strict v_scope from canary_qa_writer_private.scope where singleton for share;
  end if;
  if tg_table_name='hermes_instances' and tg_op='UPDATE' and v_scope.principal is null
    and v_role=session_user::text and v_before=v_scope.owner_id and v_after=v_scope.owner_id
    and session_user=(select pg_get_userbyid(relowner) from pg_class
      where oid='canary_qa_writer_private.scope'::regclass) then
    v_is_settlement := coalesce(
      current_setting('hivra.canary_qa_classic_settlement',true)
        = pg_current_xact_id_if_assigned()::text||':'||old.id::text
      and old.id=new.id and old.lifecycle_substate='classic_start' and new.lifecycle_substate is null
      and ((new.lifecycle_state='active' and new.status='running') or (new.lifecycle_state='paused' and new.status='stopped')),
      false);
  end if;
  if (v_scope.owner_id is not null and tg_op='TRUNCATE')
    or ((v_is_qa or v_scope.owner_id in (v_before,v_after)) and not v_is_settlement and (
      v_scope.owner_id is null or not v_is_qa
      or v_role is distinct from v_scope.principal
      or v_scope.expires_at is null or v_scope.expires_at<=clock_timestamp()
      or (tg_op<>'INSERT' and v_before is distinct from v_scope.owner_id)
      or (tg_op<>'DELETE' and v_after is distinct from v_scope.owner_id)
    )) then
    raise exception 'Canary QA writer is not admitted for this owner' using errcode='P0060';
  end if;
  if (v_is_qa or v_is_settlement) and tg_op<>'TRUNCATE' then
    if tg_table_name='hermes_instances' then
      if (tg_op<>'INSERT' and (old.proxmox_node,old.proxmox_vmid) is distinct from (v_scope.host_id,v_scope.vmid))
        or (tg_op<>'DELETE' and (new.proxmox_node,new.proxmox_vmid) is distinct from (v_scope.host_id,v_scope.vmid)) then
        raise exception 'Canary QA writer target is not admitted' using errcode='P0060';
      end if;
    elsif tg_table_name='hivra_agents' then
      if (tg_op<>'INSERT' and (old.proxmox_host,old.vmid) is distinct from (v_scope.host_id,v_scope.vmid))
        or (tg_op<>'DELETE' and (new.proxmox_host,new.vmid) is distinct from (v_scope.host_id,v_scope.vmid)) then
        raise exception 'Canary QA writer target is not admitted' using errcode='P0060';
      end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if tg_op='TRUNCATE' then return null; end if;
  return new;
end;
$$;

create function canary_qa_writer_private.finish_dispatch(p_operation_id uuid,p_outcome text,p_classic_start boolean)
returns jsonb language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_scope canary_qa_writer_private.scope%rowtype;
  v_role text := canary_qa_writer_private.request_role();
begin
  select * into strict v_scope from canary_qa_writer_private.scope where singleton for share;
  if v_role is distinct from v_scope.principal or v_scope.expires_at is null or v_scope.expires_at<=clock_timestamp()
    or coalesce(p_outcome,'') not in ('performed','refused')
    or p_classic_start is distinct from exists(select 1 from canary_qa_writer_private.classic_starts
      where operation_id=p_operation_id) then
    return jsonb_build_object('status','denied');
  end if;
  update canary_qa_writer_private.dispatches set outcome=p_outcome,settled_at=clock_timestamp()
    where operation_id=p_operation_id and owner_id=v_scope.owner_id and host_id=v_scope.host_id and vmid=v_scope.vmid
      and principal=v_role and outcome is null;
  if not found and not exists(select 1 from canary_qa_writer_private.dispatches
    where operation_id=p_operation_id and owner_id=v_scope.owner_id and host_id=v_scope.host_id and vmid=v_scope.vmid
      and principal=v_role and outcome=p_outcome) then return jsonb_build_object('status','denied'); end if;
  return jsonb_build_object('status','settled','operationId',p_operation_id,'outcome',p_outcome);
end;
$$;

create or replace function public.finish_canary_qa_dispatch(p_operation_id uuid,p_outcome text)
returns jsonb language sql volatile security definer set search_path=pg_catalog,pg_temp as $$
  select canary_qa_writer_private.finish_dispatch(p_operation_id,p_outcome,false);
$$;

create or replace function canary_qa_writer_private.settle_closed_dispatch(
  p_owner_id text,p_host_id text,p_vmid integer,p_action text,p_operation_id uuid,p_outcome text
)
returns boolean language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_scope canary_qa_writer_private.scope%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Canary QA settlement requires READ COMMITTED' using errcode='25001';
  end if;
  select * into strict v_scope from canary_qa_writer_private.scope where singleton for update;
  if v_scope.owner_id is distinct from p_owner_id or v_scope.host_id is distinct from p_host_id
    or v_scope.vmid is distinct from p_vmid or v_scope.principal is not null
    or coalesce(p_outcome,'') not in ('performed','refused') then return false; end if;
  update canary_qa_writer_private.dispatches set outcome=p_outcome,settled_at=clock_timestamp()
    where operation_id=p_operation_id and owner_id=p_owner_id and host_id=p_host_id and vmid=p_vmid
      and action=p_action and outcome is null
      and not exists(select 1 from canary_qa_writer_private.classic_starts where operation_id=p_operation_id);
  return found;
end;
$$;

create function public.claim_canary_qa_classic_start(
  p_instance_id uuid,p_owner_id text,p_host_id text,p_vmid integer,p_action text,p_operation_id uuid
) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_claim jsonb;
  v_classic jsonb;
begin
  if p_action is distinct from 'start' or p_instance_id is null
    or managed_launch_bridge_private.lock_epoch() is distinct from 'placement' then
    return jsonb_build_object('status','denied');
  end if;
  v_claim := public.claim_canary_qa_dispatch(p_owner_id,p_host_id,p_vmid,p_action,p_operation_id);
  if v_claim->>'status'='settled' then
    if exists(select 1 from canary_qa_writer_private.classic_starts
      where operation_id=p_operation_id and instance_id=p_instance_id) then return v_claim; end if;
    return jsonb_build_object('status','denied');
  end if;
  if v_claim->>'status' is distinct from 'claimed' then return v_claim; end if;
  v_classic := public.claim_hermes_instance_start_bridge_v1(
    'placement',p_instance_id,p_owner_id,p_operation_id,p_host_id,p_vmid,1,false
  );
  if v_classic->>'status' is distinct from 'claimed' then
    raise exception 'Canary QA Classic Start was not admitted' using errcode='P0060';
  end if;
  insert into canary_qa_writer_private.classic_starts values(p_operation_id,p_instance_id);
  return v_claim;
end;
$$;

create function canary_qa_writer_private.finish_classic_start(p_operation_id uuid,p_outcome text)
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_instance_id uuid;
  v_owner_id text;
  v_classic jsonb;
begin
  select s.instance_id,d.owner_id into strict v_instance_id,v_owner_id
    from canary_qa_writer_private.classic_starts s join canary_qa_writer_private.dispatches d using (operation_id)
    where operation_id=p_operation_id;
  v_classic := public.finish_hermes_instance_start_bridge_v1(v_instance_id,v_owner_id,p_operation_id,
    case when p_outcome='performed' then 'started' else 'not_started' end);
  if v_classic->>'status' is distinct from (case when p_outcome='performed' then 'awake' else 'released' end) then
    raise exception 'Canary QA Classic Start settlement could not be confirmed' using errcode='P0060';
  end if;
end;
$$;

create function public.finish_canary_qa_classic_start(p_operation_id uuid,p_outcome text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_receipt jsonb;
begin
  if managed_launch_bridge_private.lock_epoch() is distinct from 'placement' then
    return jsonb_build_object('status','denied');
  end if;
  v_receipt := canary_qa_writer_private.finish_dispatch(p_operation_id,p_outcome,true);
  if v_receipt->>'status'='settled' then
    perform canary_qa_writer_private.finish_classic_start(p_operation_id,p_outcome);
  end if;
  return v_receipt;
end;
$$;

create function canary_qa_writer_private.settle_closed_classic_start(
  p_owner_id text,p_host_id text,p_vmid integer,p_instance_id uuid,p_operation_id uuid,p_outcome text
) returns boolean language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_scope canary_qa_writer_private.scope%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed'
    or canary_qa_writer_private.request_role()<>session_user::text
    or session_user<>(select pg_get_userbyid(relowner) from pg_class
      where oid='canary_qa_writer_private.scope'::regclass) then
    raise exception 'Canary QA Classic Start settlement requires the migration owner in READ COMMITTED' using errcode='42501';
  end if;
  if managed_launch_bridge_private.lock_epoch() is distinct from 'placement' then return false; end if;
  select * into strict v_scope from canary_qa_writer_private.scope where singleton for update;
  if (v_scope.owner_id,v_scope.host_id,v_scope.vmid) is distinct from (p_owner_id,p_host_id,p_vmid)
    or v_scope.principal is not null or coalesce(p_outcome,'') not in ('performed','refused') then return false; end if;
  update canary_qa_writer_private.dispatches d set outcome=p_outcome,settled_at=clock_timestamp()
    where d.operation_id=p_operation_id and d.owner_id=p_owner_id and d.host_id=p_host_id and d.vmid=p_vmid
      and d.outcome is null and exists(select 1 from canary_qa_writer_private.classic_starts s
        where s.operation_id=d.operation_id and s.instance_id=p_instance_id);
  if not found then return false; end if;
  perform set_config('hivra.canary_qa_classic_settlement',pg_current_xact_id()::text||':'||p_instance_id::text,true);
  perform canary_qa_writer_private.finish_classic_start(p_operation_id,p_outcome);
  perform set_config('hivra.canary_qa_classic_settlement','',true);
  return true;
end;
$$;

revoke all on canary_qa_writer_private.classic_starts from public,anon,authenticated,service_role;
revoke all on all functions in schema canary_qa_writer_private from public,anon,authenticated,service_role;
revoke all on function public.claim_canary_qa_classic_start(uuid,text,text,integer,text,uuid),
  public.finish_canary_qa_classic_start(uuid,text) from public,anon,authenticated,service_role;
