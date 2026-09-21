-- Private custody for one model change per original computer. This migration
-- does not activate a route or upgrade a guest. Only the server coordinator may
-- call these RPCs after checking Clerk ownership and the guest's v1 capability.
-- No existing row is adopted or rewritten here.
create table public.hivra_model_key_operations (
  operation_id uuid primary key,
  agent_id uuid not null references public.hivra_agents(id),
  user_id text not null check (btrim(user_id) <> ''),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  binding jsonb not null,
  admission_connection_revision bigint,
  previous_config jsonb,
  previous_cipher_digest text,
  config jsonb,
  payload jsonb,
  encrypted_key text,
  cipher_digest text,
  expected_state_digest text not null check (expected_state_digest ~ '^[a-f0-9]{64}$'),
  expected_receipt jsonb not null,
  managed_key_id uuid unique references public.managed_venice_proxy_keys(id),
  phase text not null default 'pending' check (phase in ('pending','applied','deleted')),
  is_current boolean not null default false,
  lease_id uuid,
  lease_expires_at timestamptz,
  dispatch_intent_at timestamptz,
  observed_receipt jsonb,
  created_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz,
  deleted_at timestamptz,
  check ((lease_id is null) = (lease_expires_at is null)),
  check (not is_current or phase='applied'),
  check ((phase='applied') = (applied_at is not null) or phase='deleted'),
  check (phase <> 'deleted' or (encrypted_key is null and not is_current and deleted_at is not null))
);
create unique index hivra_model_key_pending on public.hivra_model_key_operations(agent_id) where phase='pending';
create unique index hivra_model_key_current on public.hivra_model_key_operations(agent_id) where is_current;
alter table public.hivra_model_key_operations enable row level security;
-- Supabase's default grants are additive. BYPASSRLS must not allow direct
-- journal writes, deleting request history, or forging a settlement receipt.
revoke all on public.hivra_model_key_operations from public,anon,authenticated,service_role;
grant select on public.hivra_model_key_operations to service_role;

create function public.hivra_model_key_binding(a public.hivra_agents)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('agentId',a.id,'userId',a.user_id,'runtime',a.type,
    'deploymentMode',a.deployment_mode,'substrate',a.computer_substrate,
    'allocationId',a.allocation_operation_id,'host',a.proxmox_host,'vmid',a.vmid,
    'connectionId',a.infrastructure_connection_id,
    'targetId',a.deployment_target_id,'orderId',a.provider_capacity_order_id,
    'enrollmentId',a.provider_enrollment_attempt_id,'serverId',a.provider_server_id,
    'hostname',a.cf_hostname,'tunnelId',a.cf_tunnel_id,'chatUrl',a.chat_url,
    'tokenDigest',encode(sha256(convert_to(a.api_token,'UTF8')),'hex'));
$$;

-- Provider credential revision is intentionally NOT recipient identity. The
-- existing credential-only recovery/preflight may rebind the same immutable
-- computer after repairing SSH credentials. Delivery uses its original guest
-- token and named tunnel, not provider credentials. Retain admission revision
-- for audit without stranding that supported recovery path.

create function public.admit_hivra_model_key_operation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_binding jsonb,p_request jsonb
) returns text language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  j public.hivra_model_key_operations%rowtype;
  c jsonb; payload jsonb; receipt jsonb; candidate jsonb; cipher text; key_id uuid;
begin
  if p_operation_id is null or jsonb_typeof(p_request) is distinct from 'object'
    or octet_length(p_request::text)>8192 then return 'invalid_request'; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found then return 'not_found'; end if;
  if public.hivra_model_key_binding(a) is distinct from p_binding then return 'target_changed'; end if;
  -- Duplicate admission never inserts the caller's newly generated candidate.
  -- Operation history survives later changes, so an old ID cannot run again.
  select * into j from public.hivra_model_key_operations where operation_id=p_operation_id;
  if found then
    if j.agent_id=a.id and j.user_id=a.user_id and j.binding=p_binding
      and j.request_digest=p_request->>'requestDigest' then return j.phase; end if;
    return 'operation_conflict';
  end if;
  if a.type<>'codex' or a.status<>'running' or a.desired_state<>'running' or a.operation_id is not null
    or a.api_token !~ '^[a-f0-9]{64}$' or a.api_token is null
    or a.cf_hostname is null or a.cf_tunnel_id is null
    or a.chat_url is distinct from 'https://' || a.cf_hostname
    or (a.computer_substrate='proxmox-kvm' and a.vmid is null)
    then return 'not_ready'; end if;
  if exists(select 1 from public.hivra_model_key_operations where agent_id=a.id and phase='pending')
    then return 'pending_conflict'; end if;
  c := nullif(p_request->'config','null'::jsonb);
  payload := nullif(p_request->'payload','null'::jsonb);
  candidate := nullif(p_request->'managedKey','null'::jsonb);
  cipher := p_request->>'encryptedKey';
  receipt := p_request->'expectedReceipt';
  if (p_request=jsonb_build_object('requestDigest',p_request->'requestDigest',
      'config',c,'payload',payload,'managedKey',candidate,'encryptedKey',cipher,
      'expectedStateDigest',p_request->'expectedStateDigest','expectedReceipt',receipt)
    and p_request->>'requestDigest' ~ '^[a-f0-9]{64}$'
    and p_request->>'expectedStateDigest' ~ '^[a-f0-9]{64}$'
    and receipt=jsonb_build_object('protocol','hivra-llm-apply-v1','operationId',p_operation_id,
      'stateDigest',receipt->'stateDigest','payloadDigest',receipt->'payloadDigest',
      'provider',payload->'provider','model',payload->'model')
    and receipt->>'stateDigest' ~ '^[a-f0-9]{64}$'
    and receipt->>'payloadDigest' ~ '^[a-f0-9]{64}$') is not true
    then return 'invalid_request'; end if;
  if c is null then
    if payload is not null or candidate is not null or cipher is not null then return 'invalid_request'; end if;
  else
    if (c->>'provider'='venice' and c->>'mode' in ('byok','managed')
      and c->>'model' ~ '^[A-Za-z0-9._:/\[\]-]{1,64}$'
      and cipher ~ '^[A-Za-z0-9+/]+={0,2}$' and length(cipher) between 48 and 384
      and payload=jsonb_build_object('provider','venice','baseUrl',payload->'baseUrl','model',c->'model')
      and payload->>'baseUrl' ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?$') is not true
      then return 'invalid_request'; end if;
    if c->>'mode'='byok' then
      if c is distinct from jsonb_build_object('provider','venice','mode','byok','model',c->'model')
        or candidate is not null or payload->>'baseUrl' is distinct from 'https://api.venice.ai/api/v1'
        then return 'invalid_request'; end if;
    else
      if (candidate=jsonb_build_object('id',candidate->'id','accountId',candidate->'accountId',
          'hash',candidate->'hash','prefix',candidate->'prefix')
        and candidate->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        and candidate->>'accountId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        and candidate->>'hash' ~ '^[a-f0-9]{64}$' and candidate->>'prefix' ~ '^hven_live_[A-Za-z0-9_-]{1,16}$'
        and c=jsonb_build_object('provider','venice','mode','managed','model',c->'model',
          'proxyKeyId',candidate->'id','keyPrefix',candidate->'prefix','walletType',c->'walletType')
        and c->>'walletType' in ('card','hermesos')) is not true then return 'invalid_request'; end if;
      perform id from public.managed_venice_wallet_accounts
        where id=(candidate->>'accountId')::uuid and user_id=a.user_id for key share;
      if not found then return 'invalid_wallet'; end if;
      key_id := (candidate->>'id')::uuid;
    end if;
  end if;
  -- Refuse unknown legacy metadata before storing anything; delete/replacement
  -- must retain and revoke the exact predecessor, never guess its identity.
  if a.llm_config is not null and (a.llm_config->>'provider'='venice'
    and a.llm_config->>'mode' in ('byok','managed')
    and (a.llm_config->>'mode'<>'managed' or a.llm_config->>'proxyKeyId' is not null)) is not true
    then return 'legacy_config_invalid'; end if;
  if a.llm_config->>'proxyKeyId' is not null then
    perform id from public.managed_venice_proxy_keys where id::text=a.llm_config->>'proxyKeyId'
      and user_id=a.user_id for update;
    if not found then return 'legacy_config_invalid'; end if;
  end if;
  if key_id is not null then
    insert into public.managed_venice_proxy_keys(id,account_id,user_id,name,key_hash,key_prefix,status,paused_reason,metadata)
      values(key_id,(candidate->>'accountId')::uuid,a.user_id,'Agent model key',candidate->>'hash',candidate->>'prefix',
        'paused','Awaiting agent application',jsonb_build_object('defaultWalletType',c->>'walletType'));
  end if;
  insert into public.hivra_model_key_operations(operation_id,agent_id,user_id,request_digest,binding,admission_connection_revision,
    previous_config,previous_cipher_digest,config,payload,encrypted_key,cipher_digest,expected_state_digest,expected_receipt,managed_key_id)
    values(p_operation_id,a.id,a.user_id,p_request->>'requestDigest',p_binding,a.infrastructure_connection_revision,a.llm_config,
      encode(sha256(convert_to(a.llm_api_key_encrypted,'UTF8')),'hex'),
      case when c is null then null else c || jsonb_build_object('enabledAt',clock_timestamp()) end,
      payload,cipher,encode(sha256(convert_to(cipher,'UTF8')),'hex'),p_request->>'expectedStateDigest',receipt,key_id);
  return 'pending';
end;
$$;

-- A short, non-renewable attempt lease excludes power transitions while I/O
-- is possible. Pending custody survives expiration; it does not trap restart
-- or deletion forever. An explicit resume uses a NEW lease and the SAME op.
create function public.claim_hivra_model_key_delivery(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_model_key_operations%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or a.status<>'running' or a.desired_state<>'running' or a.operation_id is not null then return null; end if;
  select * into j from public.hivra_model_key_operations where operation_id=p_operation_id
    and agent_id=a.id and user_id=a.user_id for update;
  if not found or j.phase<>'pending' or j.binding is distinct from public.hivra_model_key_binding(a)
    or j.previous_config is distinct from a.llm_config
    or j.previous_cipher_digest is distinct from encode(sha256(convert_to(a.llm_api_key_encrypted,'UTF8')),'hex')
    or j.lease_expires_at>clock_timestamp() then return null; end if;
  update public.hivra_model_key_operations set lease_id=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+interval '20 seconds',dispatch_intent_at=coalesce(dispatch_intent_at,clock_timestamp())
    where operation_id=j.operation_id returning * into j;
  return to_jsonb(j);
end;
$$;

create function public.settle_hivra_model_key_operation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_lease_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_model_key_operations%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or a.desired_state<>'running' or a.status<>'running' or a.operation_id is not null then return false; end if;
  select * into j from public.hivra_model_key_operations where operation_id=p_operation_id
    and agent_id=a.id and user_id=a.user_id for update;
  if not found or j.binding is distinct from public.hivra_model_key_binding(a)
    or j.expected_receipt is distinct from p_receipt then return false; end if;
  if j.phase='applied' then return j.is_current and j.observed_receipt=p_receipt; end if;
  if j.phase<>'pending' or j.lease_id is distinct from p_lease_id or p_lease_id is null
    or j.lease_expires_at<=clock_timestamp() or j.dispatch_intent_at is null
    or j.previous_config is distinct from a.llm_config
    or j.previous_cipher_digest is distinct from encode(sha256(convert_to(a.llm_api_key_encrypted,'UTF8')),'hex')
    then return false; end if;
  if j.managed_key_id is not null then
    perform id from public.managed_venice_proxy_keys where id=j.managed_key_id and user_id=j.user_id
      and status='paused' and paused_reason='Awaiting agent application' for update;
    if not found then return false; end if;
  end if;
  if j.previous_config->>'proxyKeyId' is not null then
    perform id from public.managed_venice_proxy_keys where id::text=j.previous_config->>'proxyKeyId'
      and user_id=j.user_id for update;
    if not found then return false; end if;
  end if;
  update public.hivra_model_key_operations set is_current=false where agent_id=a.id and is_current;
  update public.hivra_model_key_operations set phase='applied',is_current=true,applied_at=clock_timestamp(),
    observed_receipt=p_receipt,lease_id=null,lease_expires_at=null where operation_id=j.operation_id;
  update public.hivra_agents set llm_config=j.config,llm_api_key_encrypted=j.encrypted_key where id=a.id;
  if j.managed_key_id is not null then
    update public.managed_venice_proxy_keys set status='active',paused_reason=null,updated_at=clock_timestamp()
      where id=j.managed_key_id and user_id=j.user_id;
  end if;
  if j.previous_config->>'proxyKeyId' is not null then
    update public.managed_venice_proxy_keys set status='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()),
      updated_at=clock_timestamp() where id::text=j.previous_config->>'proxyKeyId' and user_id=j.user_id;
  end if;
  -- Keep identity/receipt history, not superseded credentials. The adopted key
  -- remains in the existing encrypted active column for supported rebuilds.
  update public.hivra_model_key_operations set encrypted_key=null where operation_id=j.operation_id;
  return true;
end;
$$;

-- No bypass GUC and no writable "success" field: only the private settlement
-- RPC can publish the current row against which legacy writes are checked.
create function public.guard_hivra_model_key_agent()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.hivra_model_key_operations%rowtype;
begin
  if not exists(select 1 from public.hivra_model_key_operations where agent_id=old.id) then return new; end if;
  if new.status='deleted' then
    if exists(select 1 from public.hivra_model_key_operations where agent_id=old.id and lease_expires_at>clock_timestamp())
      then raise exception 'Wait for bounded model delivery before completing deletion' using errcode='55006'; end if;
    return new; -- Other lifecycle/credential guards still require real cleanup.
  end if;
  if public.hivra_model_key_binding(new) is distinct from public.hivra_model_key_binding(old) then
    raise exception 'Model settings are bound to the original computer' using errcode='55000'; end if;
  if row(new.operation_id,new.status,new.desired_state) is distinct from row(old.operation_id,old.status,old.desired_state)
    and new.desired_state<>'deleted'
    and exists(select 1 from public.hivra_model_key_operations where agent_id=old.id and lease_expires_at>clock_timestamp())
    then raise exception 'A bounded model delivery is in progress' using errcode='55006'; end if;
  if row(new.llm_config,new.llm_api_key_encrypted) is distinct from row(old.llm_config,old.llm_api_key_encrypted) then
    select * into j from public.hivra_model_key_operations where agent_id=old.id and is_current;
    if not found or j.config is distinct from new.llm_config
      or j.cipher_digest is distinct from encode(sha256(convert_to(new.llm_api_key_encrypted,'UTF8')),'hex')
      or j.phase<>'applied' or j.observed_receipt is distinct from j.expected_receipt then
      raise exception 'Apply model settings through the durable operation' using errcode='55000'; end if;
  end if;
  return new;
end;
$$;
create trigger hivra_agents_model_key_guard before update on public.hivra_agents
  for each row execute function public.guard_hivra_model_key_agent();

create function public.guard_hivra_pending_model_proxy_key()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.hivra_model_key_operations%rowtype;
begin
  -- The N-1 clear route revokes first, then updates the agent. Protect its
  -- predecessor as well as the new candidate, or that rejected legacy write
  -- would still break the owner's working key. Delete intent may revoke it.
  if exists(select 1 from public.hivra_model_key_operations p
    where p.previous_config->>'proxyKeyId'=old.id::text and p.user_id=old.user_id) then
    if tg_op='DELETE' then
      raise exception 'Retain predecessor key evidence until model cleanup' using errcode='55000'; end if;
    -- Billing can still pause for exhausted funds and recover after a top-up.
    -- It must not be forced to keep serving an overdrawn predecessor key.
    if row(new.id,new.user_id,new.account_id,new.key_hash,new.key_prefix,new.metadata)
      is distinct from row(old.id,old.user_id,old.account_id,old.key_hash,old.key_prefix,old.metadata)
      or (old.status='revoked' and new.status<>'revoked')
      or (exists(select 1 from public.hivra_model_key_operations p join public.hivra_agents a on a.id=p.agent_id
          where p.phase='pending' and p.previous_config->>'proxyKeyId'=old.id::text and p.user_id=old.user_id and a.desired_state<>'deleted')
        and (new.revoked_at is distinct from old.revoked_at or (new.status='revoked' and old.status<>'revoked')))
      then raise exception 'The pending model change retains its predecessor key' using errcode='55000'; end if;
  end if;
  select * into j from public.hivra_model_key_operations where managed_key_id=old.id;
  if not found then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='DELETE' then
    raise exception 'Retain model operation key identity' using errcode='55000'; end if;
  if row(new.id,new.user_id,new.account_id,new.key_hash,new.key_prefix,new.metadata)
    is distinct from row(old.id,old.user_id,old.account_id,old.key_hash,old.key_prefix,old.metadata)
    or (j.phase='pending' and row(new.status,new.paused_reason,new.revoked_at)
      is distinct from row(old.status,old.paused_reason,old.revoked_at))
    or (j.is_current and exists(select 1 from public.hivra_agents where id=j.agent_id and desired_state<>'deleted')
      and (new.revoked_at is distinct from old.revoked_at or (new.status='revoked' and old.status<>'revoked')))
    or (old.status='revoked' and new.status<>'revoked')
    or (j.phase='deleted' and new.status<>'revoked') then
    raise exception 'Pending model key custody is owned by its agent operation' using errcode='55000'; end if;
  return new;
end;
$$;
create trigger managed_venice_pending_model_guard before update or delete on public.managed_venice_proxy_keys
  for each row execute function public.guard_hivra_pending_model_proxy_key();

create function public.clean_hivra_deleted_model_keys()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  -- AFTER all existing terminal-deletion guards, in the SAME transaction.
  if not exists(select 1 from public.hivra_model_key_operations where agent_id=new.id) then return new; end if;
  update public.hivra_model_key_operations set phase='deleted',is_current=false,encrypted_key=null,
    lease_id=null,lease_expires_at=null,deleted_at=clock_timestamp() where agent_id=new.id and phase<>'deleted';
  update public.managed_venice_proxy_keys k set status='revoked',revoked_at=coalesce(k.revoked_at,clock_timestamp()),
    updated_at=clock_timestamp() from public.hivra_model_key_operations j
    where j.agent_id=new.id and j.managed_key_id=k.id and j.user_id=k.user_id;
  return new;
end;
$$;
create trigger hivra_agents_model_key_cleanup after update of status on public.hivra_agents
  for each row when (new.status='deleted' and old.status<>'deleted')
  execute function public.clean_hivra_deleted_model_keys();

revoke all on function public.hivra_model_key_binding(public.hivra_agents),
  public.admit_hivra_model_key_operation(text,uuid,uuid,jsonb,jsonb),
  public.claim_hivra_model_key_delivery(text,uuid,uuid),
  public.settle_hivra_model_key_operation(text,uuid,uuid,uuid,jsonb),
  public.guard_hivra_model_key_agent(),public.guard_hivra_pending_model_proxy_key(),public.clean_hivra_deleted_model_keys()
  from public,anon,authenticated,service_role;
grant execute on function public.hivra_model_key_binding(public.hivra_agents),
  public.admit_hivra_model_key_operation(text,uuid,uuid,jsonb,jsonb),
  public.claim_hivra_model_key_delivery(text,uuid,uuid),
  public.settle_hivra_model_key_operation(text,uuid,uuid,uuid,jsonb) to service_role;
