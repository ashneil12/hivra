-- Owner-bound private network access for current Hivra Proxmox Ubuntu computers.
-- Enrollment secrets never enter these tables. Observations are tied to the
-- exact infrastructure authority that was proven before the guest command.

alter table public.hivra_agents drop constraint hivra_agents_operation_shape_check;
alter table public.hivra_agents add constraint hivra_agents_operation_shape_check check (
  (operation_id is null and operation_kind is null and operation_started_at is null and operation_payload is null)
  or (operation_id is not null and operation_kind is not null and operation_kind in
    ('provision','start','stop','restart','resize','snapshot','restore','delete','desktop_prepare','agent_attach','private_access')
    and operation_started_at is not null and (operation_payload is null or jsonb_typeof(operation_payload)='object'))
);

create table public.hivra_private_access_connections (
  agent_id uuid primary key references public.hivra_agents(id) on delete cascade,
  user_id text not null check (char_length(user_id) between 1 and 256),
  authority jsonb not null check (jsonb_typeof(authority)='object'),
  kind text not null default 'tailscale' check (kind='tailscale'),
  state text not null check (state in ('connected','disconnected','unknown','error')),
  machine_name text check (machine_name is null or char_length(machine_name) between 1 and 253),
  magic_dns_name text check (magic_dns_name is null or char_length(magic_dns_name) between 1 and 253),
  tailnet_name text check (tailnet_name is null or char_length(tailnet_name) between 1 and 253),
  login_server text not null check (login_server ~ '^https://[^/?#]+$'),
  ipv4 inet check (ipv4 is null or family(ipv4)=4),
  ipv6 inet check (ipv6 is null or family(ipv6)=6),
  ssh_enabled boolean not null default false check (ssh_enabled=false),
  connected_at timestamptz,
  observed_at timestamptz not null,
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9_]{1,64}$'),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.hivra_private_access_operations (
  id uuid primary key,
  agent_id uuid not null references public.hivra_agents(id) on delete cascade,
  user_id text not null check (char_length(user_id) between 1 and 256),
  action text not null check (action in ('connect','disconnect')),
  login_server text not null check (login_server ~ '^https://[^/?#]+$'),
  authority jsonb not null check (jsonb_typeof(authority)='object'),
  phase text not null check (phase in ('claimed','dispatched','complete','failed')),
  terminal_receipt jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check ((phase in ('claimed','dispatched') and completed_at is null and terminal_receipt is null)
    or (phase in ('complete','failed') and completed_at is not null and jsonb_typeof(terminal_receipt)='object'))
);
create unique index hivra_private_access_one_active
  on public.hivra_private_access_operations(agent_id) where phase in ('claimed','dispatched');

alter table public.hivra_private_access_connections enable row level security;
alter table public.hivra_private_access_operations enable row level security;
revoke all on public.hivra_private_access_connections from public,anon,authenticated,service_role;
revoke all on public.hivra_private_access_operations from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.hivra_private_access_connections to service_role;
grant select on public.hivra_private_access_operations to service_role;

create function public.hivra_private_access_authority(a public.hivra_agents)
returns jsonb language sql immutable security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object('id',(a).id,'user_id',(a).user_id,'type',(a).type,
    'computer_profile',(a).computer_profile,'computer_substrate',(a).computer_substrate,
    'deployment_mode',(a).deployment_mode,'proxmox_host',(a).proxmox_host,
    'infrastructure_connection_id',(a).infrastructure_connection_id,'deployment_target_id',(a).deployment_target_id,
    'infrastructure_connection_revision',(a).infrastructure_connection_revision,
    'infrastructure_binding_token_hash',(a).infrastructure_binding_token_hash,
    'infrastructure_binding_token_enforced',(a).infrastructure_binding_token_enforced,
    'vmid',(a).vmid,'ip',(a).ip,
    'managed_provisioner_channel',coalesce(to_jsonb(a)->>'managed_provisioner_channel','default'));
$$;

create function public.hivra_private_access_binding_ready(a public.hivra_agents)
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

create function public.guard_hivra_private_access_lease()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.hivra_private_access_operations%rowtype;
begin
  select * into p from public.hivra_private_access_operations where agent_id=old.id and phase in ('claimed','dispatched');
  if not found then return new; end if;
  if public.hivra_private_access_authority(new) is distinct from p.authority
    or new.operation_id is distinct from p.id or new.operation_kind is distinct from 'private_access'
    or new.operation_payload is distinct from jsonb_build_object('privateAccessOperationId',p.id::text)
    or new.status is distinct from 'running' or new.desired_state is null or new.desired_state not in ('running','deleted')
  then raise exception 'private access requires terminal evidence before lease release' using errcode='55000'; end if;
  return new;
end;
$$;
create trigger hivra_private_access_lease_guard before update on public.hivra_agents
  for each row execute function public.guard_hivra_private_access_lease();

create function public.begin_hivra_private_access_operation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_action text,p_login_server text,p_expected_authority jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype;
begin
  if p_user_id is null or p_agent_id is null or p_operation_id is null
    or p_action not in ('connect','disconnect') or p_login_server !~ '^https://[^/?#]+$'
    or jsonb_typeof(p_expected_authority)<>'object' then return false; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or public.hivra_private_access_authority(a) is distinct from p_expected_authority
    or a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or a.operation_id is not null or a.infrastructure_binding_token_enforced is distinct from true
    or a.computer_substrate is distinct from 'proxmox-kvm' or a.type is distinct from 'linux-desktop'
    or coalesce(a.computer_profile,'ubuntu-desktop')<>'ubuntu-desktop' or a.vmid is null or a.ip is null
    or not public.hivra_private_access_binding_ready(a) then return false; end if;
  update public.hivra_agents set operation_id=p_operation_id,operation_kind='private_access',
    operation_started_at=clock_timestamp(),operation_payload=jsonb_build_object('privateAccessOperationId',p_operation_id::text),error=null
    where id=a.id;
  insert into public.hivra_private_access_operations(id,agent_id,user_id,action,login_server,authority,phase)
    values(p_operation_id,a.id,p_user_id,p_action,p_login_server,p_expected_authority,'claimed');
  return true;
end;
$$;

create function public.dispatch_hivra_private_access_operation(p_user_id text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_private_access_operations%rowtype;
begin
  select * into p from public.hivra_private_access_operations where id=p_operation_id and user_id=p_user_id for update;
  if not found or p.phase<>'claimed' then return false; end if;
  select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'private_access'
    or a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or public.hivra_private_access_authority(a) is distinct from p.authority
    or not public.hivra_private_access_binding_ready(a) then return false; end if;
  update public.hivra_private_access_operations set phase='dispatched' where id=p.id;
  return true;
end;
$$;

create function public.cancel_undispatched_hivra_private_access_operation(p_user_id text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_private_access_operations%rowtype;
begin
  select * into p from public.hivra_private_access_operations where id=p_operation_id and user_id=p_user_id for update;
  if not found or p.phase<>'claimed' then return false; end if;
  select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'private_access'
    or public.hivra_private_access_authority(a) is distinct from p.authority then return false; end if;
  update public.hivra_private_access_operations set phase='failed',completed_at=clock_timestamp(),
    terminal_receipt=jsonb_build_object('state','error','observedAt',clock_timestamp(),'sshEnabled',false,
      'loginServer',p.login_server,'failureCode','dispatch_cancelled') where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=a.id;
  return true;
end;
$$;

create function public.complete_hivra_private_access_operation(
  p_user_id text,p_operation_id uuid,p_success boolean,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_private_access_operations%rowtype;
  s text; observed timestamptz;
begin
  if jsonb_typeof(p_receipt)<>'object' or p_receipt ? 'authKey' then return false; end if;
  select * into p from public.hivra_private_access_operations where id=p_operation_id and user_id=p_user_id for update;
  if not found then return false; end if;
  if p.phase in ('complete','failed') then return p.terminal_receipt=p_receipt; end if;
  select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
  if not found or p.phase<>'dispatched' or a.operation_id is distinct from p.id
    or a.operation_kind is distinct from 'private_access'
    or public.hivra_private_access_authority(a) is distinct from p.authority then return false; end if;
  s := p_receipt->>'state'; observed := (p_receipt->>'observedAt')::timestamptz;
  if s not in ('connected','disconnected','unknown','error') or observed is null
    or coalesce((p_receipt->>'sshEnabled')::boolean,false) then return false; end if;
  if s='disconnected' then
    delete from public.hivra_private_access_connections where agent_id=a.id and user_id=p_user_id;
  else
    insert into public.hivra_private_access_connections(agent_id,user_id,authority,state,machine_name,magic_dns_name,
      tailnet_name,login_server,ipv4,ipv6,ssh_enabled,connected_at,observed_at,failure_code,updated_at)
    values(a.id,p_user_id,p.authority,s,nullif(p_receipt->>'machineName',''),nullif(p_receipt->>'magicDnsName',''),
      nullif(p_receipt->>'tailnetName',''),p_receipt->>'loginServer',nullif(p_receipt->>'ipv4','')::inet,nullif(p_receipt->>'ipv6','')::inet,false,
      nullif(p_receipt->>'connectedAt','')::timestamptz,observed,nullif(p_receipt->>'failureCode',''),clock_timestamp())
    on conflict(agent_id) do update set user_id=excluded.user_id,authority=excluded.authority,state=excluded.state,
      machine_name=excluded.machine_name,magic_dns_name=excluded.magic_dns_name,tailnet_name=excluded.tailnet_name,
      login_server=excluded.login_server,ipv4=excluded.ipv4,ipv6=excluded.ipv6,ssh_enabled=false,connected_at=excluded.connected_at,
      observed_at=excluded.observed_at,failure_code=excluded.failure_code,updated_at=clock_timestamp();
  end if;
  update public.hivra_private_access_operations set phase=case when p_success then 'complete' else 'failed' end,
    terminal_receipt=p_receipt,completed_at=clock_timestamp() where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
exception when invalid_text_representation or datetime_field_overflow then return false;
end;
$$;

create function public.record_hivra_private_access_observation(
  p_user_id text,p_agent_id uuid,p_expected_authority jsonb,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; s text; observed timestamptz;
begin
  if jsonb_typeof(p_receipt)<>'object' or p_receipt ? 'authKey' then return false; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for key share;
  if not found or public.hivra_private_access_authority(a) is distinct from p_expected_authority then return false; end if;
  s := p_receipt->>'state'; observed := (p_receipt->>'observedAt')::timestamptz;
  if s not in ('connected','disconnected','unknown','error') or observed is null
    or coalesce((p_receipt->>'sshEnabled')::boolean,false) then return false; end if;
  if s='disconnected' then delete from public.hivra_private_access_connections where agent_id=a.id and user_id=p_user_id;
  else insert into public.hivra_private_access_connections(agent_id,user_id,authority,state,machine_name,magic_dns_name,
    tailnet_name,login_server,ipv4,ipv6,ssh_enabled,connected_at,observed_at,failure_code,updated_at)
    values(a.id,p_user_id,p_expected_authority,s,nullif(p_receipt->>'machineName',''),nullif(p_receipt->>'magicDnsName',''),
      nullif(p_receipt->>'tailnetName',''),p_receipt->>'loginServer',nullif(p_receipt->>'ipv4','')::inet,nullif(p_receipt->>'ipv6','')::inet,false,
      nullif(p_receipt->>'connectedAt','')::timestamptz,observed,nullif(p_receipt->>'failureCode',''),clock_timestamp())
    on conflict(agent_id) do update set authority=excluded.authority,state=excluded.state,machine_name=excluded.machine_name,
      magic_dns_name=excluded.magic_dns_name,tailnet_name=excluded.tailnet_name,login_server=excluded.login_server,ipv4=excluded.ipv4,ipv6=excluded.ipv6,
      ssh_enabled=false,connected_at=excluded.connected_at,observed_at=excluded.observed_at,
      failure_code=excluded.failure_code,updated_at=clock_timestamp(); end if;
  return true;
exception when invalid_text_representation or datetime_field_overflow then return false;
end;
$$;

create function public.clear_hivra_private_access_after_delete(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and desired_state='deleted' and operation_id=p_operation_id and operation_kind in ('delete','provision')) then return false; end if;
  delete from public.hivra_private_access_connections where agent_id=p_agent_id and user_id=p_user_id;
  return true;
end;
$$;

revoke all on function public.hivra_private_access_authority(public.hivra_agents),
  public.hivra_private_access_binding_ready(public.hivra_agents),public.guard_hivra_private_access_lease(),
  public.begin_hivra_private_access_operation(text,uuid,uuid,text,text,jsonb),
  public.dispatch_hivra_private_access_operation(text,uuid),
  public.cancel_undispatched_hivra_private_access_operation(text,uuid),
  public.complete_hivra_private_access_operation(text,uuid,boolean,jsonb),
  public.record_hivra_private_access_observation(text,uuid,jsonb,jsonb),
  public.clear_hivra_private_access_after_delete(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_hivra_private_access_operation(text,uuid,uuid,text,text,jsonb),
  public.dispatch_hivra_private_access_operation(text,uuid),
  public.cancel_undispatched_hivra_private_access_operation(text,uuid),
  public.complete_hivra_private_access_operation(text,uuid,boolean,jsonb),
  public.record_hivra_private_access_observation(text,uuid,jsonb,jsonb),
  public.clear_hivra_private_access_after_delete(text,uuid,uuid) to service_role;
