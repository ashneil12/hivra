-- An unallocated launch is not a model-delivery recipient. Retain its original
-- intent privately, then promote it into the existing delivery journal only
-- after the SAME allocation has produced a verified, running guest.
-- Additive: no existing agent, credential or operation is adopted here.
create table public.hivra_launch_model_requests (
  user_id text not null check (length(user_id) between 1 and 256),
  request_id uuid not null,
  agent_id uuid not null unique references public.hivra_agents(id),
  provision_operation_id uuid not null,
  model_operation_id uuid not null unique,
  fingerprint_version integer not null default 1 check (fingerprint_version=1),
  fingerprint_key_tag text not null check (fingerprint_key_tag ~ '^[a-f0-9]{64}$'),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  binding jsonb not null,
  selection jsonb not null,
  encrypted_key text,
  phase text not null default 'waiting' check (phase in ('waiting','admitting','promoted','cancelled','deleted')),
  attempted_at timestamptz,
  attempt_id uuid,
  attempt_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  promoted_at timestamptz,
  closed_at timestamptz,
  primary key(user_id,request_id),
  check ((attempt_id is null) = (attempt_expires_at is null)),
  check (phase in ('waiting','admitting') or (encrypted_key is null and attempt_id is null)),
  check ((phase in ('cancelled','deleted')) = (closed_at is not null))
);
alter table public.hivra_launch_model_requests enable row level security;
revoke all on public.hivra_launch_model_requests from public,anon,authenticated,service_role;
grant select on public.hivra_launch_model_requests to service_role;

-- Do not guess a future VMID, tunnel or bearer. Existing allocation guards and
-- the original operation/binding tag control their initial assignment. The
-- normal delivery journal freezes the final recipient after promotion.
create function public.hivra_launch_model_binding(a public.hivra_agents)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('agentId',a.id,'userId',a.user_id,'runtime',a.type,
    'deploymentMode',a.deployment_mode,'substrate',a.computer_substrate,'host',a.proxmox_host,
    'connectionId',a.infrastructure_connection_id,'targetId',a.deployment_target_id,
    'orderId',a.provider_capacity_order_id,'enrollmentId',a.provider_enrollment_attempt_id,
    'serverId',a.provider_server_id,'bindingTokenDigest',a.infrastructure_binding_token_hash);
$$;

-- Server-authenticated, strictly whitelisted reservation. Request fingerprints
-- are versioned, domain-separated HMACs; the server may supply the configured
-- legacy key's fingerprint during rotation. Random ciphertext is not identity.
create function public.reserve_hivra_launch_model_request(
  p_user_id text,p_request_id uuid,p_fingerprints jsonb,p_model_operation_id uuid,
  p_agent jsonb,p_selection jsonb,p_encrypted_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; q public.hivra_launch_model_requests%rowtype; f jsonb; k text;
begin
  if p_request_id is null or p_model_operation_id is null or p_user_id is null
    or length(p_user_id) not between 1 and 256 or btrim(p_user_id)=''
    or jsonb_typeof(p_fingerprints) is distinct from 'array'
    then return jsonb_build_object('status','invalid_request'); end if;
  if jsonb_array_length(p_fingerprints) not between 1 and 2 then return jsonb_build_object('status','invalid_request'); end if;
  for f in select value from jsonb_array_elements(p_fingerprints) loop
    if (f=jsonb_build_object('version',1,'keyTag',f->'keyTag','digest',f->'digest')
      and f->>'keyTag' ~ '^[a-f0-9]{64}$' and f->>'digest' ~ '^[a-f0-9]{64}$') is not true
      then return jsonb_build_object('status','invalid_request'); end if;
  end loop;
  -- Serialize duplicate reservations before either can allocate an agent row.
  perform pg_advisory_xact_lock(hashtextextended('hivra-launch-model-v1:' || p_user_id || ':' || p_request_id::text,0));
  select * into q from public.hivra_launch_model_requests where user_id=p_user_id and request_id=p_request_id;
  if found then
    if not exists(select 1 from jsonb_array_elements(p_fingerprints) e
      where e->>'keyTag'=q.fingerprint_key_tag and e->>'digest'=q.request_digest)
      then return jsonb_build_object('status','request_conflict'); end if;
    return jsonb_build_object('status','existing','agentId',q.agent_id,'phase',q.phase);
  end if;
  if jsonb_typeof(p_agent) is distinct from 'object' or octet_length(p_agent::text)>32768
    or jsonb_typeof(p_selection) is distinct from 'object'
    then return jsonb_build_object('status','invalid_request'); end if;
  for k in select jsonb_object_keys(p_agent) loop
    if k <> all(array['id','type','name','cpu','ram','proxmox_host','deployment_mode','computer_substrate',
      'operation_id','infrastructure_binding_token_hash','pool_id','goal','context','personality','emoji','template_skills',
      'infrastructure_connection_id','infrastructure_connection_revision','deployment_target_id',
      'provider_capacity_order_id','provider_enrollment_attempt_id','provider_server_id'])
      then return jsonb_build_object('status','invalid_request'); end if;
  end loop;
  if (p_agent->>'type'='codex' and p_agent->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    and p_agent->>'operation_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    and p_agent->>'infrastructure_binding_token_hash' ~ '^[a-f0-9]{64}$'
    and length(p_agent->>'name') between 1 and 256 and jsonb_typeof(p_agent->'name')='string'
    and p_agent->>'cpu' ~ '^(0|[1-9][0-9]{0,3})(\.[0-9]+)?$' and jsonb_typeof(p_agent->'cpu')='number'
    and p_agent->>'ram' ~ '^[1-9][0-9]{0,3}$' and jsonb_typeof(p_agent->'ram')='number'
    and p_agent->>'deployment_mode' in ('hivra-managed','self-managed')
    and p_agent->>'computer_substrate' in ('proxmox-kvm','provider-vm')
    and length(p_agent->>'proxmox_host') between 1 and 256 and jsonb_typeof(p_agent->'proxmox_host')='string'
    and p_selection->>'provider'='venice' and p_selection->>'mode' in ('byok','managed')
    and p_selection->>'model' ~ '^[A-Za-z0-9._:/\[\]-]{1,64}$' and jsonb_typeof(p_selection->'model')='string') is not true
    then return jsonb_build_object('status','invalid_request'); end if;
  if (p_agent->>'cpu')::numeric<0.5 or (p_agent->>'cpu')::numeric>9999
    or mod((p_agent->>'cpu')::numeric,0.5)<>0 then return jsonb_build_object('status','invalid_request'); end if;
  if p_agent->>'goal' is not null and (jsonb_typeof(p_agent->'goal')<>'string' or length(p_agent->>'goal')>32)
    or p_agent->>'context' is not null and (jsonb_typeof(p_agent->'context')<>'string' or length(p_agent->>'context')>2000)
    or p_agent->>'personality' is not null and (jsonb_typeof(p_agent->'personality')<>'string' or length(p_agent->>'personality')>48)
    or p_agent->>'emoji' is not null and (jsonb_typeof(p_agent->'emoji')<>'string' or length(p_agent->>'emoji')>16)
    then return jsonb_build_object('status','invalid_request'); end if;
  if nullif(p_agent->'template_skills','null'::jsonb) is not null then
    if jsonb_typeof(p_agent->'template_skills')<>'array' then return jsonb_build_object('status','invalid_request'); end if;
    if jsonb_array_length(p_agent->'template_skills')>100 or exists(select 1 from jsonb_array_elements(p_agent->'template_skills') e
      where jsonb_typeof(e)<>'string' or length(e#>>'{}')>128) then return jsonb_build_object('status','invalid_request'); end if;
  end if;
  if p_selection->>'mode'='byok' then
    if (p_selection=jsonb_build_object('provider','venice','mode','byok','model',p_selection->'model')
      and p_encrypted_key ~ '^[A-Za-z0-9+/]+={0,2}$' and length(p_encrypted_key) between 48 and 384) is not true
      then return jsonb_build_object('status','invalid_request'); end if;
  elsif (p_selection=jsonb_build_object('provider','venice','mode','managed','model',p_selection->'model',
    'walletType',p_selection->'walletType') and p_selection->>'walletType' in ('card','hermesos')
    and p_encrypted_key is null) is not true then return jsonb_build_object('status','invalid_request'); end if;
  -- Pool authority is not supplied by the FK or the deployment-target guard.
  -- Take this parent lock before inserting/locking the new managed agent.
  -- Self-managed compute must not consume any managed pool, including its own.
  if p_agent->>'pool_id' is not null then
    if p_agent->>'deployment_mode'<>'hivra-managed' or p_agent->>'pool_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      then return jsonb_build_object('status','invalid_request'); end if;
    perform id from public.pools where id=(p_agent->>'pool_id')::uuid and user_id=p_user_id and product_surface='hermesos' for share;
    if not found then return jsonb_build_object('status','invalid_request'); end if;
  end if;
  -- Explicit columns only. No active credential, arbitrary operation payload,
  -- recipient token or reported readiness can enter through this RPC.
  insert into public.hivra_agents(id,user_id,type,name,cpu,ram,proxmox_host,deployment_mode,computer_substrate,
    status,desired_state,operation_id,operation_kind,operation_started_at,operation_payload,allocation_operation_id,
    infrastructure_binding_token_hash,infrastructure_binding_token_enforced,pool_id,goal,context,personality,emoji,
    template_skills,managed_venice,llm_config,llm_api_key_encrypted,infrastructure_connection_id,
    infrastructure_connection_revision,deployment_target_id,provider_capacity_order_id,provider_enrollment_attempt_id,provider_server_id)
  values((p_agent->>'id')::uuid,p_user_id,'codex',p_agent->>'name',(p_agent->>'cpu')::numeric,(p_agent->>'ram')::integer,
    p_agent->>'proxmox_host',p_agent->>'deployment_mode',p_agent->>'computer_substrate','provisioning','running',
    (p_agent->>'operation_id')::uuid,'provision',clock_timestamp(),'{"stage":"pre_allocation_access"}',
    case when p_agent->>'computer_substrate'='provider-vm' then (p_agent->>'operation_id')::uuid end,
    p_agent->>'infrastructure_binding_token_hash',true,(p_agent->>'pool_id')::uuid,p_agent->>'goal',p_agent->>'context',
    p_agent->>'personality',p_agent->>'emoji',
    nullif(p_agent->'template_skills','null'::jsonb),
    false,null,null,(p_agent->>'infrastructure_connection_id')::uuid,(p_agent->>'infrastructure_connection_revision')::bigint,
    (p_agent->>'deployment_target_id')::uuid,(p_agent->>'provider_capacity_order_id')::uuid,
    (p_agent->>'provider_enrollment_attempt_id')::uuid,p_agent->>'provider_server_id') returning * into a;
  insert into public.hivra_launch_model_requests(user_id,request_id,agent_id,provision_operation_id,model_operation_id,
    fingerprint_key_tag,request_digest,binding,selection,encrypted_key)
  values(p_user_id,p_request_id,a.id,a.operation_id,p_model_operation_id,p_fingerprints->0->>'keyTag',
    p_fingerprints->0->>'digest',public.hivra_launch_model_binding(a),p_selection,p_encrypted_key);
  return jsonb_build_object('status','reserved','agentId',a.id,'phase','waiting');
end;
$$;

-- One automatic attempt, with explicit same-operation retries afterward.
-- Expiry bounds admission, not guest dispatch: the existing journal takes its
-- own shorter delivery lease. Cancellation can win before any guest write.
create function public.claim_hivra_launch_model_attempt(p_user_id text,p_agent_id uuid,p_request_id uuid,p_automatic boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; q public.hivra_launch_model_requests%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or a.type<>'codex' or a.status<>'running' or a.desired_state<>'running' or a.operation_id is not null
    then return null; end if;
  select * into q from public.hivra_launch_model_requests where user_id=p_user_id and agent_id=p_agent_id and request_id=p_request_id for update;
  if not found or q.phase<>'waiting' or q.binding is distinct from public.hivra_launch_model_binding(a)
    or a.allocation_operation_id is distinct from q.provision_operation_id
    or a.api_token is null or a.api_token !~ '^[a-f0-9]{64}$' or a.cf_hostname is null or a.cf_tunnel_id is null
    or a.chat_url is distinct from 'https://' || a.cf_hostname
    or (a.computer_substrate='proxmox-kvm' and a.vmid is null)
    or p_automatic is null or (p_automatic and q.attempted_at is not null)
    or q.attempt_expires_at>clock_timestamp() then return null; end if;
  update public.hivra_launch_model_requests set attempted_at=coalesce(attempted_at,clock_timestamp()),
    attempt_id=gen_random_uuid(),attempt_expires_at=clock_timestamp()+interval '30 seconds'
    where user_id=q.user_id and request_id=q.request_id returning * into q;
  return to_jsonb(q);
end;
$$;

create function public.promote_hivra_launch_model_request(
  p_user_id text,p_agent_id uuid,p_request_id uuid,p_attempt_id uuid,p_binding jsonb,p_request jsonb
) returns text language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; q public.hivra_launch_model_requests%rowtype; outcome text;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found then return 'not_found'; end if;
  select * into q from public.hivra_launch_model_requests where user_id=p_user_id and agent_id=p_agent_id and request_id=p_request_id for update;
  if not found then return 'not_found'; end if;
  if q.phase='promoted' then return 'already_promoted'; end if;
  if q.phase<>'waiting' or p_attempt_id is null or q.attempt_id is distinct from p_attempt_id
    or q.attempt_expires_at<=clock_timestamp() then return 'attempt_ended'; end if;
  if q.binding is distinct from public.hivra_launch_model_binding(a)
    or a.allocation_operation_id is distinct from q.provision_operation_id
    then return 'target_changed'; end if;
  -- This state exists only within the locked transaction. The journal trigger
  -- below requires it; ordinary settings cannot overtake the requested launch.
  update public.hivra_launch_model_requests set phase='admitting' where user_id=q.user_id and request_id=q.request_id;
  outcome := public.admit_hivra_model_key_operation(p_user_id,p_agent_id,q.model_operation_id,p_binding,p_request);
  if outcome in ('pending','applied') then
    update public.hivra_launch_model_requests set phase='promoted',promoted_at=clock_timestamp(),encrypted_key=null,
      attempt_id=null,attempt_expires_at=null where user_id=q.user_id and request_id=q.request_id;
  else
    update public.hivra_launch_model_requests set phase='waiting' where user_id=q.user_id and request_id=q.request_id;
  end if;
  return outcome;
end;
$$;

create function public.cancel_hivra_launch_model_request(p_user_id text,p_agent_id uuid,p_request_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; q public.hivra_launch_model_requests%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found then return false; end if;
  select * into q from public.hivra_launch_model_requests where user_id=p_user_id and agent_id=p_agent_id and request_id=p_request_id for update;
  if not found then return false; end if;
  if q.phase='cancelled' then return true; end if;
  if q.phase<>'waiting' then return false; end if;
  update public.hivra_launch_model_requests set phase='cancelled',encrypted_key=null,closed_at=clock_timestamp(),
    attempt_id=null,attempt_expires_at=null where user_id=q.user_id and request_id=q.request_id;
  return true;
end;
$$;

create function public.guard_hivra_launch_model_journal()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare q public.hivra_launch_model_requests%rowtype;
begin
  select * into q from public.hivra_launch_model_requests where agent_id=new.agent_id;
  if not found or q.phase in ('cancelled','deleted','promoted') then return new; end if;
  if q.phase<>'admitting' or new.operation_id is distinct from q.model_operation_id or new.user_id<>q.user_id
    or new.config->>'provider' is distinct from q.selection->>'provider'
    or new.config->>'mode' is distinct from q.selection->>'mode'
    or new.config->>'model' is distinct from q.selection->>'model'
    or (q.selection->>'mode'='byok' and new.encrypted_key is distinct from q.encrypted_key)
    or (q.selection->>'mode'='managed' and new.config->>'walletType' is distinct from q.selection->>'walletType')
    then raise exception 'Resolve the original launch model request first' using errcode='55000'; end if;
  return new;
end;
$$;
create trigger hivra_model_key_launch_guard before insert on public.hivra_model_key_operations
  for each row execute function public.guard_hivra_launch_model_journal();

create function public.guard_hivra_launch_model_agent()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare q public.hivra_launch_model_requests%rowtype;
begin
  select * into q from public.hivra_launch_model_requests where agent_id=old.id and phase in ('waiting','admitting');
  if not found or new.status='deleted' then return new; end if;
  if public.hivra_launch_model_binding(new) is distinct from q.binding
    or (new.allocation_operation_id is not null and new.allocation_operation_id<>q.provision_operation_id)
    or (old.allocation_operation_id is not null and new.allocation_operation_id is distinct from old.allocation_operation_id)
    or (old.vmid is not null and new.vmid is distinct from old.vmid)
    then raise exception 'Launch model settings belong to the original allocation' using errcode='55000'; end if;
  if row(new.llm_config,new.llm_api_key_encrypted) is distinct from row(old.llm_config,old.llm_api_key_encrypted)
    then raise exception 'Promote the launch model request before applying settings' using errcode='55000'; end if;
  return new;
end;
$$;
create trigger hivra_agents_launch_model_guard before update on public.hivra_agents
  for each row execute function public.guard_hivra_launch_model_agent();

create function public.clean_hivra_deleted_launch_models()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  update public.hivra_launch_model_requests set phase='deleted',closed_at=clock_timestamp(),encrypted_key=null,
    attempt_id=null,attempt_expires_at=null where agent_id=new.id and phase<>'deleted';
  return new;
end;
$$;
create trigger hivra_agents_launch_model_cleanup after update of status on public.hivra_agents
  for each row when (new.status='deleted' and old.status<>'deleted') execute function public.clean_hivra_deleted_launch_models();

revoke all on function public.hivra_launch_model_binding(public.hivra_agents),
  public.reserve_hivra_launch_model_request(text,uuid,jsonb,uuid,jsonb,jsonb,text),
  public.claim_hivra_launch_model_attempt(text,uuid,uuid,boolean),
  public.promote_hivra_launch_model_request(text,uuid,uuid,uuid,jsonb,jsonb),
  public.cancel_hivra_launch_model_request(text,uuid,uuid),public.guard_hivra_launch_model_journal(),
  public.guard_hivra_launch_model_agent(),public.clean_hivra_deleted_launch_models()
  from public,anon,authenticated,service_role;
grant execute on function public.hivra_launch_model_binding(public.hivra_agents),
  public.reserve_hivra_launch_model_request(text,uuid,jsonb,uuid,jsonb,jsonb,text),
  public.claim_hivra_launch_model_attempt(text,uuid,uuid,boolean),
  public.promote_hivra_launch_model_request(text,uuid,uuid,uuid,jsonb,jsonb),
  public.cancel_hivra_launch_model_request(text,uuid,uuid) to service_role;
