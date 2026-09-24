-- Add an agent to a computer its owner already has: the lifecycle the fenced
-- 20260906 attach chain lacked (docs/superpowers/specs/
-- 2026-09-24-agent-computer-contract-and-attach.md, sections 5.1 and 5.5 to
-- 5.7; threats T1 to T3, T20, T25, T30 and T35).
--
-- First release: Codex on an Ubuntu Desktop proxmox-kvm computer, one agent
-- per computer, always a new agent identity, one grant ({ workspace }). This
-- migration grants nothing to any application role; the final grants follow in
-- 20260925000100_hivra_agent_attachment_grants.sql, and the application keeps
-- the routes and the worker behind a Canary-only switch.
--
-- Rollout: additive. Apply before the code that calls these functions serves.
-- The attach tables have existed since 20260906190000 but the chain was never
-- granted to an application role, so they are expected to be empty. Preflight
-- on each environment before applying, and stop if it returns any row:
--   select phase, dispatch_id is null as undispatched, completed_at is null as open, count(*)
--   from public.hivra_agent_attachments group by 1,2,3;
-- A row in a phase or shape this file does not know makes the replaced checks
-- fail and the whole file roll back; nothing is half applied.
--
-- Idempotent: tables and columns use "if not exists", functions are replaced,
-- triggers and constraints are dropped before they are created again.

-- ---------------------------------------------------------------------------
-- 1. Attachments finish: attached, failed and detached.
-- ---------------------------------------------------------------------------
alter table public.hivra_agent_attachments
  add column if not exists agent_limit integer,
  add column if not exists grants jsonb,
  add column if not exists review_sha256 text,
  add column if not exists ended_at timestamptz,
  add column if not exists end_reason text;
alter table public.hivra_agent_attachments
  drop constraint if exists hivra_agent_attachments_phase_check,
  drop constraint if exists hivra_agent_attachments_check,
  drop constraint if exists hivra_agent_attachments_v2_shape_check,
  drop constraint if exists hivra_agent_attachments_end_reason_check;
alter table public.hivra_agent_attachments
  add constraint hivra_agent_attachments_phase_check
    check (phase in ('claimed','dispatched','cancelled','attached','failed','detached')),
  add constraint hivra_agent_attachments_check check (
    (phase='claimed' and completed_at is null and dispatch_id is null and dispatched_at is null and ended_at is null)
    or (phase='dispatched' and completed_at is null and dispatch_id is not null and dispatched_at is not null and ended_at is null)
    or (phase='cancelled' and completed_at is not null and dispatch_id is null and dispatched_at is null)
    or (phase='attached' and completed_at is not null and dispatch_id is not null and ended_at is null)
    or (phase='failed' and completed_at is not null and dispatch_id is not null)
    or (phase='detached' and completed_at is not null and dispatch_id is not null and ended_at is not null)),
  -- v1 claims (never granted) carry no review; every v2 claim carries all three.
  add constraint hivra_agent_attachments_v2_shape_check check (
    (agent_limit is null and grants is null and review_sha256 is null)
    or (agent_limit between 0 and 100000
      and jsonb_typeof(grants)='object' and grants-'workspace'='{}'::jsonb and jsonb_typeof(grants->'workspace')='boolean'
      and review_sha256 ~ '^[0-9a-f]{64}$')),
  add constraint hivra_agent_attachments_end_reason_check check (
    end_reason is null or end_reason in ('plan_agent_limit','cancelled','computer_not_running','pending_delete',
      'install_failed','removed','computer_deleted'));

-- One live agent per computer and one computer per identity, until removed.
drop index if exists public.hivra_agent_attachments_active_computer;
drop index if exists public.hivra_agent_attachments_active_identity;
create unique index if not exists hivra_agent_attachments_live_computer on public.hivra_agent_attachments(computer_id)
  where phase in ('claimed','dispatched','attached');
create unique index if not exists hivra_agent_attachments_live_identity on public.hivra_agent_attachments(agent_identity_id)
  where phase in ('claimed','dispatched','attached');
create index if not exists hivra_agent_attachments_source on public.hivra_agent_attachments(source_id, created_at desc);
create index if not exists hivra_agent_attachments_open on public.hivra_agent_attachments(created_at)
  where phase in ('claimed','dispatched');

-- ---------------------------------------------------------------------------
-- 2. The attached instance's token (5.4). The worker generates it once; the
--    guest writes the same bytes for the gateway and the instance. Hivra keeps
--    it so it can build later steps and check the instance's receipts. Read
--    only through read_hivra_attachment_instance_token().
-- ---------------------------------------------------------------------------
create table if not exists public.hivra_agent_attachment_secrets (
  operation_id uuid primary key references public.hivra_agent_attachments(id),
  instance_token text not null check (instance_token ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.hivra_agent_attachment_secrets enable row level security;
revoke all on public.hivra_agent_attachment_secrets from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 3. What the attached agent was told about its computer (4.6): every
--    rendered revision, and whether root's read-back in the same guest step
--    matched it on the host and inside the unit ("checked by Hivra").
-- ---------------------------------------------------------------------------
create table if not exists public.hivra_agent_attachment_contracts (
  attachment_id uuid not null references public.hivra_agent_attachments(id),
  user_id text not null check (btrim(user_id)<>''),
  revision integer not null check (revision between 1 and 1000000),
  content text not null check (octet_length(content) between 1 and 4096),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  grants jsonb not null check (jsonb_typeof(grants)='object' and grants-'workspace'='{}'::jsonb
    and jsonb_typeof(grants->'workspace')='boolean'),
  rendered_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  readback_sha256 text check (readback_sha256 is null or readback_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (attachment_id, revision),
  check ((delivered_at is null) = (readback_sha256 is null)),
  check (readback_sha256 is null or readback_sha256=file_sha256)
);
alter table public.hivra_agent_attachment_contracts enable row level security;
revoke all on public.hivra_agent_attachment_contracts from public,anon,authenticated,service_role;
grant select on public.hivra_agent_attachment_contracts to service_role;

-- ---------------------------------------------------------------------------
-- 4. Change access and Remove: their own reviewed operations on the
--    computer's lifecycle lease.
-- ---------------------------------------------------------------------------
create table if not exists public.hivra_agent_attachment_operations (
  id uuid primary key,
  attachment_id uuid not null references public.hivra_agent_attachments(id),
  user_id text not null,
  source_id uuid not null references public.hivra_agents(id),
  kind text not null check (kind in ('access_change','detach')),
  phase text not null check (phase in ('claimed','dispatched','completed','failed','cancelled')),
  grants jsonb not null check (jsonb_typeof(grants)='object' and grants-'workspace'='{}'::jsonb
    and jsonb_typeof(grants->'workspace')='boolean'),
  review_sha256 text not null check (review_sha256 ~ '^[0-9a-f]{64}$'),
  guest_authority jsonb not null check (jsonb_typeof(guest_authority)='object'),
  receipt jsonb check (receipt is null or (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=16384)),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default clock_timestamp(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  check ((phase='claimed' and dispatched_at is null and completed_at is null)
    or (phase='dispatched' and dispatched_at is not null and completed_at is null)
    or (phase in ('completed','failed') and dispatched_at is not null and completed_at is not null)
    or (phase='cancelled' and dispatched_at is null and completed_at is not null))
);
create unique index if not exists hivra_agent_attachment_operations_live
  on public.hivra_agent_attachment_operations(attachment_id) where phase in ('claimed','dispatched');
create index if not exists hivra_agent_attachment_operations_attachment
  on public.hivra_agent_attachment_operations(attachment_id, created_at desc);
alter table public.hivra_agent_attachment_operations enable row level security;
revoke all on public.hivra_agent_attachment_operations from public,anon,authenticated,service_role;
grant select on public.hivra_agent_attachment_operations to service_role;

-- Every kind an earlier file allows stays allowed, private_access (20260915153000) included.
alter table public.hivra_agents drop constraint if exists hivra_agents_operation_shape_check;
alter table public.hivra_agents add constraint hivra_agents_operation_shape_check check (
  (operation_id is null and operation_kind is null and operation_started_at is null and operation_payload is null)
  or (operation_id is not null and operation_kind in
    ('provision','start','stop','restart','resize','snapshot','restore','delete','desktop_prepare','agent_attach',
     'private_access','agent_access_change','agent_detach')
    and operation_kind is not null and operation_started_at is not null
    and (operation_payload is null or jsonb_typeof(operation_payload)='object'))
);

-- While a change-access or remove step holds the computer's lease, nothing but
-- that step's own terminal record may release or change it.
create or replace function public.guard_hivra_agent_attachment_operation_lease()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare o public.hivra_agent_attachment_operations%rowtype;
begin
  select * into o from public.hivra_agent_attachment_operations where source_id=old.id and phase in ('claimed','dispatched');
  if not found then return new; end if;
  if public.hivra_desktop_prepare_authority(new) is distinct from o.guest_authority
    or new.operation_id is distinct from o.id
    or new.operation_kind is distinct from (case o.kind when 'detach' then 'agent_detach' else 'agent_access_change' end)
    or new.operation_started_at is distinct from old.operation_started_at
    or new.operation_payload is distinct from jsonb_build_object('attachmentId',o.attachment_id::text,'operationId',o.id::text)
    or new.status is distinct from 'running' or new.desired_state is null or new.desired_state not in ('running','deleted')
    or (old.desired_state='deleted' and new.desired_state is distinct from 'deleted')
  then raise exception 'agent access or remove step requires its terminal evidence before lease release' using errcode='55000'; end if;
  return new;
end;
$$;
drop trigger if exists hivra_agent_attachment_operation_lease_guard on public.hivra_agents;
create trigger hivra_agent_attachment_operation_lease_guard before update on public.hivra_agents
for each row execute function public.guard_hivra_agent_attachment_operation_lease();

-- A restore would roll the computer back under a live attached agent (5.5):
-- refused while an agent is attached or being attached ("Remove Codex first").
create or replace function public.guard_hivra_restore_while_attached()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if new.operation_kind='restore' and old.operation_kind is distinct from 'restore'
    and exists(select 1 from public.hivra_agent_attachments where source_id=new.id and phase in ('claimed','dispatched','attached'))
  then raise exception 'Remove the attached agent before restoring this computer' using errcode='55000'; end if;
  return new;
end;
$$;
drop trigger if exists hivra_restore_while_attached_guard on public.hivra_agents;
create trigger hivra_restore_while_attached_guard before update of operation_kind on public.hivra_agents
for each row execute function public.guard_hivra_restore_while_attached();

-- Deleting the computer ends every attachment on it (T30): the binding is
-- detached and the installation removed with a computer_deleted receipt. The
-- agent identity is kept, unbound.
create or replace function public.detach_hivra_agents_on_computer_delete()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; r public.hivra_agent_attachment_installations%rowtype;
begin
  if new.status is distinct from 'deleted' or old.status='deleted' then return new; end if;
  for p in select * from public.hivra_agent_attachments where source_id=new.id and phase='attached' for update loop
    select * into r from public.hivra_agent_attachment_installations where operation_id=p.id;
    update public.hivra_canonical_primary_bindings set status='detached',detached_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=r.binding_id and status='active';
    update public.hivra_canonical_runtime_installations set status='removed',updated_at=clock_timestamp()
      where id=r.installation_id and status<>'removed';
    update public.hivra_agent_attachments set phase='detached',ended_at=clock_timestamp(),end_reason='computer_deleted'
      where id=p.id;
  end loop;
  return new;
end;
$$;
drop trigger if exists hivra_agents_detach_on_computer_delete on public.hivra_agents;
create trigger hivra_agents_detach_on_computer_delete after update of status on public.hivra_agents
for each row execute function public.detach_hivra_agents_on_computer_delete();

-- ---------------------------------------------------------------------------
-- 5. What the access gate shows and binds its review to (5.8).
-- ---------------------------------------------------------------------------
create or replace function public.read_hivra_agent_attach_target(p_owner text,p_source_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  m public.hivra_canonical_source_mappings%rowtype;
  r public.hivra_canonical_relationship_authority%rowtype;
  live public.hivra_agent_attachments%rowtype;
  reason text := null;
begin
  if p_owner is null or p_source_id is null then return null; end if;
  select * into a from public.hivra_agents where id=p_source_id and user_id=p_owner;
  if not found or a.status='deleted' then return null; end if;
  select * into m from public.hivra_canonical_source_mappings
    where source_kind='hivra' and source_id=a.id and user_id=p_owner and resource_kind='computer';
  if found then
    select * into r from public.hivra_canonical_relationship_authority where computer_id=m.computer_id and user_id=p_owner;
  end if;
  select * into live from public.hivra_agent_attachments where source_id=a.id and phase in ('claimed','dispatched','attached')
    order by created_at desc limit 1;
  if a.type is distinct from 'linux-desktop' or coalesce(a.computer_profile,'ubuntu-desktop')<>'ubuntu-desktop'
    or a.computer_substrate is distinct from 'proxmox-kvm' or m.computer_id is null
    or a.infrastructure_binding_token_enforced is distinct from true or not public.hivra_desktop_prepare_binding_ready(a)
  then reason := 'unsupported_computer';
  elsif live.id is not null then reason := 'agent_present';
  elsif a.status is distinct from 'running' or a.desired_state is distinct from 'running' or a.vmid is null or a.ip is null
  then reason := 'computer_not_running';
  elsif a.operation_id is not null then reason := 'computer_busy';
  end if;
  return jsonb_build_object('version',1,'sourceId',a.id,'computerId',m.computer_id,
    'deploymentMode',a.deployment_mode,'ramGb',a.ram,'cpu',a.cpu,
    'authority',public.hivra_desktop_prepare_authority(a),
    'writeAuthority',r.write_authority,
    'eligible',reason is null,'reason',reason,
    'liveAttachmentId',live.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Add: transfer relationship authority once, then claim under the owner's
--    plan-slot lock (5.1). The review the owner approved is the intent.
-- ---------------------------------------------------------------------------
create or replace function public.claim_hivra_agent_attachment(
  p_owner text,p_source_id uuid,p_operation_id uuid,p_authority_command_id uuid,
  p_expected_authority jsonb,p_intent jsonb,p_agent_limit integer
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  m public.hivra_canonical_source_mappings%rowtype;
  r public.hivra_canonical_relationship_authority%rowtype;
  p public.hivra_agent_attachments%rowtype;
  identity_id uuid;
  v_count integer;
  transferred jsonb;
begin
  if p_owner is null or length(p_owner) not between 1 and 256 or p_source_id is null or p_operation_id is null
    or p_authority_command_id is null or jsonb_typeof(p_expected_authority) is distinct from 'object'
    or p_agent_limit is null or p_agent_limit not between 0 and 100000
    or jsonb_typeof(p_intent) is distinct from 'object'
    or p_intent-array['version','agentIdentityId','runtimeId','agentName','installerSha256','grants',
      'grantPolicySha256','reviewSha256','requestId']<>'{}'::jsonb
    or p_intent->'version' is distinct from '2'::jsonb
    or jsonb_typeof(p_intent->'agentIdentityId') is distinct from 'string'
    or not coalesce(p_intent->>'agentIdentityId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
    or p_intent->>'runtimeId' is distinct from 'codex'
    or jsonb_typeof(p_intent->'agentName') is distinct from 'string'
    or not coalesce(length(btrim(p_intent->>'agentName')) between 1 and 60,false)
    or coalesce(p_intent->>'agentName','') ~ '[[:cntrl:]]'
    or p_intent->>'installerSha256' is distinct from '77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375'
    or jsonb_typeof(p_intent->'grants') is distinct from 'object' or (p_intent->'grants')-'workspace'<>'{}'::jsonb
    or jsonb_typeof(p_intent->'grants'->'workspace') is distinct from 'boolean'
    or p_intent->>'grantPolicySha256' is distinct from '3123bbb69012bd8c0f72c1af3ebe96cb6551d076c84a1e3920cdd1732283aa43'
    or not coalesce(p_intent->>'reviewSha256' ~ '^[0-9a-f]{64}$',false)
    or not coalesce(p_intent->>'requestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
  then return jsonb_build_object('status','invalid_request'); end if;
  identity_id := (p_intent->>'agentIdentityId')::uuid;

  -- The plan-slot lock first, then the canonical admin lock. The launch writers
  -- take only the slot lock, so this order cannot deadlock with them.
  perform public.lock_hivra_owner_agent_slots(p_owner);
  select * into p from public.hivra_agent_attachments where id=p_operation_id;
  if found then
    if p.user_id is distinct from p_owner or p.source_id is distinct from p_source_id or p.intent is distinct from p_intent then
      return jsonb_build_object('status','conflict');
    end if;
    return jsonb_build_object('status','claimed','operationId',p.id,'phase',p.phase,'computerId',p.computer_id,'resumed',true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hivra-canonical-shadow-admin',0));

  select * into a from public.hivra_agents where id=p_source_id and user_id=p_owner for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority then
    return jsonb_build_object('status','review_changed');
  end if;
  if a.type is distinct from 'linux-desktop' or a.computer_substrate is distinct from 'proxmox-kvm'
    or coalesce(a.computer_profile,'ubuntu-desktop')<>'ubuntu-desktop'
    or a.infrastructure_binding_token_enforced is distinct from true or not public.hivra_desktop_prepare_binding_ready(a)
  then return jsonb_build_object('status','not_eligible'); end if;
  if exists(select 1 from public.hivra_agent_attachments where source_id=a.id and phase in ('claimed','dispatched','attached')) then
    return jsonb_build_object('status','agent_present');
  end if;
  if a.status is distinct from 'running' or a.desired_state is distinct from 'running' or a.vmid is null or a.ip is null then
    return jsonb_build_object('status','computer_not_running');
  end if;
  if a.operation_id is not null then return jsonb_build_object('status','computer_busy'); end if;
  -- The database enforces the plan's agent limit (T35). An agent on My server
  -- uses the owner's own capacity and is not counted, as launch counts it.
  if a.deployment_mode='hivra-managed' then
    v_count := public.hivra_owner_agent_slot_count(p_owner);
    if v_count>=p_agent_limit then
      return jsonb_build_object('status','plan_agent_limit','activeCount',v_count,'limit',p_agent_limit);
    end if;
  end if;

  select * into m from public.hivra_canonical_source_mappings
    where source_kind='hivra' and source_id=a.id and user_id=p_owner and resource_kind='computer';
  if not found then return jsonb_build_object('status','not_eligible'); end if;
  select * into r from public.hivra_canonical_relationship_authority where computer_id=m.computer_id and user_id=p_owner;
  if not found then return jsonb_build_object('status','not_eligible'); end if;
  -- Relationship authority moves to the canonical writer once per computer,
  -- idempotent by command id (5.5, first row).
  if r.write_authority='legacy' then
    transferred := public.transfer_hivra_canonical_relationship_authority(p_owner,m.computer_id,m.last_source_event_id,
      r.generation,p_authority_command_id);
    if transferred is null then return jsonb_build_object('status','not_eligible'); end if;
    select * into r from public.hivra_canonical_relationship_authority where computer_id=m.computer_id and user_id=p_owner;
  end if;
  if r.write_authority is distinct from 'canonical' or r.generation<2 then return jsonb_build_object('status','not_eligible'); end if;

  select * into m from public.hivra_canonical_source_mappings
    where computer_id=m.computer_id and user_id=p_owner for update;
  if not exists(select 1 from public.hivra_canonical_source_events
      where event_id=m.last_source_event_id and source_kind='hivra' and source_id=a.id
        and processed_at is not null and payload=public.hivra_canonical_hivra_event_payload(a))
    or exists(select 1 from public.hivra_canonical_source_events
      where source_kind='hivra' and source_id=a.id and processed_at is null)
  then return jsonb_build_object('status','not_eligible'); end if;
  perform 1 from public.hivra_canonical_computers where id=m.computer_id and user_id=p_owner
    and observed_state='running' and desired_state='running' and operation_id is null and operation_state is null
    and write_authority='legacy' and tombstoned_at is null and source_event_id=m.last_source_event_id for update;
  if not found then return jsonb_build_object('status','not_eligible'); end if;
  perform 1 from public.hivra_canonical_relationship_authority where computer_id=m.computer_id and user_id=p_owner for update;
  -- Always a new identity; moving an existing agent is out of scope (5.1).
  if exists(select 1 from public.hivra_canonical_agent_identities where id=identity_id)
    or exists(select 1 from public.hivra_canonical_primary_bindings where computer_id=m.computer_id and status='active')
    or exists(select 1 from public.hivra_canonical_runtime_installations where computer_id=m.computer_id and status<>'removed')
    or exists(select 1 from public.hivra_agent_attachments where agent_identity_id=identity_id)
  then return jsonb_build_object('status','agent_present'); end if;

  update public.hivra_agents set operation_id=p_operation_id,operation_kind='agent_attach',
    operation_started_at=clock_timestamp(),operation_payload=jsonb_build_object('attachmentId',p_operation_id::text)
    where id=a.id;
  insert into public.hivra_agent_attachments(id,user_id,computer_id,source_id,authority_generation,
    authority_command_id,guest_authority,intent,agent_identity_id,phase,agent_limit,grants,review_sha256)
    values(p_operation_id,p_owner,m.computer_id,a.id,r.generation,r.command_id,p_expected_authority,p_intent,identity_id,
      'claimed',p_agent_limit,p_intent->'grants',p_intent->>'reviewSha256');
  insert into public.hivra_agent_attachment_outbox(operation_id) values(p_operation_id);
  return jsonb_build_object('status','claimed','operationId',p_operation_id,'phase','claimed',
    'computerId',m.computer_id,'resumed',false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Dispatch under the same lock (5.1): an owner who went over the limit
--    after the claim (a legacy row, a launch) has the claim cancelled with
--    plan_agent_limit in the same transaction, and nothing is dispatched.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_hivra_agent_attachment_v2(
  p_owner text,p_operation_id uuid,p_dispatch_id uuid,p_expected_generation bigint,
  p_expected_authority jsonb,p_installer_sha256 text
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; a public.hivra_agents%rowtype; v_count integer;
begin
  if p_owner is null or p_operation_id is null then return false; end if;
  perform public.lock_hivra_owner_agent_slots(p_owner);
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found or p.phase<>'claimed' or p.agent_limit is null then return false; end if;
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found then return false; end if;
  if a.deployment_mode='hivra-managed' then
    -- This claim already holds one of the counted slots.
    v_count := public.hivra_owner_agent_slot_count(p_owner);
    if v_count>p.agent_limit then
      if a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach' then return false; end if;
      update public.hivra_agent_attachments set phase='cancelled',completed_at=clock_timestamp(),end_reason='plan_agent_limit'
        where id=p.id and phase='claimed';
      update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
        where id=a.id;
      return false;
    end if;
  end if;
  return public.dispatch_hivra_agent_attachment(p_owner,p_operation_id,p_dispatch_id,p_expected_generation,
    p_expected_authority,p_installer_sha256);
end;
$$;

-- Cancel before dispatch, with the reason the owner sees.
create or replace function public.cancel_hivra_agent_attachment(p_owner text,p_operation_id uuid,p_reason text)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if p_reason is null or p_reason not in ('cancelled','computer_not_running','pending_delete') then return false; end if;
  if not public.cancel_undispatched_hivra_agent_attachment(p_owner,p_operation_id) then return false; end if;
  update public.hivra_agent_attachments set end_reason=p_reason where id=p_operation_id and user_id=p_owner and phase='cancelled';
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Activation v2: units v2 rendered from the approved grants (5.3) by the
--    pinned lifecycle program, and the instance token stored once. The v1
--    app-server activation stays revoked from every role.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_hivra_attachment_activation_v2(
  p_owner text,p_operation_id uuid,p_activation_id uuid,p_expected_generation bigint,
  p_expected_authority jsonb,p_observed_boot_id uuid,p_expected_staged jsonb,
  p_service_policy_sha256 text,p_program_sha256 text,p_service_definition_sha256 text,p_instance_token text
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  a public.hivra_agents%rowtype;
  m public.hivra_canonical_source_mappings%rowtype;
  r public.hivra_agent_attachment_installations%rowtype;
  o public.hivra_agent_attachment_guest_observations%rowtype;
  s jsonb; request jsonb; saved text;
begin
  if p_owner is null or p_operation_id is null or p_activation_id is null
    or p_expected_generation is null or p_expected_authority is null or p_observed_boot_id is null
    or jsonb_typeof(p_expected_staged) is distinct from 'object' or octet_length(p_expected_staged::text)>16384
    or p_service_policy_sha256 is distinct from '12b0537d0db3de953d07ddd3d050508c47af0d6c9ff1238abdaee7fae4f4917d'
    or p_program_sha256 is distinct from 'ea761a6df567b033b7ae83158d845777f024c0b7a27843f311db71bebeb54551'
    or p_service_definition_sha256 is null or p_service_definition_sha256 !~ '^[0-9a-f]{64}$'
    or p_instance_token is null or p_instance_token !~ '^[0-9a-f]{64}$'
  then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found or p.phase is distinct from 'dispatched' or p.grants is null
    or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority then return false; end if;
  -- Source first, as every lifecycle contender.
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach'
    or a.operation_payload is distinct from jsonb_build_object('attachmentId',p.id::text)
    or a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority
    or not public.hivra_desktop_prepare_binding_ready(a) then return false; end if;
  select * into m from public.hivra_canonical_source_mappings
    where computer_id=p.computer_id and user_id=p_owner and source_kind='hivra' and source_id=a.id for update;
  if not found then return false; end if;
  perform 1 from public.hivra_canonical_relationship_authority where computer_id=p.computer_id and user_id=p_owner
    and write_authority='canonical' and generation=p_expected_generation and command_id=p.authority_command_id for update;
  if not found then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if p.phase is distinct from 'dispatched'
    or exists(select 1 from public.hivra_agent_attachment_activation_dispatches where operation_id=p.id)
  then return false; end if;
  select * into r from public.hivra_agent_attachment_installations where operation_id=p.id;
  if not found then return false; end if;
  select * into o from public.hivra_agent_attachment_guest_observations where operation_id=p.id;
  if not found or o.boot_id is distinct from p_observed_boot_id then return false; end if;
  select result into s from public.hivra_agent_attachment_staging_results where operation_id=p.id;
  if not found or s is distinct from p_expected_staged or s->>'bootId' is distinct from o.boot_id::text
    or s->'identity' is distinct from jsonb_build_object('operationId',p.id::text,'dispatchId',p.dispatch_id::text,
      'installationId',r.installation_id::text,'bindingId',r.binding_id::text,
      'computerId',p.computer_id::text,'sourceId',p.source_id::text,'architecture',r.architecture)
  then return false; end if;
  if exists(select 1 from public.hivra_canonical_agent_identities where id=p.agent_identity_id)
    or exists(select 1 from public.hivra_canonical_primary_bindings where computer_id=p.computer_id and status='active')
    or exists(select 1 from public.hivra_canonical_runtime_installations where computer_id=p.computer_id and status<>'removed')
  then return false; end if;
  select instance_token into saved from public.hivra_agent_attachment_secrets where operation_id=p.id;
  if found and saved is distinct from p_instance_token then return false; end if;
  if not found then
    insert into public.hivra_agent_attachment_secrets(operation_id,instance_token) values(p.id,p_instance_token);
  end if;
  request:=jsonb_build_object('version',2,'operationId',p.id::text,'activationId',p_activation_id::text,
    'generation',p_expected_generation::text,'servicePolicySha256',p_service_policy_sha256,
    'programSha256',p_program_sha256,'serviceDefinitionSha256',p_service_definition_sha256,'grants',p.grants,
    'agentName',p.intent->>'agentName','staged',s);
  insert into public.hivra_agent_attachment_activation_dispatches(operation_id,activation_id,request)
    values(p.id,p_activation_id,request);
  insert into public.hivra_agent_attachment_activation_outbox(operation_id,activation_id,event_kind,payload)
    values(p.id,p_activation_id,'service_activation_dispatched',request);
  return true;
end;
$$;

-- The instance token, for the worker's later steps and the Chat surface's
-- model settings. Owner-bound; never for a finished attachment.
create or replace function public.read_hivra_attachment_instance_token(p_owner text,p_operation_id uuid)
returns text language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select s.instance_token from public.hivra_agent_attachment_secrets s
  join public.hivra_agent_attachments p on p.id=s.operation_id
  where p.user_id=p_owner and p.id=p_operation_id and p.phase in ('dispatched','attached');
$$;

-- ---------------------------------------------------------------------------
-- 9. Complete: only with the readiness observation ("Chat is ready"). Publishes
--    the canonical identity (active), installation (ready) and binding
--    (active) and releases the lease, in one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.complete_hivra_agent_attachment(
  p_owner text,p_operation_id uuid,p_expected_generation bigint,p_expected_authority jsonb,p_observation_id uuid
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  a public.hivra_agents%rowtype;
  m public.hivra_canonical_source_mappings%rowtype;
  r public.hivra_agent_attachment_installations%rowtype;
  d public.hivra_agent_attachment_activation_dispatches%rowtype;
  ob public.hivra_agent_attachment_activation_observations%rowtype;
begin
  if p_owner is null or p_operation_id is null or p_expected_generation is null or p_expected_authority is null
    or p_observation_id is null then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found then return false; end if;
  if p.phase='attached' then
    return exists(select 1 from public.hivra_agent_attachment_activation_observations
      where observation_id=p_observation_id and operation_id=p.id and result->>'state'='native_protocol_available');
  end if;
  if p.phase is distinct from 'dispatched' or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority then return false; end if;
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach'
    or a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority
  then return false; end if;
  select * into m from public.hivra_canonical_source_mappings
    where computer_id=p.computer_id and user_id=p_owner and source_kind='hivra' and source_id=a.id for update;
  if not found then return false; end if;
  perform 1 from public.hivra_canonical_relationship_authority where computer_id=p.computer_id and user_id=p_owner
    and write_authority='canonical' and generation=p_expected_generation and command_id=p.authority_command_id for update;
  if not found then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if p.phase is distinct from 'dispatched' then return false; end if;
  select * into r from public.hivra_agent_attachment_installations where operation_id=p.id;
  select * into d from public.hivra_agent_attachment_activation_dispatches where operation_id=p.id;
  if r.operation_id is null or d.operation_id is null or d.request->>'version' is distinct from '2' then return false; end if;
  select * into ob from public.hivra_agent_attachment_activation_observations
    where observation_id=p_observation_id and operation_id=p.id and activation_id=d.activation_id;
  if not found or ob.result->>'state' is distinct from 'native_protocol_available'
    or ob.result->>'installationId' is distinct from r.installation_id::text then return false; end if;
  if exists(select 1 from public.hivra_canonical_agent_identities where id=p.agent_identity_id)
    or exists(select 1 from public.hivra_canonical_primary_bindings where computer_id=p.computer_id and status='active')
    or exists(select 1 from public.hivra_canonical_runtime_installations where computer_id=p.computer_id and status<>'removed')
  then return false; end if;
  insert into public.hivra_canonical_agent_identities(id,user_id,name,status,source_event_id,
    write_authority,authority_generation,authority_command_id)
    values(p.agent_identity_id,p_owner,btrim(p.intent->>'agentName'),'active',m.last_source_event_id,
      'canonical',p.authority_generation,p.authority_command_id);
  insert into public.hivra_canonical_runtime_installations(id,user_id,computer_id,runtime_id,status,source_event_id,
    write_authority,authority_generation,authority_command_id)
    values(r.installation_id,p_owner,p.computer_id,'codex','ready',m.last_source_event_id,
      'canonical',p.authority_generation,p.authority_command_id);
  insert into public.hivra_canonical_primary_bindings(id,user_id,computer_id,agent_identity_id,status,source_event_id,
    write_authority,authority_generation,authority_command_id)
    values(r.binding_id,p_owner,p.computer_id,p.agent_identity_id,'active',m.last_source_event_id,
      'canonical',p.authority_generation,p.authority_command_id);
  update public.hivra_agent_attachments set phase='attached',completed_at=clock_timestamp() where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Fail: terminal only with an observed cleanup receipt. Without one the
--     attachment stays dispatched and the computer page says "We couldn't
--     confirm this step yet" (5.5).
-- ---------------------------------------------------------------------------
create or replace function public.fail_hivra_agent_attachment(
  p_owner text,p_operation_id uuid,p_expected_generation bigint,p_expected_authority jsonb,p_cleanup jsonb,p_failure_code text
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; a public.hivra_agents%rowtype; r public.hivra_agent_attachment_installations%rowtype;
begin
  if p_owner is null or p_operation_id is null or jsonb_typeof(p_cleanup) is distinct from 'object'
    or octet_length(p_cleanup::text)>16384 or p_cleanup->'version' is distinct from '1'::jsonb
    or p_cleanup->>'state' is distinct from 'removed' or p_cleanup->'workspaceTouched' is distinct from 'false'::jsonb
    or p_failure_code is null or p_failure_code !~ '^[a-z][a-z0-9_]{0,63}$' then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found then return false; end if;
  if p.phase='failed' then return true; end if;
  if p.phase is distinct from 'dispatched' or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority then return false; end if;
  select * into r from public.hivra_agent_attachment_installations where operation_id=p.id;
  if not found or p_cleanup->>'installationId' is distinct from r.installation_id::text then return false; end if;
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach' then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if p.phase is distinct from 'dispatched' then return false; end if;
  update public.hivra_agent_attachments set phase='failed',completed_at=clock_timestamp(),
    end_reason=case when p_failure_code='pending_delete' then 'pending_delete' else 'install_failed' end where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. The contract the attached agent loads (4.5, 4.6). Delivered only when
--     root's read-back matched these exact file bytes on the host and inside
--     the unit's mount namespace; revisions only move forward.
-- ---------------------------------------------------------------------------
create or replace function public.record_hivra_attachment_contract(
  p_owner text,p_attachment_id uuid,p_revision integer,p_content text,p_content_sha256 text,p_file_sha256 text,
  p_grants jsonb,p_readback jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; c public.hivra_agent_attachment_contracts%rowtype; matched boolean;
begin
  if p_owner is null or p_attachment_id is null or p_revision is null or p_revision not between 1 and 1000000
    or p_content is null or octet_length(p_content) not between 1 and 4096
    or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$'
    or encode(sha256(convert_to(p_content,'UTF8')),'hex') is distinct from p_content_sha256
    or jsonb_typeof(p_grants) is distinct from 'object' or p_grants-'workspace'<>'{}'::jsonb
    or jsonb_typeof(p_grants->'workspace') is distinct from 'boolean'
    or (p_readback is not null and (jsonb_typeof(p_readback) is distinct from 'object'
      or p_readback-array['sha256','checked']<>'{}'::jsonb or jsonb_typeof(p_readback->'checked') is distinct from 'boolean'
      or not coalesce(p_readback->>'sha256' ~ '^[0-9a-f]{64}$',false)))
  then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_attachment_id and user_id=p_owner for update;
  if not found or p.phase not in ('dispatched','attached') then return false; end if;
  matched := p_readback is not null and (p_readback->>'checked')::boolean and p_readback->>'sha256'=p_file_sha256;
  select * into c from public.hivra_agent_attachment_contracts where attachment_id=p.id and revision=p_revision;
  if found then
    if c.content_sha256 is distinct from p_content_sha256 or c.file_sha256 is distinct from p_file_sha256
      or c.grants is distinct from p_grants then return false; end if;
    if matched and c.delivered_at is null then
      update public.hivra_agent_attachment_contracts set delivered_at=clock_timestamp(),readback_sha256=p_file_sha256
        where attachment_id=p.id and revision=p_revision;
    end if;
    return true;
  end if;
  if exists(select 1 from public.hivra_agent_attachment_contracts where attachment_id=p.id and revision>=p_revision) then
    return false;
  end if;
  insert into public.hivra_agent_attachment_contracts(attachment_id,user_id,revision,content,content_sha256,file_sha256,
    grants,delivered_at,readback_sha256)
    values(p.id,p_owner,p_revision,p_content,p_content_sha256,p_file_sha256,p_grants,
      case when matched then clock_timestamp() end,case when matched then p_file_sha256 end);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Change access and Remove (5.5): each its own reviewed operation.
-- ---------------------------------------------------------------------------
create or replace function public.begin_hivra_agent_attachment_operation(
  p_owner text,p_attachment_id uuid,p_operation_id uuid,p_kind text,p_expected_authority jsonb,
  p_grants jsonb,p_review_sha256 text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; a public.hivra_agents%rowtype; o public.hivra_agent_attachment_operations%rowtype;
begin
  if p_owner is null or p_attachment_id is null or p_operation_id is null or p_kind is null
    or p_kind not in ('access_change','detach') or jsonb_typeof(p_expected_authority) is distinct from 'object'
    or jsonb_typeof(p_grants) is distinct from 'object' or p_grants-'workspace'<>'{}'::jsonb
    or jsonb_typeof(p_grants->'workspace') is distinct from 'boolean'
    or p_review_sha256 is null or p_review_sha256 !~ '^[0-9a-f]{64}$'
  then return jsonb_build_object('status','invalid_request'); end if;
  select * into o from public.hivra_agent_attachment_operations where id=p_operation_id;
  if found then
    if o.user_id is distinct from p_owner or o.attachment_id is distinct from p_attachment_id or o.kind is distinct from p_kind
      or o.grants is distinct from p_grants or o.review_sha256 is distinct from p_review_sha256 then
      return jsonb_build_object('status','conflict');
    end if;
    return jsonb_build_object('status','claimed','operationId',o.id,'phase',o.phase,'resumed',true);
  end if;
  select * into p from public.hivra_agent_attachments where id=p_attachment_id and user_id=p_owner;
  if not found then return jsonb_build_object('status','not_found'); end if;
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  select * into p from public.hivra_agent_attachments where id=p_attachment_id and user_id=p_owner for update;
  if p.phase is distinct from 'attached' then return jsonb_build_object('status','not_attached'); end if;
  if public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority then
    return jsonb_build_object('status','review_changed');
  end if;
  if a.status is distinct from 'running' or a.desired_state is distinct from 'running' then
    return jsonb_build_object('status','computer_not_running');
  end if;
  if a.operation_id is not null or exists(select 1 from public.hivra_agent_attachment_operations
      where attachment_id=p.id and phase in ('claimed','dispatched')) then
    return jsonb_build_object('status','computer_busy');
  end if;
  if p_kind='access_change' and p_grants=p.grants then return jsonb_build_object('status','unchanged'); end if;
  -- A Remove carries the grants the attachment has, so its record says what was removed.
  if p_kind='detach' and p_grants is distinct from p.grants then return jsonb_build_object('status','review_changed'); end if;
  -- The lease first: the operation's guard holds it from the moment the step exists.
  update public.hivra_agents set operation_id=p_operation_id,
    operation_kind=case p_kind when 'detach' then 'agent_detach' else 'agent_access_change' end,
    operation_started_at=clock_timestamp(),
    operation_payload=jsonb_build_object('attachmentId',p.id::text,'operationId',p_operation_id::text)
    where id=a.id;
  insert into public.hivra_agent_attachment_operations(id,attachment_id,user_id,source_id,kind,phase,grants,review_sha256,guest_authority)
    values(p_operation_id,p.id,p_owner,a.id,p_kind,'claimed',p_grants,p_review_sha256,public.hivra_desktop_prepare_authority(a));
  return jsonb_build_object('status','claimed','operationId',p_operation_id,'phase','claimed','resumed',false);
end;
$$;

-- At most once: only this compare-and-swap lets the worker send the guest step.
create or replace function public.dispatch_hivra_agent_attachment_operation(p_owner text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare o public.hivra_agent_attachment_operations%rowtype; a public.hivra_agents%rowtype;
begin
  select * into o from public.hivra_agent_attachment_operations where id=p_operation_id and user_id=p_owner;
  if not found or o.phase is distinct from 'claimed' then return false; end if;
  select * into a from public.hivra_agents where id=o.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from o.id or a.status is distinct from 'running'
    or a.desired_state is distinct from 'running'
    or public.hivra_desktop_prepare_authority(a) is distinct from o.guest_authority then return false; end if;
  update public.hivra_agent_attachment_operations set phase='dispatched',dispatched_at=clock_timestamp()
    where id=o.id and phase='claimed';
  return found;
end;
$$;

-- Cancel a step that was never sent (the computer stopped, or a delete is pending).
create or replace function public.cancel_hivra_agent_attachment_operation(p_owner text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare o public.hivra_agent_attachment_operations%rowtype; a public.hivra_agents%rowtype;
begin
  select * into o from public.hivra_agent_attachment_operations where id=p_operation_id and user_id=p_owner;
  if not found or o.phase is distinct from 'claimed' then return false; end if;
  select * into a from public.hivra_agents where id=o.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from o.id then return false; end if;
  update public.hivra_agent_attachment_operations set phase='cancelled',completed_at=clock_timestamp()
    where id=o.id and phase='claimed';
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
end;
$$;

-- The guest's observed receipt ends the step. Remove needs every removal fact
-- observed; Change access needs the view to match the new grant and Chat ready.
create or replace function public.complete_hivra_agent_attachment_operation(p_owner text,p_operation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  o public.hivra_agent_attachment_operations%rowtype;
  p public.hivra_agent_attachments%rowtype;
  a public.hivra_agents%rowtype;
  r public.hivra_agent_attachment_installations%rowtype;
begin
  if p_owner is null or p_operation_id is null or jsonb_typeof(p_receipt) is distinct from 'object'
    or octet_length(p_receipt::text)>16384 or p_receipt->'version' is distinct from '1'::jsonb then return false; end if;
  select * into o from public.hivra_agent_attachment_operations where id=p_operation_id and user_id=p_owner;
  if not found then return false; end if;
  if o.phase='completed' then return o.receipt=p_receipt; end if;
  if o.phase is distinct from 'dispatched' then return false; end if;
  select * into r from public.hivra_agent_attachment_installations where operation_id=o.attachment_id;
  if not found or p_receipt->>'installationId' is distinct from r.installation_id::text
    or p_receipt->>'operationId' is distinct from o.id::text then return false; end if;
  if o.kind='detach' then
    if p_receipt->>'state' is distinct from 'removed' or p_receipt->'workspaceTouched' is distinct from 'false'::jsonb
      or p_receipt->'unitsRemoved' is distinct from 'true'::jsonb or p_receipt->'viewUnmounted' is distinct from 'true'::jsonb
      or p_receipt->'accountRemoved' is distinct from 'true'::jsonb or p_receipt->'homeRemoved' is distinct from 'true'::jsonb
      or p_receipt->'networkRemoved' is distinct from 'true'::jsonb or p_receipt->'stagingCleared' is distinct from 'true'::jsonb
      or p_receipt->'leftoverFiles' is distinct from '0'::jsonb then return false; end if;
  else
    if p_receipt->>'state' is distinct from 'ready' or p_receipt->'grants' is distinct from o.grants
      or p_receipt->'viewMounted' is distinct from o.grants->'workspace' then return false; end if;
  end if;
  select * into a from public.hivra_agents where id=o.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from o.id then return false; end if;
  select * into p from public.hivra_agent_attachments where id=o.attachment_id and user_id=p_owner for update;
  select * into o from public.hivra_agent_attachment_operations where id=p_operation_id for update;
  if o.phase is distinct from 'dispatched' or p.phase is distinct from 'attached' then return false; end if;
  update public.hivra_agent_attachment_operations set phase='completed',completed_at=clock_timestamp(),receipt=p_receipt
    where id=o.id;
  if o.kind='detach' then
    update public.hivra_canonical_primary_bindings set status='detached',detached_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=r.binding_id and status='active';
    update public.hivra_canonical_runtime_installations set status='removed',updated_at=clock_timestamp()
      where id=r.installation_id and status<>'removed';
    update public.hivra_agent_attachments set phase='detached',ended_at=clock_timestamp(),end_reason='removed' where id=p.id;
  else
    update public.hivra_agent_attachments set grants=o.grants,review_sha256=o.review_sha256 where id=p.id;
  end if;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
end;
$$;

-- A step that could not finish but was observed back in the attachment's
-- previous state (Change access put back, or a refusal before anything moved).
create or replace function public.fail_hivra_agent_attachment_operation(p_owner text,p_operation_id uuid,p_failure_code text,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare o public.hivra_agent_attachment_operations%rowtype; a public.hivra_agents%rowtype; p public.hivra_agent_attachments%rowtype;
begin
  if p_owner is null or p_operation_id is null or p_failure_code is null or p_failure_code !~ '^[a-z][a-z0-9_]{0,63}$'
    or jsonb_typeof(p_receipt) is distinct from 'object' or octet_length(p_receipt::text)>16384
    or p_receipt->'version' is distinct from '1'::jsonb or p_receipt->>'state' not in ('restored','refused') then return false; end if;
  select * into o from public.hivra_agent_attachment_operations where id=p_operation_id and user_id=p_owner;
  if not found or o.phase is distinct from 'dispatched' or p_receipt->>'operationId' is distinct from o.id::text then return false; end if;
  select * into p from public.hivra_agent_attachments where id=o.attachment_id;
  -- A put-back must be observed in the attachment's current grant again.
  if p_receipt->>'state'='restored' and p_receipt->'viewMounted' is distinct from p.grants->'workspace' then return false; end if;
  select * into a from public.hivra_agents where id=o.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from o.id then return false; end if;
  update public.hivra_agent_attachment_operations set phase='failed',completed_at=clock_timestamp(),
    failure_code=p_failure_code,receipt=p_receipt where id=o.id and phase='dispatched';
  if not found then return false; end if;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Reads for the computer page, the Agents list and the worker.
-- ---------------------------------------------------------------------------
create or replace function public.read_hivra_agent_attachments(p_owner text,p_source_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select coalesce(jsonb_agg(item order by created desc),'[]'::jsonb) from (
    select p.created_at as created, jsonb_build_object(
      'id',p.id,'phase',p.phase,'agentName',p.intent->>'agentName','runtimeId',p.intent->>'runtimeId',
      'agentIdentityId',p.agent_identity_id,'grants',p.grants,'endReason',p.end_reason,
      'createdAt',p.created_at,'dispatchedAt',p.dispatched_at,'completedAt',p.completed_at,'endedAt',p.ended_at,
      'deploymentMode',a.deployment_mode,'installationId',r.installation_id,
      'receipts',jsonb_build_object(
        'accepted',p.created_at,
        'staged',(select s.recorded_at from public.hivra_agent_attachment_staging_results s where s.operation_id=p.id),
        'started',(select min(ob.created_at) from public.hivra_agent_attachment_activation_observations ob
          where ob.operation_id=p.id and ob.result->>'state' in ('process_running','native_protocol_available')),
        'chatReady',(select min(ob.created_at) from public.hivra_agent_attachment_activation_observations ob
          where ob.operation_id=p.id and ob.result->>'state'='native_protocol_available')),
      'contract',(select jsonb_build_object('revision',c.revision,'content',c.content,'grants',c.grants,
          'renderedAt',c.rendered_at,'deliveredAt',c.delivered_at,
          'lastDelivered',(select jsonb_build_object('revision',x.revision,'deliveredAt',x.delivered_at)
            from public.hivra_agent_attachment_contracts x where x.attachment_id=p.id and x.delivered_at is not null
              and x.revision<c.revision order by x.revision desc limit 1))
        from public.hivra_agent_attachment_contracts c where c.attachment_id=p.id order by c.revision desc limit 1),
      'operation',(select jsonb_build_object('id',o.id,'kind',o.kind,'phase',o.phase,'grants',o.grants,
          'createdAt',o.created_at,'dispatchedAt',o.dispatched_at,'completedAt',o.completed_at,'failureCode',o.failure_code)
        from public.hivra_agent_attachment_operations o where o.attachment_id=p.id order by o.created_at desc limit 1)
    ) as item
    from public.hivra_agent_attachments p
    join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
    left join public.hivra_agent_attachment_installations r on r.operation_id=p.id
    where p.user_id=p_owner and p.source_id=p_source_id
    order by p.created_at desc limit 10
  ) rows;
$$;

-- Every live attached agent the owner has, for the Agents list
-- ("Codex on MY_UBUNTU_DESKTOP" opens the computer's Chat tab).
create or replace function public.read_hivra_owner_attached_agents(p_owner text)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'phase',p.phase,'agentName',p.intent->>'agentName',
      'runtimeId',p.intent->>'runtimeId','sourceId',p.source_id,'computerName',a.name,'computerStatus',a.status,
      'deploymentMode',a.deployment_mode,'installationId',r.installation_id,'createdAt',p.created_at,
      'completedAt',p.completed_at) order by p.created_at desc),'[]'::jsonb)
  from public.hivra_agent_attachments p
  join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
  left join public.hivra_agent_attachment_installations r on r.operation_id=p.id
  where p.user_id=p_owner and p.phase in ('claimed','dispatched','attached') and a.status<>'deleted';
$$;

-- Open work for the minute worker: attachments still installing and access or
-- remove steps still open. At most p_limit items in all, oldest first across
-- both kinds.
create or replace function public.list_open_hivra_agent_attachment_work(p_limit integer)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select coalesce(jsonb_agg(item order by at, id),'[]'::jsonb) from (
    select at, id, item from (
      (select p.created_at as at, p.id, jsonb_build_object('kind','attach','ownerId',p.user_id,'id',p.id) as item
        from public.hivra_agent_attachments p where p.phase in ('claimed','dispatched')
        order by p.created_at, p.id limit greatest(1,least(coalesce(p_limit,20),100)))
      union all
      (select o.created_at, o.id, jsonb_build_object('kind',o.kind,'ownerId',o.user_id,'id',o.id,'attachmentId',o.attachment_id)
        from public.hivra_agent_attachment_operations o where o.phase in ('claimed','dispatched')
        order by o.created_at, o.id limit greatest(1,least(coalesce(p_limit,20),100)))
    ) both_kinds
    order by at, id limit greatest(1,least(coalesce(p_limit,20),100))
  ) work;
$$;

-- One consistent view of an attachment for the worker's later steps.
create or replace function public.read_hivra_agent_attachment_state(p_owner text,p_attachment_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('version',1,'id',p.id,'ownerId',p.user_id,'phase',p.phase,'sourceId',p.source_id,
    'computerId',p.computer_id,'generation',p.authority_generation::text,'guestAuthority',p.guest_authority,
    'agentName',p.intent->>'agentName','grants',p.grants,'reviewSha256',p.review_sha256,'dispatchId',p.dispatch_id,
    'installation',case when r.operation_id is null then null else jsonb_build_object('installationId',r.installation_id,
      'bindingId',r.binding_id,'architecture',r.architecture) end,
    'bootId',g.boot_id,'staged',s.result,'activation',d.request,
    'readyObservationId',(select ob.observation_id from public.hivra_agent_attachment_activation_observations ob
      where ob.operation_id=p.id and ob.result->>'state'='native_protocol_available' order by ob.created_at limit 1),
    'contractRevision',(select max(c.revision) from public.hivra_agent_attachment_contracts c where c.attachment_id=p.id),
    'desiredState',a.desired_state,'computerStatus',a.status)
  from public.hivra_agent_attachments p
  join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
  left join public.hivra_agent_attachment_installations r on r.operation_id=p.id
  left join public.hivra_agent_attachment_guest_observations g on g.operation_id=p.id
  left join public.hivra_agent_attachment_staging_results s on s.operation_id=p.id
  left join public.hivra_agent_attachment_activation_dispatches d on d.operation_id=p.id
  where p.id=p_attachment_id and p.user_id=p_owner;
$$;

create or replace function public.read_hivra_agent_attachment_operation(p_owner text,p_operation_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('version',1,'operationId',o.id,'attachmentId',o.attachment_id,'ownerId',o.user_id,
    'kind',o.kind,'phase',o.phase,'grants',o.grants,'previousGrants',p.grants,'guestAuthority',o.guest_authority,
    'reviewSha256',o.review_sha256,'installationId',r.installation_id,'agentName',p.intent->>'agentName',
    'desiredState',a.desired_state,'computerStatus',a.status,'createdAt',o.created_at)
  from public.hivra_agent_attachment_operations o
  join public.hivra_agent_attachments p on p.id=o.attachment_id and p.user_id=o.user_id
  join public.hivra_agent_attachment_installations r on r.operation_id=p.id
  join public.hivra_agents a on a.id=o.source_id and a.user_id=o.user_id
  where o.id=p_operation_id and o.user_id=p_owner;
$$;

-- Nothing here is callable by an application role yet (the grants migration
-- follows); the triggers are never callable.
revoke all on function public.guard_hivra_agent_attachment_operation_lease(),
  public.guard_hivra_restore_while_attached(),
  public.detach_hivra_agents_on_computer_delete(),
  public.read_hivra_agent_attach_target(text,uuid),
  public.claim_hivra_agent_attachment(text,uuid,uuid,uuid,jsonb,jsonb,integer),
  public.dispatch_hivra_agent_attachment_v2(text,uuid,uuid,bigint,jsonb,text),
  public.cancel_hivra_agent_attachment(text,uuid,text),
  public.dispatch_hivra_attachment_activation_v2(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text,text,text),
  public.read_hivra_attachment_instance_token(text,uuid),
  public.complete_hivra_agent_attachment(text,uuid,bigint,jsonb,uuid),
  public.fail_hivra_agent_attachment(text,uuid,bigint,jsonb,jsonb,text),
  public.record_hivra_attachment_contract(text,uuid,integer,text,text,text,jsonb,jsonb),
  public.begin_hivra_agent_attachment_operation(text,uuid,uuid,text,jsonb,jsonb,text),
  public.dispatch_hivra_agent_attachment_operation(text,uuid),
  public.cancel_hivra_agent_attachment_operation(text,uuid),
  public.complete_hivra_agent_attachment_operation(text,uuid,jsonb),
  public.fail_hivra_agent_attachment_operation(text,uuid,text,jsonb),
  public.read_hivra_agent_attachments(text,uuid),
  public.read_hivra_owner_attached_agents(text),
  public.list_open_hivra_agent_attachment_work(integer),
  public.read_hivra_agent_attachment_state(text,uuid),
  public.read_hivra_agent_attachment_operation(text,uuid)
  from public,anon,authenticated,service_role;
