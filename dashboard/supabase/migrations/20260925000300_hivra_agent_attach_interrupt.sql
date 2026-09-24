-- A dispatched attach step no longer wedges its computer (docs/superpowers/
-- specs/2026-09-24-agent-computer-contract-and-attach.md, 5.5; threat T3).
--
-- Before this file, an install, Change access or Remove that had been sent to
-- the computer held the computer's lease until the guest answered. A computer
-- that stopped under the step, or whose owner asked to delete it, stayed held:
-- Start, Stop and Restart were refused and Delete only answered "pending".
--
-- - interrupt_hivra_agent_attachment_step: the worker calls it when the host,
--   under its allocation lock, saw that the VM is not running (so nothing of
--   the step can still run in it), or when a delete is pending (the delete
--   destroys the VM and whatever the step did in it). The step stays open and
--   is marked lease_released with its reason; the computer's lease is released
--   so Start, Restart and Delete go ahead. Nothing is marked done.
-- - resume_hivra_agent_attachment_step: when Hivra's record shows the computer
--   running again, free, not being deleted and unchanged since the step's
--   review, the worker takes the lease back and ends the step by what the
--   computer shows: an interrupted install is removed and then fails; a Change
--   access looks and finishes or is put back; a Remove runs again.
-- - An interrupted install never becomes attached (check constraint).
-- - Deleting the computer ends an interrupted install (failed,
--   computer_deleted) and an interrupted Change access or Remove (failed,
--   computer_deleted).
-- - The worker's queue is served least recently tried first, so steps that
--   stay held never starve a newer one. An interrupted step is listed only
--   while its computer is running and free, and then at most every ten minutes.
--
-- Rollout: additive. Apply after 20260925000200 and before the code that calls
-- these functions serves. Existing rows get lease_released=false and no
-- interruption, which every earlier file already implies. Idempotent: columns
-- "if not exists", constraints dropped before they are created again,
-- functions replaced, grants revoked before they are given.

-- ---------------------------------------------------------------------------
-- 1. The interruption record on both kinds of step.
-- ---------------------------------------------------------------------------
alter table public.hivra_agent_attachments
  add column if not exists lease_released boolean not null default false,
  add column if not exists interrupted_at timestamptz,
  add column if not exists interrupt_reason text,
  add column if not exists last_attempt_at timestamptz;
alter table public.hivra_agent_attachment_operations
  add column if not exists lease_released boolean not null default false,
  add column if not exists interrupted_at timestamptz,
  add column if not exists interrupt_reason text,
  add column if not exists last_attempt_at timestamptz;
alter table public.hivra_agent_attachments drop constraint if exists hivra_agent_attachments_interrupt_check;
alter table public.hivra_agent_attachments add constraint hivra_agent_attachments_interrupt_check check (
  (interrupt_reason is null) = (interrupted_at is null)
  and (interrupt_reason is null or interrupt_reason in ('computer_not_running','pending_delete'))
  and (not lease_released or (phase='dispatched' and interrupt_reason is not null))
  -- An install the computer stopped under is removed, never finished.
  and (phase<>'attached' or interrupt_reason is null));
alter table public.hivra_agent_attachment_operations drop constraint if exists hivra_agent_attachment_operations_interrupt_check;
alter table public.hivra_agent_attachment_operations add constraint hivra_agent_attachment_operations_interrupt_check check (
  (interrupt_reason is null) = (interrupted_at is null)
  and (interrupt_reason is null or interrupt_reason in ('computer_not_running','pending_delete'))
  and (not lease_released or (phase='dispatched' and interrupt_reason is not null)));

-- ---------------------------------------------------------------------------
-- 2. The lease guards hold only for a step that still holds the lease.
-- ---------------------------------------------------------------------------
create or replace function public.guard_hivra_agent_attachment_lease()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p public.hivra_agent_attachments%rowtype;
begin
  select * into p from public.hivra_agent_attachments
    where source_id=old.id and phase in ('claimed','dispatched') and not lease_released;
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

create or replace function public.guard_hivra_agent_attachment_operation_lease()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare o public.hivra_agent_attachment_operations%rowtype;
begin
  select * into o from public.hivra_agent_attachment_operations
    where source_id=old.id and phase in ('claimed','dispatched') and not lease_released;
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

-- ---------------------------------------------------------------------------
-- 3. Interrupt: release the computer, keep the step open.
--    computer_not_running is the worker's host observation under the host
--    lock; pending_delete is checked here against the computer's row.
-- ---------------------------------------------------------------------------
create or replace function public.interrupt_hivra_agent_attachment_step(p_owner text,p_kind text,p_step_id uuid,p_reason text)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  o public.hivra_agent_attachment_operations%rowtype;
  a public.hivra_agents%rowtype;
  v_source uuid; v_phase text; v_released boolean; v_reason text; v_lease_kind text;
begin
  if p_owner is null or p_step_id is null or p_kind is null or p_kind not in ('attach','access_change','detach')
    or p_reason is null or p_reason not in ('computer_not_running','pending_delete') then return false; end if;
  if p_kind='attach' then
    select * into p from public.hivra_agent_attachments where id=p_step_id and user_id=p_owner;
    if not found then return false; end if;
    v_source:=p.source_id; v_phase:=p.phase; v_released:=p.lease_released; v_reason:=p.interrupt_reason;
    v_lease_kind:='agent_attach';
  else
    select * into o from public.hivra_agent_attachment_operations where id=p_step_id and user_id=p_owner and kind=p_kind;
    if not found then return false; end if;
    v_source:=o.source_id; v_phase:=o.phase; v_released:=o.lease_released; v_reason:=o.interrupt_reason;
    v_lease_kind:=case p_kind when 'detach' then 'agent_detach' else 'agent_access_change' end;
  end if;
  -- Only a step that was sent to the computer; a claim is cancelled or refused instead.
  if v_phase is distinct from 'dispatched' then return false; end if;
  -- A replay of the same interruption is the same answer.
  if v_released then return v_reason is not distinct from p_reason; end if;
  -- Source first, as every lifecycle contender.
  select * into a from public.hivra_agents where id=v_source and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p_step_id or a.operation_kind is distinct from v_lease_kind then return false; end if;
  if p_reason='pending_delete' and a.desired_state is distinct from 'deleted' then return false; end if;
  if p_kind='attach' then
    update public.hivra_agent_attachments set lease_released=true,interrupted_at=clock_timestamp(),interrupt_reason=p_reason
      where id=p_step_id and phase='dispatched' and not lease_released;
  else
    update public.hivra_agent_attachment_operations set lease_released=true,interrupted_at=clock_timestamp(),interrupt_reason=p_reason
      where id=p_step_id and phase='dispatched' and not lease_released;
  end if;
  if not found then return false; end if;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Resume: take the lease back once the computer runs again, free and
--    unchanged since the step's review. The worker then ends the step by what
--    the computer shows. A replay after the lease came back answers true.
-- ---------------------------------------------------------------------------
create or replace function public.resume_hivra_agent_attachment_step(p_owner text,p_kind text,p_step_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  o public.hivra_agent_attachment_operations%rowtype;
  a public.hivra_agents%rowtype;
  v_source uuid; v_phase text; v_released boolean; v_authority jsonb; v_lease_kind text; v_payload jsonb;
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
  if a.status is distinct from 'running' or a.desired_state is distinct from 'running' or a.operation_id is not null
    or public.hivra_desktop_prepare_authority(a) is distinct from v_authority then return false; end if;
  -- The lease first, while the step is still released; then the step holds it again.
  update public.hivra_agents set operation_id=p_step_id,operation_kind=v_lease_kind,operation_started_at=clock_timestamp(),
    operation_payload=v_payload where id=a.id;
  if p_kind='attach' then
    update public.hivra_agent_attachments set lease_released=false where id=p_step_id and phase='dispatched' and lease_released;
  else
    update public.hivra_agent_attachment_operations set lease_released=false where id=p_step_id and phase='dispatched' and lease_released;
  end if;
  if not found then raise exception 'attach step changed while its lease was taken back' using errcode='40001'; end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Deleting the computer ends every attachment and step on it (T30): an
--    attached agent is detached with a computer_deleted receipt as before, and
--    a step the lease was released from ends failed with computer_deleted.
-- ---------------------------------------------------------------------------
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
  update public.hivra_agent_attachment_operations set phase='failed',completed_at=clock_timestamp(),
    failure_code='computer_deleted',lease_released=false
    where source_id=new.id and phase='dispatched' and lease_released;
  update public.hivra_agent_attachments set phase='failed',completed_at=clock_timestamp(),end_reason='computer_deleted',
    lease_released=false
    where source_id=new.id and phase='dispatched' and lease_released;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The worker's queue: least recently tried first. An interrupted step waits
--    off the list until its computer is running and free, then is tried at
--    most every ten minutes. Listing a step stamps when it was tried.
-- ---------------------------------------------------------------------------
create or replace function public.list_open_hivra_agent_attachment_work(p_limit integer)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare v_limit integer := greatest(1,least(coalesce(p_limit,20),100)); v_items jsonb;
begin
  with open_steps as (
    select 'attach'::text as kind, p.id, p.user_id, null::uuid as attachment_id, p.last_attempt_at, p.created_at
      from public.hivra_agent_attachments p
      join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
      where p.phase in ('claimed','dispatched')
        and (not p.lease_released or (a.status='running' and a.desired_state='running' and a.operation_id is null
          and coalesce(p.last_attempt_at,'-infinity'::timestamptz)<=clock_timestamp()-interval '10 minutes'))
    union all
    select o.kind, o.id, o.user_id, o.attachment_id, o.last_attempt_at, o.created_at
      from public.hivra_agent_attachment_operations o
      join public.hivra_agents a on a.id=o.source_id and a.user_id=o.user_id
      where o.phase in ('claimed','dispatched')
        and (not o.lease_released or (a.status='running' and a.desired_state='running' and a.operation_id is null
          and coalesce(o.last_attempt_at,'-infinity'::timestamptz)<=clock_timestamp()-interval '10 minutes'))
  ), picked as (
    select * from open_steps order by last_attempt_at asc nulls first, created_at, id limit v_limit
  ), tried_attachments as (
    update public.hivra_agent_attachments t set last_attempt_at=clock_timestamp()
      from picked where picked.kind='attach' and t.id=picked.id returning t.id
  ), tried_operations as (
    update public.hivra_agent_attachment_operations t set last_attempt_at=clock_timestamp()
      from picked where picked.kind<>'attach' and t.id=picked.id returning t.id
  )
  select coalesce(jsonb_agg(case when kind='attach' then jsonb_build_object('kind','attach','ownerId',user_id,'id',id)
      else jsonb_build_object('kind',kind,'ownerId',user_id,'id',id,'attachmentId',attachment_id) end
      order by last_attempt_at asc nulls first, created_at, id),'[]'::jsonb)
    into v_items from picked;
  return v_items;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The reads carry the interruption.
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
    'leaseReleased',p.lease_released,'interruptReason',p.interrupt_reason)
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
    'desiredState',a.desired_state,'computerStatus',a.status,'computerOperationId',a.operation_id,'createdAt',o.created_at,
    'leaseReleased',o.lease_released,'interruptReason',o.interrupt_reason)
  from public.hivra_agent_attachment_operations o
  join public.hivra_agent_attachments p on p.id=o.attachment_id and p.user_id=o.user_id
  join public.hivra_agent_attachment_installations r on r.operation_id=p.id
  join public.hivra_agents a on a.id=o.source_id and a.user_id=o.user_id
  where o.id=p_operation_id and o.user_id=p_owner;
$$;

create or replace function public.read_hivra_agent_attachments(p_owner text,p_source_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select coalesce(jsonb_agg(item order by created desc),'[]'::jsonb) from (
    select p.created_at as created, jsonb_build_object(
      'id',p.id,'phase',p.phase,'agentName',p.intent->>'agentName','runtimeId',p.intent->>'runtimeId',
      'agentIdentityId',p.agent_identity_id,'grants',p.grants,'endReason',p.end_reason,
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

create or replace function public.read_hivra_owner_attached_agents(p_owner text)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'phase',p.phase,'agentName',p.intent->>'agentName',
      'runtimeId',p.intent->>'runtimeId','sourceId',p.source_id,'computerName',a.name,'computerStatus',a.status,
      'deploymentMode',a.deployment_mode,'installationId',r.installation_id,'createdAt',p.created_at,
      'completedAt',p.completed_at,'interruptReason',p.interrupt_reason) order by p.created_at desc),'[]'::jsonb)
  from public.hivra_agent_attachments p
  join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
  left join public.hivra_agent_attachment_installations r on r.operation_id=p.id
  where p.user_id=p_owner and p.phase in ('claimed','dispatched','attached') and a.status<>'deleted';
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants: service_role only; the triggers are never callable.
-- ---------------------------------------------------------------------------
revoke all on function public.guard_hivra_agent_attachment_lease(),
  public.guard_hivra_agent_attachment_operation_lease(),
  public.detach_hivra_agents_on_computer_delete()
  from public,anon,authenticated,service_role;
revoke all on function public.interrupt_hivra_agent_attachment_step(text,text,uuid,text),
  public.resume_hivra_agent_attachment_step(text,text,uuid),
  public.list_open_hivra_agent_attachment_work(integer),
  public.read_hivra_agent_attachment_state(text,uuid),
  public.read_hivra_agent_attachment_operation(text,uuid),
  public.read_hivra_agent_attachments(text,uuid),
  public.read_hivra_owner_attached_agents(text)
  from public,anon,authenticated;
grant execute on function public.interrupt_hivra_agent_attachment_step(text,text,uuid,text),
  public.resume_hivra_agent_attachment_step(text,text,uuid),
  public.list_open_hivra_agent_attachment_work(integer),
  public.read_hivra_agent_attachment_state(text,uuid),
  public.read_hivra_agent_attachment_operation(text,uuid),
  public.read_hivra_agent_attachments(text,uuid),
  public.read_hivra_owner_attached_agents(text)
  to service_role;
