-- Private pre-dispatch observation. Supplied only by the bound host observer,
-- never inferred from the installer's response. Does not authorize execution.
create table public.hivra_agent_attachment_guest_observations (
  operation_id uuid primary key references public.hivra_agent_attachments(id),
  boot_id uuid not null,
  worker_sha256 text not null check (worker_sha256='2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab'),
  observed_at timestamptz not null default clock_timestamp()
);
alter table public.hivra_agent_attachment_guest_observations enable row level security;
revoke all on public.hivra_agent_attachment_guest_observations from public,anon,authenticated,service_role;
grant select on public.hivra_agent_attachment_guest_observations to service_role;

create function public.observe_hivra_attachment_guest(
  p_owner text,p_operation_id uuid,p_expected_generation bigint,
  p_expected_authority jsonb,p_boot_id uuid,p_worker_sha256 text
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; r public.hivra_agent_attachment_guest_observations%rowtype;
begin
  if p_owner is null or p_operation_id is null or p_expected_generation is null
    or p_expected_authority is null or p_boot_id is null
    or p_worker_sha256 is distinct from '2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab'
  then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority then return false; end if;
  -- Same source-first ordering as cancellation, reservation and dispatch.
  perform 1 from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found then return false; end if;
  select * into r from public.hivra_agent_attachment_guest_observations where operation_id=p.id;
  if found then return r.boot_id=p_boot_id and r.worker_sha256=p_worker_sha256; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if p.phase is distinct from 'claimed'
    or not exists(select 1 from public.hivra_agent_attachment_installations where operation_id=p.id)
    or not exists(select 1 from public.hivra_agents where id=p.source_id and user_id=p_owner
      and operation_id=p.id and operation_kind='agent_attach' and status='running' and desired_state='running'
      and public.hivra_desktop_prepare_authority(hivra_agents)=p.guest_authority
      and public.hivra_desktop_prepare_binding_ready(hivra_agents))
    or not exists(select 1 from public.hivra_canonical_relationship_authority where computer_id=p.computer_id and user_id=p_owner
      and write_authority='canonical' and generation=p_expected_generation and command_id=p.authority_command_id)
  then return false; end if;
  insert into public.hivra_agent_attachment_guest_observations(operation_id,boot_id,worker_sha256)
    values(p.id,p_boot_id,p_worker_sha256) on conflict do nothing;
  return found;
end;
$$;

create function public.guard_hivra_attachment_guest_dispatch()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if new.phase='dispatched' and old.phase is distinct from 'dispatched' then
    perform 1 from public.hivra_agent_attachment_guest_observations where operation_id=new.id
      and observed_at<=clock_timestamp() and observed_at>=clock_timestamp()-interval '5 minutes';
    if not found then raise exception 'attachment requires a fresh recorded guest boot before dispatch' using errcode='55000'; end if;
  end if;
  return new;
end;
$$;
create trigger hivra_attachment_guest_dispatch_guard before update of phase on public.hivra_agent_attachments
for each row execute function public.guard_hivra_attachment_guest_dispatch();

revoke all on function public.observe_hivra_attachment_guest(text,uuid,bigint,jsonb,uuid,text),
  public.guard_hivra_attachment_guest_dispatch() from public,anon,authenticated,service_role;
-- Exact replay never refreshes observed_at. If an undispatched observation goes
-- stale, cancel that exact operation and begin anew; do not silently renew it.
-- Existing dispatched operations are not assigned invented boot observations.
