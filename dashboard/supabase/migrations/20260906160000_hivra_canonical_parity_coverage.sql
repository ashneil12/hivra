-- Complete legacy shadow read-cutover coverage, without changing authority.
-- Retain the original projection/tombstone checks and reject rows the current
-- mapping-based reader cannot represent. Never delete such rows.

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

  v_ready :=
    v_unmapped_computer_count = 0
    and v_unmapped_identity_count = 0
    and v_unmapped_installation_count = 0
    and v_unmapped_binding_count = 0
    and v_projection_mismatch_count = 0
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
