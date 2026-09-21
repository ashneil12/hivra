-- Advance Buzz's reviewed Sprig pin after the upstream rolling release changed.
-- The transport URL remains intentionally untrusted: application and database
-- receipts accept only this exact source revision and the reviewed per-arch
-- archive/binary digests.

create or replace function public.settle_hivra_buzz_runtime_install(
  p_user_id text,p_binding_id uuid,p_lease_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype;
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found then return false; end if;
  if b.runtime_status='active' then return b.runtime_install_receipt is not distinct from p_receipt; end if;
  if b.status<>'joined' or b.runtime_status<>'install_pending' or p_lease_id is null
    or b.runtime_lease_id is distinct from p_lease_id or b.runtime_lease_expires_at<=clock_timestamp()
    or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
    or p_receipt->>'protocol'<>'hivra-buzz-runtime-v1' or p_receipt->>'action'<>'installed'
    or p_receipt->>'state'<>'active' or p_receipt->>'bindingId'<>b.id::text
    or p_receipt->>'agentId'<>b.agent_id::text or p_receipt->>'publicKey'<>b.public_key
    or p_receipt->>'provider'<>b.runtime_provider or p_receipt->>'model'<>b.runtime_model
    or p_receipt->>'ownerPublicKey'<>b.runtime_owner_public_key
    or p_receipt->>'operationId'<>b.runtime_operation_id::text
    or p_receipt->>'requestDigest'<>b.runtime_request_digest
    or p_receipt->>'leaseId'<>p_lease_id::text
    or p_receipt->>'sourceGitSha'<>'1c8321cd08feb597f8bcff5195c21148fb3e98ed'
    or not (
      (p_receipt->>'architecture'='x86_64'
        and p_receipt->>'archiveSha256'='2f73c2bf2ad69aa515f7821d73666583bff300099c638145a3f77bc0dcf2d916'
        and p_receipt->>'binarySha256'='0e1062f1ae58c92f312f4445df3291c0269e0fa8a08f452bf5bfa95dd3611356')
      or (p_receipt->>'architecture'='aarch64'
        and p_receipt->>'archiveSha256'='73758486876233800c79e9da41850b890e98e6fadece8eab342952f74c5c5df1'
        and p_receipt->>'binarySha256'='8435bc5a9105f5f200de1f54844feda262ab65baed8d7abb8dbc5fa134473f55')
    )
    or p_receipt->>'serviceName'<>('hivra-buzz-'||b.id::text||'.service')
    or p_receipt->>'observedAt' is null or (p_receipt->>'mainPid')!~'^[1-9][0-9]*$'
    or p_receipt-array['protocol','action','bindingId','agentId','publicKey','serviceName','sourceGitSha',
      'observedAt','state','architecture','archiveSha256','binarySha256','provider','model','ownerPublicKey',
      'operationId','requestDigest','leaseId','mainPid']<>'{}'::jsonb
    then return false; end if;
  update public.hivra_buzz_agent_bindings set runtime_status='active',encrypted_runtime_api_key=null,
    runtime_install_receipt=p_receipt,runtime_last_observed_at=(p_receipt->>'observedAt')::timestamptz,
    runtime_last_error_code=null,runtime_lease_id=null,runtime_lease_expires_at=null,
    updated_at=clock_timestamp() where id=b.id;
  return true;
exception when others then return false;
end;
$$;

create or replace function public.settle_hivra_buzz_runtime_remove(
  p_user_id text,p_binding_id uuid,p_lease_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype;
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found then return false; end if;
  if b.runtime_status='removed' then return b.runtime_remove_receipt is not distinct from p_receipt; end if;
  if b.runtime_status<>'remove_pending' or p_lease_id is null or b.runtime_lease_id is distinct from p_lease_id
    or b.runtime_lease_expires_at<=clock_timestamp() or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
    or p_receipt->>'protocol'<>'hivra-buzz-runtime-v1' or p_receipt->>'action'<>'removed'
    or p_receipt->>'state'<>'absent' or p_receipt->>'bindingId'<>b.id::text
    or p_receipt->>'agentId'<>b.agent_id::text or p_receipt->>'publicKey'<>b.public_key
    or p_receipt->>'operationId'<>b.runtime_operation_id::text
    or p_receipt->>'requestDigest'<>b.runtime_request_digest
    or p_receipt->>'leaseId'<>p_lease_id::text
    or p_receipt->>'serviceName'<>('hivra-buzz-'||b.id::text||'.service')
    or p_receipt->>'sourceGitSha'<>'1c8321cd08feb597f8bcff5195c21148fb3e98ed' or p_receipt->>'observedAt' is null
    or p_receipt-array['protocol','action','bindingId','agentId','publicKey','serviceName','sourceGitSha',
      'observedAt','state','operationId','requestDigest','leaseId']<>'{}'::jsonb
    then return false; end if;
  update public.hivra_buzz_agent_bindings set runtime_status='removed',encrypted_runtime_api_key=null,
    runtime_remove_receipt=p_receipt,runtime_last_observed_at=(p_receipt->>'observedAt')::timestamptz,
    runtime_last_error_code=null,runtime_lease_id=null,runtime_lease_expires_at=null,
    updated_at=clock_timestamp() where id=b.id;
  return true;
exception when others then return false;
end;
$$;

create or replace function public.confirm_hivra_buzz_runtime_health(
  p_user_id text,p_binding_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype;
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found or b.runtime_status<>'active' or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
    or p_receipt->>'protocol'<>'hivra-buzz-runtime-v1' or p_receipt->>'action'<>'observed'
    or p_receipt->>'state'<>'active' or p_receipt->>'bindingId'<>b.id::text
    or p_receipt->>'agentId'<>b.agent_id::text or p_receipt->>'publicKey'<>b.public_key
    or p_receipt->>'serviceName'<>('hivra-buzz-'||b.id::text||'.service')
    or p_receipt->>'sourceGitSha'<>'1c8321cd08feb597f8bcff5195c21148fb3e98ed'
    or not (
      (p_receipt->>'architecture'='x86_64'
        and p_receipt->>'binarySha256'='0e1062f1ae58c92f312f4445df3291c0269e0fa8a08f452bf5bfa95dd3611356')
      or (p_receipt->>'architecture'='aarch64'
        and p_receipt->>'binarySha256'='8435bc5a9105f5f200de1f54844feda262ab65baed8d7abb8dbc5fa134473f55')
    )
    or p_receipt->>'observedAt' is null or (p_receipt->>'mainPid')!~'^[1-9][0-9]*$'
    or p_receipt-array['protocol','action','bindingId','agentId','publicKey','serviceName','sourceGitSha',
      'observedAt','state','architecture','binarySha256','mainPid']<>'{}'::jsonb
    then return false; end if;
  update public.hivra_buzz_agent_bindings set runtime_last_observed_at=(p_receipt->>'observedAt')::timestamptz,
    runtime_last_error_code=null,updated_at=clock_timestamp() where id=b.id;
  return true;
exception when others then return false;
end;
$$;

revoke all on function public.settle_hivra_buzz_runtime_install(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.settle_hivra_buzz_runtime_remove(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.confirm_hivra_buzz_runtime_health(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.settle_hivra_buzz_runtime_install(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.settle_hivra_buzz_runtime_remove(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.confirm_hivra_buzz_runtime_health(text,uuid,jsonb) to service_role;
