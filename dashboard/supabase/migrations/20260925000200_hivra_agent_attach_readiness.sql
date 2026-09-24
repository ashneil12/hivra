-- Add an agent only to a computer that is running and ready, and end a
-- precondition refusal as failed with its reason, never held (docs/superpowers/
-- specs/2026-09-24-agent-computer-contract-and-attach.md, 5.5 and 5.8).
--
-- - The gate reads "computer_not_ready" for a running computer that Hivra has
--   not yet seen ready: no provisioned_at stamp, or no gateway (chat_url) for
--   the agent's Chat tab to reach.
-- - refuse_hivra_agent_attachment ends a claim that nothing ran for yet (no
--   dispatch was ever granted) as failed, with computer_not_running or
--   computer_not_ready, and releases the computer's lease. The worker calls it
--   instead of holding the claim when the computer stopped, is not ready, or
--   its guest never answered Hivra.
-- - The worker's state read carries the claim's createdAt, so how long a guest
--   has not answered is measured from the database.
--
-- Rollout: additive. Apply after 20260925000000 and 20260925000100 and before
-- the code that calls refuse_hivra_agent_attachment serves. The attach tables
-- hold no rows on any environment before this release, so the replaced checks
-- validate instantly.
--
-- Idempotent: constraints are dropped before they are created again, functions
-- are replaced, and the grants are revoked before they are given.

-- ---------------------------------------------------------------------------
-- 1. A failed attachment either had a dispatch (and an observed cleanup), or
--    was refused before one with a precondition reason.
-- ---------------------------------------------------------------------------
alter table public.hivra_agent_attachments
  drop constraint if exists hivra_agent_attachments_check,
  drop constraint if exists hivra_agent_attachments_end_reason_check;
alter table public.hivra_agent_attachments
  add constraint hivra_agent_attachments_check check (
    (phase='claimed' and completed_at is null and dispatch_id is null and dispatched_at is null and ended_at is null)
    or (phase='dispatched' and completed_at is null and dispatch_id is not null and dispatched_at is not null and ended_at is null)
    or (phase='cancelled' and completed_at is not null and dispatch_id is null and dispatched_at is null)
    or (phase='attached' and completed_at is not null and dispatch_id is not null and ended_at is null)
    or (phase='failed' and completed_at is not null and dispatch_id is not null)
    or (phase='failed' and completed_at is not null and dispatch_id is null and dispatched_at is null
      and end_reason in ('computer_not_running','computer_not_ready'))
    or (phase='detached' and completed_at is not null and dispatch_id is not null and ended_at is not null)),
  add constraint hivra_agent_attachments_end_reason_check check (
    end_reason is null or end_reason in ('plan_agent_limit','cancelled','computer_not_running','computer_not_ready',
      'pending_delete','install_failed','removed','computer_deleted'));

-- ---------------------------------------------------------------------------
-- 2. What the access gate shows: running, then ready.
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
  elsif a.provisioned_at is null or nullif(btrim(coalesce(a.chat_url,'')),'') is null then reason := 'computer_not_ready';
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
-- 3. Refuse before dispatch: failed with its reason, the lease released.
--    Only a claim that no dispatch was ever granted for, so nothing of it ran
--    on the computer. A replay of the same refusal answers true.
-- ---------------------------------------------------------------------------
create or replace function public.refuse_hivra_agent_attachment(p_owner text,p_operation_id uuid,p_reason text)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; a public.hivra_agents%rowtype;
begin
  if p_owner is null or p_operation_id is null or p_reason is null
    or p_reason not in ('computer_not_running','computer_not_ready') then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found then return false; end if;
  if p.phase='failed' then return p.end_reason is not distinct from p_reason and p.dispatch_id is null; end if;
  if p.phase is distinct from 'claimed' then return false; end if;
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach' then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if p.phase is distinct from 'claimed' or p.dispatch_id is not null then return false; end if;
  if exists(select 1 from public.hivra_agent_attachment_dispatches where operation_id=p.id) then return false; end if;
  update public.hivra_agent_attachments set phase='failed',completed_at=clock_timestamp(),end_reason=p_reason where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The worker's state read, with the claim's createdAt.
-- ---------------------------------------------------------------------------
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
    'desiredState',a.desired_state,'computerStatus',a.status,'createdAt',p.created_at)
  from public.hivra_agent_attachments p
  join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
  left join public.hivra_agent_attachment_installations r on r.operation_id=p.id
  left join public.hivra_agent_attachment_guest_observations g on g.operation_id=p.id
  left join public.hivra_agent_attachment_staging_results s on s.operation_id=p.id
  left join public.hivra_agent_attachment_activation_dispatches d on d.operation_id=p.id
  where p.id=p_attachment_id and p.user_id=p_owner;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants: service_role only, as for every other attach function.
-- ---------------------------------------------------------------------------
revoke all on function public.read_hivra_agent_attach_target(text,uuid),
  public.refuse_hivra_agent_attachment(text,uuid,text),
  public.read_hivra_agent_attachment_state(text,uuid)
  from public,anon,authenticated;
grant execute on function public.read_hivra_agent_attach_target(text,uuid),
  public.refuse_hivra_agent_attachment(text,uuid,text),
  public.read_hivra_agent_attachment_state(text,uuid)
  to service_role;
