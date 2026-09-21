-- Owner-bound Hetzner change-type operations for already allocated provider
-- computers. A resize changes Hetzner billing and requires provider downtime.
-- The primary disk is deliberately retained (upgrade_disk=false in the only
-- application dispatcher); this journal never claims that storage grew.

create function public.hivra_provider_resize_size_valid(p_size jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_server_type_id numeric;
  v_cores numeric;
  v_memory numeric;
  v_disk numeric;
  v_monthly numeric;
begin
  if jsonb_typeof(p_size) is distinct from 'object'
    or (p_size - array['serverTypeId','serverType','architecture','cores','memoryGb','advertisedDiskGb','cpuType','price']) <> '{}'::jsonb
    or jsonb_typeof(p_size->'serverTypeId') is distinct from 'number'
    or coalesce(p_size->>'serverType','') !~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$'
    or coalesce(p_size->>'architecture','') not in ('x86','arm')
    or p_size->>'cpuType' is distinct from 'shared'
    or jsonb_typeof(p_size->'cores') is distinct from 'number'
    or jsonb_typeof(p_size->'memoryGb') is distinct from 'number'
    or jsonb_typeof(p_size->'advertisedDiskGb') is distinct from 'number'
    or jsonb_typeof(p_size->'price') is distinct from 'object'
    or ((p_size->'price') - array['currency','hourlyGross','monthlyGross']) <> '{}'::jsonb
    or coalesce(p_size#>>'{price,currency}','') not in ('EUR','USD')
    or coalesce(p_size#>>'{price,hourlyGross}','') !~ '^[0-9]+([.][0-9]+)?$'
    or coalesce(p_size#>>'{price,monthlyGross}','') !~ '^[0-9]+([.][0-9]+)?$'
  then
    return false;
  end if;
  begin
    v_server_type_id := (p_size->>'serverTypeId')::numeric;
    v_cores := (p_size->>'cores')::numeric;
    v_memory := (p_size->>'memoryGb')::numeric;
    v_disk := (p_size->>'advertisedDiskGb')::numeric;
    v_monthly := (p_size#>>'{price,monthlyGross}')::numeric;
  exception when others then
    return false;
  end;
  return v_server_type_id = trunc(v_server_type_id) and v_server_type_id between 1 and 9007199254740991
    and v_cores = trunc(v_cores) and v_memory = trunc(v_memory) and v_disk = trunc(v_disk)
    and v_cores between 1 and 1024 and v_memory between 1 and 65536
    and v_disk between 1 and 9007199254740991 and v_monthly >= 0;
end;
$$;

create function public.hivra_provider_resize_quote_valid(
  p_quote jsonb,
  p_operation_id uuid,
  p_agent_id uuid,
  p_provider_server_id text,
  p_quote_fingerprint text,
  p_observed_at timestamptz,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing_disk numeric;
  v_observed timestamptz;
  v_expires timestamptz;
begin
  if jsonb_typeof(p_quote) is distinct from 'object'
    or (p_quote - array['operationId','quoteFingerprint','agentId','providerServerId','location','source','target',
      'existingDiskGb','upgradeDisk','observedAt','expiresAt','downtimeNotice','billingConfirmation']) <> '{}'::jsonb
    or p_quote->>'operationId' is distinct from p_operation_id::text
    or p_quote->>'agentId' is distinct from p_agent_id::text
    or p_quote->>'providerServerId' is distinct from p_provider_server_id
    or p_quote->>'quoteFingerprint' is distinct from p_quote_fingerprint
    or coalesce(p_quote->>'location','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    or p_quote->'upgradeDisk' is distinct from 'false'::jsonb
    or p_quote->>'billingConfirmation' is distinct from 'Resize this server and accept the new Hetzner billing'
    or p_quote->>'downtimeNotice' is distinct from
      'The computer must stay powered off while Hetzner changes its server type. Hivra leaves it stopped after the resize so you can review the result before starting it again.'
    or public.hivra_provider_resize_size_valid(p_quote->'source') is distinct from true
    or public.hivra_provider_resize_size_valid(p_quote->'target') is distinct from true
    or p_quote#>>'{source,serverType}' is not distinct from p_quote#>>'{target,serverType}'
    or p_quote#>>'{source,architecture}' is distinct from p_quote#>>'{target,architecture}'
    or p_quote#>>'{source,price,currency}' is distinct from p_quote#>>'{target,price,currency}'
    or jsonb_typeof(p_quote->'existingDiskGb') is distinct from 'number'
  then
    return false;
  end if;
  begin
    v_existing_disk := (p_quote->>'existingDiskGb')::numeric;
    v_observed := (p_quote->>'observedAt')::timestamptz;
    v_expires := (p_quote->>'expiresAt')::timestamptz;
  exception when others then
    return false;
  end;
  return v_observed is not distinct from p_observed_at
    and v_expires is not distinct from p_expires_at
    and p_expires_at is not distinct from p_observed_at + interval '5 minutes'
    and v_existing_disk = trunc(v_existing_disk)
    and v_existing_disk between 1 and 9007199254740991
    and (p_quote#>>'{target,cores}')::numeric between 2 and 8
    and (p_quote#>>'{target,memoryGb}')::numeric between 4 and 32
    and (p_quote#>>'{target,advertisedDiskGb}')::numeric <= 320
    and (p_quote#>>'{target,price,monthlyGross}')::numeric
      <= case p_quote#>>'{target,price,currency}' when 'EUR' then 45 else 50 end
    and (p_quote#>>'{source,advertisedDiskGb}')::numeric >= v_existing_disk
    and (p_quote#>>'{target,advertisedDiskGb}')::numeric >= v_existing_disk;
end;
$$;

create function public.hivra_provider_resize_action_valid(p_action jsonb, p_server_id text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_resource jsonb;
  v_action_id numeric;
  v_server_id numeric;
begin
  if jsonb_typeof(p_action) is distinct from 'object'
    or (p_action - array['id','command','status','resources']) <> '{}'::jsonb
    or jsonb_typeof(p_action->'id') is distinct from 'number'
    or p_action->>'command' is distinct from 'change_type'
    or coalesce(p_action->>'status','') not in ('running','success','error')
    or jsonb_typeof(p_action->'resources') is distinct from 'array'
    or jsonb_array_length(p_action->'resources') <> 1
    or p_server_id !~ '^[1-9][0-9]{0,15}$'
  then
    return false;
  end if;
  v_resource := p_action->'resources'->0;
  if jsonb_typeof(v_resource) is distinct from 'object'
    or (v_resource - array['id','type']) <> '{}'::jsonb
    or jsonb_typeof(v_resource->'id') is distinct from 'number'
    or v_resource->>'type' is distinct from 'server'
  then
    return false;
  end if;
  begin
    v_action_id := (p_action->>'id')::numeric;
    v_server_id := (v_resource->>'id')::numeric;
  exception when others then
    return false;
  end;
  return v_action_id = trunc(v_action_id) and v_action_id between 1 and 9007199254740991
    and v_server_id = trunc(v_server_id) and v_server_id between 1 and 9007199254740991
    and v_server_id = p_server_id::numeric;
end;
$$;

create function public.hivra_provider_current_shape_valid(
  p_shape jsonb,p_order_id uuid,p_connection_id uuid,p_connection_revision bigint,p_server_id text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_type jsonb;
  v_type_id numeric;
  v_cores numeric;
  v_memory numeric;
  v_advertised_disk numeric;
  v_primary_disk numeric;
  v_observed timestamptz;
begin
  if jsonb_typeof(p_shape) is distinct from 'object'
    or (p_shape-array['version','provider','capacityOrderId','connectionId','connectionRevision','providerServerId',
      'resizeOperationId','resizeQuoteFingerprintSha256','previousShapeFingerprintSha256','serverType',
      'primaryDiskGb','observedAt']) <> '{}'::jsonb
    or p_shape->'version' is distinct from '1'::jsonb
    or p_shape->>'provider' is distinct from 'hetzner-cloud'
    or p_shape->>'capacityOrderId' is distinct from p_order_id::text
    or p_shape->>'connectionId' is distinct from p_connection_id::text
    or p_shape->'connectionRevision' is distinct from to_jsonb(p_connection_revision)
    or p_shape->>'providerServerId' is distinct from p_server_id
    or coalesce(p_shape->>'resizeOperationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_shape->>'resizeQuoteFingerprintSha256','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_shape->>'previousShapeFingerprintSha256','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_shape->'primaryDiskGb') is distinct from 'number'
    or coalesce(p_shape->>'observedAt','') = ''
  then return false; end if;
  v_type:=p_shape->'serverType';
  if jsonb_typeof(v_type) is distinct from 'object'
    or (v_type-array['id','name','architecture','cores','memoryGb','advertisedDiskGb','cpuType']) <> '{}'::jsonb
    or jsonb_typeof(v_type->'id') is distinct from 'number'
    or coalesce(v_type->>'name','') !~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$'
    or coalesce(v_type->>'architecture','') not in ('x86','arm')
    or jsonb_typeof(v_type->'cores') is distinct from 'number'
    or jsonb_typeof(v_type->'memoryGb') is distinct from 'number'
    or jsonb_typeof(v_type->'advertisedDiskGb') is distinct from 'number'
    or coalesce(v_type->>'cpuType','') not in ('shared','dedicated')
  then return false; end if;
  begin
    v_type_id:=(v_type->>'id')::numeric;
    v_cores:=(v_type->>'cores')::numeric;
    v_memory:=(v_type->>'memoryGb')::numeric;
    v_advertised_disk:=(v_type->>'advertisedDiskGb')::numeric;
    v_primary_disk:=(p_shape->>'primaryDiskGb')::numeric;
    v_observed:=(p_shape->>'observedAt')::timestamptz;
  exception when others then return false; end;
  return v_type_id=trunc(v_type_id) and v_type_id between 1 and 9007199254740991
    and v_cores=trunc(v_cores) and v_cores between 1 and 1024
    and v_memory=trunc(v_memory) and v_memory between 1 and 65536
    and v_advertised_disk=trunc(v_advertised_disk) and v_advertised_disk between 1 and 9007199254740991
    and v_primary_disk=trunc(v_primary_disk) and v_primary_disk between 1 and 9007199254740991
    and v_observed is not null;
end;
$$;

alter table public.infrastructure_capacity_orders
  add column current_server_shape jsonb,
  add column current_server_shape_fingerprint_sha256 text,
  add constraint infrastructure_capacity_orders_current_shape_check check (
    (current_server_shape is null and current_server_shape_fingerprint_sha256 is null)
    or (
      current_server_shape is not null
      and current_server_shape_fingerprint_sha256 is not null
      and current_server_shape_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
      and current_server_shape_fingerprint_sha256 =
        encode(sha256(convert_to(current_server_shape::text,'UTF8')),'hex')
      and public.hivra_provider_current_shape_valid(current_server_shape,id,connection_id,connection_revision,provider_resource_id)
    )
  );

create table public.hivra_provider_resize_operations (
  operation_id uuid primary key,
  agent_id uuid not null references public.hivra_agents(id),
  user_id text not null check (length(user_id) between 1 and 256 and btrim(user_id) <> ''),
  connection_id uuid not null references public.infrastructure_connections(id),
  connection_revision bigint not null check (connection_revision > 0),
  deployment_target_id uuid not null references public.deployment_targets(id),
  capacity_order_id uuid not null references public.infrastructure_capacity_orders(id),
  enrollment_attempt_id uuid not null,
  allocation_operation_id uuid not null,
  provider_server_id text not null check (
    provider_server_id ~ '^[1-9][0-9]{0,15}$'
    and provider_server_id::numeric <= 9007199254740991
  ),
  source_shape_fingerprint_sha256 text not null check (source_shape_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in (
    'quoted','dispatch_pending','request_uncertain','action_pending','provider_pending',
    'manual_attention','succeeded','failed','cancelled'
  )),
  plan_fingerprint_sha256 text not null check (plan_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  quote_fingerprint_sha256 text not null check (quote_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  quote_snapshot jsonb not null,
  quote_observed_at timestamptz not null,
  quote_expires_at timestamptz not null,
  billing_confirmed_at timestamptz,
  dispatch_not_after timestamptz,
  provider_post_attempted_at timestamptz,
  provider_action jsonb,
  provider_observed_at timestamptz,
  provider_observed_status text check (provider_observed_status is null or length(provider_observed_status) between 1 and 64),
  provider_observed_server_type_id bigint check (provider_observed_server_type_id is null or provider_observed_server_type_id > 0),
  provider_observed_server_type text check (provider_observed_server_type is null or provider_observed_server_type ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$'),
  provider_observed_architecture text check (provider_observed_architecture is null or provider_observed_architecture in ('x86','arm')),
  provider_observed_cores integer check (provider_observed_cores is null or provider_observed_cores between 1 and 1024),
  provider_observed_memory_gb integer check (provider_observed_memory_gb is null or provider_observed_memory_gb between 1 and 65536),
  provider_observed_advertised_disk_gb bigint check (provider_observed_advertised_disk_gb is null or provider_observed_advertised_disk_gb > 0),
  provider_observed_cpu_type text check (provider_observed_cpu_type is null or provider_observed_cpu_type in ('shared','dedicated')),
  provider_observed_disk_gb bigint check (provider_observed_disk_gb is null or provider_observed_disk_gb > 0),
  completed_at timestamptz,
  failure_code text check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hivra_provider_resize_quote_check check (
    public.hivra_provider_resize_quote_valid(quote_snapshot, operation_id, agent_id, provider_server_id,
      quote_fingerprint_sha256, quote_observed_at, quote_expires_at)
  ),
  constraint hivra_provider_resize_action_check check (
    provider_action is null or public.hivra_provider_resize_action_valid(provider_action, provider_server_id)
  ),
  constraint hivra_provider_resize_observation_check check (
    (provider_observed_at is null and provider_observed_status is null and provider_observed_server_type_id is null
      and provider_observed_server_type is null and provider_observed_architecture is null and provider_observed_cores is null
      and provider_observed_memory_gb is null and provider_observed_advertised_disk_gb is null
      and provider_observed_cpu_type is null and provider_observed_disk_gb is null)
    or (provider_observed_at is not null and provider_observed_status is not null and provider_observed_server_type_id is not null
      and provider_observed_server_type is not null and provider_observed_architecture is not null and provider_observed_cores is not null
      and provider_observed_memory_gb is not null and provider_observed_advertised_disk_gb is not null
      and provider_observed_cpu_type is not null and provider_observed_disk_gb is not null)
  ),
  constraint hivra_provider_resize_stage_check check (
    (status = 'quoted' and billing_confirmed_at is null and dispatch_not_after is null
      and provider_post_attempted_at is null and provider_action is null and provider_observed_at is null
      and completed_at is null and failure_code is null)
    or (status = 'dispatch_pending' and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is null and provider_action is null and provider_observed_at is null
      and completed_at is null and failure_code is null)
    or (status = 'request_uncertain' and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is not null and provider_action is null
      and completed_at is null and failure_code is null)
    or (status = 'action_pending' and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is not null and provider_action is not null
      and completed_at is null and failure_code is null)
    or (status in ('provider_pending','manual_attention')
      and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is not null and completed_at is null and failure_code is null)
    or (status = 'succeeded' and billing_confirmed_at is not null and provider_post_attempted_at is not null
      and provider_observed_at is not null and completed_at is not null and failure_code is null)
    or (status = 'failed' and billing_confirmed_at is not null and provider_post_attempted_at is not null
      and provider_action->>'status' is not distinct from 'error' and provider_observed_at is not null
      and completed_at is not null and failure_code is not null)
    or (status = 'cancelled' and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is null and provider_action is null and provider_observed_at is null
      and completed_at is not null and failure_code is not null)
  )
);

create unique index hivra_provider_resize_one_active_agent
  on public.hivra_provider_resize_operations(agent_id)
  where status in ('dispatch_pending','request_uncertain','action_pending','provider_pending','manual_attention');
create index hivra_provider_resize_owner_agent_created
  on public.hivra_provider_resize_operations(user_id, agent_id, created_at desc);

alter table public.hivra_provider_resize_operations enable row level security;
revoke all on table public.hivra_provider_resize_operations from public, anon, authenticated, service_role;
grant select, insert, update on table public.hivra_provider_resize_operations to service_role;

create function public.guard_hivra_provider_current_shape()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  q public.hivra_provider_resize_operations%rowtype;
  v_previous_fingerprint text;
  v_expected_type jsonb;
begin
  if row(new.current_server_shape,new.current_server_shape_fingerprint_sha256)
    is not distinct from row(old.current_server_shape,old.current_server_shape_fingerprint_sha256)
  then return new; end if;
  if old.status <> 'created_off' or new.status <> 'created_off'
    or new.current_server_shape is null or new.current_server_shape_fingerprint_sha256 is null
    or public.hivra_provider_current_shape_valid(new.current_server_shape,old.id,old.connection_id,
      old.connection_revision,old.provider_resource_id) is distinct from true
    or new.current_server_shape_fingerprint_sha256 is distinct from
      encode(sha256(convert_to(new.current_server_shape::text,'UTF8')),'hex')
    or (to_jsonb(old)-array['current_server_shape','current_server_shape_fingerprint_sha256','updated_at'])
      is distinct from (to_jsonb(new)-array['current_server_shape','current_server_shape_fingerprint_sha256','updated_at'])
  then raise exception 'Current provider shape requires exact terminal resize evidence' using errcode='55006'; end if;
  v_previous_fingerprint:=coalesce(old.current_server_shape_fingerprint_sha256,old.quote_fingerprint_sha256);
  select * into q from public.hivra_provider_resize_operations
    where operation_id=(new.current_server_shape->>'resizeOperationId')::uuid
      and capacity_order_id=old.id and user_id=old.user_id
      and connection_id=old.connection_id and connection_revision=old.connection_revision
      and provider_server_id=old.provider_resource_id and status='succeeded';
  if not found then
    raise exception 'Current provider shape lacks terminal resize evidence' using errcode='55006';
  end if;
  v_expected_type:=jsonb_build_object(
    'id',q.provider_observed_server_type_id,'name',q.provider_observed_server_type,
    'architecture',q.provider_observed_architecture,'cores',q.provider_observed_cores,
    'memoryGb',q.provider_observed_memory_gb,'advertisedDiskGb',q.provider_observed_advertised_disk_gb,
    'cpuType',q.provider_observed_cpu_type
  );
  if q.source_shape_fingerprint_sha256 is distinct from v_previous_fingerprint
    or new.current_server_shape->>'previousShapeFingerprintSha256' is distinct from v_previous_fingerprint
    or new.current_server_shape->>'resizeQuoteFingerprintSha256' is distinct from q.quote_fingerprint_sha256
    or new.current_server_shape->'serverType' is distinct from v_expected_type
    or new.current_server_shape->'primaryDiskGb' is distinct from to_jsonb(q.provider_observed_disk_gb)
    or (new.current_server_shape->>'observedAt')::timestamptz is distinct from q.provider_observed_at
    or q.provider_observed_status is distinct from 'off'
    or q.provider_observed_server_type_id is distinct from (q.quote_snapshot#>>'{target,serverTypeId}')::bigint
    or q.provider_observed_server_type is distinct from q.quote_snapshot#>>'{target,serverType}'
    or q.provider_observed_architecture is distinct from q.quote_snapshot#>>'{target,architecture}'
    or q.provider_observed_cores is distinct from (q.quote_snapshot#>>'{target,cores}')::integer
    or q.provider_observed_memory_gb is distinct from (q.quote_snapshot#>>'{target,memoryGb}')::integer
    or q.provider_observed_advertised_disk_gb is distinct from (q.quote_snapshot#>>'{target,advertisedDiskGb}')::bigint
    or q.provider_observed_cpu_type is distinct from q.quote_snapshot#>>'{target,cpuType}'
    or q.provider_observed_disk_gb is distinct from (q.quote_snapshot->>'existingDiskGb')::bigint
    or q.provider_action->>'status' is not distinct from 'error'
  then raise exception 'Current provider shape is not the verified successor' using errcode='55006'; end if;
  return new;
exception when invalid_text_representation then
  raise exception 'Current provider shape operation is invalid' using errcode='55006';
end;
$$;

create trigger infrastructure_capacity_orders_current_shape_guard
  before update on public.infrastructure_capacity_orders
  for each row execute function public.guard_hivra_provider_current_shape();

create function public.hivra_provider_resize_binding_valid(
  p_user_id text,
  p_agent_id uuid,
  p_connection_id uuid,
  p_connection_revision bigint,
  p_target_id uuid,
  p_capacity_order_id uuid,
  p_enrollment_attempt_id uuid,
  p_allocation_operation_id uuid,
  p_provider_server_id text
)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.hivra_agents a
    join public.infrastructure_connections c on c.id = a.infrastructure_connection_id
    join public.infrastructure_capacity_orders o on o.id = a.provider_capacity_order_id
    join public.deployment_targets t on t.id = a.deployment_target_id
    where a.id = p_agent_id and a.user_id = p_user_id
      and a.computer_substrate = 'provider-vm' and a.deployment_mode = 'self-managed'
      and a.vmid is null and a.proxmox_host = '__hivra_self_managed_no_ambient_authority__'
      and a.infrastructure_connection_id = p_connection_id
      and a.infrastructure_connection_revision = p_connection_revision
      and a.deployment_target_id = p_target_id
      and a.provider_capacity_order_id = p_capacity_order_id
      and a.provider_enrollment_attempt_id = p_enrollment_attempt_id
      and a.allocation_operation_id = p_allocation_operation_id
      and a.provider_server_id = p_provider_server_id
      and a.provider_install_outcome = 'succeeded' and a.provider_install_stopped_at is not null
      and c.user_id = p_user_id and c.provider = 'hetzner-cloud' and c.status = 'ready'
      and c.revision = p_connection_revision
      and o.user_id = p_user_id and o.connection_id = p_connection_id and o.active_connection_id = p_connection_id
      and o.connection_revision = p_connection_revision and o.provider = 'hetzner-cloud' and o.status = 'created_off'
      and o.provider_resource_id = p_provider_server_id
      and o.provider_creation_receipt->>'serverId' = p_provider_server_id
      and o.cleanup_started_at is null and o.cleanup_finished_at is null and o.detached_at is null
      and t.user_id = p_user_id and t.connection_id = p_connection_id
      and t.evidence_connection_revision = p_connection_revision and t.id = p_target_id
      and t.provider_capacity_order_id = p_capacity_order_id and t.external_id = p_provider_server_id
      and t.status = 'ready' and t.provider_retired_at is null and t.isolation_class = 'provider-vm'
      and t.supported_isolation_drivers = array['provider-vm']::text[]
      and t.capabilities->>'kind' = 'provider-vm'
      and t.capabilities->>'provider' = 'hetzner-cloud'
      and t.capabilities->>'allocation' = 'exclusive-computer'
      and t.capabilities->>'capacityOrderId' = p_capacity_order_id::text
      and t.capabilities->>'enrollmentAttemptId' = p_enrollment_attempt_id::text
      and t.capabilities->'launchReady' = 'true'::jsonb
      and t.capabilities#>'{provisioner,configured}' = 'true'::jsonb
      and t.capabilities#>'{provisioner,ready}' = 'true'::jsonb
  );
$$;

create function public.guard_hivra_provider_resize_journal()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  a public.hivra_agents%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Retain provider resize evidence' using errcode = '55006';
  end if;
  select * into a from public.hivra_agents where id = new.agent_id and user_id = new.user_id;
  if not found or public.hivra_provider_resize_binding_valid(new.user_id,new.agent_id,new.connection_id,
      new.connection_revision,new.deployment_target_id,new.capacity_order_id,new.enrollment_attempt_id,
      new.allocation_operation_id,new.provider_server_id) is distinct from true then
    raise exception 'Provider resize identity changed' using errcode = '55006';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'quoted' or a.status <> 'stopped' or a.desired_state <> 'stopped' or a.operation_id is not null
      or new.quote_observed_at < clock_timestamp() - interval '30 seconds'
      or new.quote_observed_at > clock_timestamp() + interval '5 seconds'
      or new.created_at < clock_timestamp() - interval '30 seconds' or new.created_at > clock_timestamp() + interval '5 seconds'
    then
      raise exception 'Reserve a fresh provider resize quote' using errcode = '55006';
    end if;
    return new;
  end if;
  if row(new.operation_id,new.agent_id,new.user_id,new.connection_id,new.connection_revision,new.deployment_target_id,
      new.capacity_order_id,new.enrollment_attempt_id,new.allocation_operation_id,new.provider_server_id,
      new.source_shape_fingerprint_sha256,
      new.plan_fingerprint_sha256,new.quote_fingerprint_sha256,new.quote_snapshot,new.quote_observed_at,
      new.quote_expires_at,new.created_at)
    is distinct from row(old.operation_id,old.agent_id,old.user_id,old.connection_id,old.connection_revision,old.deployment_target_id,
      old.capacity_order_id,old.enrollment_attempt_id,old.allocation_operation_id,old.provider_server_id,
      old.source_shape_fingerprint_sha256,
      old.plan_fingerprint_sha256,old.quote_fingerprint_sha256,old.quote_snapshot,old.quote_observed_at,
      old.quote_expires_at,old.created_at)
  then
    raise exception 'Retain the reviewed provider resize quote' using errcode = '55006';
  end if;
  if old.status in ('succeeded','failed','cancelled') and new is distinct from old then
    raise exception 'Retain terminal provider resize evidence' using errcode = '55006';
  end if;
  if new.updated_at < old.updated_at or new.updated_at > clock_timestamp() + interval '5 seconds' then
    raise exception 'Provider resize evidence cannot move backwards' using errcode = '55006';
  end if;
  if old.status = 'quoted' then
    if new.status <> 'dispatch_pending' or a.operation_id is not null or a.status <> 'stopped' or a.desired_state <> 'stopped'
      or new.billing_confirmed_at is null or new.dispatch_not_after is distinct from new.billing_confirmed_at + interval '45 seconds'
      or new.billing_confirmed_at < clock_timestamp() - interval '5 seconds'
      or new.billing_confirmed_at > clock_timestamp() + interval '5 seconds'
    then raise exception 'Confirm billing before resize dispatch' using errcode = '55006'; end if;
  elsif old.status = 'dispatch_pending' then
    if new.status not in ('request_uncertain','cancelled')
    then raise exception 'Invalid provider resize dispatch transition' using errcode = '55006'; end if;
  elsif old.status in ('request_uncertain','action_pending','provider_pending','manual_attention') then
    if new.status not in ('request_uncertain','action_pending','provider_pending','manual_attention','succeeded','failed')
    then raise exception 'Invalid provider resize observation transition' using errcode = '55006'; end if;
  else
    raise exception 'Invalid provider resize transition' using errcode = '55006';
  end if;
  if old.billing_confirmed_at is not null and row(new.billing_confirmed_at,new.dispatch_not_after)
      is distinct from row(old.billing_confirmed_at,old.dispatch_not_after) then
    raise exception 'Retain provider resize billing authority' using errcode = '55006';
  end if;
  if new.provider_post_attempted_at is distinct from old.provider_post_attempted_at then
    if old.provider_post_attempted_at is not null or old.status <> 'dispatch_pending'
      or new.status <> 'request_uncertain'
      or new.provider_post_attempted_at < new.billing_confirmed_at
      or new.provider_post_attempted_at >= new.dispatch_not_after
      or new.provider_post_attempted_at < clock_timestamp() - interval '5 seconds'
      or new.provider_post_attempted_at > clock_timestamp() + interval '5 seconds'
    then raise exception 'Provider resize request fence changed' using errcode = '55006'; end if;
  end if;
  if old.status <> 'quoted' and (
    a.operation_id is distinct from new.operation_id or a.operation_kind <> 'resize'
    or a.status <> 'provisioning' or a.desired_state not in ('stopped','deleted')
  ) then
    raise exception 'Provider resize no longer owns this computer' using errcode = '55006';
  end if;
  if new.provider_action is distinct from old.provider_action and old.provider_action is not null then
    if new.provider_action->'id' is distinct from old.provider_action->'id'
      or new.provider_action->>'command' is distinct from old.provider_action->>'command'
      or new.provider_action->'resources' is distinct from old.provider_action->'resources'
      or (old.provider_action->>'status' <> 'running' and new.provider_action is distinct from old.provider_action)
    then raise exception 'Provider resize action identity changed' using errcode = '55006'; end if;
  end if;
  if new.provider_action is distinct from old.provider_action and new.provider_post_attempted_at is null then
    raise exception 'Provider action lacks a dispatched request' using errcode = '55006';
  end if;
  if old.provider_observed_at is not null and new.provider_observed_at is not null
    and new.provider_observed_at < old.provider_observed_at then
    raise exception 'Provider resize observation moved backwards' using errcode = '55006';
  end if;
  if new.provider_observed_at is distinct from old.provider_observed_at and (
    new.provider_post_attempted_at is null
    or new.provider_observed_at < new.provider_post_attempted_at
    or new.provider_observed_at < clock_timestamp() - interval '30 seconds'
    or new.provider_observed_at > clock_timestamp() + interval '5 seconds'
  ) then
    raise exception 'Provider resize observation is not fresh' using errcode = '55006';
  end if;
  if new.status = 'succeeded' and (
    new.provider_observed_status <> 'off'
    or new.provider_observed_server_type_id <> (new.quote_snapshot#>>'{target,serverTypeId}')::bigint
    or new.provider_observed_server_type is distinct from new.quote_snapshot#>>'{target,serverType}'
    or new.provider_observed_architecture is distinct from new.quote_snapshot#>>'{target,architecture}'
    or new.provider_observed_cores <> (new.quote_snapshot#>>'{target,cores}')::integer
    or new.provider_observed_memory_gb <> (new.quote_snapshot#>>'{target,memoryGb}')::integer
    or new.provider_observed_advertised_disk_gb <> (new.quote_snapshot#>>'{target,advertisedDiskGb}')::bigint
    or new.provider_observed_cpu_type is distinct from new.quote_snapshot#>>'{target,cpuType}'
    or new.provider_observed_disk_gb <> (new.quote_snapshot->>'existingDiskGb')::bigint
    -- The bound server is authoritative when an action receipt has aged out;
    -- only an explicit action error contradicts an exact target observation.
    or new.provider_action->>'status' = 'error'
    or new.completed_at < clock_timestamp() - interval '5 seconds'
    or new.completed_at > clock_timestamp() + interval '5 seconds'
  ) then
    raise exception 'Provider resize success is not reconciled' using errcode = '55006';
  end if;
  if new.status = 'failed' and (
    new.provider_action->>'status' is distinct from 'error'
    or new.provider_observed_status <> 'off'
    or new.provider_observed_server_type_id <> (new.quote_snapshot#>>'{source,serverTypeId}')::bigint
    or new.provider_observed_server_type is distinct from new.quote_snapshot#>>'{source,serverType}'
    or new.provider_observed_architecture is distinct from new.quote_snapshot#>>'{source,architecture}'
    or new.provider_observed_cores <> (new.quote_snapshot#>>'{source,cores}')::integer
    or new.provider_observed_memory_gb <> (new.quote_snapshot#>>'{source,memoryGb}')::integer
    or new.provider_observed_advertised_disk_gb <> (new.quote_snapshot#>>'{source,advertisedDiskGb}')::bigint
    or new.provider_observed_cpu_type is distinct from new.quote_snapshot#>>'{source,cpuType}'
    or new.provider_observed_disk_gb <> (new.quote_snapshot->>'existingDiskGb')::bigint
    or new.completed_at < clock_timestamp() - interval '5 seconds'
    or new.completed_at > clock_timestamp() + interval '5 seconds'
  ) then
    raise exception 'Provider resize failure is not reconciled' using errcode = '55006';
  end if;
  if new.status = 'cancelled' and (
    old.status <> 'dispatch_pending' or new.provider_post_attempted_at is not null
    or new.completed_at < clock_timestamp() - interval '5 seconds'
    or new.completed_at > clock_timestamp() + interval '5 seconds'
  ) then
    raise exception 'Provider resize cancellation is not pre-dispatch' using errcode = '55006';
  end if;
  return new;
end;
$$;

create trigger hivra_provider_resize_journal_guard
  before insert or update or delete on public.hivra_provider_resize_operations
  for each row execute function public.guard_hivra_provider_resize_journal();

create function public.guard_hivra_provider_resize_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  j public.hivra_provider_resize_operations%rowtype;
  v_payload jsonb;
begin
  if old.computer_substrate <> 'provider-vm' then return new; end if;
  if old.operation_kind = 'resize' then
    select * into j from public.hivra_provider_resize_operations
      where agent_id = old.id and operation_id = old.operation_id;
    if not found then raise exception 'Provider resize journal is required' using errcode = '55006'; end if;
    if new.operation_id is null and new.operation_kind is null and new.operation_started_at is null and new.operation_payload is null then
      if new.status <> 'stopped'
        or new.desired_state <> (case when old.desired_state = 'deleted' then 'deleted' else 'stopped' end)
        or (j.status = 'succeeded' and (new.cpu <> (j.quote_snapshot#>>'{target,cores}')::numeric
          or new.ram <> (j.quote_snapshot#>>'{target,memoryGb}')::integer))
        or (j.status in ('failed','cancelled') and row(new.cpu,new.ram) is distinct from row(old.cpu,old.ram))
        or j.status not in ('succeeded','failed','cancelled')
      then raise exception 'Verify provider resize before releasing its operation' using errcode = '55006'; end if;
      return new;
    end if;
    if new.desired_state = 'deleted'
      and old.desired_state = 'stopped'
      and row(new.operation_id,new.operation_kind,new.operation_started_at,new.operation_payload,new.status,new.cpu,new.ram)
        is not distinct from row(old.operation_id,old.operation_kind,old.operation_started_at,old.operation_payload,old.status,old.cpu,old.ram)
    then return new; end if;
    if row(new.operation_id,new.operation_kind,new.operation_started_at,new.operation_payload,new.status,
        new.desired_state,new.cpu,new.ram)
      is distinct from row(old.operation_id,old.operation_kind,old.operation_started_at,old.operation_payload,old.status,
        old.desired_state,old.cpu,old.ram)
    then raise exception 'Retain active provider resize authority' using errcode = '55006'; end if;
    return new;
  end if;
  if new.operation_kind = 'resize' then
    select * into j from public.hivra_provider_resize_operations
      where agent_id = new.id and operation_id = new.operation_id;
    v_payload := jsonb_build_object(
      'quoteFingerprint', j.quote_fingerprint_sha256,
      'sourceServerType', j.quote_snapshot#>>'{source,serverType}',
      'targetServerType', j.quote_snapshot#>>'{target,serverType}',
      'upgradeDisk', false
    );
    if not found or j.user_id <> new.user_id or j.status <> 'dispatch_pending'
      or old.operation_id is not null or old.status <> 'stopped' or old.desired_state <> 'stopped'
      or new.status <> 'provisioning' or new.desired_state <> 'stopped'
      or new.operation_started_at is distinct from j.billing_confirmed_at
      or new.operation_payload is distinct from v_payload
      or row(new.cpu,new.ram) is distinct from row(old.cpu,old.ram)
    then raise exception 'Claim the reviewed provider resize atomically' using errcode = '55006'; end if;
  end if;
  return new;
end;
$$;

create trigger hivra_agents_provider_resize_guard
  before update on public.hivra_agents
  for each row execute function public.guard_hivra_provider_resize_lifecycle();

create function public.create_hivra_provider_resize_quote(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_connection_id uuid,p_connection_revision bigint,
  p_target_id uuid,p_capacity_order_id uuid,p_enrollment_attempt_id uuid,p_allocation_operation_id uuid,
  p_provider_server_id text,p_plan_fingerprint text,p_quote_fingerprint text,p_quote jsonb,
  p_quote_observed_at timestamptz,p_quote_expires_at timestamptz
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  q public.hivra_provider_resize_operations%rowtype;
  a public.hivra_agents%rowtype;
  o public.infrastructure_capacity_orders%rowtype;
  v_source_shape_fingerprint text;
begin
  if p_operation_id is null or p_plan_fingerprint !~ '^[0-9a-f]{64}$' or p_quote_fingerprint !~ '^[0-9a-f]{64}$'
    or public.hivra_provider_resize_quote_valid(p_quote,p_operation_id,p_agent_id,p_provider_server_id,
      p_quote_fingerprint,p_quote_observed_at,p_quote_expires_at) is distinct from true
    or p_quote_observed_at < clock_timestamp() - interval '30 seconds'
    or p_quote_observed_at > clock_timestamp() + interval '5 seconds'
  then return 'conflict'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hivra-provider-resize:' || p_operation_id::text, 0));
  select * into q from public.hivra_provider_resize_operations where operation_id = p_operation_id;
  if found then
    if row(q.user_id,q.agent_id,q.connection_id,q.connection_revision,q.deployment_target_id,q.capacity_order_id,
        q.enrollment_attempt_id,q.allocation_operation_id,q.provider_server_id,q.plan_fingerprint_sha256,
        q.quote_fingerprint_sha256,q.quote_snapshot,q.quote_observed_at,q.quote_expires_at)
      is not distinct from row(p_user_id,p_agent_id,p_connection_id,p_connection_revision,p_target_id,p_capacity_order_id,
        p_enrollment_attempt_id,p_allocation_operation_id,p_provider_server_id,p_plan_fingerprint,
        p_quote_fingerprint,p_quote,p_quote_observed_at,p_quote_expires_at)
    then return 'replay'; end if;
    return 'conflict';
  end if;
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and status='ready' and revision=p_connection_revision for update;
  if not found then return 'conflict'; end if;
  select * into o from public.infrastructure_capacity_orders where id=p_capacity_order_id and user_id=p_user_id
    and connection_id=p_connection_id and active_connection_id=p_connection_id and connection_revision=p_connection_revision
    and provider='hetzner-cloud' and status='created_off' and provider_resource_id=p_provider_server_id
    and provider_creation_receipt->>'serverId'=p_provider_server_id and cleanup_started_at is null
    and cleanup_finished_at is null and detached_at is null for update;
  if not found then return 'conflict'; end if;
  if o.current_server_shape is null then
    if o.current_server_shape_fingerprint_sha256 is not null
      or p_quote->>'location' is distinct from o.quote_snapshot#>>'{location,name}'
      or p_quote#>'{source,serverTypeId}' is distinct from o.quote_snapshot#>'{serverType,id}'
      or p_quote#>>'{source,serverType}' is distinct from o.quote_snapshot#>>'{serverType,name}'
      or p_quote#>>'{source,architecture}' is distinct from o.quote_snapshot#>>'{serverType,architecture}'
      or p_quote#>'{source,cores}' is distinct from o.quote_snapshot#>'{serverType,cores}'
      or p_quote#>'{source,memoryGb}' is distinct from o.quote_snapshot#>'{serverType,memoryGb}'
      or p_quote#>'{source,advertisedDiskGb}' is distinct from o.quote_snapshot#>'{serverType,diskGb}'
      or p_quote#>>'{source,cpuType}' is distinct from o.quote_snapshot#>>'{simpleModePolicy,cpuType}'
      or p_quote->'existingDiskGb' is distinct from o.quote_snapshot#>'{serverType,diskGb}'
    then return 'conflict'; end if;
    v_source_shape_fingerprint:=o.quote_fingerprint_sha256;
  else
    if o.current_server_shape_fingerprint_sha256 is null
      or public.hivra_provider_current_shape_valid(o.current_server_shape,o.id,o.connection_id,o.connection_revision,
        o.provider_resource_id) is distinct from true
      or o.current_server_shape_fingerprint_sha256 is distinct from
        encode(sha256(convert_to(o.current_server_shape::text,'UTF8')),'hex')
      or p_quote->>'location' is distinct from o.quote_snapshot#>>'{location,name}'
      or p_quote#>'{source,serverTypeId}' is distinct from o.current_server_shape#>'{serverType,id}'
      or p_quote#>>'{source,serverType}' is distinct from o.current_server_shape#>>'{serverType,name}'
      or p_quote#>>'{source,architecture}' is distinct from o.current_server_shape#>>'{serverType,architecture}'
      or p_quote#>'{source,cores}' is distinct from o.current_server_shape#>'{serverType,cores}'
      or p_quote#>'{source,memoryGb}' is distinct from o.current_server_shape#>'{serverType,memoryGb}'
      or p_quote#>'{source,advertisedDiskGb}' is distinct from o.current_server_shape#>'{serverType,advertisedDiskGb}'
      or p_quote#>>'{source,cpuType}' is distinct from o.current_server_shape#>>'{serverType,cpuType}'
      or p_quote->'existingDiskGb' is distinct from o.current_server_shape->'primaryDiskGb'
    then return 'conflict'; end if;
    v_source_shape_fingerprint:=o.current_server_shape_fingerprint_sha256;
  end if;
  perform id from public.deployment_targets where id=p_target_id and user_id=p_user_id and connection_id=p_connection_id
    and evidence_connection_revision=p_connection_revision and provider_capacity_order_id=p_capacity_order_id
    and external_id=p_provider_server_id and status='ready' and provider_retired_at is null
    and isolation_class='provider-vm' and supported_isolation_drivers=array['provider-vm']::text[]
    and capabilities @> jsonb_build_object('kind','provider-vm','provider','hetzner-cloud','allocation','exclusive-computer',
      'capacityOrderId',p_capacity_order_id,'enrollmentAttemptId',p_enrollment_attempt_id,'launchReady',true)
    and capabilities#>'{provisioner,configured}'='true'::jsonb
    and capabilities#>'{provisioner,ready}'='true'::jsonb for update;
  if not found then return 'conflict'; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is not null or a.status<>'stopped' or a.desired_state<>'stopped'
    or public.hivra_provider_resize_binding_valid(p_user_id,p_agent_id,p_connection_id,p_connection_revision,p_target_id,
      p_capacity_order_id,p_enrollment_attempt_id,p_allocation_operation_id,p_provider_server_id) is distinct from true
    or a.cpu <> (p_quote#>>'{source,cores}')::numeric or a.ram <> (p_quote#>>'{source,memoryGb}')::integer
  then return 'conflict'; end if;
  insert into public.hivra_provider_resize_operations(operation_id,agent_id,user_id,connection_id,connection_revision,
    deployment_target_id,capacity_order_id,enrollment_attempt_id,allocation_operation_id,provider_server_id,
    source_shape_fingerprint_sha256,status,
    plan_fingerprint_sha256,quote_fingerprint_sha256,quote_snapshot,quote_observed_at,quote_expires_at)
  values(p_operation_id,p_agent_id,p_user_id,p_connection_id,p_connection_revision,p_target_id,p_capacity_order_id,
    p_enrollment_attempt_id,p_allocation_operation_id,p_provider_server_id,v_source_shape_fingerprint,'quoted',p_plan_fingerprint,
    p_quote_fingerprint,p_quote,p_quote_observed_at,p_quote_expires_at);
  return 'created';
exception when unique_violation then
  return 'conflict';
end;
$$;

create function public.claim_hivra_provider_resize_operation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_quote_fingerprint text,p_billing_confirmation text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  q public.hivra_provider_resize_operations%rowtype;
  a public.hivra_agents%rowtype;
  v_now timestamptz;
begin
  if p_billing_confirmation is distinct from 'Resize this server and accept the new Hetzner billing'
    or p_quote_fingerprint !~ '^[0-9a-f]{64}$' then return 'rejected'; end if;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id;
  if not found or q.quote_fingerprint_sha256<>p_quote_fingerprint then return 'rejected'; end if;
  perform id from public.infrastructure_connections where id=q.connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and status='ready' and revision=q.connection_revision for update;
  if not found then return 'rejected'; end if;
  perform id from public.infrastructure_capacity_orders where id=q.capacity_order_id and user_id=p_user_id
    and active_connection_id=q.connection_id and connection_revision=q.connection_revision
    and status='created_off' and provider_resource_id=q.provider_server_id
    and coalesce(current_server_shape_fingerprint_sha256,quote_fingerprint_sha256)=q.source_shape_fingerprint_sha256
    for update;
  if not found then return 'rejected'; end if;
  perform id from public.deployment_targets where id=q.deployment_target_id and user_id=p_user_id
    and connection_id=q.connection_id and evidence_connection_revision=q.connection_revision
    and provider_capacity_order_id=q.capacity_order_id and external_id=q.provider_server_id
    and status='ready' and provider_retired_at is null and capabilities->'launchReady'='true'::jsonb for update;
  if not found then return 'rejected'; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if q.quote_fingerprint_sha256<>p_quote_fingerprint then return 'rejected'; end if;
  if q.status<>'quoted' then return 'observe'; end if;
  if clock_timestamp()>=q.quote_expires_at then return 'expired'; end if;
  if a.operation_id is not null or a.status<>'stopped' or a.desired_state<>'stopped'
    or public.hivra_provider_resize_binding_valid(q.user_id,q.agent_id,q.connection_id,q.connection_revision,
      q.deployment_target_id,q.capacity_order_id,q.enrollment_attempt_id,q.allocation_operation_id,q.provider_server_id)
      is distinct from true
  then return 'rejected'; end if;
  v_now:=clock_timestamp();
  update public.hivra_provider_resize_operations set status='dispatch_pending',billing_confirmed_at=v_now,
    dispatch_not_after=v_now+interval '45 seconds',updated_at=v_now where operation_id=q.operation_id;
  update public.hivra_agents set status='provisioning',desired_state='stopped',operation_id=q.operation_id,
    operation_kind='resize',operation_started_at=v_now,operation_payload=jsonb_build_object(
      'quoteFingerprint',q.quote_fingerprint_sha256,'sourceServerType',q.quote_snapshot#>>'{source,serverType}',
      'targetServerType',q.quote_snapshot#>>'{target,serverType}','upgradeDisk',false),error=null
    where id=a.id;
  return 'dispatch';
end;
$$;

create function public.begin_hivra_provider_resize_dispatch(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare a public.hivra_agents%rowtype; q public.hivra_provider_resize_operations%rowtype; v_now timestamptz;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is distinct from q.operation_id or a.operation_kind<>'resize'
    or a.status<>'provisioning' then return 'rejected'; end if;
  if q.status<>'dispatch_pending' then return 'observe'; end if;
  perform id from public.infrastructure_capacity_orders where id=q.capacity_order_id and user_id=p_user_id
    and provider_resource_id=q.provider_server_id
    and coalesce(current_server_shape_fingerprint_sha256,quote_fingerprint_sha256)=q.source_shape_fingerprint_sha256
    for update;
  if not found then return 'rejected'; end if;
  if a.desired_state='deleted' or a.desired_state<>'stopped' or q.provider_post_attempted_at is not null
    or clock_timestamp()>=q.dispatch_not_after then return 'rejected'; end if;
  v_now:=clock_timestamp();
  update public.hivra_provider_resize_operations set status='request_uncertain',provider_post_attempted_at=v_now,
    updated_at=v_now where operation_id=q.operation_id;
  return 'dispatch';
end;
$$;

create function public.record_hivra_provider_resize_action(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_action jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare q public.hivra_provider_resize_operations%rowtype;
begin
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or q.status not in ('request_uncertain','action_pending','provider_pending','manual_attention')
    or q.provider_post_attempted_at is null
    or public.hivra_provider_resize_action_valid(p_action,q.provider_server_id) is distinct from true
  then return false; end if;
  if q.provider_action is not null and (q.provider_action->'id' is distinct from p_action->'id'
    or q.provider_action->>'command' is distinct from p_action->>'command'
    or q.provider_action->'resources' is distinct from p_action->'resources'
    or (q.provider_action->>'status'<>'running' and q.provider_action is distinct from p_action))
  then return false; end if;
  update public.hivra_provider_resize_operations set status='action_pending',provider_action=p_action,
    updated_at=clock_timestamp() where operation_id=q.operation_id;
  return true;
end;
$$;

create function public.record_hivra_provider_resize_observation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_observed_at timestamptz,p_provider_status text,
  p_server_type_id bigint,p_server_type text,p_architecture text,p_cores integer,p_memory_gb integer,
  p_advertised_disk_gb bigint,p_cpu_type text,p_disk_gb bigint,p_stage text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare q public.hivra_provider_resize_operations%rowtype;
begin
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or q.status not in ('request_uncertain','action_pending','provider_pending','manual_attention')
    or p_stage not in ('request_uncertain','action_pending','provider_pending','manual_attention')
    or p_observed_at<clock_timestamp()-interval '30 seconds' or p_observed_at>clock_timestamp()+interval '5 seconds'
    or (q.provider_observed_at is not null and p_observed_at<q.provider_observed_at)
    or coalesce(p_provider_status,'') !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
    or coalesce(p_server_type_id,0) not between 1 and 9007199254740991
    or coalesce(p_server_type,'') !~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$'
    or coalesce(p_architecture,'') not in ('x86','arm')
    or coalesce(p_cores,0) not between 1 and 1024
    or coalesce(p_memory_gb,0) not between 1 and 65536
    or coalesce(p_advertised_disk_gb,0) not between 1 and 9007199254740991
    or coalesce(p_cpu_type,'') not in ('shared','dedicated')
    or coalesce(p_disk_gb,0) not between 1 and 9007199254740991
  then return false; end if;
  update public.hivra_provider_resize_operations set status=p_stage,provider_observed_at=p_observed_at,
    provider_observed_status=p_provider_status,provider_observed_server_type_id=p_server_type_id,
    provider_observed_server_type=p_server_type,provider_observed_architecture=p_architecture,
    provider_observed_cores=p_cores,provider_observed_memory_gb=p_memory_gb,
    provider_observed_advertised_disk_gb=p_advertised_disk_gb,provider_observed_cpu_type=p_cpu_type,
    provider_observed_disk_gb=p_disk_gb,
    updated_at=clock_timestamp() where operation_id=q.operation_id;
  return true;
end;
$$;

create function public.complete_hivra_provider_resize_operation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_observed_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare q public.hivra_provider_resize_operations%rowtype; a public.hivra_agents%rowtype;
  o public.infrastructure_capacity_orders%rowtype;
  v_now timestamptz; v_shape jsonb; v_shape_fingerprint text;
begin
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id;
  if not found then return false; end if;
  perform id from public.infrastructure_connections where id=q.connection_id and user_id=p_user_id for update;
  if not found then return false; end if;
  select * into o from public.infrastructure_capacity_orders where id=q.capacity_order_id and user_id=p_user_id for update;
  if not found then return false; end if;
  perform id from public.deployment_targets where id=q.deployment_target_id and user_id=p_user_id for update;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if q.status='succeeded' then
    return o.current_server_shape_fingerprint_sha256 is not null
      and o.current_server_shape_fingerprint_sha256 = encode(sha256(convert_to(o.current_server_shape::text,'UTF8')),'hex')
      and public.hivra_provider_current_shape_valid(o.current_server_shape,o.id,o.connection_id,o.connection_revision,
        o.provider_resource_id) is true
      and o.current_server_shape->>'resizeOperationId' = q.operation_id::text
      and o.current_server_shape->>'resizeQuoteFingerprintSha256' = q.quote_fingerprint_sha256
      and o.current_server_shape->>'previousShapeFingerprintSha256' = q.source_shape_fingerprint_sha256
      and (o.current_server_shape->>'observedAt')::timestamptz = q.provider_observed_at
      and a.status='stopped' and a.desired_state in ('stopped','deleted')
      and a.operation_id is null and a.operation_kind is null and a.operation_started_at is null
      and a.cpu=(q.quote_snapshot#>>'{target,cores}')::numeric
      and a.ram=(q.quote_snapshot#>>'{target,memoryGb}')::integer;
  end if;
  if q.status not in ('request_uncertain','action_pending','provider_pending','manual_attention')
    or a.operation_id is distinct from q.operation_id or a.operation_kind<>'resize' or a.status<>'provisioning'
    or a.desired_state not in ('stopped','deleted') or q.provider_post_attempted_at is null
    or q.provider_observed_at is distinct from p_observed_at or q.provider_observed_status is distinct from 'off'
    or q.provider_observed_server_type_id is distinct from (q.quote_snapshot#>>'{target,serverTypeId}')::bigint
    or q.provider_observed_server_type is distinct from q.quote_snapshot#>>'{target,serverType}'
    or q.provider_observed_architecture is distinct from q.quote_snapshot#>>'{target,architecture}'
    or q.provider_observed_cores is distinct from (q.quote_snapshot#>>'{target,cores}')::integer
    or q.provider_observed_memory_gb is distinct from (q.quote_snapshot#>>'{target,memoryGb}')::integer
    or q.provider_observed_advertised_disk_gb is distinct from (q.quote_snapshot#>>'{target,advertisedDiskGb}')::bigint
    or q.provider_observed_cpu_type is distinct from q.quote_snapshot#>>'{target,cpuType}'
    or q.provider_observed_disk_gb is distinct from (q.quote_snapshot->>'existingDiskGb')::bigint
    or q.provider_action->>'status'='error'
    or coalesce(o.current_server_shape_fingerprint_sha256,o.quote_fingerprint_sha256)
      is distinct from q.source_shape_fingerprint_sha256
  then return false; end if;
  v_now:=clock_timestamp();
  v_shape:=jsonb_build_object(
    'version',1,'provider','hetzner-cloud','capacityOrderId',q.capacity_order_id,
    'connectionId',q.connection_id,'connectionRevision',q.connection_revision,
    'providerServerId',q.provider_server_id,'resizeOperationId',q.operation_id,
    'resizeQuoteFingerprintSha256',q.quote_fingerprint_sha256,
    'previousShapeFingerprintSha256',q.source_shape_fingerprint_sha256,
    'serverType',jsonb_build_object(
      'id',q.provider_observed_server_type_id,'name',q.provider_observed_server_type,
      'architecture',q.provider_observed_architecture,'cores',q.provider_observed_cores,
      'memoryGb',q.provider_observed_memory_gb,'advertisedDiskGb',q.provider_observed_advertised_disk_gb,
      'cpuType',q.provider_observed_cpu_type),
    'primaryDiskGb',q.provider_observed_disk_gb,'observedAt',q.provider_observed_at
  );
  if public.hivra_provider_current_shape_valid(v_shape,o.id,o.connection_id,o.connection_revision,
      o.provider_resource_id) is distinct from true then return false; end if;
  v_shape_fingerprint:=encode(sha256(convert_to(v_shape::text,'UTF8')),'hex');
  update public.hivra_provider_resize_operations set status='succeeded',completed_at=v_now,updated_at=v_now
    where operation_id=q.operation_id;
  update public.infrastructure_capacity_orders
    set current_server_shape=v_shape,current_server_shape_fingerprint_sha256=v_shape_fingerprint,updated_at=v_now
    where id=o.id and coalesce(current_server_shape_fingerprint_sha256,quote_fingerprint_sha256)
      =q.source_shape_fingerprint_sha256;
  if not found then
    raise exception 'Provider resize successor shape changed during completion' using errcode='55006';
  end if;
  -- `capacity` and `last_preflight_at` remain one coherent historical guest
  -- observation. Provider CPU/RAM/type live on the agent and chained shape
  -- until a genuine guest preflight publishes a new complete snapshot.
  update public.hivra_agents set status='stopped',desired_state=case when desired_state='deleted' then 'deleted' else 'stopped' end,
    cpu=(q.quote_snapshot#>>'{target,cores}')::numeric,ram=(q.quote_snapshot#>>'{target,memoryGb}')::integer,error=null,
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=a.id;
  return true;
end;
$$;

create function public.fail_hivra_provider_resize_operation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_failure_code text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare q public.hivra_provider_resize_operations%rowtype; a public.hivra_agents%rowtype; v_now timestamptz;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or coalesce(p_failure_code,'') !~ '^[a-z][a-z0-9_]{0,63}$' then return false; end if;
  if q.status='failed' then return q.failure_code=p_failure_code; end if;
  if q.status='succeeded'
    or a.operation_id is distinct from q.operation_id or a.operation_kind<>'resize' or a.status<>'provisioning'
    or a.desired_state not in ('stopped','deleted') or q.provider_action->>'status' is distinct from 'error'
    or q.provider_observed_status is distinct from 'off'
    or q.provider_observed_server_type_id is distinct from (q.quote_snapshot#>>'{source,serverTypeId}')::bigint
    or q.provider_observed_server_type is distinct from q.quote_snapshot#>>'{source,serverType}'
    or q.provider_observed_architecture is distinct from q.quote_snapshot#>>'{source,architecture}'
    or q.provider_observed_cores is distinct from (q.quote_snapshot#>>'{source,cores}')::integer
    or q.provider_observed_memory_gb is distinct from (q.quote_snapshot#>>'{source,memoryGb}')::integer
    or q.provider_observed_advertised_disk_gb is distinct from (q.quote_snapshot#>>'{source,advertisedDiskGb}')::bigint
    or q.provider_observed_cpu_type is distinct from q.quote_snapshot#>>'{source,cpuType}'
    or q.provider_observed_disk_gb is distinct from (q.quote_snapshot->>'existingDiskGb')::bigint
  then return false; end if;
  v_now:=clock_timestamp();
  update public.hivra_provider_resize_operations set status='failed',failure_code=p_failure_code,
    completed_at=v_now,updated_at=v_now where operation_id=q.operation_id;
  update public.hivra_agents set status='stopped',desired_state=case when desired_state='deleted' then 'deleted' else 'stopped' end,
    error=null,operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=a.id;
  return true;
end;
$$;

create function public.cancel_hivra_provider_resize_operation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_failure_code text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare q public.hivra_provider_resize_operations%rowtype; a public.hivra_agents%rowtype; v_now timestamptz;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or p_failure_code !~ '^[a-z][a-z0-9_]{0,63}$' or q.status='cancelled' then return q.status='cancelled'; end if;
  if q.status<>'dispatch_pending' or q.provider_post_attempted_at is not null
    or a.operation_id is distinct from q.operation_id or a.operation_kind<>'resize' or a.status<>'provisioning'
    or a.desired_state not in ('stopped','deleted') then return false; end if;
  v_now:=clock_timestamp();
  update public.hivra_provider_resize_operations set status='cancelled',failure_code=p_failure_code,
    completed_at=v_now,updated_at=v_now where operation_id=q.operation_id;
  update public.hivra_agents set status='stopped',desired_state=case when desired_state='deleted' then 'deleted' else 'stopped' end,
    error=null,operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=a.id;
  return true;
end;
$$;

revoke all on function public.hivra_provider_resize_size_valid(jsonb) from public, anon, authenticated;
revoke all on function public.hivra_provider_resize_quote_valid(jsonb,uuid,uuid,text,text,timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.hivra_provider_resize_action_valid(jsonb,text) from public, anon, authenticated;
revoke all on function public.hivra_provider_current_shape_valid(jsonb,uuid,uuid,bigint,text) from public, anon, authenticated;
revoke all on function public.guard_hivra_provider_current_shape() from public, anon, authenticated;
revoke all on function public.hivra_provider_resize_binding_valid(text,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.guard_hivra_provider_resize_journal() from public, anon, authenticated;
revoke all on function public.guard_hivra_provider_resize_lifecycle() from public, anon, authenticated;
revoke all on function public.create_hivra_provider_resize_quote(text,uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text,text,text,jsonb,timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.claim_hivra_provider_resize_operation(text,uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.begin_hivra_provider_resize_dispatch(text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.record_hivra_provider_resize_action(text,uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.record_hivra_provider_resize_observation(text,uuid,uuid,timestamptz,text,bigint,text,text,integer,integer,bigint,text,bigint,text) from public, anon, authenticated;
revoke all on function public.complete_hivra_provider_resize_operation(text,uuid,uuid,timestamptz) from public, anon, authenticated;
revoke all on function public.fail_hivra_provider_resize_operation(text,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.cancel_hivra_provider_resize_operation(text,uuid,uuid,text) from public, anon, authenticated;

grant execute on function public.create_hivra_provider_resize_quote(text,uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text,text,text,jsonb,timestamptz,timestamptz) to service_role;
grant execute on function public.hivra_provider_resize_size_valid(jsonb) to service_role;
grant execute on function public.hivra_provider_resize_quote_valid(jsonb,uuid,uuid,text,text,timestamptz,timestamptz) to service_role;
grant execute on function public.hivra_provider_resize_action_valid(jsonb,text) to service_role;
grant execute on function public.hivra_provider_current_shape_valid(jsonb,uuid,uuid,bigint,text) to service_role;
grant execute on function public.hivra_provider_resize_binding_valid(text,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.claim_hivra_provider_resize_operation(text,uuid,uuid,text,text) to service_role;
grant execute on function public.begin_hivra_provider_resize_dispatch(text,uuid,uuid) to service_role;
grant execute on function public.record_hivra_provider_resize_action(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.record_hivra_provider_resize_observation(text,uuid,uuid,timestamptz,text,bigint,text,text,integer,integer,bigint,text,bigint,text) to service_role;
grant execute on function public.complete_hivra_provider_resize_operation(text,uuid,uuid,timestamptz) to service_role;
grant execute on function public.fail_hivra_provider_resize_operation(text,uuid,uuid,text) to service_role;
grant execute on function public.cancel_hivra_provider_resize_operation(text,uuid,uuid,text) to service_role;
