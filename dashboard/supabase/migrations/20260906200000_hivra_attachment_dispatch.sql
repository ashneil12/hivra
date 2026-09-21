-- Private at-most-once dispatch transition. This is not an installer and does
-- not grant application execution or release an uncertain guest operation.
alter table public.hivra_agent_attachments
  drop constraint hivra_agent_attachments_phase_check,
  drop constraint hivra_agent_attachments_check,
  add column dispatch_id uuid,
  add column dispatched_at timestamptz,
  add constraint hivra_agent_attachments_phase_check check (phase in ('claimed','dispatched','cancelled')),
  add constraint hivra_agent_attachments_check check (
    (phase='claimed' and completed_at is null and dispatch_id is null and dispatched_at is null)
    or (phase='dispatched' and completed_at is null and dispatch_id is not null and dispatched_at is not null)
    or (phase='cancelled' and completed_at is not null and dispatch_id is null and dispatched_at is null)
  );
drop index public.hivra_agent_attachments_active_computer;
drop index public.hivra_agent_attachments_active_identity;
create unique index hivra_agent_attachments_active_computer on public.hivra_agent_attachments(computer_id)
  where phase in ('claimed','dispatched');
create unique index hivra_agent_attachments_active_identity on public.hivra_agent_attachments(agent_identity_id)
  where phase in ('claimed','dispatched');

create table public.hivra_agent_attachment_dispatches (
  operation_id uuid primary key references public.hivra_agent_attachments(id),
  dispatch_id uuid not null unique,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.hivra_agent_attachment_dispatches enable row level security;
revoke all on public.hivra_agent_attachment_dispatches from public,anon,authenticated,service_role;
grant select on public.hivra_agent_attachment_dispatches to service_role;

create or replace function public.guard_hivra_agent_attachment_lease()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype;
begin
  select * into p from public.hivra_agent_attachments where source_id=old.id and phase in ('claimed','dispatched');
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

create function public.dispatch_hivra_agent_attachment(
  p_owner text,p_operation_id uuid,p_dispatch_id uuid,p_expected_generation bigint,
  p_expected_authority jsonb,p_installer_sha256 text
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  a public.hivra_agents%rowtype;
  m public.hivra_canonical_source_mappings%rowtype;
begin
  if p_owner is null or p_operation_id is null or p_dispatch_id is null
    or p_expected_generation is null or p_expected_authority is null or p_installer_sha256 is null
  then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found or p.phase<>'claimed' or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority or p.intent->>'installerSha256' is distinct from p_installer_sha256
  then return false; end if;
  -- All lifecycle contenders lock the original source before canonical rows or
  -- the journal. Cancellation and dispatch therefore have a single winner.
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach'
    or a.operation_payload is distinct from jsonb_build_object('attachmentId',p.id::text)
    or a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or public.hivra_desktop_prepare_authority(a) is distinct from p.guest_authority
    or not public.hivra_desktop_prepare_binding_ready(a) then return false; end if;
  select * into m from public.hivra_canonical_source_mappings
    where computer_id=p.computer_id and user_id=p_owner and source_kind='hivra' and source_id=a.id for update;
  if not found or not exists(select 1 from public.hivra_canonical_source_events
      where event_id=m.last_source_event_id and source_kind='hivra' and source_id=a.id
        and processed_at is not null and payload=public.hivra_canonical_hivra_event_payload(a))
    or exists(select 1 from public.hivra_canonical_source_events where source_kind='hivra' and source_id=a.id and processed_at is null)
  then return false; end if;
  perform 1 from public.hivra_canonical_computers where id=p.computer_id and user_id=p_owner
    and observed_state='running' and desired_state='running' and operation_id=p.id and operation_state is not null
    and write_authority='legacy' and tombstoned_at is null and source_event_id=m.last_source_event_id for update;
  if not found then return false; end if;
  perform 1 from public.hivra_canonical_relationship_authority where computer_id=p.computer_id and user_id=p_owner
    and write_authority='canonical' and generation=p_expected_generation and command_id=p.authority_command_id for update;
  if not found then return false; end if;
  if exists(select 1 from public.hivra_canonical_agent_identities where id=p.agent_identity_id)
    or exists(select 1 from public.hivra_canonical_primary_bindings where computer_id=p.computer_id and status='active')
    or exists(select 1 from public.hivra_canonical_runtime_installations where computer_id=p.computer_id and status<>'removed')
  then return false; end if;
  update public.hivra_agent_attachments set phase='dispatched',dispatch_id=p_dispatch_id,dispatched_at=clock_timestamp()
    where id=p.id and phase='claimed';
  if not found then return false; end if;
  insert into public.hivra_agent_attachment_dispatches(operation_id,dispatch_id) values(p.id,p_dispatch_id);
  return true;
end;
$$;
revoke all on function public.dispatch_hivra_agent_attachment(text,uuid,uuid,bigint,jsonb,text)
  from public,anon,authenticated,service_role;
