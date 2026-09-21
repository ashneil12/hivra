-- Staged relationship authority transfer. Deliberately NOT granted to application
-- roles until the authority-aware reader and shared guest-operation fence ship.
-- This does not dispatch an installer, change a VM, or transfer lifecycle ownership.

alter table public.hivra_canonical_shadow_control
  drop constraint hivra_canonical_shadow_control_write_authority_check,
  add check (write_authority in ('legacy','mixed'));

create table public.hivra_canonical_authority_commands (
  id uuid primary key,
  user_id text not null,
  computer_id uuid not null,
  expected_source_event_id bigint not null references public.hivra_canonical_source_events(event_id),
  expected_generation bigint not null check (expected_generation > 0),
  generation bigint not null check (generation = expected_generation + 1),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (computer_id,user_id) references public.hivra_canonical_computers(id,user_id),
  unique (computer_id,generation),
  unique (id,user_id,generation),
  unique (id,user_id,computer_id,generation)
);

create table public.hivra_canonical_relationship_authority (
  computer_id uuid primary key,
  user_id text not null,
  write_authority text not null default 'legacy' check (write_authority in ('legacy','canonical')),
  generation bigint not null default 1 check (generation > 0),
  command_id uuid,
  foreign key (computer_id,user_id) references public.hivra_canonical_computers(id,user_id),
  foreign key (command_id,user_id,computer_id,generation) references public.hivra_canonical_authority_commands(id,user_id,computer_id,generation),
  check ((write_authority='legacy' and generation=1 and command_id is null)
    or (write_authority='canonical' and generation>1 and command_id is not null))
);

create table public.hivra_canonical_authority_outbox (
  command_id uuid primary key references public.hivra_canonical_authority_commands(id),
  event_kind text not null default 'relationship_authority_transferred'
    check (event_kind='relationship_authority_transferred'),
  created_at timestamptz not null default clock_timestamp()
);

-- Per-entity epochs are separate from the legacy source-event cursor. A future
-- command must check its entity epoch, not infer it from the computer lifecycle.
do $$
declare entity_table text;
begin
  foreach entity_table in array array['hivra_canonical_computers',
    'hivra_canonical_agent_identities','hivra_canonical_runtime_installations',
    'hivra_canonical_primary_bindings'] loop
    execute format('alter table public.%I
      add column write_authority text not null default ''legacy'' check (write_authority in (''legacy'',''canonical'')),
      add column authority_generation bigint not null default 1 check (authority_generation > 0),
      add column authority_command_id uuid,
      add check ((write_authority=''legacy'' and authority_generation=1 and authority_command_id is null)
        or (write_authority=''canonical'' and authority_generation>1 and authority_command_id is not null))', entity_table);
    if entity_table='hivra_canonical_agent_identities' then
      execute format('alter table public.%I add foreign key (authority_command_id,user_id,authority_generation)
        references public.hivra_canonical_authority_commands(id,user_id,generation)', entity_table);
    else
      execute format('alter table public.%I add foreign key (authority_command_id,user_id,%I,authority_generation)
        references public.hivra_canonical_authority_commands(id,user_id,computer_id,generation)',
        entity_table, case when entity_table='hivra_canonical_computers' then 'id' else 'computer_id' end);
    end if;
  end loop;
end;
$$;

-- Computer lifecycle has no canonical writer in this release.
alter table public.hivra_canonical_computers add check (write_authority='legacy');

create function public.initialize_hivra_canonical_relationship_authority()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
begin
  insert into public.hivra_canonical_relationship_authority(computer_id,user_id)
  values(new.id,new.user_id);
  return new;
end;
$$;

create trigger hivra_canonical_relationship_authority_init
after insert on public.hivra_canonical_computers
for each row execute function public.initialize_hivra_canonical_relationship_authority();
insert into public.hivra_canonical_relationship_authority(computer_id,user_id)
select id,user_id from public.hivra_canonical_computers;

create function public.transfer_hivra_canonical_relationship_authority(
  p_owner text, p_computer_id uuid, p_expected_source_event_id bigint,
  p_expected_generation bigint, p_command_id uuid
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
declare
  m public.hivra_canonical_source_mappings%rowtype;
  a public.hivra_canonical_relationship_authority%rowtype;
  c public.hivra_canonical_authority_commands%rowtype;
  v_payload jsonb;
  v_generation bigint;
  v_count integer;
begin
  if p_owner is null or p_computer_id is null or p_command_id is null
    or p_expected_source_event_id is null or p_expected_source_event_id <= 0
    or p_expected_generation is null or p_expected_generation <= 0 then return null; end if;

  -- Exact completed-command replay needs no fresh mutation or source liveness.
  select * into c from public.hivra_canonical_authority_commands where id=p_command_id;
  if found then
    if c.user_id is distinct from p_owner or c.computer_id is distinct from p_computer_id
      or c.expected_source_event_id is distinct from p_expected_source_event_id
      or c.expected_generation is distinct from p_expected_generation then return null; end if;
    return jsonb_build_object('commandId',c.id,'computerId',c.computer_id,'generation',c.generation,'resumed',true);
  end if;

  -- Serialize administrative read-mode changes with authority transfer. The
  -- old shadow reader cannot remain selected while its epoch becomes obsolete.
  perform pg_advisory_xact_lock(hashtextextended('hivra-canonical-shadow-admin',0));
  perform 1 from public.hivra_canonical_shadow_control
  where singleton and inventory_read_mode='legacy' for update;
  if not found then return null; end if;

  select * into m from public.hivra_canonical_source_mappings
  where computer_id=p_computer_id and user_id=p_owner;
  if not found then return null; end if;

  -- Match the legacy trigger's lock order: source, mapping, computer, then
  -- relationship authority. This is metadata transfer, not a guest-work lease.
  if m.source_kind='hivra' then
    select public.hivra_canonical_hivra_event_payload(source) into v_payload
    from public.hivra_agents source where id=m.source_id and user_id=p_owner
      and status='running' and desired_state='running' and operation_id is null
    for update;
  else
    select public.hivra_canonical_hermes_event_payload(source) into v_payload
    from public.hermes_instances source where id=m.source_id and user_id=p_owner and status='running'
    for update;
  end if;
  if not found then return null; end if;
  select * into m from public.hivra_canonical_source_mappings
  where computer_id=p_computer_id and user_id=p_owner for update;

  -- A concurrent same-command caller may have completed while we waited.
  select * into c from public.hivra_canonical_authority_commands where id=p_command_id;
  if found then
    if c.user_id is distinct from p_owner or c.computer_id is distinct from p_computer_id
      or c.expected_source_event_id is distinct from p_expected_source_event_id
      or c.expected_generation is distinct from p_expected_generation then return null; end if;
    return jsonb_build_object('commandId',c.id,'computerId',c.computer_id,'generation',c.generation,'resumed',true);
  end if;
  if m.last_source_event_id is distinct from p_expected_source_event_id then return null; end if;
  if not exists (select 1 from public.hivra_canonical_source_events
    where event_id=p_expected_source_event_id and processed_at is not null
      and source_kind=m.source_kind and source_id=m.source_id and payload=v_payload)
    or exists (select 1 from public.hivra_canonical_source_events
      where source_kind=m.source_kind and source_id=m.source_id and processed_at is null)
    then return null; end if;

  perform 1 from public.hivra_canonical_computers
  where id=p_computer_id and user_id=p_owner and write_authority='legacy'
    and observed_state='running' and desired_state='running' and operation_state is null
    and operation_id is null and tombstoned_at is null and source_event_id=p_expected_source_event_id
  for update;
  if not found then return null; end if;
  select * into a from public.hivra_canonical_relationship_authority
  where computer_id=p_computer_id and user_id=p_owner for update;
  if not found or a.write_authority <> 'legacy' or a.generation <> p_expected_generation then return null; end if;
  v_generation := a.generation+1;

  insert into public.hivra_canonical_authority_commands(id,user_id,computer_id,
    expected_source_event_id,expected_generation,generation)
  values(p_command_id,p_owner,p_computer_id,p_expected_source_event_id,p_expected_generation,v_generation);

  if m.resource_kind='agent' then
    update public.hivra_canonical_agent_identities
    set write_authority='canonical',authority_generation=v_generation,authority_command_id=p_command_id
    where id=m.agent_identity_id and user_id=p_owner and write_authority='legacy'
      and authority_generation=p_expected_generation and source_event_id=p_expected_source_event_id;
    get diagnostics v_count=row_count;
    if v_count<>1 then raise exception 'agent identity authority mismatch' using errcode='55000'; end if;
    update public.hivra_canonical_runtime_installations
    set write_authority='canonical',authority_generation=v_generation,authority_command_id=p_command_id
    where id=m.runtime_installation_id and computer_id=p_computer_id and user_id=p_owner
      and write_authority='legacy' and authority_generation=p_expected_generation and source_event_id=p_expected_source_event_id;
    get diagnostics v_count=row_count;
    if v_count<>1 then raise exception 'runtime installation authority mismatch' using errcode='55000'; end if;
    update public.hivra_canonical_primary_bindings
    set write_authority='canonical',authority_generation=v_generation,authority_command_id=p_command_id
    where id=m.primary_binding_id and computer_id=p_computer_id and user_id=p_owner
      and agent_identity_id=m.agent_identity_id and write_authority='legacy'
      and authority_generation=p_expected_generation and source_event_id=p_expected_source_event_id;
    get diagnostics v_count=row_count;
    if v_count<>1 then raise exception 'primary binding authority mismatch' using errcode='55000'; end if;
  end if;
  update public.hivra_canonical_relationship_authority
  set write_authority='canonical',generation=v_generation,command_id=p_command_id
  where computer_id=p_computer_id;
  update public.hivra_canonical_shadow_control
  set write_authority='mixed',updated_at=clock_timestamp() where singleton;
  -- Immutable event, not an installer job. No worker is authorized by it.
  insert into public.hivra_canonical_authority_outbox(command_id) values(p_command_id);
  return jsonb_build_object('commandId',p_command_id,'computerId',p_computer_id,'generation',v_generation,'resumed',false);
end;
$$;

alter table public.hivra_canonical_authority_commands enable row level security;
alter table public.hivra_canonical_relationship_authority enable row level security;
alter table public.hivra_canonical_authority_outbox enable row level security;
revoke all on public.hivra_canonical_authority_commands, public.hivra_canonical_relationship_authority,
  public.hivra_canonical_authority_outbox from public,anon,authenticated,service_role;
grant select on public.hivra_canonical_authority_commands, public.hivra_canonical_relationship_authority,
  public.hivra_canonical_authority_outbox to service_role;
revoke all on function public.initialize_hivra_canonical_relationship_authority() from public,anon,authenticated,service_role;
revoke all on function public.transfer_hivra_canonical_relationship_authority(text,uuid,bigint,bigint,uuid)
  from public,anon,authenticated,service_role;

create or replace function public.apply_hivra_canonical_source_event(p_event_id bigint)
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
    -- Do not even attempt a legacy INSERT for a canonically owned row: a
    -- detached identity may now have another active binding elsewhere.
    if not exists (select 1 from public.hivra_canonical_agent_identities
      where id=v_agent_identity_id and write_authority='canonical') then
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
    end if;

    -- Do not even attempt a legacy INSERT for a canonically owned row: a
    -- detached identity may now have another active binding elsewhere.
    if not exists (select 1 from public.hivra_canonical_runtime_installations
      where id=v_runtime_installation_id and write_authority='canonical') then
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
    end if;

    -- Do not even attempt a legacy INSERT for a canonically owned row: a
    -- detached identity may now have another active binding elsewhere.
    if not exists (select 1 from public.hivra_canonical_primary_bindings
      where id=v_primary_binding_id and write_authority='canonical') then
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

create or replace function public.hivra_canonical_shadow_parity()
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
  v_unmapped_computer_count bigint;
  v_unmapped_identity_count bigint;
  v_unmapped_installation_count bigint;
  v_unmapped_binding_count bigint;
  v_unsupported_authority_count bigint;
  v_authority_mismatch_count bigint;
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
          or (identity.write_authority='legacy' and (
            identity.name is distinct from expected.name
            or identity.status is distinct from case when expected.is_deleted then 'archived' else 'active' end
            or identity.source_event_id is distinct from mapping.last_source_event_id
          ))
          or installation.id is null
          or installation.user_id is distinct from expected.user_id
          or installation.computer_id is distinct from mapping.computer_id
          or (installation.write_authority='legacy' and (
            installation.runtime_id is distinct from expected.runtime_id
            or installation.status is distinct from public.hivra_canonical_installation_status(
              expected.source_status, expected.is_deleted
            )
            or installation.source_event_id is distinct from mapping.last_source_event_id
          ))
          or binding.id is null
          or binding.user_id is distinct from expected.user_id
          or binding.computer_id is distinct from mapping.computer_id
          or binding.agent_identity_id is distinct from mapping.agent_identity_id
          or binding.role is distinct from 'primary'
          or (binding.write_authority='legacy' and (
            binding.status is distinct from case when expected.is_deleted then 'detached' else 'active' end
            or (binding.detached_at is not null) is distinct from expected.is_deleted
            or binding.source_event_id is distinct from mapping.last_source_event_id
          ))
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
          identity.id is null
          or (identity.write_authority='legacy' and (identity.status is distinct from 'archived'
            or identity.source_event_id is distinct from mapping.last_source_event_id))
          or installation.id is null
          or (installation.write_authority='legacy' and (installation.status is distinct from 'removed'
            or installation.source_event_id is distinct from mapping.last_source_event_id))
          or binding.id is null
          or (binding.write_authority='legacy' and (binding.status is distinct from 'detached'
            or binding.detached_at is null
            or binding.source_event_id is distinct from mapping.last_source_event_id))
        )
      )
    );

  select count(*) into v_pending_event_count
  from public.hivra_canonical_source_events
  where processed_at is null;

  select count(*) into v_error_event_count
  from public.hivra_canonical_reconciliation_errors
  where resolved_at is null;

  -- The legacy reader traverses mappings, not every canonical table row.
  -- Canonical-only relationships require an authority-aware reader and parity
  -- migration; this legacy gate must not silently hide or admit them.
  select count(*) into v_unmapped_computer_count
  from public.hivra_canonical_computers entity
  where not exists (
    select 1 from public.hivra_canonical_source_mappings mapping
    where mapping.computer_id = entity.id and mapping.user_id = entity.user_id
  );
  select count(*) into v_unmapped_identity_count
  from public.hivra_canonical_agent_identities entity
  where not exists (
    select 1 from public.hivra_canonical_source_mappings mapping
    where mapping.agent_identity_id = entity.id and mapping.user_id = entity.user_id
  );
  select count(*) into v_unmapped_installation_count
  from public.hivra_canonical_runtime_installations entity
  where not exists (
    select 1 from public.hivra_canonical_source_mappings mapping
    where mapping.runtime_installation_id = entity.id and mapping.user_id = entity.user_id
  );
  select count(*) into v_unmapped_binding_count
  from public.hivra_canonical_primary_bindings entity
  where not exists (
    select 1 from public.hivra_canonical_source_mappings mapping
    where mapping.primary_binding_id = entity.id and mapping.user_id = entity.user_id
  );

  select count(*) into v_unsupported_authority_count
  from public.hivra_canonical_relationship_authority where write_authority='canonical';

  select count(*) into v_authority_mismatch_count
  from public.hivra_canonical_source_mappings m
  left join public.hivra_canonical_relationship_authority a on a.computer_id=m.computer_id
  left join public.hivra_canonical_agent_identities identity on identity.id=m.agent_identity_id
  left join public.hivra_canonical_runtime_installations installation on installation.id=m.runtime_installation_id
  left join public.hivra_canonical_primary_bindings binding on binding.id=m.primary_binding_id
  left join public.hivra_canonical_authority_commands command on command.id=a.command_id
  left join public.hivra_canonical_authority_outbox event on event.command_id=a.command_id
  where a.computer_id is null or a.user_id is distinct from m.user_id
    or (a.write_authority='canonical' and (
      command.id is null or command.user_id is distinct from m.user_id
      or command.computer_id is distinct from m.computer_id
      or command.generation is distinct from a.generation or event.command_id is null
    ))
    or (m.resource_kind='agent' and (
      identity.write_authority is distinct from a.write_authority
      or identity.authority_generation is distinct from a.generation
      or identity.authority_command_id is distinct from a.command_id
      or installation.write_authority is distinct from a.write_authority
      or installation.authority_generation is distinct from a.generation
      or installation.authority_command_id is distinct from a.command_id
      or binding.write_authority is distinct from a.write_authority
      or binding.authority_generation is distinct from a.generation
      or binding.authority_command_id is distinct from a.command_id
    ));

  if (select write_authority from public.hivra_canonical_shadow_control where singleton)
    is distinct from (case when v_unsupported_authority_count>0 then 'mixed' else 'legacy' end) then
    v_authority_mismatch_count := v_authority_mismatch_count+1;
  end if;

  v_ready :=
    v_unsupported_authority_count = 0
    and v_authority_mismatch_count = 0
    and v_unmapped_computer_count = 0
    and v_unmapped_identity_count = 0
    and v_unmapped_installation_count = 0
    and v_unmapped_binding_count = 0
    and v_projection_mismatch_count = 0
    and v_historical_mismatch_count = 0
    and v_pending_event_count = 0
    and v_error_event_count = 0;

  return jsonb_build_object(
    'ready', v_ready,
    'writeAuthority', case when v_unsupported_authority_count>0 then 'mixed' else 'legacy' end,
    'unsupportedAuthorityCount', v_unsupported_authority_count,
    'authorityMismatchCount', v_authority_mismatch_count,
    'legacyResourceCount', v_legacy_resource_count,
    'expectedAgentCount', v_expected_agent_count,
    'currentMappingCount', v_current_mapping_count,
    'currentComputerCount', v_current_computer_count,
    'currentIdentityCount', v_current_identity_count,
    'currentInstallationCount', v_current_installation_count,
    'currentBindingCount', v_current_binding_count,
    'unmappedComputerCount', v_unmapped_computer_count,
    'unmappedIdentityCount', v_unmapped_identity_count,
    'unmappedInstallationCount', v_unmapped_installation_count,
    'unmappedBindingCount', v_unmapped_binding_count,
    'projectionMismatchCount', v_projection_mismatch_count,
    'historicalMismatchCount', v_historical_mismatch_count,
    'pendingEventCount', v_pending_event_count,
    'errorEventCount', v_error_event_count
  );
end;
$$;
