-- The attached agent's lifecycle program, re-pinned after its Remove fix.
--
-- Live on Canary an attach was staged on an Ubuntu Desktop computer and its
-- activation never ran. Every cleanup Remove was then refused in the guest:
-- the gateway drop-in folder (bux-hivra-chat.service.d) exists only on agent
-- computers or after an activation, and Remove opened it unconditionally. A
-- staged home was also left behind. provisioner/attached-agent.py now removes a
-- staged, never activated agent (scripts/test-attached-agent-remove.py).
--
-- Activation dispatch accepts only the reviewed program, so this replaces
-- dispatch_hivra_attachment_activation_v2 (20260925100200) with the new digest
-- and nothing else changed. Observe, Change access and Remove do not check the
-- digest, so an attachment already activated or held keeps working. While the
-- previous revision still serves (a minute or two after merge) its activation
-- is not dispatched: the step is held and the next pass dispatches it.
-- Additive: apply at merge. Idempotent.

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
    or p_program_sha256 is distinct from '58ab3cac9ea75ee85c2c8bbb29202d31b3e2081d4bf87d633f0c3100e4c0ab4c'
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

revoke all on function public.dispatch_hivra_attachment_activation_v2(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text,text,text) from public,anon,authenticated;
grant execute on function public.dispatch_hivra_attachment_activation_v2(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text,text,text) to service_role;
