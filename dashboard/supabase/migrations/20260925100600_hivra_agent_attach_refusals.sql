-- A refusal the computer names ends an attach step as failed with its reason,
-- and a computer that changed while a step waited for it is taken back to be
-- cleaned up (docs/superpowers/specs/2026-09-24-agent-computer-contract-and-
-- attach.md, 5.5 and 5.8; threat T3).
--
-- Before this file an install that had been sent to the computer and that the
-- computer refused the same way every time (its gateway older than attached
-- agents, ~/Hivra not a plain folder, a staging run that ended without a
-- receipt) held the computer's lease for good: Start, Stop and Restart were
-- refused. An interrupted step whose computer came back changed (moved,
-- restored, its address or channel changed) was never taken back and kept its
-- plan slot.
--
-- - hivra_agent_attachments.failure_code: why an install that was sent to the
--   computer failed, stored by fail_hivra_agent_attachment beside end_reason
--   install_failed. The worker calls it only after an observed cleanup.
-- - refuse_hivra_agent_attachment also ends a claim nothing ran for as failed
--   with computer_update_required (the computer's gateway predates attached
--   agents) or download_failed (the computer could not fetch Codex).
-- - resume_hivra_agent_attachment_step takes the lease back for a computer
--   that runs again, free, but changed while the step waited. The step is
--   marked computer_changed; the worker removes what an install left and fails
--   it with that reason, and ends a Change access or Remove by what the
--   computer shows, as for any other resumed step.
-- - The worker's state read carries when the install and the activation were
--   sent (dispatchedAt, activationDispatchedAt), so a step that never ended is
--   judged from the database clock; the computer page's read carries the
--   failure code.
--
-- Rollout: additive. Apply after 20260925100500 and before the code that reads
-- failureCode or refuses with the new reasons serves. Every row the earlier
-- files allow still passes: the replaced checks only widen what a failed or
-- interrupted row may look like. Preflight on each environment and keep the
-- result with the release record:
--   select phase, end_reason, interrupt_reason, count(*)
--   from public.hivra_agent_attachments group by 1,2,3;
-- Expected: no rows, or only phases and reasons the checks below allow.
--
-- Idempotent: the column "if not exists", constraints dropped before they are
-- created again, functions replaced, grants revoked before they are given.

-- ---------------------------------------------------------------------------
-- 1. The failure code, and the new refusal and interruption reasons.
-- ---------------------------------------------------------------------------
alter table public.hivra_agent_attachments add column if not exists failure_code text;
alter table public.hivra_agent_attachments
  drop constraint if exists hivra_agent_attachments_failure_code_check,
  drop constraint if exists hivra_agent_attachments_check,
  drop constraint if exists hivra_agent_attachments_end_reason_check,
  drop constraint if exists hivra_agent_attachments_interrupt_check;
alter table public.hivra_agent_attachments
  add constraint hivra_agent_attachments_failure_code_check check (
    failure_code is null or (phase='failed' and failure_code ~ '^[a-z][a-z0-9_]{0,63}$')),
  add constraint hivra_agent_attachments_check check (
    (phase='claimed' and completed_at is null and dispatch_id is null and dispatched_at is null and ended_at is null)
    or (phase='dispatched' and completed_at is null and dispatch_id is not null and dispatched_at is not null and ended_at is null)
    or (phase='cancelled' and completed_at is not null and dispatch_id is null and dispatched_at is null)
    or (phase='attached' and completed_at is not null and dispatch_id is not null and ended_at is null)
    or (phase='failed' and completed_at is not null and dispatch_id is not null)
    or (phase='failed' and completed_at is not null and dispatch_id is null and dispatched_at is null
      and end_reason in ('computer_not_running','computer_not_ready','computer_update_required','download_failed'))
    or (phase='detached' and completed_at is not null and dispatch_id is not null and ended_at is not null)),
  add constraint hivra_agent_attachments_end_reason_check check (
    end_reason is null or end_reason in ('plan_agent_limit','cancelled','computer_not_running','computer_not_ready',
      'computer_update_required','download_failed','pending_delete','install_failed','removed','computer_deleted')),
  add constraint hivra_agent_attachments_interrupt_check check (
    (interrupt_reason is null) = (interrupted_at is null)
    and (interrupt_reason is null or interrupt_reason in ('computer_not_running','pending_delete','computer_changed'))
    and (not lease_released or (phase='dispatched' and interrupt_reason is not null))
    -- An install the computer stopped under, or that came back changed, is removed, never finished.
    and (phase<>'attached' or interrupt_reason is null));
alter table public.hivra_agent_attachment_operations drop constraint if exists hivra_agent_attachment_operations_interrupt_check;
alter table public.hivra_agent_attachment_operations add constraint hivra_agent_attachment_operations_interrupt_check check (
  (interrupt_reason is null) = (interrupted_at is null)
  and (interrupt_reason is null or interrupt_reason in ('computer_not_running','pending_delete','computer_changed'))
  and (not lease_released or (phase='dispatched' and interrupt_reason is not null)));

-- ---------------------------------------------------------------------------
-- 2. Fail: terminal only with an observed cleanup receipt, now with its code.
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
    end_reason=case when p_failure_code='pending_delete' then 'pending_delete' else 'install_failed' end,
    failure_code=p_failure_code where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Refuse before dispatch, with the two new preconditions.
-- ---------------------------------------------------------------------------
create or replace function public.refuse_hivra_agent_attachment(p_owner text,p_operation_id uuid,p_reason text)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype; a public.hivra_agents%rowtype;
begin
  if p_owner is null or p_operation_id is null or p_reason is null
    or p_reason not in ('computer_not_running','computer_not_ready','computer_update_required','download_failed') then return false; end if;
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
-- 4. Resume: a computer that runs again, free, is taken back even when it
--    changed while the step waited; the step is then marked computer_changed
--    and ended by what the computer shows, never continued as reviewed.
-- ---------------------------------------------------------------------------
create or replace function public.resume_hivra_agent_attachment_step(p_owner text,p_kind text,p_step_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  o public.hivra_agent_attachment_operations%rowtype;
  a public.hivra_agents%rowtype;
  v_source uuid; v_phase text; v_released boolean; v_authority jsonb; v_lease_kind text; v_payload jsonb; v_changed boolean;
begin
  if p_owner is null or p_step_id is null or p_kind is null or p_kind not in ('attach','access_change','detach') then return false; end if;
  if p_kind='attach' then
    select * into p from public.hivra_agent_attachments where id=p_step_id and user_id=p_owner;
    if not found then return false; end if;
    v_source:=p.source_id; v_phase:=p.phase; v_released:=p.lease_released; v_authority:=p.guest_authority;
    v_lease_kind:='agent_attach'; v_payload:=jsonb_build_object('attachmentId',p.id::text);
  else
    select * into o from public.hivra_agent_attachment_operations where id=p_step_id and user_id=p_owner and kind=p_kind;
    if not found then return false; end if;
    select * into p from public.hivra_agent_attachments where id=o.attachment_id and user_id=p_owner;
    if not found or p.phase is distinct from 'attached' then return false; end if;
    v_source:=o.source_id; v_phase:=o.phase; v_released:=o.lease_released; v_authority:=o.guest_authority;
    v_lease_kind:=case p_kind when 'detach' then 'agent_detach' else 'agent_access_change' end;
    v_payload:=jsonb_build_object('attachmentId',o.attachment_id::text,'operationId',o.id::text);
  end if;
  if v_phase is distinct from 'dispatched' then return false; end if;
  select * into a from public.hivra_agents where id=v_source and user_id=p_owner for update;
  if not found then return false; end if;
  if not v_released then
    return a.operation_id is not distinct from p_step_id and a.operation_kind is not distinct from v_lease_kind;
  end if;
  if a.status is distinct from 'running' or a.desired_state is distinct from 'running' or a.operation_id is not null then return false; end if;
  v_changed := public.hivra_desktop_prepare_authority(a) is distinct from v_authority;
  -- The lease first, while the step is still released; then the step holds it again.
  update public.hivra_agents set operation_id=p_step_id,operation_kind=v_lease_kind,operation_started_at=clock_timestamp(),
    operation_payload=v_payload where id=a.id;
  if p_kind='attach' then
    update public.hivra_agent_attachments set lease_released=false,
      interrupt_reason=case when v_changed then 'computer_changed' else interrupt_reason end
      where id=p_step_id and phase='dispatched' and lease_released;
  else
    update public.hivra_agent_attachment_operations set lease_released=false,
      interrupt_reason=case when v_changed then 'computer_changed' else interrupt_reason end
      where id=p_step_id and phase='dispatched' and lease_released;
  end if;
  if not found then raise exception 'attach step changed while its lease was taken back' using errcode='40001'; end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The reads: when each part of an install was sent, and why it failed.
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
    'desiredState',a.desired_state,'computerStatus',a.status,'computerOperationId',a.operation_id,'createdAt',p.created_at,
    'leaseReleased',p.lease_released,'interruptReason',p.interrupt_reason,
    'dispatchedAt',p.dispatched_at,'activationDispatchedAt',d.created_at)
  from public.hivra_agent_attachments p
  join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
  left join public.hivra_agent_attachment_installations r on r.operation_id=p.id
  left join public.hivra_agent_attachment_guest_observations g on g.operation_id=p.id
  left join public.hivra_agent_attachment_staging_results s on s.operation_id=p.id
  left join public.hivra_agent_attachment_activation_dispatches d on d.operation_id=p.id
  where p.id=p_attachment_id and p.user_id=p_owner;
$$;

create or replace function public.read_hivra_agent_attachments(p_owner text,p_source_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select coalesce(jsonb_agg(item order by created desc),'[]'::jsonb) from (
    select p.created_at as created, jsonb_build_object(
      'id',p.id,'phase',p.phase,'agentName',p.intent->>'agentName','runtimeId',p.intent->>'runtimeId',
      'agentIdentityId',p.agent_identity_id,'grants',p.grants,'endReason',p.end_reason,'failureCode',p.failure_code,
      'createdAt',p.created_at,'dispatchedAt',p.dispatched_at,'completedAt',p.completed_at,'endedAt',p.ended_at,
      'deploymentMode',a.deployment_mode,'installationId',r.installation_id,
      'leaseReleased',p.lease_released,'interruptReason',p.interrupt_reason,'interruptedAt',p.interrupted_at,
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
          'createdAt',o.created_at,'dispatchedAt',o.dispatched_at,'completedAt',o.completed_at,'failureCode',o.failure_code,
          'leaseReleased',o.lease_released,'interruptReason',o.interrupt_reason,'interruptedAt',o.interrupted_at)
        from public.hivra_agent_attachment_operations o where o.attachment_id=p.id order by o.created_at desc limit 1)
    ) as item
    from public.hivra_agent_attachments p
    join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
    left join public.hivra_agent_attachment_installations r on r.operation_id=p.id
    where p.user_id=p_owner and p.source_id=p_source_id
    order by p.created_at desc limit 10
  ) rows;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants: service_role only, as for every other attach function.
-- ---------------------------------------------------------------------------
revoke all on function public.fail_hivra_agent_attachment(text,uuid,bigint,jsonb,jsonb,text),
  public.refuse_hivra_agent_attachment(text,uuid,text),
  public.resume_hivra_agent_attachment_step(text,text,uuid),
  public.read_hivra_agent_attachment_state(text,uuid),
  public.read_hivra_agent_attachments(text,uuid)
  from public,anon,authenticated;
grant execute on function public.fail_hivra_agent_attachment(text,uuid,bigint,jsonb,jsonb,text),
  public.refuse_hivra_agent_attachment(text,uuid,text),
  public.resume_hivra_agent_attachment_step(text,text,uuid),
  public.read_hivra_agent_attachment_state(text,uuid),
  public.read_hivra_agent_attachments(text,uuid)
  to service_role;
