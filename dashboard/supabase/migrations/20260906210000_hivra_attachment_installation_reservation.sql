-- Keep installation/binding identities durable before dispatch. This reserves
-- identities only; it does not create an installed runtime or an active agent.
create table public.hivra_agent_attachment_installations (
  operation_id uuid primary key references public.hivra_agent_attachments(id),
  installation_id uuid not null unique,
  binding_id uuid not null unique,
  architecture text not null check (architecture in ('x86_64','aarch64')),
  installer_sha256 text not null check (installer_sha256='77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375'),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.hivra_agent_attachment_installations enable row level security;
revoke all on public.hivra_agent_attachment_installations from public,anon,authenticated,service_role;
grant select on public.hivra_agent_attachment_installations to service_role;

create function public.reserve_hivra_attachment_installation(
  p_owner text,p_operation_id uuid,p_expected_generation bigint,
  p_installation_id uuid,p_binding_id uuid,p_architecture text
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; r public.hivra_agent_attachment_installations%rowtype;
begin
  if p_owner is null or p_operation_id is null or p_expected_generation is null
    or p_installation_id is null or p_binding_id is null or p_architecture is null
    or p_architecture not in ('x86_64','aarch64') then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found or p.authority_generation is distinct from p_expected_generation then return false; end if;
  -- Same source-first ordering as dispatch/cancel. An exact saved reservation
  -- remains readable after dispatch without granting another dispatch attempt.
  perform 1 from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found then return false; end if;
  select * into r from public.hivra_agent_attachment_installations where operation_id=p.id;
  if found then return r.installation_id=p_installation_id and r.binding_id=p_binding_id and r.architecture=p_architecture; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if p.phase<>'claimed' or p.intent->>'runtimeId' is distinct from 'codex'
    or p.intent->>'installerSha256' is distinct from '77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375'
    or not exists(select 1 from public.hivra_agents where id=p.source_id and user_id=p_owner
      and operation_id=p.id and operation_kind='agent_attach' and desired_state='running'
      and public.hivra_desktop_prepare_authority(hivra_agents)=p.guest_authority)
    or not exists(select 1 from public.hivra_canonical_relationship_authority where computer_id=p.computer_id and user_id=p_owner
      and write_authority='canonical' and generation=p_expected_generation and command_id=p.authority_command_id)
    or exists(select 1 from public.hivra_canonical_runtime_installations where id=p_installation_id)
    or exists(select 1 from public.hivra_canonical_primary_bindings where id=p_binding_id)
  then return false; end if;
  insert into public.hivra_agent_attachment_installations(operation_id,installation_id,binding_id,architecture,installer_sha256)
    values(p.id,p_installation_id,p_binding_id,p_architecture,p.intent->>'installerSha256') on conflict do nothing;
  return found;
end;
$$;

create function public.guard_hivra_attachment_installation_dispatch()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if new.phase='dispatched' and old.phase is distinct from 'dispatched' then
    perform 1 from public.hivra_agent_attachment_installations where operation_id=new.id
      and installer_sha256=new.intent->>'installerSha256';
    if not found then raise exception 'attachment installation identity must be reserved before dispatch' using errcode='55000'; end if;
  end if;
  return new;
end;
$$;
create trigger hivra_attachment_installation_dispatch_guard before update of phase on public.hivra_agent_attachments
for each row execute function public.guard_hivra_attachment_installation_dispatch();

revoke all on function public.reserve_hivra_attachment_installation(text,uuid,bigint,uuid,uuid,text),
  public.guard_hivra_attachment_installation_dispatch() from public,anon,authenticated,service_role;
