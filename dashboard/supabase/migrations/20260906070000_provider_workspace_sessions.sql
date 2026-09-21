-- Workspace grants over the existing provider computer identity/lifecycle.
-- No browser management bearer, new machine, launch admission or live runtime
-- capability is created by this migration. Route admission must first verify
-- the installed workspace protocol through the original pinned guest channel.
create table public.hivra_workspace_sessions (
  id uuid primary key,
  user_id text not null check (char_length(user_id) between 1 and 256),
  computer_id uuid not null references public.hivra_agents(id) on delete cascade,
  surface text not null check (surface in ('files','box-terminal')),
  audience text not null,
  allocation_operation_id uuid not null,
  connection_id uuid not null,
  connection_revision bigint not null,
  target_id uuid not null,
  order_id uuid not null,
  enrollment_attempt_id uuid not null,
  provider_server_id text not null,
  identity jsonb not null,
  access jsonb not null,
  exchange_hash text not null unique check (exchange_hash ~ '^[a-f0-9]{64}$'),
  pkce_challenge text not null check (pkce_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  token_hash text unique check (token_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz not null,
  exchange_expires_at timestamptz not null,
  expires_at timestamptz not null,
  exchanged_at timestamptz,
  revoked_at timestamptz,
  check (exchange_expires_at>issued_at and exchange_expires_at<=issued_at+interval '60 seconds'),
  check (expires_at>exchange_expires_at and expires_at<=issued_at+interval '4 minutes'),
  check ((exchanged_at is null)=(token_hash is null)),
  check (audience='https://'||(access->>'hostname'))
);
create index hivra_workspace_sessions_owner on public.hivra_workspace_sessions(user_id,computer_id,expires_at);
alter table public.hivra_workspace_sessions enable row level security;
revoke all on public.hivra_workspace_sessions from public,anon,authenticated,service_role;
grant select on public.hivra_workspace_sessions to service_role;

-- The same running allocation, enrolled connection and original prepared target
-- must still exist. Neither an identical hostname nor running UI text is proof.
create function public.hivra_workspace_binding_current(s public.hivra_workspace_sessions)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.hivra_agents a
    join public.infrastructure_connections c on c.id=a.infrastructure_connection_id
    join public.infrastructure_capacity_orders o on o.id=a.provider_capacity_order_id
    join public.deployment_targets t on t.id=a.deployment_target_id
    join public.infrastructure_first_boot_enrollments e on e.attempt_id=a.provider_enrollment_attempt_id
    where a.id=s.computer_id and a.user_id=s.user_id
      and a.computer_substrate='provider-vm' and a.deployment_mode='self-managed'
      and a.proxmox_host='__hivra_self_managed_no_ambient_authority__'
      and a.type='linux-desktop' and a.computer_profile='ubuntu-desktop' and a.vmid is null
      and a.status='running' and a.desired_state='running' and a.operation_id is null and a.operation_kind is null
      and a.api_token is null and a.provider_install_outcome='succeeded' and a.provider_install_stopped_at is not null
      and a.allocation_operation_id=s.allocation_operation_id
      and a.infrastructure_connection_id=s.connection_id and a.infrastructure_connection_revision=s.connection_revision
      and a.provider_capacity_order_id=s.order_id and a.deployment_target_id=s.target_id
      and a.provider_enrollment_attempt_id=s.enrollment_attempt_id and a.provider_server_id=s.provider_server_id
      and a.provider_install_identity=s.identity and a.provider_install_desktop_access=s.access
      and public.hivra_provider_desktop_identity_valid(s.identity,a.id,a.allocation_operation_id)
      and public.hivra_provider_desktop_access_matches(s.access,a) and a.chat_url=s.audience
      and c.user_id=s.user_id and c.revision=s.connection_revision and c.status='ready' and c.provider='hetzner-cloud'
      and o.user_id=s.user_id and o.connection_id=c.id and o.active_connection_id=c.id
      and o.connection_revision=c.revision and o.status='created_off' and o.provider_resource_id=a.provider_server_id
      and t.user_id=s.user_id and t.connection_id=c.id and t.evidence_connection_revision=c.revision
      and t.provider_capacity_order_id=o.id and t.external_id=a.provider_server_id
      and t.provider_retired_at is null
      and e.user_id=s.user_id and e.order_id=o.id and e.connection_id=c.id and e.connection_revision=c.revision
      and e.provider_server_id=s.provider_server_id and e.phase='enrolled'
      and e.enrolled_at>=e.issued_at and e.enrolled_at<e.expires_at);
$$;

create function public.issue_hivra_workspace_session(p_user text,p_computer uuid,p_id uuid,p_surface text,
  p_audience text,p_identity jsonb,p_access jsonb,p_exchange_hash text,p_challenge text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; s public.hivra_workspace_sessions%rowtype; stamp timestamptz:=clock_timestamp();
begin
  if p_id is null or p_user is null or char_length(p_user) not between 1 and 256
    or p_surface is null or p_surface not in ('files','box-terminal')
    or p_exchange_hash is null or p_exchange_hash !~ '^[a-f0-9]{64}$'
    or p_challenge is null or p_challenge !~ '^[A-Za-z0-9_-]{43}$'
    then return jsonb_build_object('status','invalid'); end if;
  select * into a from public.hivra_agents where id=p_computer and user_id=p_user for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  s.id:=p_id; s.user_id:=p_user; s.computer_id:=p_computer; s.surface:=p_surface; s.audience:=p_audience;
  s.allocation_operation_id:=a.allocation_operation_id; s.connection_id:=a.infrastructure_connection_id;
  s.connection_revision:=a.infrastructure_connection_revision; s.target_id:=a.deployment_target_id;
  s.order_id:=a.provider_capacity_order_id; s.identity:=p_identity; s.access:=p_access;
  s.enrollment_attempt_id:=a.provider_enrollment_attempt_id; s.provider_server_id:=a.provider_server_id;
  s.exchange_hash:=p_exchange_hash; s.pkce_challenge:=p_challenge;
  s.issued_at:=stamp; s.exchange_expires_at:=stamp+interval '60 seconds'; s.expires_at:=stamp+interval '4 minutes';
  if not public.hivra_workspace_binding_current(s) then return jsonb_build_object('status','computer_not_ready'); end if;
  if (select count(*) from public.hivra_workspace_sessions where computer_id=p_computer and user_id=p_user
    and revoked_at is null and expires_at>stamp)>=64 then return jsonb_build_object('status','limit'); end if;
  insert into public.hivra_workspace_sessions select s.* on conflict do nothing;
  if not found then return jsonb_build_object('status','conflict'); end if;
  return jsonb_build_object('status','issued','sessionId',s.id,'expiresAt',s.expires_at,'exchangeExpiresAt',s.exchange_expires_at);
end;
$$;

create function public.exchange_hivra_workspace_session(p_id uuid,p_computer uuid,p_surface text,p_audience text,
  p_exchange_hash text,p_challenge text,p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.hivra_workspace_sessions%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status','invalid'); end if;
  select * into s from public.hivra_workspace_sessions where id=p_id and computer_id=p_computer
    and surface=p_surface and audience=p_audience and exchange_hash=p_exchange_hash and pkce_challenge=p_challenge for update;
  if not found then return jsonb_build_object('status','denied'); end if;
  if s.revoked_at is not null or s.exchanged_at is not null or s.exchange_expires_at<=clock_timestamp()
    or s.expires_at<=clock_timestamp() or not public.hivra_workspace_binding_current(s)
    then return jsonb_build_object('status','denied'); end if;
  update public.hivra_workspace_sessions set token_hash=p_token_hash,exchanged_at=clock_timestamp() where id=s.id;
  return jsonb_build_object('status','exchanged','sessionId',s.id,'computerId',s.computer_id,
    'userId',s.user_id,'surface',s.surface,'audience',s.audience,'expiresAt',s.expires_at);
end;
$$;

create function public.authorize_hivra_workspace_session(p_id uuid,p_computer uuid,p_surface text,p_audience text,p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.hivra_workspace_sessions%rowtype;
begin
  select * into s from public.hivra_workspace_sessions where id=p_id and computer_id=p_computer
    and surface=p_surface and audience=p_audience and token_hash=p_token_hash;
  if not found or s.exchanged_at is null or s.revoked_at is not null or s.expires_at<=clock_timestamp()
    or not public.hivra_workspace_binding_current(s) then return jsonb_build_object('status','denied'); end if;
  return jsonb_build_object('status','authorized','sessionId',s.id,'computerId',s.computer_id,
    'userId',s.user_id,'surface',s.surface,'audience',s.audience,'expiresAt',s.expires_at);
end;
$$;

create function public.revoke_hivra_workspace_session(p_user text,p_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.hivra_workspace_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=p_id and user_id=p_user;
  return found;
end;
$$;

revoke all on function public.hivra_workspace_binding_current(public.hivra_workspace_sessions) from public,anon,authenticated;
revoke all on function public.issue_hivra_workspace_session(text,uuid,uuid,text,text,jsonb,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.exchange_hivra_workspace_session(uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.authorize_hivra_workspace_session(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.revoke_hivra_workspace_session(text,uuid) from public,anon,authenticated;
grant execute on function public.issue_hivra_workspace_session(text,uuid,uuid,text,text,jsonb,jsonb,text,text) to service_role;
grant execute on function public.exchange_hivra_workspace_session(uuid,uuid,text,text,text,text,text) to service_role;
grant execute on function public.authorize_hivra_workspace_session(uuid,uuid,text,text,text) to service_role;
grant execute on function public.revoke_hivra_workspace_session(text,uuid) to service_role;

-- A later return to running must not resurrect pre-restart or pre-stop grants.
create function public.invalidate_hivra_workspace_sessions_on_agent_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if row(old.user_id,old.status,old.desired_state,old.operation_id,old.operation_kind,
    old.allocation_operation_id,old.infrastructure_connection_id,old.infrastructure_connection_revision,
    old.deployment_target_id,old.provider_capacity_order_id,old.provider_enrollment_attempt_id,
    old.provider_server_id,old.provider_install_identity,old.provider_install_desktop_access,old.chat_url)
    is distinct from row(new.user_id,new.status,new.desired_state,new.operation_id,new.operation_kind,
    new.allocation_operation_id,new.infrastructure_connection_id,new.infrastructure_connection_revision,
    new.deployment_target_id,new.provider_capacity_order_id,new.provider_enrollment_attempt_id,
    new.provider_server_id,new.provider_install_identity,new.provider_install_desktop_access,new.chat_url) then
    update public.hivra_workspace_sessions set revoked_at=clock_timestamp() where computer_id=old.id and revoked_at is null;
  end if;
  return new;
end;
$$;
revoke all on function public.invalidate_hivra_workspace_sessions_on_agent_change() from public,anon,authenticated;
create trigger invalidate_hivra_workspace_sessions after update on public.hivra_agents
for each row execute function public.invalidate_hivra_workspace_sessions_on_agent_change();

create function public.invalidate_hivra_workspace_sessions_on_connection_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if row(old.user_id,old.status,old.revision,old.provider) is distinct from row(new.user_id,new.status,new.revision,new.provider) then
    update public.hivra_workspace_sessions set revoked_at=clock_timestamp() where connection_id=old.id and revoked_at is null;
  end if;
  return new;
end;
$$;
revoke all on function public.invalidate_hivra_workspace_sessions_on_connection_change() from public,anon,authenticated;
create trigger invalidate_hivra_workspace_sessions after update on public.infrastructure_connections
for each row execute function public.invalidate_hivra_workspace_sessions_on_connection_change();
