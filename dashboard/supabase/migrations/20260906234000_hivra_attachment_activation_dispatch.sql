-- Private one-time service-start authorization. Not service readiness, binding
-- activation, a route grant, or permission to release the shared guest lease.
create table public.hivra_agent_attachment_activation_dispatches (
  operation_id uuid primary key references public.hivra_agent_attachment_staging_results(operation_id),
  activation_id uuid not null unique,
  request jsonb not null check (jsonb_typeof(request)='object'),
  created_at timestamptz not null default clock_timestamp()
);
create table public.hivra_agent_attachment_activation_outbox (
  operation_id uuid primary key references public.hivra_agent_attachment_activation_dispatches(operation_id),
  activation_id uuid not null unique references public.hivra_agent_attachment_activation_dispatches(activation_id),
  event_kind text not null check (event_kind='service_activation_dispatched'),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.hivra_agent_attachment_activation_dispatches enable row level security;
alter table public.hivra_agent_attachment_activation_outbox enable row level security;
revoke all on public.hivra_agent_attachment_activation_dispatches,public.hivra_agent_attachment_activation_outbox
  from public,anon,authenticated,service_role;
grant select on public.hivra_agent_attachment_activation_dispatches,public.hivra_agent_attachment_activation_outbox to service_role;

create function public.dispatch_hivra_attachment_activation(
  p_owner text,p_operation_id uuid,p_activation_id uuid,p_expected_generation bigint,
  p_expected_authority jsonb,p_observed_boot_id uuid,p_expected_staged jsonb,
  p_service_policy_sha256 text,p_service_definition_sha256 text
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  a public.hivra_agents%rowtype;
  m public.hivra_canonical_source_mappings%rowtype;
  r public.hivra_agent_attachment_installations%rowtype;
  o public.hivra_agent_attachment_guest_observations%rowtype;
  s jsonb; request jsonb;
begin
  if p_owner is null or p_operation_id is null or p_activation_id is null
    or p_expected_generation is null or p_expected_authority is null or p_observed_boot_id is null
    or jsonb_typeof(p_expected_staged) is distinct from 'object'
    or octet_length(p_expected_staged::text)>16384
    or p_service_policy_sha256 is distinct from '66f89162530b682aa66d8a59250f385530726a162def8902ffb7bc953eee9428'
    or p_service_definition_sha256 is null or length(p_service_definition_sha256)<>64
    or p_service_definition_sha256 !~ '^[0-9a-f]{64}$'
  then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found or p.phase is distinct from 'dispatched'
    or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority
    or p.intent->>'runtimeId' is distinct from 'codex'
    or p.intent->>'installerSha256' is distinct from '77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375'
  then return false; end if;
  -- Same source-first fence as staging and legacy lifecycle. A queued delete
  -- blocks a fresh activation; uncertainty keeps this fence occupied.
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach'
    or a.operation_payload is distinct from jsonb_build_object('attachmentId',p.id::text)
    or a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority
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
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if p.phase is distinct from 'dispatched' or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority
    or exists(select 1 from public.hivra_agent_attachment_activation_dispatches where operation_id=p.id)
  then return false; end if;
  select * into r from public.hivra_agent_attachment_installations where operation_id=p.id;
  if not found then return false; end if;
  select * into o from public.hivra_agent_attachment_guest_observations where operation_id=p.id;
  if not found or o.boot_id is distinct from p_observed_boot_id then return false; end if;
  select result into s from public.hivra_agent_attachment_staging_results where operation_id=p.id;
  if not found or s is distinct from p_expected_staged
    or not exists(select 1 from public.hivra_agent_attachment_dispatches where operation_id=p.id and dispatch_id=p.dispatch_id)
    or s->>'bootId' is distinct from o.boot_id::text
    or s->'identity' is distinct from jsonb_build_object('operationId',p.id::text,'dispatchId',p.dispatch_id::text,
      'installationId',r.installation_id::text,'bindingId',r.binding_id::text,
      'computerId',p.computer_id::text,'sourceId',p.source_id::text,'architecture',r.architecture)
  then return false; end if;
  if exists(select 1 from public.hivra_canonical_agent_identities where id=p.agent_identity_id)
    or exists(select 1 from public.hivra_canonical_primary_bindings where computer_id=p.computer_id and status='active')
    or exists(select 1 from public.hivra_canonical_runtime_installations where computer_id=p.computer_id and status<>'removed')
  then return false; end if;
  request:=jsonb_build_object('version',1,'operationId',p.id::text,'activationId',p_activation_id::text,
    'generation',p_expected_generation::text,'servicePolicySha256',p_service_policy_sha256,
    'serviceDefinitionSha256',p_service_definition_sha256,'staged',s);
  insert into public.hivra_agent_attachment_activation_dispatches(operation_id,activation_id,request)
    values(p.id,p_activation_id,request);
  insert into public.hivra_agent_attachment_activation_outbox(operation_id,activation_id,event_kind,payload)
    values(p.id,p_activation_id,'service_activation_dispatched',request);
  return true;
end;
$$;
revoke all on function public.dispatch_hivra_attachment_activation(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text)
  from public,anon,authenticated,service_role;

create function public.read_hivra_attachment_activation(p_owner text,p_operation_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select d.request from public.hivra_agent_attachment_activation_dispatches d
  join public.hivra_agent_attachments p on p.id=d.operation_id
  where p.user_id=p_owner and p.id=p_operation_id;
$$;
revoke all on function public.read_hivra_attachment_activation(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_hivra_attachment_activation(text,uuid) to service_role;
-- The service digest binds the future guest action; this RPC cannot inspect
-- guest bytes or prove current readiness. A pinned worker must verify the unit,
-- account, installation and boot before a start, then reconcile on uncertainty.
-- Reading this journal or observing true on an earlier pass is NOT a new grant.
