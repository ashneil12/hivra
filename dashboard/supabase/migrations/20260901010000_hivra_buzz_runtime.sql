-- Durable, owner-bound installation state for Buzz's in-guest ACP sidecar.
-- Provider credentials are encrypted only while an installation is pending and
-- are cleared as soon as the exact guest receipt settles.

alter table public.hivra_buzz_agent_bindings
  add column runtime_status text not null default 'not_installed',
  add column runtime_operation_id uuid,
  add column runtime_request_digest text,
  add column runtime_provider text,
  add column runtime_model text,
  add column runtime_owner_public_key text,
  add column encrypted_runtime_api_key text,
  add column runtime_install_receipt jsonb,
  add column runtime_remove_receipt jsonb,
  add column runtime_last_observed_at timestamptz,
  add column runtime_last_error_code text,
  add column runtime_lease_id uuid,
  add column runtime_lease_expires_at timestamptz,
  add constraint hivra_buzz_runtime_status check (
    runtime_status in ('not_installed','install_pending','active','remove_pending','removed')
  ),
  add constraint hivra_buzz_runtime_digest check (
    runtime_request_digest is null or runtime_request_digest ~ '^[a-f0-9]{64}$'
  ),
  add constraint hivra_buzz_runtime_provider check (
    runtime_provider is null or runtime_provider in ('openai','anthropic')
  ),
  add constraint hivra_buzz_runtime_model check (
    runtime_model is null or (char_length(runtime_model) between 1 and 160
      and runtime_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$')
  ),
  add constraint hivra_buzz_runtime_owner check (
    runtime_owner_public_key is null or runtime_owner_public_key ~ '^[a-f0-9]{64}$'
  ),
  add constraint hivra_buzz_runtime_lease check (
    (runtime_lease_id is null)=(runtime_lease_expires_at is null)
  ),
  add constraint hivra_buzz_runtime_custody check (
    (runtime_status='not_installed' and runtime_operation_id is null
      and runtime_request_digest is null and runtime_provider is null and runtime_model is null
      and runtime_owner_public_key is null and encrypted_runtime_api_key is null
      and runtime_install_receipt is null and runtime_remove_receipt is null
      and runtime_lease_id is null and runtime_lease_expires_at is null)
    or (runtime_status='install_pending' and runtime_operation_id is not null
      and runtime_request_digest is not null and runtime_provider is not null and runtime_model is not null
      and runtime_owner_public_key is not null and encrypted_runtime_api_key is not null
      and runtime_install_receipt is null and runtime_remove_receipt is null)
    or (runtime_status='active' and runtime_operation_id is not null
      and runtime_request_digest is not null and runtime_provider is not null and runtime_model is not null
      and runtime_owner_public_key is not null and encrypted_runtime_api_key is null
      and runtime_install_receipt is not null and runtime_remove_receipt is null
      and runtime_lease_id is null and runtime_lease_expires_at is null)
    or (runtime_status='remove_pending' and runtime_operation_id is not null
      and runtime_request_digest is not null and runtime_provider is not null and runtime_model is not null
      and runtime_owner_public_key is not null and runtime_remove_receipt is null)
    or (runtime_status='removed' and runtime_operation_id is not null
      and runtime_request_digest is not null and runtime_provider is not null and runtime_model is not null
      and runtime_owner_public_key is not null and encrypted_runtime_api_key is null
      and runtime_remove_receipt is not null and runtime_lease_id is null and runtime_lease_expires_at is null)
  );

create unique index hivra_buzz_runtime_operation_unique
  on public.hivra_buzz_agent_bindings(runtime_operation_id)
  where runtime_operation_id is not null;

create function public.begin_hivra_buzz_runtime_install(
  p_user_id text,p_binding_id uuid,p_operation_id uuid,p_request_digest text,
  p_provider text,p_model text,p_owner_public_key text,p_encrypted_api_key text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; a public.hivra_agents%rowtype;
begin
  if p_user_id is null or p_user_id='' or char_length(p_user_id)>256 or p_binding_id is null or p_operation_id is null
    or p_request_digest !~ '^[a-f0-9]{64}$' or p_provider not in ('openai','anthropic')
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

create function public.claim_hivra_buzz_runtime_install(
  p_user_id text,p_binding_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; v_lease uuid:=gen_random_uuid(); v_expires timestamptz:=clock_timestamp()+interval '4 minutes';
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found or b.status<>'joined' or b.runtime_status<>'install_pending'
    or b.encrypted_private_key is null or b.encrypted_runtime_api_key is null
    or (b.runtime_lease_expires_at is not null and b.runtime_lease_expires_at>clock_timestamp()) then return null; end if;
  if not exists(select 1 from public.hivra_agents a where a.id=b.agent_id and a.user_id=p_user_id
    and a.status='running' and a.desired_state='running' and a.ip is not null
    and a.computer_substrate='proxmox-kvm' and a.vmid>=100
    and a.operation_id is null and a.operation_kind is null
    and a.infrastructure_binding_token_enforced is true
    and a.infrastructure_binding_token_hash ~ '^[a-f0-9]{64}$') then return null; end if;
  update public.hivra_buzz_agent_bindings set runtime_lease_id=v_lease,
    runtime_lease_expires_at=v_expires,updated_at=clock_timestamp() where id=b.id;
  return to_jsonb(b)||jsonb_build_object('runtime_lease_id',v_lease,'runtime_lease_expires_at',v_expires);
end;
$$;

create function public.settle_hivra_buzz_runtime_install(
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
    or p_receipt->>'sourceGitSha'<>'4a9de1a3a121285ef475d630b2b5764044c02cde'
    or not (
      (p_receipt->>'architecture'='x86_64'
        and p_receipt->>'archiveSha256'='e9090f350b7868edf77579111a89d886c05f34f1b096bd966a095b5120e74ccd'
        and p_receipt->>'binarySha256'='84135592d1019d2839ab2ebe0b0284fc6d1cb1e768abdc9f8b91dad54c9de863')
      or (p_receipt->>'architecture'='aarch64'
        and p_receipt->>'archiveSha256'='0585779f5772812c100f4bf3f49278cb8bb5d74e3f99ab492906956f56a5075d'
        and p_receipt->>'binarySha256'='93bc7533a403dafb7f0c7cd7e7c91dea29d2dbbf4f80c4b58b9f0c6d80cc569b')
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

create function public.claim_hivra_buzz_runtime_remove(
  p_user_id text,p_binding_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; v_lease uuid:=gen_random_uuid(); v_expires timestamptz:=clock_timestamp()+interval '2 minutes';
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found or b.runtime_status in ('not_installed','removed') then return null; end if;
  if b.runtime_status not in ('install_pending','active','remove_pending')
    or (b.runtime_lease_expires_at is not null and b.runtime_lease_expires_at>clock_timestamp()) then return null; end if;
  update public.hivra_buzz_agent_bindings set runtime_status='remove_pending',runtime_lease_id=v_lease,
    runtime_lease_expires_at=v_expires,updated_at=clock_timestamp() where id=b.id;
  return to_jsonb(b)||jsonb_build_object('runtime_status','remove_pending','runtime_lease_id',v_lease,'runtime_lease_expires_at',v_expires);
end;
$$;

create function public.settle_hivra_buzz_runtime_remove(
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
    or p_receipt->>'sourceGitSha'<>'4a9de1a3a121285ef475d630b2b5764044c02cde' or p_receipt->>'observedAt' is null
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

create function public.confirm_hivra_buzz_runtime_health(
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
    or p_receipt->>'sourceGitSha'<>'4a9de1a3a121285ef475d630b2b5764044c02cde'
    or not (
      (p_receipt->>'architecture'='x86_64'
        and p_receipt->>'binarySha256'='84135592d1019d2839ab2ebe0b0284fc6d1cb1e768abdc9f8b91dad54c9de863')
      or (p_receipt->>'architecture'='aarch64'
        and p_receipt->>'binarySha256'='93bc7533a403dafb7f0c7cd7e7c91dea29d2dbbf4f80c4b58b9f0c6d80cc569b')
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

-- `complete_hivra_agent_delete` records `status=deleted` only after provider
-- teardown has been verified. At that terminal boundary the destroyed disk is
-- authoritative absence evidence even when the guest was already stopped and
-- could not return a systemd removal receipt.
create function public.retire_hivra_buzz_runtime_after_agent_delete()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old.status is distinct from 'deleted' and new.status='deleted' then
    update public.hivra_buzz_agent_bindings set
      runtime_status='removed',
      encrypted_runtime_api_key=null,
      runtime_remove_receipt=jsonb_build_object(
        'protocol','hivra-buzz-runtime-agent-delete-v1',
        'action','removed_with_computer',
        'bindingId',id,
        'agentId',new.id,
        'agentOperationId',old.operation_id,
        'vmid',old.vmid,
        'observedAt',clock_timestamp()
      ),
      runtime_last_observed_at=clock_timestamp(),
      runtime_last_error_code=null,
      runtime_lease_id=null,
      runtime_lease_expires_at=null,
      updated_at=clock_timestamp()
    where agent_id=new.id and user_id=new.user_id
      and runtime_status in ('install_pending','active','remove_pending');
  end if;
  return new;
end;
$$;

-- Snapshots contain the whole guest disk. Never capture or roll back a disk
-- while Buzz secret custody may exist. Both snapshot RPCs and runtime admission
-- lock the same agent row first, so this trigger check is race-safe rather than
-- a best-effort application preflight.
create function public.guard_hivra_snapshot_from_buzz_runtime()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if exists(
    select 1 from public.hivra_buzz_agent_bindings b
    where b.agent_id=new.agent_id and b.user_id=new.user_id
      and b.runtime_status in ('install_pending','active','remove_pending')
  ) then
    raise exception 'Buzz runtime must be removed before snapshot or restore'
      using errcode='55006';
  end if;
  return new;
end;
$$;

create trigger guard_hivra_snapshot_create_from_buzz_runtime
before insert on public.hivra_agent_snapshots
for each row execute function public.guard_hivra_snapshot_from_buzz_runtime();

create trigger guard_hivra_snapshot_restore_from_buzz_runtime
before update of status on public.hivra_agent_snapshots
for each row when (new.status='restoring' and old.status is distinct from new.status)
execute function public.guard_hivra_snapshot_from_buzz_runtime();

create trigger retire_hivra_buzz_runtime_after_agent_delete
after update of status on public.hivra_agents
for each row execute function public.retire_hivra_buzz_runtime_after_agent_delete();

revoke all on function public.begin_hivra_buzz_runtime_install(text,uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.claim_hivra_buzz_runtime_install(text,uuid) from public,anon,authenticated;
revoke all on function public.settle_hivra_buzz_runtime_install(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.claim_hivra_buzz_runtime_remove(text,uuid) from public,anon,authenticated;
revoke all on function public.settle_hivra_buzz_runtime_remove(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.confirm_hivra_buzz_runtime_health(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.retire_hivra_buzz_runtime_after_agent_delete() from public,anon,authenticated;
revoke all on function public.guard_hivra_snapshot_from_buzz_runtime() from public,anon,authenticated;
grant execute on function public.begin_hivra_buzz_runtime_install(text,uuid,uuid,text,text,text,text,text) to service_role;
grant execute on function public.claim_hivra_buzz_runtime_install(text,uuid) to service_role;
grant execute on function public.settle_hivra_buzz_runtime_install(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.claim_hivra_buzz_runtime_remove(text,uuid) to service_role;
grant execute on function public.settle_hivra_buzz_runtime_remove(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.confirm_hivra_buzz_runtime_health(text,uuid,jsonb) to service_role;
