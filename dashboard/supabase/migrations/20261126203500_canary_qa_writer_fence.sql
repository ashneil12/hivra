create schema canary_qa_writer_private;
revoke all on schema canary_qa_writer_private from public,anon,authenticated,service_role;

create table canary_qa_writer_private.scope (
  singleton boolean primary key check (singleton),
  owner_id text,
  host_id text,
  vmid integer check (vmid between 100 and 999999999),
  principal text check (principal ~ '^hivra_canary_qa_[a-z0-9]{1,40}$'),
  expires_at timestamptz,
  check ((principal is null) = (expires_at is null)),
  check ((owner_id is null and host_id is null and vmid is null and principal is null)
    or (owner_id is not null and host_id is not null and vmid is not null))
);
insert into canary_qa_writer_private.scope(singleton) values (true);

create table canary_qa_writer_private.generations (
  principal text primary key check (principal ~ '^hivra_canary_qa_[a-z0-9]{1,40}$'),
  opened_at timestamptz not null default clock_timestamp()
);

create table canary_qa_writer_private.dispatches (
  operation_id uuid primary key,
  owner_id text not null,
  host_id text not null,
  vmid integer not null,
  principal text not null references canary_qa_writer_private.generations(principal),
  action text not null check (action in ('create','start','resize')),
  claimed_at timestamptz not null default clock_timestamp(),
  outcome text check (outcome in ('performed','refused')),
  settled_at timestamptz,
  check ((outcome is null) = (settled_at is null))
);
create unique index canary_qa_one_pending_dispatch on canary_qa_writer_private.dispatches(owner_id)
  where outcome is null;
revoke all on all tables in schema canary_qa_writer_private from public,anon,authenticated,service_role;

create function canary_qa_writer_private.request_role()
returns text language sql stable set search_path=pg_catalog,pg_temp as $$
  select coalesce(nullif(current_setting('role',true),'none'),session_user::text);
$$;

create function canary_qa_writer_private.guard_owner()
returns trigger language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_before text;
  v_after text;
  v_role text := canary_qa_writer_private.request_role();
  v_is_qa boolean := v_role ~ '^hivra_canary_qa_[a-z0-9]{1,40}$';
  v_scope canary_qa_writer_private.scope%rowtype;
begin
  if tg_op<>'INSERT' and tg_op<>'TRUNCATE' then v_before := old.user_id; end if;
  if tg_op<>'DELETE' and tg_op<>'TRUNCATE' then v_after := new.user_id; end if;
  select * into strict v_scope from canary_qa_writer_private.scope where singleton;
  if v_scope.owner_id is null or v_scope.owner_id in (v_before,v_after) or v_is_qa or tg_op='TRUNCATE' then
    select * into strict v_scope from canary_qa_writer_private.scope where singleton for share;
  end if;
  if (v_scope.owner_id is not null and tg_op='TRUNCATE')
    or ((v_is_qa or v_scope.owner_id in (v_before,v_after)) and (
      v_scope.owner_id is null or not v_is_qa
      or v_role is distinct from v_scope.principal
      or v_scope.expires_at is null or v_scope.expires_at<=clock_timestamp()
      or (tg_op<>'INSERT' and v_before is distinct from v_scope.owner_id)
      or (tg_op<>'DELETE' and v_after is distinct from v_scope.owner_id)
    )) then
    raise exception 'Canary QA writer is not admitted for this owner' using errcode='P0060';
  end if;
  if v_is_qa and tg_op<>'TRUNCATE' then
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

do $$
declare
  relation text;
begin
  foreach relation in array array['hermes_instances','hivra_agents','hivra_launch_operations',
    'hivra_launch_model_requests','hivra_model_key_operations','hermes_computer_moves']
  loop
    execute format('create trigger guard_canary_qa_owner before insert or update or delete on public.%I
      for each row execute function canary_qa_writer_private.guard_owner()',relation);
    execute format('create trigger guard_canary_qa_bulk before truncate on public.%I
      for each statement execute function canary_qa_writer_private.guard_owner()',relation);
  end loop;
end;
$$;

create function canary_qa_writer_private.set_scope(
  p_owner_id text,p_host_id text,p_vmid integer,p_principal text,p_expires_at timestamptz
)
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_scope canary_qa_writer_private.scope%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Canary QA scope changes require READ COMMITTED' using errcode='25001';
  end if;
  if p_owner_id is null or p_owner_id !~ '^user_[A-Za-z0-9]{1,128}$'
    or p_host_id is null or p_host_id !~ '^[A-Za-z0-9_-]{1,64}$'
    or coalesce(p_vmid,0) not between 100 and 999999999
    or (p_principal is null) is distinct from (p_expires_at is null)
    or (p_principal is not null and (p_principal !~ '^hivra_canary_qa_[a-z0-9]{1,40}$'
      or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '1 hour'
      or not exists(select 1 from pg_roles r where rolname=p_principal and not rolsuper and not rolcanlogin
        and not rolcreaterole and not rolcreatedb and not rolreplication and not rolbypassrls
        and not exists(select 1 from pg_auth_members m where m.member=r.oid))
      or pg_has_role('service_role',p_principal,'MEMBER') or pg_has_role(p_principal,'service_role','MEMBER'))) then
    raise exception 'invalid Canary QA writer scope' using errcode='22023';
  end if;
  select * into strict v_scope from canary_qa_writer_private.scope where singleton for update;
  if v_scope.owner_id is not null and (v_scope.owner_id,v_scope.host_id,v_scope.vmid)
      is distinct from (p_owner_id,p_host_id,p_vmid) then
    raise exception 'the enrolled Canary QA owner and target cannot change';
  end if;
  if p_principal is not null and (
    v_scope.principal is not null
    or exists(select 1 from canary_qa_writer_private.dispatches d where d.owner_id=p_owner_id and d.outcome is null)
  ) then raise exception 'close and reconcile the Canary QA writer before opening a generation' using errcode='P0060'; end if;
  if p_principal is not null then
    insert into canary_qa_writer_private.generations(principal) values(p_principal) on conflict do nothing;
    if not found then raise exception 'a revoked Canary QA generation cannot reopen' using errcode='P0060'; end if;
  end if;
  update canary_qa_writer_private.scope set owner_id=p_owner_id,host_id=p_host_id,vmid=p_vmid,
    principal=p_principal,expires_at=p_expires_at where singleton;
end;
$$;

create function public.claim_canary_qa_dispatch(
  p_owner_id text,p_host_id text,p_vmid integer,p_action text,p_operation_id uuid
)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_scope canary_qa_writer_private.scope%rowtype;
  v_receipt canary_qa_writer_private.dispatches%rowtype;
  v_role text := canary_qa_writer_private.request_role();
begin
  select * into strict v_scope from canary_qa_writer_private.scope where singleton for share;
  if v_scope.owner_id is null or v_scope.owner_id is distinct from p_owner_id
    or v_scope.host_id is distinct from p_host_id or v_scope.vmid is distinct from p_vmid
    or v_role is distinct from v_scope.principal or v_scope.expires_at is null or v_scope.expires_at<=clock_timestamp()
    or coalesce(p_action,'') not in ('create','start','resize') or p_operation_id is null then
    return jsonb_build_object('status','denied');
  end if;
  insert into canary_qa_writer_private.dispatches(operation_id,owner_id,host_id,vmid,principal,action)
    values(p_operation_id,p_owner_id,p_host_id,p_vmid,v_role,p_action) on conflict do nothing;
  if not found then
    select * into v_receipt from canary_qa_writer_private.dispatches where operation_id=p_operation_id;
    if found then
      if (v_receipt.owner_id,v_receipt.host_id,v_receipt.vmid,v_receipt.action)
        is distinct from (p_owner_id,p_host_id,p_vmid,p_action) then return jsonb_build_object('status','denied'); end if;
      if v_receipt.outcome is not null then
        return jsonb_build_object('status','settled','operationId',p_operation_id,'outcome',v_receipt.outcome);
      end if;
    end if;
    return jsonb_build_object('status','pending');
  end if;
  return jsonb_build_object('status','claimed','ownerId',p_owner_id,'hostId',p_host_id,'vmid',p_vmid,
    'action',p_action,'operationId',p_operation_id);
end;
$$;

create function public.finish_canary_qa_dispatch(p_operation_id uuid,p_outcome text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_scope canary_qa_writer_private.scope%rowtype;
  v_role text := canary_qa_writer_private.request_role();
begin
  select * into strict v_scope from canary_qa_writer_private.scope where singleton for share;
  if v_role is distinct from v_scope.principal or v_scope.expires_at is null or v_scope.expires_at<=clock_timestamp()
    or coalesce(p_outcome,'') not in ('performed','refused') then
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

create function canary_qa_writer_private.settle_closed_dispatch(
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
      and action=p_action and outcome is null;
  return found;
end;
$$;

revoke all on all functions in schema canary_qa_writer_private from public,anon,authenticated,service_role;
revoke all on function public.claim_canary_qa_dispatch(text,text,integer,text,uuid),
  public.finish_canary_qa_dispatch(uuid,text) from public,anon,authenticated,service_role;
