-- Preserve the control-plane resource allocation alongside each provider
-- snapshot. Proxmox rollback restores VM CPU/RAM too, so completing restore
-- must atomically return Hivra's recorded allocation to the same values.

alter table public.hivra_agent_snapshots
  add column if not exists source_cpu numeric,
  add column if not exists source_ram integer;

update public.hivra_agent_snapshots snapshots
set source_cpu = agents.cpu,
    source_ram = agents.ram
from public.hivra_agents agents
where snapshots.agent_id = agents.id
  and (snapshots.source_cpu is null or snapshots.source_ram is null);

alter table public.hivra_agent_snapshots
  alter column source_cpu set not null,
  alter column source_ram set not null,
  drop constraint if exists hivra_agent_snapshots_source_resources_check,
  add constraint hivra_agent_snapshots_source_resources_check
    check (source_cpu > 0 and source_ram > 0);

create or replace function public.begin_hivra_agent_snapshot(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_snapshot_id uuid,
  p_provider_snapshot_id text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_agent public.hivra_agents%rowtype;
  v_claimed boolean;
begin
  select * into v_agent
  from public.hivra_agents
  where id = p_agent_id and user_id = p_user_id
  for update;

  if not found
    or v_agent.computer_substrate is distinct from 'proxmox-kvm'
    or not v_agent.infrastructure_binding_token_enforced
    or v_agent.vmid is null
    or v_agent.status not in ('running', 'stopped')
    or v_agent.desired_state <> v_agent.status
    or p_provider_snapshot_id <> ('hivra_' || replace(p_snapshot_id::text, '-', ''))
    or (
      select count(*)
      from public.hivra_agent_snapshots
      where agent_id = p_agent_id
        and user_id = p_user_id
        and status <> 'deleted'
    ) >= 5
  then
    return false;
  end if;

  v_claimed := public.claim_hivra_agent_operation(
    p_user_id,
    p_agent_id,
    p_operation_id,
    'snapshot',
    v_agent.desired_state,
    jsonb_build_object(
      'snapshotId', p_snapshot_id::text,
      'providerSnapshotId', p_provider_snapshot_id
    )
  );
  if not v_claimed then return false; end if;

  insert into public.hivra_agent_snapshots (
    id, user_id, agent_id, provider_snapshot_id, source_deployment_mode,
    source_proxmox_host, source_connection_id, source_target_id,
    source_connection_revision, source_binding_token_hash, source_vmid,
    source_cpu, source_ram, create_operation_id
  ) values (
    p_snapshot_id, p_user_id, p_agent_id, p_provider_snapshot_id,
    v_agent.deployment_mode, v_agent.proxmox_host,
    v_agent.infrastructure_connection_id, v_agent.deployment_target_id,
    v_agent.infrastructure_connection_revision,
    v_agent.infrastructure_binding_token_hash, v_agent.vmid,
    v_agent.cpu, v_agent.ram, p_operation_id
  );
  return true;
end;
$$;

create or replace function public.complete_hivra_agent_snapshot_restore(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_snapshot_id uuid,
  p_snapshot_config_sha256 text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_snapshot public.hivra_agent_snapshots%rowtype;
  v_completed boolean;
begin
  if p_snapshot_config_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid Hivra restore completion evidence' using errcode = '22023';
  end if;

  select * into v_snapshot
  from public.hivra_agent_snapshots
  where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id
    and status = 'restoring' and restore_operation_id = p_operation_id
    and snapshot_config_sha256 = p_snapshot_config_sha256
  for update;
  if not found then return false; end if;

  v_completed := public.complete_hivra_agent_operation(
    p_user_id, p_agent_id, p_operation_id, 'stopped', 'stopped',
    v_snapshot.source_cpu, v_snapshot.source_ram
  );
  if not v_completed then return false; end if;

  update public.hivra_agent_snapshots
  set status = 'ready',
      restore_operation_id = null,
      last_restored_at = now(),
      restore_count = restore_count + 1,
      last_error = null
  where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id
    and status = 'restoring' and restore_operation_id = p_operation_id;
  if not found then
    raise exception 'restore completion lost its durable identity' using errcode = '55000';
  end if;
  return true;
end;
$$;

revoke all on function public.begin_hivra_agent_snapshot(text, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_hivra_agent_snapshot_restore(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.begin_hivra_agent_snapshot(text, uuid, uuid, uuid, text) to service_role;
grant execute on function public.complete_hivra_agent_snapshot_restore(text, uuid, uuid, uuid, text) to service_role;
