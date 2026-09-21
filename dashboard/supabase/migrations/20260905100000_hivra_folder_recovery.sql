-- One bounded transfer: Ubuntu /home/bux/Hivra into another empty, freshly
-- provisioned identity. No VM cloning, source removal, secrets, or file bytes
-- are stored in this journal. Reuses the normal restore lifecycle fence.
create table public.hivra_folder_recoveries (
  id uuid primary key,
  user_id text not null,
  source_agent_id uuid not null references public.hivra_agents(id),
  destination_agent_id uuid not null unique references public.hivra_agents(id),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  source_binding_hash text not null check (source_binding_hash ~ '^[0-9a-f]{64}$'),
  destination_authority jsonb not null check (jsonb_typeof(destination_authority) = 'object'),
  revoke_source_sessions boolean not null check (revoke_source_sessions),
  status text not null default 'pending' check (status in ('pending', 'complete')),
  file_count integer check (file_count between 0 and 512),
  byte_count integer check (byte_count between 0 and 2097152),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check (source_agent_id <> destination_agent_id),
  check ((status = 'pending' and completed_at is null and file_count is null and byte_count is null)
    or (status = 'complete' and completed_at is not null and file_count is not null and byte_count is not null))
);
alter table public.hivra_folder_recoveries enable row level security;
revoke all on public.hivra_folder_recoveries from public, anon, authenticated, service_role;
grant select on public.hivra_folder_recoveries to service_role;

create function public.hivra_folder_recovery_authority(a public.hivra_agents)
returns jsonb language sql immutable security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'id', (a).id, 'user_id', (a).user_id, 'type', (a).type, 'profile', (a).computer_profile,
    'substrate', (a).computer_substrate, 'mode', (a).deployment_mode,
    'host', (a).proxmox_host, 'connection', (a).infrastructure_connection_id,
    'target', (a).deployment_target_id, 'revision', (a).infrastructure_connection_revision,
    'binding', (a).infrastructure_binding_token_hash, 'enforced', (a).infrastructure_binding_token_enforced,
    'vmid', (a).vmid, 'ip', (a).ip, 'chat_url', (a).chat_url, 'hostname', (a).cf_hostname,
    'tunnel', (a).cf_tunnel_id, 'token_hash', encode(sha256(convert_to(coalesce((a).api_token,''), 'UTF8')), 'hex')
  );
$$;

create function public.guard_hivra_folder_recovery_lease()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.hivra_folder_recoveries%rowtype;
begin
  select * into r from public.hivra_folder_recoveries where destination_agent_id=old.id;
  if not found or r.status='complete' then return new; end if;
  if public.hivra_folder_recovery_authority(new) is distinct from r.destination_authority
    or new.operation_id is distinct from r.id
    or new.operation_kind is distinct from 'restore'
    or new.operation_payload is distinct from jsonb_build_object('folderRecoveryId',r.id::text)
    or new.status is distinct from 'provisioning' or new.desired_state is distinct from 'running'
  then
    raise exception 'folder recovery requires verified completion before another lifecycle operation'
      using errcode='55000';
  end if;
  return new;
end;
$$;
create trigger hivra_folder_recovery_lease_guard before update on public.hivra_agents
for each row execute function public.guard_hivra_folder_recovery_lease();

create function public.begin_hivra_folder_recovery(
  p_user_id text, p_source_id uuid, p_destination_id uuid, p_source_binding_hash text,
  p_artifact_sha256 text, p_operation_id uuid, p_revoke_source_sessions boolean
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.hivra_agents%rowtype; d public.hivra_agents%rowtype;
  r public.hivra_folder_recoveries%rowtype;
begin
  if p_user_id is null or p_source_id is null or p_destination_id is null or p_operation_id is null
    or p_source_id=p_destination_id or p_revoke_source_sessions is distinct from true
    or p_artifact_sha256 is null or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_source_binding_hash is null or p_source_binding_hash !~ '^[0-9a-f]{64}$'
  then raise exception 'invalid folder recovery request' using errcode='22023'; end if;
  -- Stable row-lock ordering for concurrent transfers.
  perform id from public.hivra_agents where id in (p_source_id,p_destination_id) order by id for update;
  select * into s from public.hivra_agents where id=p_source_id and user_id=p_user_id;
  if not found or s.status='deleted' or s.infrastructure_binding_token_hash is distinct from p_source_binding_hash
    or s.infrastructure_binding_token_enforced is distinct from true
    or s.type is distinct from 'linux-desktop' or s.computer_profile is distinct from 'ubuntu-desktop'
    or s.computer_substrate is distinct from 'proxmox-kvm'
  then raise exception 'source folder identity is unavailable' using errcode='55000'; end if;
  select * into d from public.hivra_agents where id=p_destination_id and user_id=p_user_id;
  if not found or d.type is distinct from 'linux-desktop' or d.computer_profile is distinct from 'ubuntu-desktop'
    or d.computer_substrate is distinct from 'proxmox-kvm' or d.vmid is null or d.ip is null
    or d.infrastructure_binding_token_enforced is distinct from true or d.api_token is null
    or d.api_token is not distinct from s.api_token
    or d.infrastructure_binding_token_hash is not distinct from s.infrastructure_binding_token_hash
    or d.desired_state is distinct from 'running'
  then raise exception 'destination requires a distinct fresh Ubuntu identity' using errcode='55000'; end if;
  select * into r from public.hivra_folder_recoveries where destination_agent_id=d.id;
  if found then
    if r.user_id=p_user_id and r.source_agent_id=s.id and r.source_binding_hash=p_source_binding_hash
      and r.artifact_sha256=p_artifact_sha256
      and r.destination_authority=public.hivra_folder_recovery_authority(d)
      and (r.status='complete' or (d.operation_id=r.id and d.operation_kind='restore'))
    then return r.id; end if;
    raise exception 'destination already has a different folder recovery' using errcode='55000';
  end if;
  if d.operation_id is not null or d.status is distinct from 'running' then
    raise exception 'destination has another lifecycle operation' using errcode='55000';
  end if;
  -- The deployment-authority guard also verifies current self-host connection
  -- revision/readiness on this claim. There is no ambient managed fallback.
  update public.hivra_agents set operation_id=p_operation_id, operation_kind='restore',
    operation_payload=jsonb_build_object('folderRecoveryId',p_operation_id::text),
    operation_started_at=clock_timestamp(), status='provisioning', error=null
    where id=d.id;
  insert into public.hivra_folder_recoveries(id,user_id,source_agent_id,destination_agent_id,
    artifact_sha256,source_binding_hash,destination_authority,revoke_source_sessions)
    values(p_operation_id,p_user_id,s.id,d.id,p_artifact_sha256,p_source_binding_hash,
      public.hivra_folder_recovery_authority(d),true);
  return p_operation_id;
end;
$$;

create function public.complete_hivra_folder_recovery(
  p_user_id text, p_operation_id uuid, p_artifact_sha256 text, p_file_count integer, p_byte_count integer
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.hivra_folder_recoveries%rowtype; d public.hivra_agents%rowtype; session_id uuid;
begin
  if p_file_count is null or p_file_count not between 0 and 512
    or p_byte_count is null or p_byte_count not between 0 and 2097152 then
    raise exception 'invalid folder verification evidence' using errcode='22023';
  end if;
  select * into r from public.hivra_folder_recoveries where id=p_operation_id and user_id=p_user_id;
  if not found or r.artifact_sha256 is distinct from p_artifact_sha256 then return false; end if;
  select * into d from public.hivra_agents where id=r.destination_agent_id and user_id=p_user_id for update;
  if not found or public.hivra_folder_recovery_authority(d) is distinct from r.destination_authority then return false; end if;
  select * into r from public.hivra_folder_recoveries where id=p_operation_id for update;
  if r.status='complete' then return r.file_count=p_file_count and r.byte_count=p_byte_count; end if;
  if d.operation_id is distinct from r.id or d.operation_kind is distinct from 'restore'
    or d.operation_payload is distinct from jsonb_build_object('folderRecoveryId',r.id::text)
    or d.desired_state is distinct from 'running' then return false; end if;
  -- Revoke existing sessions, not the capability: the preserved source can
  -- still be opened under a newly issued session. Serialize with session issue.
  perform pg_advisory_xact_lock(hashtextextended('hivra-remote-desktop-v1:hivra-agent:'||r.source_agent_id::text,0));
  for session_id in select id from public.hivra_remote_desktop_sessions
    where user_id=p_user_id and computer_kind='hivra-agent' and computer_id=r.source_agent_id and revoked_at is null
  loop
    perform public.revoke_hivra_remote_desktop_session(p_user_id,session_id,'user_revoked');
  end loop;
  -- Mark terminal first, then clear precisely this lease, in one transaction.
  update public.hivra_folder_recoveries set status='complete',file_count=p_file_count,
    byte_count=p_byte_count,completed_at=clock_timestamp() where id=r.id;
  update public.hivra_agents set status='running',operation_id=null,operation_kind=null,
    operation_payload=null,operation_started_at=null,error=null where id=d.id;
  return true;
end;
$$;

revoke all on function public.hivra_folder_recovery_authority(public.hivra_agents) from public,anon,authenticated;
revoke all on function public.guard_hivra_folder_recovery_lease() from public,anon,authenticated;
revoke all on function public.begin_hivra_folder_recovery(text,uuid,uuid,text,text,uuid,boolean) from public,anon,authenticated;
revoke all on function public.complete_hivra_folder_recovery(text,uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.hivra_folder_recovery_authority(public.hivra_agents) to service_role;
grant execute on function public.begin_hivra_folder_recovery(text,uuid,uuid,text,text,uuid,boolean) to service_role;
grant execute on function public.complete_hivra_folder_recovery(text,uuid,text,integer,integer) to service_role;
