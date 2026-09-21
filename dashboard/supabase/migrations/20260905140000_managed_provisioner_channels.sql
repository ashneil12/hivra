-- Keep Canary-managed provisioner delivery physically separate from the
-- historical production directory on shared Proxmox hosts. Existing rows and
-- callers that predate this column remain bound to the default channel.
alter table public.hivra_agents
  add column if not exists managed_provisioner_channel text not null default 'default';

alter table public.hivra_agents
  drop constraint if exists hivra_agents_managed_provisioner_channel_check;
alter table public.hivra_agents
  add constraint hivra_agents_managed_provisioner_channel_check
  check (managed_provisioner_channel in ('default','canary'));

alter table public.hivra_agents
  drop constraint if exists hivra_agents_canary_provisioner_binding_check;
alter table public.hivra_agents
  add constraint hivra_agents_canary_provisioner_binding_check
  check (managed_provisioner_channel <> 'canary'
    or (deployment_mode is not distinct from 'hivra-managed'
      and computer_substrate is not distinct from 'proxmox-kvm'));

comment on column public.hivra_agents.managed_provisioner_channel is
  'Immutable server-selected managed provisioner directory: default retains the historical production path; canary uses its isolated path.';

create or replace function public.guard_hivra_managed_provisioner_channel()
returns trigger language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
begin
  if new.managed_provisioner_channel is distinct from old.managed_provisioner_channel then
    raise exception 'Managed provisioner channel is immutable' using errcode='55006';
  end if;
  return new;
end;
$$;

drop trigger if exists hivra_agents_managed_provisioner_channel_guard on public.hivra_agents;
create trigger hivra_agents_managed_provisioner_channel_guard
  before update of managed_provisioner_channel on public.hivra_agents
  for each row execute function public.guard_hivra_managed_provisioner_channel();

revoke all on function public.guard_hivra_managed_provisioner_channel()
  from public,anon,authenticated,service_role;

-- Preserve every existing launch-model custody and budget field while adding
-- the server-selected channel to the exact reservation whitelist. Omission is
-- accepted only for a rolling N-1 deployment and resolves to the legacy
-- default; an explicit unknown or null value fails closed.
create or replace function public.reserve_hivra_launch_model_request(
  p_user_id text,p_request_id uuid,p_fingerprints jsonb,p_model_operation_id uuid,
  p_agent jsonb,p_selection jsonb,p_encrypted_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; q public.hivra_launch_model_requests%rowtype; f jsonb; k text;
  c text := 'default';
begin
  if p_request_id is null or p_model_operation_id is null or p_user_id is null
    or length(p_user_id) not between 1 and 256 or btrim(p_user_id)=''
    or jsonb_typeof(p_fingerprints) is distinct from 'array'
    then return jsonb_build_object('status','invalid_request'); end if;
  if jsonb_array_length(p_fingerprints) not between 1 and 2 then return jsonb_build_object('status','invalid_request'); end if;
  for f in select value from jsonb_array_elements(p_fingerprints) loop
    if (f=jsonb_build_object('version',f->'version','keyTag',f->'keyTag','digest',f->'digest')
      and f->>'version' in ('1','2') and jsonb_typeof(f->'version')='number'
      and f->>'keyTag' ~ '^[a-f0-9]{64}$' and f->>'digest' ~ '^[a-f0-9]{64}$') is not true
      then return jsonb_build_object('status','invalid_request'); end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_fingerprints) e
    where e->>'version' is distinct from p_fingerprints->0->>'version')
    then return jsonb_build_object('status','invalid_request'); end if;
  perform pg_advisory_xact_lock(hashtextextended('hivra-launch-model-v1:' || p_user_id || ':' || p_request_id::text,0));
  select * into q from public.hivra_launch_model_requests where user_id=p_user_id and request_id=p_request_id;
  if found then
    if not exists(select 1 from jsonb_array_elements(p_fingerprints) e
      where (e->>'version')::integer=q.fingerprint_version
        and e->>'keyTag'=q.fingerprint_key_tag and e->>'digest'=q.request_digest)
      then return jsonb_build_object('status','request_conflict'); end if;
    return jsonb_build_object('status','existing','agentId',q.agent_id,'phase',q.phase);
  end if;
  if jsonb_typeof(p_agent) is distinct from 'object' or octet_length(p_agent::text)>32768
    or jsonb_typeof(p_selection) is distinct from 'object'
    then return jsonb_build_object('status','invalid_request'); end if;
  for k in select jsonb_object_keys(p_agent) loop
    if k <> all(array['id','type','name','cpu','ram','proxmox_host','deployment_mode','computer_substrate',
      'managed_provisioner_channel','operation_id','infrastructure_binding_token_hash','pool_id','goal','context','personality','emoji','template_skills',
      'infrastructure_connection_id','infrastructure_connection_revision','deployment_target_id',
      'provider_capacity_order_id','provider_enrollment_attempt_id','provider_server_id'])
      then return jsonb_build_object('status','invalid_request'); end if;
  end loop;
  if p_agent ? 'managed_provisioner_channel' then
    if jsonb_typeof(p_agent->'managed_provisioner_channel') is distinct from 'string'
      or p_agent->>'managed_provisioner_channel' not in ('default','canary')
      then return jsonb_build_object('status','invalid_request'); end if;
    c := p_agent->>'managed_provisioner_channel';
  end if;
  if c='canary' and (p_agent->>'deployment_mode' is distinct from 'hivra-managed'
    or p_agent->>'computer_substrate' is distinct from 'proxmox-kvm')
    then return jsonb_build_object('status','invalid_request'); end if;
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
  if p_agent->>'pool_id' is not null then
    if p_agent->>'deployment_mode'<>'hivra-managed' or p_agent->>'pool_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      then return jsonb_build_object('status','invalid_request'); end if;
    perform id from public.pools where id=(p_agent->>'pool_id')::uuid and user_id=p_user_id and product_surface='hermesos' for share;
    if not found then return jsonb_build_object('status','invalid_request'); end if;
  end if;
  insert into public.hivra_agents(id,user_id,type,name,cpu,ram,proxmox_host,deployment_mode,computer_substrate,
    managed_provisioner_channel,status,desired_state,operation_id,operation_kind,operation_started_at,operation_payload,allocation_operation_id,
    infrastructure_binding_token_hash,infrastructure_binding_token_enforced,pool_id,goal,context,personality,emoji,
    template_skills,managed_venice,llm_config,llm_api_key_encrypted,infrastructure_connection_id,
    infrastructure_connection_revision,deployment_target_id,provider_capacity_order_id,provider_enrollment_attempt_id,provider_server_id)
  values((p_agent->>'id')::uuid,p_user_id,'codex',p_agent->>'name',(p_agent->>'cpu')::numeric,(p_agent->>'ram')::integer,
    p_agent->>'proxmox_host',p_agent->>'deployment_mode',p_agent->>'computer_substrate',c,'provisioning','running',
    (p_agent->>'operation_id')::uuid,'provision',clock_timestamp(),'{"stage":"pre_allocation_access"}',
    case when p_agent->>'computer_substrate'='provider-vm' then (p_agent->>'operation_id')::uuid end,
    p_agent->>'infrastructure_binding_token_hash',true,(p_agent->>'pool_id')::uuid,p_agent->>'goal',p_agent->>'context',
    p_agent->>'personality',p_agent->>'emoji',nullif(p_agent->'template_skills','null'::jsonb),
    false,null,null,(p_agent->>'infrastructure_connection_id')::uuid,(p_agent->>'infrastructure_connection_revision')::bigint,
    (p_agent->>'deployment_target_id')::uuid,(p_agent->>'provider_capacity_order_id')::uuid,
    (p_agent->>'provider_enrollment_attempt_id')::uuid,p_agent->>'provider_server_id') returning * into a;
  insert into public.hivra_launch_model_requests(user_id,request_id,agent_id,provision_operation_id,model_operation_id,
    fingerprint_version,fingerprint_key_tag,request_digest,binding,selection,encrypted_key)
  values(p_user_id,p_request_id,a.id,a.operation_id,p_model_operation_id,(p_fingerprints->0->>'version')::integer,
    p_fingerprints->0->>'keyTag',p_fingerprints->0->>'digest',public.hivra_launch_model_binding(a),p_selection,p_encrypted_key);
  return jsonb_build_object('status','reserved','agentId',a.id,'phase','waiting');
end;
$$;

revoke all on function public.reserve_hivra_launch_model_request(text,uuid,jsonb,uuid,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.reserve_hivra_launch_model_request(text,uuid,jsonb,uuid,jsonb,jsonb,text)
  to service_role;
