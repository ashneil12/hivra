-- Staged attachment admission. No application-role grant and no guest dispatch
-- until pinned installer, terminal evidence and reconciliation are implemented.
-- A retained operation ID must never project as idle just because its kind is
-- newer than this reader. Preserve it as unknown until a specific state exists.
create or replace function public.hivra_canonical_operation_state(p_source_kind text,p_payload jsonb,p_deleted boolean)
returns text language sql immutable security invoker set search_path=pg_catalog,pg_temp as $$
  select case when p_deleted then null
    when p_source_kind='hivra' then case p_payload->>'operationKind'
      when 'provision' then 'provisioning' when 'start' then 'starting'
      when 'stop' then 'stopping' when 'restart' then 'rebooting'
      when 'resize' then 'resizing' when 'snapshot' then 'snapshotting'
      when 'restore' then 'restoring' when 'delete' then 'deleting'
      else case when nullif(p_payload->>'operationId','') is not null then 'unknown' else null end end
    when p_payload->>'status' in ('provisioning','redeploying') then 'provisioning'
    when p_payload->>'status'='restoring' then 'restoring' else null end;
$$;

alter table public.hivra_agents drop constraint hivra_agents_operation_shape_check;
alter table public.hivra_agents add constraint hivra_agents_operation_shape_check check (
  (operation_id is null and operation_kind is null and operation_started_at is null and operation_payload is null)
  or (operation_id is not null and operation_kind in
    ('provision','start','stop','restart','resize','snapshot','restore','delete','desktop_prepare','agent_attach')
    and operation_kind is not null and operation_started_at is not null
    and (operation_payload is null or jsonb_typeof(operation_payload)='object'))
);

create table public.hivra_agent_attachments (
  id uuid primary key,
  user_id text not null,
  computer_id uuid not null,
  source_id uuid not null references public.hivra_agents(id),
  authority_generation bigint not null,
  authority_command_id uuid not null,
  guest_authority jsonb not null check (jsonb_typeof(guest_authority)='object'),
  intent jsonb not null check (jsonb_typeof(intent)='object'),
  agent_identity_id uuid not null,
  phase text not null check (phase in ('claimed','cancelled')),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key (computer_id,user_id) references public.hivra_canonical_computers(id,user_id),
  foreign key (authority_command_id,user_id,computer_id,authority_generation)
    references public.hivra_canonical_authority_commands(id,user_id,computer_id,generation),
  check ((phase='claimed' and completed_at is null) or (phase='cancelled' and completed_at is not null))
);
create unique index hivra_agent_attachments_active_computer on public.hivra_agent_attachments(computer_id) where phase='claimed';
create unique index hivra_agent_attachments_active_identity on public.hivra_agent_attachments(agent_identity_id) where phase='claimed';
create table public.hivra_agent_attachment_outbox (
  operation_id uuid primary key references public.hivra_agent_attachments(id),
  event_kind text not null default 'attachment_claimed' check (event_kind='attachment_claimed'),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.hivra_agent_attachments enable row level security;
alter table public.hivra_agent_attachment_outbox enable row level security;
revoke all on public.hivra_agent_attachments, public.hivra_agent_attachment_outbox from public,anon,authenticated,service_role;
grant select on public.hivra_agent_attachments, public.hivra_agent_attachment_outbox to service_role;

create function public.guard_hivra_agent_attachment_lease()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype;
begin
  select * into p from public.hivra_agent_attachments where source_id=old.id and phase='claimed';
  if not found then return new; end if;
  if public.hivra_desktop_prepare_authority(new) is distinct from p.guest_authority
    or new.operation_id is distinct from p.id or new.operation_kind is distinct from 'agent_attach'
    or new.operation_started_at is distinct from old.operation_started_at
    or new.operation_payload is distinct from jsonb_build_object('attachmentId',p.id::text)
    or new.status is distinct from 'running' or new.desired_state is null or new.desired_state not in ('running','deleted')
    or (old.desired_state='deleted' and new.desired_state is distinct from 'deleted')
  then raise exception 'attachment requires its exact cancellation or terminal evidence before lease release' using errcode='55000'; end if;
  return new;
end;
$$;
create trigger hivra_agent_attachment_lease_guard before update on public.hivra_agents
for each row execute function public.guard_hivra_agent_attachment_lease();

create function public.begin_hivra_agent_attachment(
  p_owner text,p_computer_id uuid,p_operation_id uuid,p_expected_generation bigint,
  p_expected_authority jsonb,p_intent jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  m public.hivra_canonical_source_mappings%rowtype;
  a public.hivra_agents%rowtype;
  r public.hivra_canonical_relationship_authority%rowtype;
  p public.hivra_agent_attachments%rowtype;
  identity_id uuid;
begin
  if p_owner is null or p_computer_id is null or p_operation_id is null
    or p_expected_generation is null or p_expected_generation<2
    or jsonb_typeof(p_expected_authority) is distinct from 'object'
    or jsonb_typeof(p_intent) is distinct from 'object'
    or p_intent-array['agentIdentityId','runtimeId','agentName','installerSha256']<>'{}'::jsonb
    or jsonb_typeof(p_intent->'agentIdentityId') is distinct from 'string'
    or not coalesce(p_intent->>'agentIdentityId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
    or p_intent->>'runtimeId' is distinct from 'codex'
    or jsonb_typeof(p_intent->'agentName') is distinct from 'string'
    or not coalesce(length(btrim(p_intent->>'agentName')) between 1 and 128,false)
    or jsonb_typeof(p_intent->'installerSha256') is distinct from 'string'
    or not coalesce(p_intent->>'installerSha256' ~ '^[0-9a-f]{64}$',false)
  then return null; end if;
  identity_id := (p_intent->>'agentIdentityId')::uuid;

  -- Same administrative lock as transfer/read-mode changes, followed by the
  -- legacy projection order: source -> mapping -> computer -> controller.
  perform pg_advisory_xact_lock(hashtextextended('hivra-canonical-shadow-admin',0));
  select * into p from public.hivra_agent_attachments where id=p_operation_id;
  if found then
    if p.user_id is distinct from p_owner or p.computer_id is distinct from p_computer_id
      or p.authority_generation is distinct from p_expected_generation
      or p.guest_authority is distinct from p_expected_authority or p.intent is distinct from p_intent
    then return null; end if;
    return jsonb_build_object('operationId',p.id,'phase',p.phase,'resumed',true);
  end if;
  select * into m from public.hivra_canonical_source_mappings
    where computer_id=p_computer_id and user_id=p_owner and source_kind='hivra' and resource_kind='computer';
  if not found then return null; end if;
  select * into a from public.hivra_agents where id=m.source_id and user_id=p_owner for update;
  if not found or public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority
    or a.status is distinct from 'running' or a.desired_state is distinct from 'running' or a.operation_id is not null
    or a.infrastructure_binding_token_enforced is distinct from true
    or a.computer_substrate is distinct from 'proxmox-kvm' or a.type is distinct from 'linux-desktop'
    or coalesce(a.computer_profile,'ubuntu-desktop')<>'ubuntu-desktop' or a.vmid is null or a.ip is null
    or not public.hivra_desktop_prepare_binding_ready(a) then return null; end if;
  select * into m from public.hivra_canonical_source_mappings
    where computer_id=p_computer_id and user_id=p_owner for update;
  if not exists(select 1 from public.hivra_canonical_source_events
      where event_id=m.last_source_event_id and source_kind='hivra' and source_id=a.id
        and processed_at is not null and payload=public.hivra_canonical_hivra_event_payload(a))
    or exists(select 1 from public.hivra_canonical_source_events
      where source_kind='hivra' and source_id=a.id and processed_at is null)
  then return null; end if;
  perform 1 from public.hivra_canonical_computers where id=p_computer_id and user_id=p_owner
    and observed_state='running' and desired_state='running' and operation_id is null and operation_state is null
    and write_authority='legacy' and tombstoned_at is null and source_event_id=m.last_source_event_id for update;
  if not found then return null; end if;
  select * into r from public.hivra_canonical_relationship_authority
    where computer_id=p_computer_id and user_id=p_owner for update;
  if not found or r.write_authority is distinct from 'canonical' or r.generation is distinct from p_expected_generation then return null; end if;
  -- Initial admission creates a new identity only. Reusing/migrating an existing
  -- identity is not silently interpreted as permission to take over its runtime.
  if exists(select 1 from public.hivra_canonical_agent_identities where id=identity_id)
    or exists(select 1 from public.hivra_canonical_primary_bindings where computer_id=p_computer_id and status='active')
    or exists(select 1 from public.hivra_canonical_runtime_installations where computer_id=p_computer_id and status<>'removed')
    or exists(select 1 from public.hivra_agent_attachments where agent_identity_id=identity_id and phase='claimed')
  then return null; end if;
  update public.hivra_agents set operation_id=p_operation_id,operation_kind='agent_attach',
    operation_started_at=clock_timestamp(),operation_payload=jsonb_build_object('attachmentId',p_operation_id::text)
    where id=a.id;
  insert into public.hivra_agent_attachments(id,user_id,computer_id,source_id,authority_generation,
    authority_command_id,guest_authority,intent,agent_identity_id,phase)
    values(p_operation_id,p_owner,p_computer_id,a.id,r.generation,r.command_id,p_expected_authority,p_intent,identity_id,'claimed');
  insert into public.hivra_agent_attachment_outbox(operation_id) values(p_operation_id);
  return jsonb_build_object('operationId',p_operation_id,'phase','claimed','resumed',false);
end;
$$;

create function public.cancel_undispatched_hivra_agent_attachment(p_owner text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_agent_attachments%rowtype;
begin
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach'
    or public.hivra_desktop_prepare_authority(a) is distinct from p.guest_authority then return false; end if;
  update public.hivra_agent_attachments set phase='cancelled',completed_at=clock_timestamp()
    where id=p.id and phase='claimed';
  if not found then return false; end if;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=a.id;
  return true;
end;
$$;

revoke all on function public.guard_hivra_agent_attachment_lease(),
  public.begin_hivra_agent_attachment(text,uuid,uuid,bigint,jsonb,jsonb),
  public.cancel_undispatched_hivra_agent_attachment(text,uuid) from public,anon,authenticated,service_role;
