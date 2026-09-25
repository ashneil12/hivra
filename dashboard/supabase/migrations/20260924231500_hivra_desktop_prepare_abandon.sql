-- A dispatched desktop preparation normally ends only with its exact guest
-- terminal receipt. A guest that was powered off (or whose installer died
-- with its guest lock released) can never mint one, and the lease guard then
-- pins the computer at status 'running' and rejects every power action
-- forever. The stale-operation reconciler may release such a lease only with
-- host evidence taken under the FD8 lifecycle lock after fencing the exact
-- operation on the host, and records that evidence as the terminal receipt.
alter table public.hivra_desktop_preparations drop constraint hivra_desktop_preparations_phase_check;
alter table public.hivra_desktop_preparations add constraint hivra_desktop_preparations_phase_check
  check (phase in ('claimed','dispatched','complete','failed','cancelled','abandoned'));
alter table public.hivra_desktop_preparations drop constraint hivra_desktop_preparations_check;
alter table public.hivra_desktop_preparations add constraint hivra_desktop_preparations_check check (
  (phase in ('claimed','dispatched') and completed_at is null and terminal_receipt is null)
  or (phase='cancelled' and completed_at is not null and terminal_receipt is null)
  or (phase in ('complete','failed','abandoned') and completed_at is not null
    and jsonb_typeof(terminal_receipt) is not distinct from 'object')
);

create function public.abandon_hivra_desktop_prepare(p_user_id text,p_operation_id uuid,p_evidence jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_desktop_preparations%rowtype; v_status text;
begin
  if p_user_id is null or p_operation_id is null or jsonb_typeof(p_evidence) is distinct from 'object' then return false; end if;
  select * into p from public.hivra_desktop_preparations where id=p_operation_id and user_id=p_user_id;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
  if not found or public.hivra_desktop_prepare_authority(a) is distinct from p.authority then return false; end if;
  select * into p from public.hivra_desktop_preparations where id=p_operation_id for update;
  if p.phase='abandoned' then return p.terminal_receipt=p_evidence; end if;
  -- Only a dispatched journal old enough to exceed any bounded install run
  -- (15 minutes) and only for the Ubuntu installer that honours the host fence.
  if p.phase<>'dispatched' or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'desktop_prepare'
    or a.status is distinct from 'running' or a.type is distinct from 'linux-desktop'
    or coalesce(a.computer_profile,'ubuntu-desktop')<>'ubuntu-desktop'
    or p.created_at>clock_timestamp()-interval '30 minutes'
    or p_evidence-array['version','operationId','computerId','vmid','bindingTag','vmStatus','guestInstaller']<>'{}'::jsonb
    or p_evidence->'version' is distinct from '1'::jsonb
    or p_evidence->>'operationId' is distinct from p.id::text
    or p_evidence->>'computerId' is distinct from a.id::text
    or p_evidence->'vmid' is distinct from to_jsonb(a.vmid)
    or p_evidence->>'bindingTag' is distinct from 'hivra-bind-'||left(a.infrastructure_binding_token_hash,32)
    or not coalesce(
      (p_evidence->>'vmStatus'='stopped' and p_evidence->>'guestInstaller'='powered_off')
      or (p_evidence->>'vmStatus'='running' and p_evidence->>'guestInstaller' in ('absent','exited')),
      false)
  then return false; end if;
  v_status := p_evidence->>'vmStatus';
  update public.hivra_desktop_preparations set phase='abandoned',completed_at=clock_timestamp(),terminal_receipt=p_evidence
    where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null,
    status=v_status,
    desired_state=case when a.desired_state='deleted' then 'deleted' else v_status end,
    error=case when v_status='stopped'
      then 'Desktop preparation stopped because the computer was powered off. Start it, then open Desktop to prepare it again.'
      else 'Desktop preparation stopped before it finished. Open Desktop to prepare it again.' end
    where id=a.id;
  return true;
end;
$$;

revoke all on function public.abandon_hivra_desktop_prepare(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.abandon_hivra_desktop_prepare(text,uuid,jsonb) to service_role;
