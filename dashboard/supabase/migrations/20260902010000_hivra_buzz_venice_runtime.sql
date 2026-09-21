-- Let the Buzz sidecar reuse an account-owned Venice key from Hivra Vault.
-- Venice speaks the OpenAI-compatible chat-completions wire protocol, while
-- the journal retains the provider label so receipts describe the real source.

alter table public.hivra_buzz_agent_bindings
  drop constraint hivra_buzz_runtime_provider,
  add constraint hivra_buzz_runtime_provider check (
    runtime_provider is null or runtime_provider in ('openai','anthropic','venice')
  );

create or replace function public.begin_hivra_buzz_runtime_install(
  p_user_id text,p_binding_id uuid,p_operation_id uuid,p_request_digest text,
  p_provider text,p_model text,p_owner_public_key text,p_encrypted_api_key text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; a public.hivra_agents%rowtype;
begin
  if p_user_id is null or p_user_id='' or char_length(p_user_id)>256 or p_binding_id is null or p_operation_id is null
    or p_request_digest !~ '^[a-f0-9]{64}$' or p_provider not in ('openai','anthropic','venice')
    or p_model is null or char_length(p_model) not between 1 and 160
    or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$'
    or p_owner_public_key !~ '^[a-f0-9]{64}$'
    or p_encrypted_api_key is null or p_encrypted_api_key='' then
    return jsonb_build_object('status','invalid_request');
  end if;
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found or b.status<>'joined' or b.encrypted_private_key is null then
    return jsonb_build_object('status','not_found');
  end if;
  select * into a from public.hivra_agents where id=b.agent_id and user_id=p_user_id for update;
  if not found or a.status<>'running' or a.desired_state<>'running' or a.ip is null
    or a.computer_substrate is distinct from 'proxmox-kvm' or a.vmid is null or a.vmid<100
    or a.operation_id is not null or a.operation_kind is not null
    or a.infrastructure_binding_token_enforced is distinct from true
    or a.infrastructure_binding_token_hash is null
    or a.infrastructure_binding_token_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status','agent_not_ready');
  end if;
  if b.runtime_status='active' then
    return jsonb_build_object('status','active','bindingId',b.id);
  end if;
  if b.runtime_status in ('install_pending','remove_pending') then
    if b.runtime_status='install_pending' and b.runtime_operation_id=p_operation_id
      and b.runtime_request_digest=p_request_digest and b.runtime_provider=p_provider
      and b.runtime_model=p_model and b.runtime_owner_public_key=p_owner_public_key then
      return jsonb_build_object('status','install_pending','bindingId',b.id);
    end if;
    return jsonb_build_object('status','operation_conflict','bindingId',b.id);
  end if;
  update public.hivra_buzz_agent_bindings set
    runtime_status='install_pending',runtime_operation_id=p_operation_id,
    runtime_request_digest=p_request_digest,runtime_provider=p_provider,runtime_model=p_model,
    runtime_owner_public_key=p_owner_public_key,encrypted_runtime_api_key=p_encrypted_api_key,
    runtime_install_receipt=null,runtime_remove_receipt=null,runtime_last_observed_at=null,
    runtime_last_error_code=null,runtime_lease_id=null,runtime_lease_expires_at=null,
    updated_at=clock_timestamp()
  where id=b.id;
  return jsonb_build_object('status','install_pending','bindingId',b.id);
exception when unique_violation then
  return jsonb_build_object('status','operation_conflict');
end;
$$;

revoke all on function public.begin_hivra_buzz_runtime_install(text,uuid,uuid,text,text,text,text,text) from public;
revoke all on function public.begin_hivra_buzz_runtime_install(text,uuid,uuid,text,text,text,text,text) from anon;
revoke all on function public.begin_hivra_buzz_runtime_install(text,uuid,uuid,text,text,text,text,text) from authenticated;
grant execute on function public.begin_hivra_buzz_runtime_install(text,uuid,uuid,text,text,text,text,text) to service_role;
