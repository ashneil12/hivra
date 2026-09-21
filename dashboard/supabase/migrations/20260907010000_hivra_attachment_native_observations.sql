-- Expand private observation vocabulary, not attachment readiness or authority.
-- Native protocol uses the same exact identity/PID/phase and source-first fence.
-- Preserve immutable results/outbox, all denied mutation roles and lease state.
create or replace function public.record_hivra_attachment_activation_observation(
  p_owner text,p_operation_id uuid,p_expected_generation bigint,p_expected_authority jsonb,
  p_expected_request jsonb,p_observation_id uuid,p_result jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  a public.hivra_agents%rowtype;
  d public.hivra_agent_attachment_activation_dispatches%rowtype;
  prior public.hivra_agent_attachment_activation_observations%rowtype;
begin
  if p_owner is null or p_operation_id is null or p_expected_generation is null
    or p_expected_authority is null or p_expected_request is null or p_observation_id is null
    or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>32768
    or p_result->'version' is distinct from '1'::jsonb
    or not p_result ?& array['version','state','journalPhase','operationId','activationId','installationId','bootId','serviceDefinitionSha256']
    or p_result-array['version','state','journalPhase','operationId','activationId','installationId','bootId','serviceDefinitionSha256','mainPid']<>'{}'::jsonb
    or coalesce(p_result->>'state','') not in ('process_running','service_inactive','activation_unresolved','native_protocol_available')
    or coalesce(p_result->>'journalPhase','') not in ('preparing','start_requested','service_started','start_failed')
  then return false; end if;
  if p_result->>'state' in ('process_running','native_protocol_available') then
    if jsonb_typeof(p_result->'mainPid') is distinct from 'number'
      or p_result->>'mainPid' !~ '^[1-9][0-9]{0,9}$'
      or p_result->>'journalPhase' not in ('start_requested','service_started') then return false; end if;
    if (p_result->>'mainPid')::bigint not between 2 and 2147483647 then return false; end if;
  elsif p_result ? 'mainPid'
    or (p_result->>'state'='service_inactive' and p_result->>'journalPhase' not in ('start_requested','service_started'))
  then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found then return false; end if;
  -- Source first, as in dispatch and lifecycle. Pending delete may record facts
  -- but cannot acquire another operation or release this one.
  select * into a from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'agent_attach'
    or a.operation_payload is distinct from jsonb_build_object('attachmentId',p.id::text)
    or a.status is distinct from 'running' or coalesce(a.desired_state,'') not in ('running','deleted')
    or public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority
    or not public.hivra_desktop_prepare_binding_ready(a) then return false; end if;
  perform 1 from public.hivra_canonical_relationship_authority where computer_id=p.computer_id and user_id=p_owner
    and write_authority='canonical' and generation=p_expected_generation and command_id=p.authority_command_id for update;
  if not found then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if not found or p.phase is distinct from 'dispatched' or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority then return false; end if;
  select * into d from public.hivra_agent_attachment_activation_dispatches where operation_id=p.id;
  if not found or d.request is distinct from p_expected_request
    or p_result->>'operationId' is distinct from p.id::text
    or p_result->>'activationId' is distinct from d.activation_id::text
    or p_result->>'installationId' is distinct from d.request->'staged'->'identity'->>'installationId'
    or p_result->>'bootId' is distinct from d.request->'staged'->>'bootId'
    or p_result->>'serviceDefinitionSha256' is distinct from d.request->>'serviceDefinitionSha256'
  then return false; end if;
  select * into prior from public.hivra_agent_attachment_activation_observations where observation_id=p_observation_id;
  if found then
    return prior.operation_id=p.id and prior.activation_id=d.activation_id and prior.result=p_result;
  end if;
  insert into public.hivra_agent_attachment_activation_observations(observation_id,operation_id,activation_id,result)
    values(p_observation_id,p.id,d.activation_id,p_result);
  insert into public.hivra_agent_attachment_activation_observation_outbox(observation_id,event_kind,payload)
    values(p_observation_id,'service_activation_observed',p_result);
  return true;
end;
$$;
revoke all on function public.record_hivra_attachment_activation_observation(text,uuid,bigint,jsonb,jsonb,uuid,jsonb)
  from public,anon,authenticated,service_role;
-- No mutation role is enabled. Only a later reviewed worker cutover may grant
-- access. This stores caller observations, not independent guest attestation.
