-- Desktop preparation shares the existing per-computer lifecycle lease. A
-- dispatched, uncertain guest installer cannot be cleared by generic recovery.
alter table public.hivra_agents drop constraint hivra_agents_operation_shape_check;
alter table public.hivra_agents add constraint hivra_agents_operation_shape_check check (
  (operation_id is null and operation_kind is null and operation_started_at is null and operation_payload is null)
  or (operation_id is not null and operation_kind is not null and operation_kind in
    ('provision','start','stop','restart','resize','snapshot','restore','delete','desktop_prepare')
    and operation_started_at is not null and (operation_payload is null or jsonb_typeof(operation_payload)='object'))
);

create table public.hivra_desktop_preparations (
  id uuid primary key, agent_id uuid not null references public.hivra_agents(id), user_id text not null,
  authority jsonb not null check (jsonb_typeof(authority)='object'),
  phase text not null check (phase in ('claimed','dispatched','complete','failed','cancelled')),
  created_at timestamptz not null default clock_timestamp(), completed_at timestamptz, terminal_receipt jsonb,
  check ((phase in ('claimed','dispatched') and completed_at is null and terminal_receipt is null)
    or (phase='cancelled' and completed_at is not null and terminal_receipt is null)
    or (phase in ('complete','failed') and completed_at is not null and jsonb_typeof(terminal_receipt) is not distinct from 'object'))
);
create unique index hivra_desktop_preparations_one_active on public.hivra_desktop_preparations(agent_id)
  where phase in ('claimed','dispatched');
alter table public.hivra_desktop_preparations enable row level security;
revoke all on public.hivra_desktop_preparations from public,anon,authenticated,service_role;
grant select on public.hivra_desktop_preparations to service_role;

create function public.hivra_desktop_prepare_authority(a public.hivra_agents)
returns jsonb language sql immutable security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object('id',(a).id,'user_id',(a).user_id,'type',(a).type,
    'computer_profile',(a).computer_profile,'computer_substrate',(a).computer_substrate,
    'deployment_mode',(a).deployment_mode,'proxmox_host',(a).proxmox_host,
    'infrastructure_connection_id',(a).infrastructure_connection_id,'deployment_target_id',(a).deployment_target_id,
    'infrastructure_connection_revision',(a).infrastructure_connection_revision,
    'infrastructure_binding_token_hash',(a).infrastructure_binding_token_hash,
    'infrastructure_binding_token_enforced',(a).infrastructure_binding_token_enforced,
    'vmid',(a).vmid,'ip',(a).ip,'chat_url',(a).chat_url,
    'managed_provisioner_channel',coalesce(to_jsonb(a)->>'managed_provisioner_channel','default'));
$$;

create function public.guard_hivra_desktop_prepare_lease()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.hivra_desktop_preparations%rowtype;
begin
  select * into p from public.hivra_desktop_preparations where agent_id=old.id and phase in ('claimed','dispatched');
  if not found then return new; end if;
  if public.hivra_desktop_prepare_authority(new) is distinct from p.authority
    or new.operation_id is distinct from p.id or new.operation_kind is distinct from 'desktop_prepare'
    or new.operation_payload is distinct from jsonb_build_object('desktopPrepareId',p.id::text)
    or new.status is distinct from 'running' or new.desired_state is null or new.desired_state not in ('running','deleted')
    or (old.desired_state='deleted' and new.desired_state is distinct from 'deleted')
  then raise exception 'desktop preparation requires exact terminal evidence before lease release' using errcode='55000'; end if;
  return new;
end;
$$;
create trigger hivra_desktop_prepare_lease_guard before update on public.hivra_agents
  for each row execute function public.guard_hivra_desktop_prepare_lease();

-- Match ordinary lifecycle admission, including a fresh connection/target
-- revision check at dispatch after any staging delay. Completion deliberately
-- needs only the unchanged recorded identity, so cleanup remains possible.
create function public.hivra_desktop_prepare_binding_ready(a public.hivra_agents)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if a.deployment_mode='hivra-managed' then return true; end if;
  if a.deployment_mode is distinct from 'self-managed' then return false; end if;
  perform 1 from public.infrastructure_connections where id=a.infrastructure_connection_id and user_id=a.user_id
    and status='ready' and revision=a.infrastructure_connection_revision for key share;
  if not found then return false; end if;
  perform 1 from public.deployment_targets where id=a.deployment_target_id and user_id=a.user_id
    and connection_id=a.infrastructure_connection_id and status='ready'
    and evidence_connection_revision=a.infrastructure_connection_revision
    and capabilities @> '{"launchReady":true}'::jsonb and isolation_class='hardware-vm' for key share;
  return found;
end;
$$;

create function public.begin_hivra_desktop_prepare(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_expected_authority jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_desktop_preparations%rowtype;
begin
  if p_user_id is null or p_agent_id is null or p_operation_id is null or p_expected_authority is null then return null; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority
    or a.status is distinct from 'running' or a.infrastructure_binding_token_enforced is distinct from true
    or a.computer_substrate is distinct from 'proxmox-kvm' or a.type is distinct from 'linux-desktop'
    or coalesce(a.computer_profile,'ubuntu-desktop')<>'ubuntu-desktop' or a.vmid is null or a.ip is null
  then return null; end if;
  if a.operation_id is not null then
    select * into p from public.hivra_desktop_preparations where id=a.operation_id and user_id=p_user_id
      and agent_id=a.id and authority=p_expected_authority and phase in ('claimed','dispatched');
    if found and a.operation_kind='desktop_prepare' then
      return jsonb_build_object('operationId',p.id,'phase',p.phase,'resumed',true);
    end if;
    return null;
  end if;
  if a.desired_state is distinct from 'running' or not public.hivra_desktop_prepare_binding_ready(a) then return null; end if;
  update public.hivra_agents set operation_id=p_operation_id,operation_kind='desktop_prepare',
    operation_started_at=clock_timestamp(),operation_payload=jsonb_build_object('desktopPrepareId',p_operation_id::text),error=null
    where id=a.id;
  insert into public.hivra_desktop_preparations(id,agent_id,user_id,authority,phase)
    values(p_operation_id,a.id,p_user_id,p_expected_authority,'claimed');
  return jsonb_build_object('operationId',p_operation_id,'phase','claimed','resumed',false);
end;
$$;

create function public.dispatch_hivra_desktop_prepare(p_user_id text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_desktop_preparations%rowtype;
begin
  select * into p from public.hivra_desktop_preparations where id=p_operation_id and user_id=p_user_id;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'desktop_prepare'
    or a.desired_state is distinct from 'running' or a.status is distinct from 'running'
    or public.hivra_desktop_prepare_authority(a) is distinct from p.authority
    or not public.hivra_desktop_prepare_binding_ready(a) then return false; end if;
  update public.hivra_desktop_preparations set phase='dispatched' where id=p.id and phase='claimed';
  return found;
end;
$$;

create function public.cancel_undispatched_hivra_desktop_prepare(p_user_id text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_desktop_preparations%rowtype;
begin
  select * into p from public.hivra_desktop_preparations where id=p_operation_id and user_id=p_user_id;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'desktop_prepare'
    or public.hivra_desktop_prepare_authority(a) is distinct from p.authority then return false; end if;
  update public.hivra_desktop_preparations set phase='cancelled',completed_at=clock_timestamp()
    where id=p.id and phase='claimed';
  if not found then return false; end if;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=a.id;
  return true;
end;
$$;

create function public.complete_hivra_desktop_prepare(p_user_id text,p_operation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_desktop_preparations%rowtype; success boolean;
begin
  select * into p from public.hivra_desktop_preparations where id=p_operation_id and user_id=p_user_id;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
  if not found or public.hivra_desktop_prepare_authority(a) is distinct from p.authority then return false; end if;
  select * into p from public.hivra_desktop_preparations where id=p_operation_id for update;
  if p.phase in ('complete','failed') then return p.terminal_receipt=p_receipt; end if;
  if p.phase<>'dispatched' or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'desktop_prepare'
    or jsonb_typeof(p_receipt) is distinct from 'object'
    or p_receipt-array['version','operationId','computerId','vmid','guestIp','bindingTag','bootId','exitCode']<>'{}'::jsonb
    or p_receipt->'version' is distinct from '1'::jsonb or p_receipt->>'operationId' is distinct from p.id::text
    or p_receipt->>'computerId' is distinct from a.id::text or p_receipt->'vmid' is distinct from to_jsonb(a.vmid)
    or p_receipt->>'guestIp' is distinct from a.ip
    or p_receipt->>'bindingTag' is distinct from 'hivra-bind-'||left(a.infrastructure_binding_token_hash,32)
    or not coalesce(p_receipt->>'bootId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
    or jsonb_typeof(p_receipt->'exitCode') is distinct from 'number'
    or not coalesce(p_receipt->>'exitCode' ~ '^(0|[1-9][0-9]{0,2})$',false)
  then return false; end if;
  if (p_receipt->>'exitCode')::integer>255 then return false; end if;
  success=(p_receipt->>'exitCode')::integer=0;
  update public.hivra_desktop_preparations set phase=case when success then 'complete' else 'failed' end,
    completed_at=clock_timestamp(),terminal_receipt=p_receipt where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null,
    error=case when success then null else 'Desktop preparation failed. The guest installer stopped; inspect Desktop before retrying.' end
    where id=a.id;
  return true;
end;
$$;

revoke all on function public.hivra_desktop_prepare_authority(public.hivra_agents), public.guard_hivra_desktop_prepare_lease(),
  public.hivra_desktop_prepare_binding_ready(public.hivra_agents),
  public.begin_hivra_desktop_prepare(text,uuid,uuid,jsonb),public.dispatch_hivra_desktop_prepare(text,uuid),
  public.cancel_undispatched_hivra_desktop_prepare(text,uuid),public.complete_hivra_desktop_prepare(text,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.begin_hivra_desktop_prepare(text,uuid,uuid,jsonb),public.dispatch_hivra_desktop_prepare(text,uuid),
  public.cancel_undispatched_hivra_desktop_prepare(text,uuid),public.complete_hivra_desktop_prepare(text,uuid,jsonb) to service_role;
