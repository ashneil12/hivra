-- Canonical Agent/Computer shadow registry.
--
-- Legacy hermes_instances and hivra_agents remain the only write authorities.
-- This migration creates a secret-safe, replayable read model and does not move
-- lifecycle, provider, access, snapshot, event, or credential ownership.

create table public.hivra_canonical_shadow_control (
  singleton boolean primary key default true check (singleton),
  inventory_read_mode text not null default 'legacy'
    check (inventory_read_mode in ('legacy', 'shadow')),
  write_authority text not null default 'legacy'
    check (write_authority = 'legacy'),
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.hivra_canonical_shadow_control(singleton)
values (true);

create table public.hivra_canonical_source_events (
  event_id bigint generated always as identity primary key,
  source_kind text not null check (source_kind in ('hermes', 'hivra')),
  source_id uuid not null,
  source_operation text not null
    check (source_operation in ('insert', 'update', 'delete', 'backfill')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  check ((processed_at is null) or (last_error is null))
);

create unique index hivra_canonical_source_events_backfill_unique
  on public.hivra_canonical_source_events(source_kind, source_id)
  where source_operation = 'backfill';

create index hivra_canonical_source_events_pending_idx
  on public.hivra_canonical_source_events(next_attempt_at, event_id)
  where processed_at is null;

create table public.hivra_canonical_computers (
  id uuid primary key,
  user_id text not null check (length(user_id) between 1 and 256),
  name text not null check (length(btrim(name)) between 1 and 256),
  resource_kind text not null check (resource_kind in ('agent', 'computer')),
  os_profile text check (
    os_profile is null
    or (
      length(os_profile) between 1 and 128
      and os_profile ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    )
  ),
  capacity_kind text check (
    capacity_kind is null
    or capacity_kind in ('pool', 'deployment-target', 'legacy-hermes-host')
  ),
  capacity_id uuid,
  infrastructure_connection_id uuid,
  infrastructure_connection_revision bigint,
  desired_state text not null
    check (desired_state in ('absent', 'running', 'stopped', 'unknown')),
  observed_state text not null
    check (observed_state in (
      'unknown', 'missing', 'provisioning', 'running', 'stopped',
      'suspended', 'deleting', 'error'
    )),
  health_state text not null default 'unknown'
    check (health_state in ('unknown', 'healthy', 'degraded', 'unreachable', 'incompatible')),
  operation_state text check (operation_state in (
    'provisioning', 'starting', 'stopping', 'rebooting', 'resizing',
    'snapshotting', 'restoring', 'deleting', 'failed', 'unknown'
  )),
  operation_id uuid,
  surfaces text[] not null default '{}',
  actions text[] not null default '{}',
  source_status text,
  source_event_id bigint not null
    references public.hivra_canonical_source_events(event_id) on delete restrict,
  tombstoned_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, user_id),
  check ((capacity_kind is null) = (capacity_id is null)),
  check (
    (capacity_kind = 'deployment-target'
      and infrastructure_connection_id is not null
      and infrastructure_connection_revision is not null
      and infrastructure_connection_revision > 0)
    or
    (capacity_kind is distinct from 'deployment-target'
      and infrastructure_connection_id is null
      and infrastructure_connection_revision is null)
  ),
  check (operation_id is null or operation_state is not null),
  check (surfaces <@ array['workspace','files','git','terminal','browser','desktop','native']::text[]),
  check (actions <@ array['provision','start','stop','reboot','delete','resize','snapshot','restore']::text[])
);

create table public.hivra_canonical_agent_identities (
  id uuid primary key,
  user_id text not null check (length(user_id) between 1 and 256),
  name text not null check (length(btrim(name)) between 1 and 256),
  status text not null check (status in ('active', 'archived')),
  source_event_id bigint not null
    references public.hivra_canonical_source_events(event_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, user_id)
);

create table public.hivra_canonical_runtime_installations (
  id uuid primary key,
  user_id text not null check (length(user_id) between 1 and 256),
  computer_id uuid not null,
  runtime_id text not null check (
    length(runtime_id) between 1 and 128
    and runtime_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  status text not null check (status in ('unknown', 'installing', 'ready', 'failed', 'removed')),
  source_event_id bigint not null
    references public.hivra_canonical_source_events(event_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, user_id),
  foreign key (computer_id, user_id)
    references public.hivra_canonical_computers(id, user_id)
    on update restrict on delete restrict
);

create table public.hivra_canonical_primary_bindings (
  id uuid primary key,
  user_id text not null check (length(user_id) between 1 and 256),
  computer_id uuid not null,
  agent_identity_id uuid not null,
  role text not null default 'primary' check (role = 'primary'),
  status text not null check (status in ('active', 'detached')),
  source_event_id bigint not null
    references public.hivra_canonical_source_events(event_id) on delete restrict,
  bound_at timestamptz not null default clock_timestamp(),
  detached_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, user_id),
  foreign key (computer_id, user_id)
    references public.hivra_canonical_computers(id, user_id)
    on update restrict on delete restrict,
  foreign key (agent_identity_id, user_id)
    references public.hivra_canonical_agent_identities(id, user_id)
    on update restrict on delete restrict,
  check ((status = 'active' and detached_at is null) or (status = 'detached' and detached_at is not null))
);

create unique index hivra_canonical_one_active_primary_per_computer
  on public.hivra_canonical_primary_bindings(computer_id)
  where status = 'active';

create table public.hivra_canonical_source_mappings (
  source_kind text not null check (source_kind in ('hermes', 'hivra')),
  source_id uuid not null,
  user_id text not null check (length(user_id) between 1 and 256),
  resource_kind text not null check (resource_kind in ('agent', 'computer')),
  compatibility_alias text not null,
  computer_id uuid not null,
  agent_identity_id uuid,
  runtime_installation_id uuid,
  primary_binding_id uuid,
  first_source_event_id bigint not null
    references public.hivra_canonical_source_events(event_id) on delete restrict,
  last_source_event_id bigint not null
    references public.hivra_canonical_source_events(event_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (source_kind, source_id),
  unique (compatibility_alias),
  unique (computer_id),
  unique (agent_identity_id),
  unique (runtime_installation_id),
  unique (primary_binding_id),
  foreign key (computer_id, user_id)
    references public.hivra_canonical_computers(id, user_id)
    deferrable initially deferred,
  foreign key (agent_identity_id, user_id)
    references public.hivra_canonical_agent_identities(id, user_id)
    deferrable initially deferred,
  foreign key (runtime_installation_id, user_id)
    references public.hivra_canonical_runtime_installations(id, user_id)
    deferrable initially deferred,
  foreign key (primary_binding_id, user_id)
    references public.hivra_canonical_primary_bindings(id, user_id)
    deferrable initially deferred,
  check (
    (source_kind = 'hermes' and compatibility_alias = 'h-' || source_id::text)
    or (source_kind = 'hivra' and compatibility_alias = 'x-' || source_id::text)
  ),
  check (
    (resource_kind = 'computer'
      and agent_identity_id is null
      and runtime_installation_id is null
      and primary_binding_id is null)
    or
    (resource_kind = 'agent'
      and agent_identity_id is not null
      and runtime_installation_id is not null
      and primary_binding_id is not null)
  ),
  check (last_source_event_id >= first_source_event_id)
);

create table public.hivra_canonical_reconciliation_errors (
  event_id bigint primary key references public.hivra_canonical_source_events(event_id) on delete restrict,
  source_kind text not null,
  source_id uuid not null,
  error_code text not null,
  error_detail text not null,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz
);

create function public.hivra_canonical_hermes_event_payload(
  v_row public.hermes_instances
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'userId', v_row.user_id,
    'name', v_row.name,
    'status', v_row.status,
    'lifecycleState', v_row.lifecycle_state,
    'backend', v_row.backend,
    'agentType', v_row.agent_type,
    'hostId', v_row.host_id,
    'poolId', v_row.pool_id,
    'productSurface', v_row.product_surface,
    'infrastructureProvider', v_row.infrastructure_provider,
    'proxmoxNode', v_row.proxmox_node,
    'proxmoxVmid', v_row.proxmox_vmid,
    'cpu', v_row.cpu_limit,
    'ramMb', v_row.ram_limit
  );
$$;

create function public.hivra_canonical_hivra_event_payload(
  v_row public.hivra_agents
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'userId', v_row.user_id,
    'name', v_row.name,
    'status', v_row.status,
    'desiredState', v_row.desired_state,
    'operationId', v_row.operation_id,
    'operationKind', v_row.operation_kind,
    'type', v_row.type,
    'computerProfile', v_row.computer_profile,
    'deploymentMode', v_row.deployment_mode,
    'computerSubstrate', v_row.computer_substrate,
    'poolId', v_row.pool_id,
    'connectionId', v_row.infrastructure_connection_id,
    'connectionRevision', v_row.infrastructure_connection_revision,
    'targetId', v_row.deployment_target_id,
    'capacityOrderId', v_row.provider_capacity_order_id,
    'providerServerId', v_row.provider_server_id,
    'proxmoxHost', v_row.proxmox_host,
    'vmid', v_row.vmid,
    'cpu', v_row.cpu,
    'ramGb', v_row.ram
  );
$$;

create function public.capture_hivra_canonical_hermes_source_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.hermes_instances%rowtype;
  v_event_id bigint;
  v_result text;
  v_mode text;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  insert into public.hivra_canonical_source_events(
    source_kind, source_id, source_operation, payload
  ) values (
    'hermes', v_row.id, lower(tg_op),
    public.hivra_canonical_hermes_event_payload(v_row)
  ) returning event_id into v_event_id;
  v_result := public.apply_hivra_canonical_source_event(v_event_id);
  if v_result not in ('applied', 'superseded', 'already_processed') then
    select inventory_read_mode into v_mode
    from public.hivra_canonical_shadow_control
    where singleton;
    if v_mode = 'shadow' then
      raise exception 'canonical shadow projection rejected the legacy write'
        using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create function public.capture_hivra_canonical_hivra_source_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.hivra_agents%rowtype;
  v_event_id bigint;
  v_result text;
  v_mode text;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  insert into public.hivra_canonical_source_events(
    source_kind, source_id, source_operation, payload
  ) values (
    'hivra', v_row.id, lower(tg_op),
    public.hivra_canonical_hivra_event_payload(v_row)
  ) returning event_id into v_event_id;
  v_result := public.apply_hivra_canonical_source_event(v_event_id);
  if v_result not in ('applied', 'superseded', 'already_processed') then
    select inventory_read_mode into v_mode
    from public.hivra_canonical_shadow_control
    where singleton;
    if v_mode = 'shadow' then
      raise exception 'canonical shadow projection rejected the legacy write'
        using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create function public.hivra_canonical_observed_state(p_status text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select case lower(coalesce(p_status, ''))
    when 'provisioning' then 'provisioning'
    when 'redeploying' then 'provisioning'
    when 'restoring' then 'provisioning'
    when 'running' then 'running'
    when 'stopped' then 'stopped'
    when 'paused' then 'stopped'
    when 'suspended' then 'suspended'
    when 'deleting' then 'deleting'
    when 'deleted' then 'missing'
    when 'error' then 'error'
    when 'failed' then 'error'
    else 'unknown'
  end;
$$;

create function public.hivra_canonical_desired_state(
  p_source_kind text,
  p_payload jsonb,
  p_deleted boolean
)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_deleted then 'absent'
    when p_source_kind = 'hivra' and p_payload ->> 'desiredState' = 'running' then 'running'
    when p_source_kind = 'hivra' and p_payload ->> 'desiredState' = 'stopped' then 'stopped'
    when p_source_kind = 'hermes' and p_payload ->> 'lifecycleState' = 'active' then 'running'
    when p_source_kind = 'hermes' and p_payload ->> 'lifecycleState' in ('paused', 'suspended') then 'stopped'
    when p_source_kind = 'hermes' and p_payload ->> 'lifecycleState' in ('pending', 'provisioning') then 'running'
    else 'unknown'
  end;
$$;

create function public.hivra_canonical_operation_state(
  p_source_kind text,
  p_payload jsonb,
  p_deleted boolean
)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_deleted then null
    when p_source_kind = 'hivra' then case p_payload ->> 'operationKind'
      when 'provision' then 'provisioning'
      when 'start' then 'starting'
      when 'stop' then 'stopping'
      when 'restart' then 'rebooting'
      when 'resize' then 'resizing'
      when 'snapshot' then 'snapshotting'
      when 'restore' then 'restoring'
      when 'delete' then 'deleting'
      else null
    end
    when p_payload ->> 'status' in ('provisioning', 'redeploying') then 'provisioning'
    when p_payload ->> 'status' = 'restoring' then 'restoring'
    else null
  end;
$$;

create function public.hivra_canonical_surfaces(
  p_source_kind text,
  p_payload jsonb,
  p_is_computer boolean,
  p_deleted boolean
)
returns text[]
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select case
    when coalesce(p_deleted, false)
      or lower(btrim(coalesce(p_payload ->> 'status', ''))) <> 'running'
      then '{}'::text[]
    when p_source_kind = 'hermes'
      and lower(btrim(coalesce(p_payload ->> 'backend', ''))) in ('gateway', 'webui')
      then array['workspace','terminal','browser','native']::text[]
    when p_is_computer then array['files','terminal','desktop']::text[]
    when lower(btrim(coalesce(p_payload ->> 'type', ''))) in ('hermes','claude-code','codex','openclaw','agent-zero','deepseek-harness')
      then array['workspace','files','git','terminal']::text[]
    when lower(btrim(coalesce(p_payload ->> 'type', ''))) = 'aeon' then array['workspace']::text[]
    else '{}'::text[]
  end;
$$;

create function public.hivra_canonical_actions(
  p_source_kind text,
  p_payload jsonb,
  p_is_computer boolean,
  p_deleted boolean
)
returns text[]
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select case
    when coalesce(p_deleted, false) then '{}'::text[]
    when p_source_kind = 'hermes'
      and lower(btrim(coalesce(p_payload ->> 'backend', ''))) not in ('gateway', 'webui')
      then '{}'::text[]
    when p_source_kind = 'hermes' and lower(btrim(coalesce(p_payload ->> 'status', ''))) = 'running'
      then array['stop','reboot','delete']::text[]
    when p_source_kind = 'hermes' and lower(btrim(coalesce(p_payload ->> 'status', ''))) in ('stopped','paused','suspended')
      then array['start','delete']::text[]
    when p_source_kind = 'hermes' and lower(btrim(coalesce(p_payload ->> 'status', ''))) in ('provisioning','redeploying','restoring','deleting')
      then array['delete']::text[]
    when p_source_kind = 'hermes' and lower(btrim(coalesce(p_payload ->> 'status', ''))) in ('error','failed')
      then array['start','delete']::text[]
    when p_is_computer
      and lower(btrim(coalesce(p_payload ->> 'computerSubstrate', ''))) = 'proxmox-kvm'
      and lower(btrim(coalesce(p_payload ->> 'status', ''))) = 'running'
      then array['stop','reboot','delete','resize','snapshot','restore']::text[]
    when p_is_computer
      and lower(btrim(coalesce(p_payload ->> 'computerSubstrate', ''))) = 'proxmox-kvm'
      and lower(btrim(coalesce(p_payload ->> 'status', ''))) = 'stopped'
      then array['start','delete','resize','snapshot','restore']::text[]
    when p_is_computer
      and lower(btrim(coalesce(p_payload ->> 'computerSubstrate', ''))) = 'proxmox-kvm'
      and lower(btrim(coalesce(p_payload ->> 'status', ''))) = 'error'
      then array['start','delete','restore']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload ->> 'status', ''))) = 'running'
      then array['stop','reboot','delete']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload ->> 'status', ''))) in ('stopped','error')
      then array['start','delete']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload ->> 'status', ''))) = 'provisioning'
      then array['delete']::text[]
    when p_source_kind = 'hivra'
      and lower(btrim(coalesce(p_payload ->> 'type', ''))) in ('hermes','claude-code','codex','openclaw','agent-zero','deepseek-harness','aeon')
      and lower(btrim(coalesce(p_payload ->> 'status', ''))) in ('provisioning','running','stopped','error')
      then array['delete']::text[]
    else '{}'::text[]
  end;
$$;

create function public.hivra_canonical_installation_status(
  p_status text,
  p_deleted boolean
)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_deleted then 'removed'
    when p_status = 'running' then 'ready'
    when p_status in ('provisioning','redeploying','restoring') then 'installing'
    when p_status in ('error','failed') then 'failed'
    else 'unknown'
  end;
$$;

create function public.apply_hivra_canonical_source_event(p_event_id bigint)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_event public.hivra_canonical_source_events%rowtype;
  v_mapping public.hivra_canonical_source_mappings%rowtype;
  v_user_id text;
  v_name text;
  v_status text;
  v_runtime_id text;
  v_os_profile text;
  v_resource_kind text;
  v_compatibility_alias text;
  v_is_computer boolean;
  v_is_deleted boolean;
  v_capacity_kind text;
  v_capacity_id uuid;
  v_connection_id uuid;
  v_connection_revision bigint;
  v_operation_state text;
  v_operation_id uuid;
  v_agent_identity_id uuid;
  v_runtime_installation_id uuid;
  v_primary_binding_id uuid;
begin
  select * into v_event
  from public.hivra_canonical_source_events
  where event_id = p_event_id
  for update;

  if not found then return 'not_found'; end if;
  if v_event.processed_at is not null then return 'already_processed'; end if;

  -- Serialize every source independently. If a newer event has already won,
  -- retire this one before interpreting any of its (possibly obsolete) data.
  perform pg_advisory_xact_lock(
    hashtextextended('hivra-canonical-shadow:' || v_event.source_kind || ':' || v_event.source_id::text, 0)
  );

  select * into v_mapping
  from public.hivra_canonical_source_mappings
  where source_kind = v_event.source_kind and source_id = v_event.source_id
  for update;

  if found and v_mapping.last_source_event_id > v_event.event_id then
    update public.hivra_canonical_source_events
    set processed_at = clock_timestamp(), last_error = null,
        next_attempt_at = clock_timestamp(),
        attempt_count = attempt_count + 1
    where event_id = v_event.event_id;
    update public.hivra_canonical_reconciliation_errors
    set resolved_at = clock_timestamp(), last_seen_at = clock_timestamp()
    where event_id = v_event.event_id and resolved_at is null;
    return 'superseded';
  end if;

  v_user_id := nullif(btrim(v_event.payload ->> 'userId'), '');
  v_name := nullif(btrim(v_event.payload ->> 'name'), '');
  v_status := lower(nullif(btrim(v_event.payload ->> 'status'), ''));
  if v_user_id is null or length(v_user_id) > 256
    or v_name is null or length(v_name) > 256 then
    raise exception 'invalid owner or name in canonical source event' using errcode = '22023';
  end if;

  v_is_computer := v_event.source_kind = 'hivra'
    and (
      nullif(v_event.payload ->> 'computerProfile', '') is not null
      or coalesce(v_event.payload ->> 'type' = 'linux-desktop', false)
    );
  v_resource_kind := case when v_is_computer then 'computer' else 'agent' end;
  v_compatibility_alias := case v_event.source_kind
    when 'hermes' then 'h-' || v_event.source_id::text
    else 'x-' || v_event.source_id::text
  end;
  v_runtime_id := lower(coalesce(
    nullif(v_event.payload ->> case when v_event.source_kind = 'hermes' then 'agentType' else 'type' end, ''),
    case when v_event.source_kind = 'hermes' then 'hermes' else 'unknown' end
  ));
  if v_runtime_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'invalid runtime id in canonical source event' using errcode = '22023';
  end if;
  v_os_profile := lower(nullif(btrim(v_event.payload ->> 'computerProfile'), ''));
  if v_os_profile is not null and v_os_profile !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'invalid OS profile in canonical source event' using errcode = '22023';
  end if;
  v_is_deleted := coalesce(v_event.source_operation = 'delete', false)
    or coalesce(v_status = 'deleted', false)
    or coalesce(lower(btrim(v_event.payload ->> 'desiredState')) = 'deleted', false)
    or coalesce(lower(btrim(v_event.payload ->> 'lifecycleState')) = 'deleted', false);

  insert into public.hivra_canonical_source_mappings(
    source_kind, source_id, user_id, resource_kind, compatibility_alias,
    computer_id, agent_identity_id, runtime_installation_id, primary_binding_id,
    first_source_event_id, last_source_event_id
  ) values (
    v_event.source_kind, v_event.source_id, v_user_id, v_resource_kind, v_compatibility_alias,
    gen_random_uuid(),
    case when v_is_computer then null else gen_random_uuid() end,
    case when v_is_computer then null else gen_random_uuid() end,
    case when v_is_computer then null else gen_random_uuid() end,
    v_event.event_id, v_event.event_id
  )
  on conflict (source_kind, source_id) do nothing;

  select * into v_mapping
  from public.hivra_canonical_source_mappings
  where source_kind = v_event.source_kind and source_id = v_event.source_id
  for update;

  if v_mapping.user_id is distinct from v_user_id
    or v_mapping.resource_kind is distinct from v_resource_kind
    or v_mapping.compatibility_alias is distinct from v_compatibility_alias then
    raise exception 'canonical source identity changed owner or resource kind' using errcode = '55000';
  end if;
  if v_resource_kind = 'computer' and not (
    v_mapping.agent_identity_id is null
    and v_mapping.runtime_installation_id is null
    and v_mapping.primary_binding_id is null
  ) then
    raise exception 'computer source unexpectedly owns agent relationship ids' using errcode = '55000';
  end if;
  if v_resource_kind = 'agent' and not (
    v_mapping.agent_identity_id is not null
    and v_mapping.runtime_installation_id is not null
    and v_mapping.primary_binding_id is not null
  ) then
    raise exception 'agent source lacks complete relationship ids' using errcode = '55000';
  end if;

  if not v_is_deleted and exists (
    select 1 from public.hivra_canonical_computers
    where id = v_mapping.computer_id and tombstoned_at is not null
  ) then
    raise exception 'canonical tombstone cannot be resurrected' using errcode = '55000';
  end if;

  v_capacity_kind := null;
  v_capacity_id := null;
  v_connection_id := null;
  v_connection_revision := null;
  if v_event.source_kind = 'hivra' and nullif(v_event.payload ->> 'targetId', '') is not null then
    v_capacity_kind := 'deployment-target';
    v_capacity_id := (v_event.payload ->> 'targetId')::uuid;
    v_connection_id := (v_event.payload ->> 'connectionId')::uuid;
    v_connection_revision := (v_event.payload ->> 'connectionRevision')::bigint;
    if v_connection_revision <= 0 then
      raise exception 'invalid deployment target revision in canonical source event' using errcode = '22023';
    end if;
  elsif v_event.source_kind = 'hermes' and nullif(v_event.payload ->> 'hostId', '') is not null then
    v_capacity_kind := 'legacy-hermes-host';
    v_capacity_id := (v_event.payload ->> 'hostId')::uuid;
  elsif nullif(v_event.payload ->> 'poolId', '') is not null then
    v_capacity_kind := 'pool';
    v_capacity_id := (v_event.payload ->> 'poolId')::uuid;
  end if;

  v_operation_state := public.hivra_canonical_operation_state(
    v_event.source_kind, v_event.payload, v_is_deleted
  );
  v_operation_id := case
    when not v_is_deleted and nullif(v_event.payload ->> 'operationId', '') is not null
      then (v_event.payload ->> 'operationId')::uuid
    else null
  end;

  insert into public.hivra_canonical_computers(
    id, user_id, name, resource_kind, os_profile,
    capacity_kind, capacity_id, infrastructure_connection_id,
    infrastructure_connection_revision, desired_state, observed_state,
    health_state, operation_state, operation_id, surfaces, actions,
    source_status, source_event_id, tombstoned_at
  ) values (
    v_mapping.computer_id, v_user_id, v_name, v_resource_kind, v_os_profile,
    v_capacity_kind, v_capacity_id, v_connection_id, v_connection_revision,
    public.hivra_canonical_desired_state(v_event.source_kind, v_event.payload, v_is_deleted),
    case when v_is_deleted then 'missing' else public.hivra_canonical_observed_state(v_status) end,
    'unknown', v_operation_state, v_operation_id,
    public.hivra_canonical_surfaces(v_event.source_kind, v_event.payload, v_is_computer, v_is_deleted),
    public.hivra_canonical_actions(v_event.source_kind, v_event.payload, v_is_computer, v_is_deleted),
    v_status, v_event.event_id,
    case when v_is_deleted then clock_timestamp() else null end
  )
  on conflict (id) do update set
    name = excluded.name,
    os_profile = excluded.os_profile,
    capacity_kind = excluded.capacity_kind,
    capacity_id = excluded.capacity_id,
    infrastructure_connection_id = excluded.infrastructure_connection_id,
    infrastructure_connection_revision = excluded.infrastructure_connection_revision,
    desired_state = excluded.desired_state,
    observed_state = excluded.observed_state,
    health_state = excluded.health_state,
    operation_state = excluded.operation_state,
    operation_id = excluded.operation_id,
    surfaces = excluded.surfaces,
    actions = excluded.actions,
    source_status = excluded.source_status,
    source_event_id = excluded.source_event_id,
    tombstoned_at = excluded.tombstoned_at,
    updated_at = clock_timestamp()
  where excluded.source_event_id > public.hivra_canonical_computers.source_event_id;

  v_agent_identity_id := v_mapping.agent_identity_id;
  v_runtime_installation_id := v_mapping.runtime_installation_id;
  v_primary_binding_id := v_mapping.primary_binding_id;
  if not v_is_computer then
    insert into public.hivra_canonical_agent_identities(
      id, user_id, name, status, source_event_id
    ) values (
      v_agent_identity_id, v_user_id, v_name,
      case when v_is_deleted then 'archived' else 'active' end,
      v_event.event_id
    )
    on conflict (id) do update set
      name = excluded.name,
      status = excluded.status,
      source_event_id = excluded.source_event_id,
      updated_at = clock_timestamp()
    where excluded.source_event_id > public.hivra_canonical_agent_identities.source_event_id;

    insert into public.hivra_canonical_runtime_installations(
      id, user_id, computer_id, runtime_id, status, source_event_id
    ) values (
      v_runtime_installation_id, v_user_id, v_mapping.computer_id, v_runtime_id,
      public.hivra_canonical_installation_status(v_status, v_is_deleted),
      v_event.event_id
    )
    on conflict (id) do update set
      runtime_id = excluded.runtime_id,
      status = excluded.status,
      source_event_id = excluded.source_event_id,
      updated_at = clock_timestamp()
    where excluded.source_event_id > public.hivra_canonical_runtime_installations.source_event_id;

    insert into public.hivra_canonical_primary_bindings(
      id, user_id, computer_id, agent_identity_id, role, status,
      source_event_id, detached_at
    ) values (
      v_primary_binding_id, v_user_id, v_mapping.computer_id, v_agent_identity_id,
      'primary', case when v_is_deleted then 'detached' else 'active' end,
      v_event.event_id, case when v_is_deleted then clock_timestamp() else null end
    )
    on conflict (id) do update set
      status = excluded.status,
      source_event_id = excluded.source_event_id,
      detached_at = excluded.detached_at,
      updated_at = clock_timestamp()
    where excluded.source_event_id > public.hivra_canonical_primary_bindings.source_event_id;
  end if;

  update public.hivra_canonical_source_mappings
  set last_source_event_id = greatest(last_source_event_id, v_event.event_id),
      updated_at = clock_timestamp()
  where source_kind = v_event.source_kind and source_id = v_event.source_id;

  update public.hivra_canonical_source_events
  set processed_at = clock_timestamp(), last_error = null,
      next_attempt_at = clock_timestamp(),
      attempt_count = attempt_count + 1
  where event_id = v_event.event_id;

  update public.hivra_canonical_reconciliation_errors
  set resolved_at = clock_timestamp(), last_seen_at = clock_timestamp()
  where event_id = v_event.event_id and resolved_at is null;
  return 'applied';
exception when others then
  update public.hivra_canonical_source_events
  set attempt_count = attempt_count + 1,
      last_error = left(sqlerrm, 1000),
      next_attempt_at = clock_timestamp() + make_interval(
        secs => least(3600, (5 * power(2, least(attempt_count, 9)))::integer)
      )
  where event_id = p_event_id;
  insert into public.hivra_canonical_reconciliation_errors(
    event_id, source_kind, source_id, error_code, error_detail
  )
  select event_id, source_kind, source_id, sqlstate, left(sqlerrm, 1000)
  from public.hivra_canonical_source_events
  where event_id = p_event_id
  on conflict (event_id) do update set
    error_code = excluded.error_code,
    error_detail = excluded.error_detail,
    last_seen_at = clock_timestamp(),
    resolved_at = null;
  return 'failed';
end;
$$;

create function public.reconcile_hivra_canonical_source_events(
  p_limit integer default 100
)
returns table (
  applied_count integer,
  failed_count integer,
  remaining_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_event_id bigint;
  v_result text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'canonical reconciliation limit must be between 1 and 1000'
      using errcode = '22023';
  end if;

  -- Seed/reconcile/cutover are mutually exclusive administrative operations.
  perform pg_advisory_xact_lock(
    hashtextextended('hivra-canonical-shadow-admin', 0)
  );

  applied_count := 0;
  failed_count := 0;
  for v_event_id in
    select event_id
    from public.hivra_canonical_source_events
    where processed_at is null
      and next_attempt_at <= clock_timestamp()
    order by next_attempt_at, event_id
    for update skip locked
    limit p_limit
  loop
    v_result := public.apply_hivra_canonical_source_event(v_event_id);
    if v_result in ('applied', 'superseded', 'already_processed') then
      applied_count := applied_count + 1;
    else
      failed_count := failed_count + 1;
    end if;
  end loop;

  select count(*) into remaining_count
  from public.hivra_canonical_source_events
  where processed_at is null;
  return next;
end;
$$;

-- Online, bounded source discovery. This only enqueues secret-safe snapshots;
-- the operator must run reconciliation until both remaining counts reach zero.
-- Triggers are installed before the first possible call, so concurrent legacy
-- writes either supersede a seed event or are projected synchronously.
create function public.seed_hivra_canonical_source_events(
  p_limit integer default 100
)
returns table (
  seeded_count integer,
  remaining_source_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_instance public.hermes_instances%rowtype;
  v_agent public.hivra_agents%rowtype;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'canonical seed limit must be between 1 and 1000'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('hivra-canonical-shadow-admin', 0)
  );
  seeded_count := 0;

  for v_instance in
    select instance.*
    from public.hermes_instances instance
    where not exists (
      select 1
      from public.hivra_canonical_source_mappings mapping
      where mapping.source_kind = 'hermes'
        and mapping.source_id = instance.id
    )
      and not exists (
        select 1
        from public.hivra_canonical_source_events event
        where event.source_kind = 'hermes'
          and event.source_id = instance.id
          and event.processed_at is null
      )
    order by instance.id
    for key share skip locked
    limit p_limit
  loop
    insert into public.hivra_canonical_source_events(
      source_kind, source_id, source_operation, payload
    ) values (
      'hermes', v_instance.id, 'backfill',
      public.hivra_canonical_hermes_event_payload(v_instance)
    ) on conflict do nothing;
    if found then seeded_count := seeded_count + 1; end if;
  end loop;

  if seeded_count < p_limit then
    for v_agent in
      select agent.*
      from public.hivra_agents agent
      where not exists (
        select 1
        from public.hivra_canonical_source_mappings mapping
        where mapping.source_kind = 'hivra'
          and mapping.source_id = agent.id
      )
        and not exists (
          select 1
          from public.hivra_canonical_source_events event
          where event.source_kind = 'hivra'
            and event.source_id = agent.id
            and event.processed_at is null
        )
      order by agent.id
      for key share skip locked
      limit (p_limit - seeded_count)
    loop
      insert into public.hivra_canonical_source_events(
        source_kind, source_id, source_operation, payload
      ) values (
        'hivra', v_agent.id, 'backfill',
        public.hivra_canonical_hivra_event_payload(v_agent)
      ) on conflict do nothing;
      if found then seeded_count := seeded_count + 1; end if;
    end loop;
  end if;

  select count(*) into remaining_source_count
  from (
    select instance.id
    from public.hermes_instances instance
    where not exists (
      select 1 from public.hivra_canonical_source_mappings mapping
      where mapping.source_kind = 'hermes' and mapping.source_id = instance.id
    )
    union all
    select agent.id
    from public.hivra_agents agent
    where not exists (
      select 1 from public.hivra_canonical_source_mappings mapping
      where mapping.source_kind = 'hivra' and mapping.source_id = agent.id
    )
  ) unprojected;
  return next;
end;
$$;

create function public.hivra_canonical_shadow_parity()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_legacy_resource_count bigint;
  v_expected_agent_count bigint;
  v_current_mapping_count bigint;
  v_current_computer_count bigint;
  v_current_identity_count bigint;
  v_current_installation_count bigint;
  v_current_binding_count bigint;
  v_projection_mismatch_count bigint;
  v_historical_mismatch_count bigint;
  v_pending_event_count bigint;
  v_error_event_count bigint;
  v_ready boolean;
begin
  with source_rows as (
    select
      'hermes'::text as source_kind,
      instance.id as source_id,
      public.hivra_canonical_hermes_event_payload(instance) as payload,
      false as is_computer,
      null::uuid as operation_id
    from public.hermes_instances instance
    union all
    select
      'hivra'::text,
      agent.id,
      public.hivra_canonical_hivra_event_payload(agent),
      agent.computer_profile is not null or coalesce(agent.type = 'linux-desktop', false),
      agent.operation_id
    from public.hivra_agents agent
  ), expected as (
    select
      source.*,
      nullif(btrim(source.payload ->> 'userId'), '') as user_id,
      nullif(btrim(source.payload ->> 'name'), '') as name,
      lower(nullif(btrim(source.payload ->> 'status'), '')) as source_status,
      case when source.is_computer then 'computer' else 'agent' end as resource_kind,
      case source.source_kind
        when 'hermes' then 'h-' || source.source_id::text
        else 'x-' || source.source_id::text
      end as compatibility_alias,
      lower(nullif(btrim(source.payload ->> 'computerProfile'), '')) as os_profile,
      case
        when source.source_kind = 'hivra' and nullif(source.payload ->> 'targetId', '') is not null
          then 'deployment-target'
        when source.source_kind = 'hermes' and nullif(source.payload ->> 'hostId', '') is not null
          then 'legacy-hermes-host'
        when nullif(source.payload ->> 'poolId', '') is not null then 'pool'
        else null
      end as capacity_kind,
      case
        when source.source_kind = 'hivra' and nullif(source.payload ->> 'targetId', '') is not null
          then (source.payload ->> 'targetId')::uuid
        when source.source_kind = 'hermes' and nullif(source.payload ->> 'hostId', '') is not null
          then (source.payload ->> 'hostId')::uuid
        when nullif(source.payload ->> 'poolId', '') is not null
          then (source.payload ->> 'poolId')::uuid
        else null
      end as capacity_id,
      case
        when source.source_kind = 'hivra' and nullif(source.payload ->> 'targetId', '') is not null
          then (source.payload ->> 'connectionId')::uuid
        else null
      end as connection_id,
      case
        when source.source_kind = 'hivra' and nullif(source.payload ->> 'targetId', '') is not null
          then (source.payload ->> 'connectionRevision')::bigint
        else null
      end as connection_revision,
      coalesce(lower(btrim(source.payload ->> 'status')) = 'deleted', false)
        or coalesce(lower(btrim(source.payload ->> 'desiredState')) = 'deleted', false)
        or coalesce(lower(btrim(source.payload ->> 'lifecycleState')) = 'deleted', false) as is_deleted,
      lower(coalesce(
        nullif(source.payload ->> case when source.source_kind = 'hermes' then 'agentType' else 'type' end, ''),
        case when source.source_kind = 'hermes' then 'hermes' else 'unknown' end
      )) as runtime_id
    from source_rows source
  )
  select
    count(*),
    count(*) filter (where not expected.is_computer),
    count(*) filter (where
      mapping.computer_id is null
      or current_event.event_id is null
      or current_event.source_kind is distinct from expected.source_kind
      or current_event.source_id is distinct from expected.source_id
      or current_event.processed_at is null
      or mapping.user_id is distinct from expected.user_id
      or mapping.resource_kind is distinct from expected.resource_kind
      or mapping.compatibility_alias is distinct from expected.compatibility_alias
      or computer.user_id is distinct from expected.user_id
      or computer.name is distinct from expected.name
      or computer.resource_kind is distinct from expected.resource_kind
      or computer.os_profile is distinct from expected.os_profile
      or computer.capacity_kind is distinct from expected.capacity_kind
      or computer.capacity_id is distinct from expected.capacity_id
      or computer.infrastructure_connection_id is distinct from expected.connection_id
      or computer.infrastructure_connection_revision is distinct from expected.connection_revision
      or computer.desired_state is distinct from public.hivra_canonical_desired_state(
        expected.source_kind, expected.payload, expected.is_deleted
      )
      or computer.observed_state is distinct from case
        when expected.is_deleted then 'missing'
        else public.hivra_canonical_observed_state(expected.source_status)
      end
      or computer.health_state is distinct from 'unknown'
      or computer.operation_state is distinct from public.hivra_canonical_operation_state(
        expected.source_kind, expected.payload, expected.is_deleted
      )
      or computer.operation_id is distinct from case
        when expected.is_deleted then null else expected.operation_id
      end
      or computer.surfaces is distinct from public.hivra_canonical_surfaces(
        expected.source_kind, expected.payload, expected.is_computer, expected.is_deleted
      )
      or computer.actions is distinct from public.hivra_canonical_actions(
        expected.source_kind, expected.payload, expected.is_computer, expected.is_deleted
      )
      or computer.source_status is distinct from expected.source_status
      or (computer.tombstoned_at is not null) is distinct from expected.is_deleted
      or computer.source_event_id is distinct from mapping.last_source_event_id
      or (
        expected.is_computer and (
          mapping.agent_identity_id is not null
          or mapping.runtime_installation_id is not null
          or mapping.primary_binding_id is not null
        )
      )
      or (
        not expected.is_computer and (
          identity.id is null
          or identity.user_id is distinct from expected.user_id
          or identity.name is distinct from expected.name
          or identity.status is distinct from case when expected.is_deleted then 'archived' else 'active' end
          or identity.source_event_id is distinct from mapping.last_source_event_id
          or installation.id is null
          or installation.user_id is distinct from expected.user_id
          or installation.computer_id is distinct from mapping.computer_id
          or installation.runtime_id is distinct from expected.runtime_id
          or installation.status is distinct from public.hivra_canonical_installation_status(
            expected.source_status, expected.is_deleted
          )
          or installation.source_event_id is distinct from mapping.last_source_event_id
          or binding.id is null
          or binding.user_id is distinct from expected.user_id
          or binding.computer_id is distinct from mapping.computer_id
          or binding.agent_identity_id is distinct from mapping.agent_identity_id
          or binding.role is distinct from 'primary'
          or binding.status is distinct from case when expected.is_deleted then 'detached' else 'active' end
          or (binding.detached_at is not null) is distinct from expected.is_deleted
          or binding.source_event_id is distinct from mapping.last_source_event_id
        )
      )
    )
  into
    v_legacy_resource_count,
    v_expected_agent_count,
    v_projection_mismatch_count
  from expected
  left join public.hivra_canonical_source_mappings mapping
    on mapping.source_kind = expected.source_kind
   and mapping.source_id = expected.source_id
  left join public.hivra_canonical_computers computer
    on computer.id = mapping.computer_id
   and computer.user_id = mapping.user_id
  left join public.hivra_canonical_agent_identities identity
    on identity.id = mapping.agent_identity_id
   and identity.user_id = mapping.user_id
  left join public.hivra_canonical_runtime_installations installation
    on installation.id = mapping.runtime_installation_id
   and installation.user_id = mapping.user_id
  left join public.hivra_canonical_primary_bindings binding
    on binding.id = mapping.primary_binding_id
   and binding.user_id = mapping.user_id
  left join public.hivra_canonical_source_events current_event
    on current_event.event_id = mapping.last_source_event_id;

  select count(*) into v_current_mapping_count
  from public.hivra_canonical_source_mappings;
  select count(*) into v_current_computer_count
  from public.hivra_canonical_computers;
  select count(*) into v_current_identity_count
  from public.hivra_canonical_agent_identities;
  select count(*) into v_current_installation_count
  from public.hivra_canonical_runtime_installations;
  select count(*) into v_current_binding_count
  from public.hivra_canonical_primary_bindings;

  -- Mappings retained after a hard legacy delete must be complete tombstones,
  -- never active resources which could leak back into a shadow inventory.
  select count(*) into v_historical_mismatch_count
  from public.hivra_canonical_source_mappings mapping
  left join public.hivra_canonical_computers computer
    on computer.id = mapping.computer_id
   and computer.user_id = mapping.user_id
  left join public.hivra_canonical_agent_identities identity
    on identity.id = mapping.agent_identity_id
   and identity.user_id = mapping.user_id
  left join public.hivra_canonical_runtime_installations installation
    on installation.id = mapping.runtime_installation_id
   and installation.user_id = mapping.user_id
  left join public.hivra_canonical_primary_bindings binding
    on binding.id = mapping.primary_binding_id
   and binding.user_id = mapping.user_id
  left join public.hivra_canonical_source_events event
    on event.event_id = mapping.last_source_event_id
  where not exists (
      select 1 from public.hermes_instances
      where mapping.source_kind = 'hermes' and id = mapping.source_id
    )
    and not exists (
      select 1 from public.hivra_agents
      where mapping.source_kind = 'hivra' and id = mapping.source_id
    )
    and (
      event.event_id is null
      or event.source_kind is distinct from mapping.source_kind
      or event.source_id is distinct from mapping.source_id
      or event.source_operation is distinct from 'delete'
      or computer.id is null
      or computer.user_id is distinct from mapping.user_id
      or computer.resource_kind is distinct from mapping.resource_kind
      or computer.desired_state is distinct from 'absent'
      or computer.observed_state is distinct from 'missing'
      or computer.operation_state is not null
      or computer.operation_id is not null
      or computer.surfaces is distinct from '{}'::text[]
      or computer.actions is distinct from '{}'::text[]
      or computer.source_event_id is distinct from mapping.last_source_event_id
      or computer.tombstoned_at is null
      or (
        mapping.resource_kind = 'agent' and (
          identity.id is null or identity.status is distinct from 'archived'
          or identity.source_event_id is distinct from mapping.last_source_event_id
          or installation.id is null or installation.status is distinct from 'removed'
          or installation.source_event_id is distinct from mapping.last_source_event_id
          or binding.id is null or binding.status is distinct from 'detached'
          or binding.detached_at is null
          or binding.source_event_id is distinct from mapping.last_source_event_id
        )
      )
    );

  select count(*) into v_pending_event_count
  from public.hivra_canonical_source_events
  where processed_at is null;

  select count(*) into v_error_event_count
  from public.hivra_canonical_reconciliation_errors
  where resolved_at is null;

  v_ready :=
    v_projection_mismatch_count = 0
    and v_historical_mismatch_count = 0
    and v_pending_event_count = 0
    and v_error_event_count = 0;

  return jsonb_build_object(
    'ready', v_ready,
    'writeAuthority', 'legacy',
    'legacyResourceCount', v_legacy_resource_count,
    'expectedAgentCount', v_expected_agent_count,
    'currentMappingCount', v_current_mapping_count,
    'currentComputerCount', v_current_computer_count,
    'currentIdentityCount', v_current_identity_count,
    'currentInstallationCount', v_current_installation_count,
    'currentBindingCount', v_current_binding_count,
    'projectionMismatchCount', v_projection_mismatch_count,
    'historicalMismatchCount', v_historical_mismatch_count,
    'pendingEventCount', v_pending_event_count,
    'errorEventCount', v_error_event_count
  );
end;
$$;

create function public.set_hivra_canonical_inventory_read_mode(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_ready boolean;
begin
  if p_mode not in ('legacy', 'shadow') then
    raise exception 'canonical inventory read mode must be legacy or shadow'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('hivra-canonical-shadow-admin', 0)
  );
  perform 1
  from public.hivra_canonical_shadow_control
  where singleton
  for update;
  if not found then
    raise exception 'canonical shadow control row is missing'
      using errcode = '55000';
  end if;

  if p_mode = 'legacy' then
    update public.hivra_canonical_shadow_control
    set inventory_read_mode = 'legacy', updated_at = clock_timestamp()
    where singleton;
    return public.hivra_canonical_shadow_parity()
      || jsonb_build_object('inventoryReadMode', 'legacy');
  end if;

  -- Briefly block new legacy writers while parity is checked and the mode is
  -- flipped. In-flight writers finish first; later writers see shadow mode and
  -- their AFTER trigger fails the legacy mutation if projection cannot apply.
  lock table public.hermes_instances, public.hivra_agents in share mode;

  v_ready := coalesce(
    (public.hivra_canonical_shadow_parity() ->> 'ready')::boolean,
    false
  );
  if p_mode = 'shadow' and not v_ready then
    raise exception 'canonical shadow parity gate is not ready'
      using errcode = '55000';
  end if;

  update public.hivra_canonical_shadow_control
  set inventory_read_mode = 'shadow', updated_at = clock_timestamp()
  where singleton;
  return public.hivra_canonical_shadow_parity()
    || jsonb_build_object('inventoryReadMode', 'shadow');
end;
$$;

alter table public.hivra_canonical_shadow_control enable row level security;
alter table public.hivra_canonical_source_events enable row level security;
alter table public.hivra_canonical_computers enable row level security;
alter table public.hivra_canonical_agent_identities enable row level security;
alter table public.hivra_canonical_runtime_installations enable row level security;
alter table public.hivra_canonical_primary_bindings enable row level security;
alter table public.hivra_canonical_source_mappings enable row level security;
alter table public.hivra_canonical_reconciliation_errors enable row level security;

revoke all on table public.hivra_canonical_shadow_control
  from public, anon, authenticated, service_role;
revoke all on table public.hivra_canonical_source_events
  from public, anon, authenticated, service_role;
revoke all on table public.hivra_canonical_computers
  from public, anon, authenticated, service_role;
revoke all on table public.hivra_canonical_agent_identities
  from public, anon, authenticated, service_role;
revoke all on table public.hivra_canonical_runtime_installations
  from public, anon, authenticated, service_role;
revoke all on table public.hivra_canonical_primary_bindings
  from public, anon, authenticated, service_role;
revoke all on table public.hivra_canonical_source_mappings
  from public, anon, authenticated, service_role;
revoke all on table public.hivra_canonical_reconciliation_errors
  from public, anon, authenticated, service_role;
revoke all on sequence public.hivra_canonical_source_events_event_id_seq
  from public, anon, authenticated, service_role;

grant select on table public.hivra_canonical_shadow_control to service_role;
grant select on table public.hivra_canonical_source_events to service_role;
grant select on table public.hivra_canonical_computers to service_role;
grant select on table public.hivra_canonical_agent_identities to service_role;
grant select on table public.hivra_canonical_runtime_installations to service_role;
grant select on table public.hivra_canonical_primary_bindings to service_role;
grant select on table public.hivra_canonical_source_mappings to service_role;
grant select on table public.hivra_canonical_reconciliation_errors to service_role;

revoke all on function public.hivra_canonical_hermes_event_payload(public.hermes_instances)
  from public, anon, authenticated, service_role;
revoke all on function public.hivra_canonical_hivra_event_payload(public.hivra_agents)
  from public, anon, authenticated, service_role;
revoke all on function public.capture_hivra_canonical_hermes_source_event()
  from public, anon, authenticated, service_role;
revoke all on function public.capture_hivra_canonical_hivra_source_event()
  from public, anon, authenticated, service_role;
revoke all on function public.hivra_canonical_observed_state(text)
  from public, anon, authenticated, service_role;
revoke all on function public.hivra_canonical_desired_state(text, jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hivra_canonical_operation_state(text, jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hivra_canonical_surfaces(text, jsonb, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hivra_canonical_actions(text, jsonb, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hivra_canonical_installation_status(text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.apply_hivra_canonical_source_event(bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.reconcile_hivra_canonical_source_events(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.seed_hivra_canonical_source_events(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hivra_canonical_shadow_parity()
  from public, anon, authenticated, service_role;
revoke all on function public.set_hivra_canonical_inventory_read_mode(text)
  from public, anon, authenticated, service_role;

grant execute on function public.reconcile_hivra_canonical_source_events(integer)
  to service_role;
grant execute on function public.seed_hivra_canonical_source_events(integer)
  to service_role;
grant execute on function public.hivra_canonical_shadow_parity()
  to service_role;
grant execute on function public.set_hivra_canonical_inventory_read_mode(text)
  to service_role;

create trigger hivra_canonical_hermes_source_event
after insert or update or delete on public.hermes_instances
for each row execute function public.capture_hivra_canonical_hermes_source_event();

create trigger hivra_canonical_hivra_source_event
after insert or update or delete on public.hivra_agents
for each row execute function public.capture_hivra_canonical_hivra_source_event();

-- Deliberately do not scan legacy tables inside the migration transaction.
-- Shadow mode remains fail-closed until a service-role operator repeatedly
-- runs seed_hivra_canonical_source_events() and reconciliation, then observes
-- a zero-mismatch parity result.

comment on table public.hivra_canonical_computers is
  'Read-only canonical Computer shadow. Legacy Hermes/Hivra rows retain lifecycle write authority.';
comment on table public.hivra_canonical_source_mappings is
  'Stable source-to-canonical identity map. h-/x- aliases remain compatibility identifiers only.';
comment on function public.set_hivra_canonical_inventory_read_mode(text) is
  'Parity-gated inventory presentation switch. This function never changes lifecycle write authority.';
