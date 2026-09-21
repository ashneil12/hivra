-- Consistent owner-bound worker input only. No application mutation grants.
create function public.read_hivra_attachment_execution(p_owner text,p_operation_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object(
    'version',1,'operationId',p.id,'ownerId',p.user_id,'computerId',p.computer_id,
    'generation',p.authority_generation::text,'authorityCommandId',p.authority_command_id,
    'phase',p.phase,'guestAuthority',p.guest_authority,'desiredState',a.desired_state,
    'installation',case when r.operation_id is null then null else jsonb_build_object(
      'installationId',r.installation_id,'bindingId',r.binding_id,'architecture',r.architecture,
      'installerSha256',r.installer_sha256) end,
    'observation',case when o.operation_id is null then null else jsonb_build_object(
      'bootId',o.boot_id,'workerSha256',o.worker_sha256) end,
    'dispatchId',d.dispatch_id,'staged',s.result)
  from public.hivra_agent_attachments p
  join public.hivra_agents a on a.id=p.source_id and a.user_id=p.user_id
  join public.hivra_canonical_relationship_authority c on c.computer_id=p.computer_id and c.user_id=p.user_id
  left join public.hivra_agent_attachment_installations r on r.operation_id=p.id
  left join public.hivra_agent_attachment_guest_observations o on o.operation_id=p.id
  left join public.hivra_agent_attachment_dispatches d on d.operation_id=p.id
  left join public.hivra_agent_attachment_staging_results s on s.operation_id=p.id
  where p.user_id=p_owner and p.id=p_operation_id and p.phase in ('claimed','dispatched')
    and p.intent->>'runtimeId'='codex'
    and p.intent->>'installerSha256'='77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375'
    and c.write_authority='canonical' and c.generation=p.authority_generation and c.command_id=p.authority_command_id
    and a.operation_id=p.id and a.operation_kind='agent_attach'
    and a.operation_payload=jsonb_build_object('attachmentId',p.id::text)
    and a.status='running' and a.desired_state in ('running','deleted')
    and public.hivra_desktop_prepare_authority(a)=p.guest_authority
    and ((p.phase='claimed' and p.dispatch_id is null and d.operation_id is null and s.operation_id is null)
      or (p.phase='dispatched' and d.dispatch_id=p.dispatch_id and r.operation_id is not null and o.operation_id is not null));
$$;
revoke all on function public.read_hivra_attachment_execution(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_hivra_attachment_execution(text,uuid) to service_role;
-- One MVCC snapshot, not a lock or dispatch token. Each mutating RPC retains
-- its source-first authority rechecks and remains unavailable to app roles.
