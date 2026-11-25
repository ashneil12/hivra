-- Durable Proxmox placement admission.
--
-- Placement used to be a read-modify-write race: the application ranked hosts
-- from one snapshot and the durable row was written later. Two launches (or a
-- launch and a resize) could therefore both observe the last CPU/RAM/disk slot.
-- The authority is now inside the database write transaction. It shares the
-- holder-admission advisory lock, so holder reservations and ordinary paid
-- placement are serialized against each other without changing entitlement,
-- grace, hibernation or disk-backing semantics.

-- Token requalification grace is exactly REQUALIFICATION_GRACE_HOURS. The
-- previous 48-hour literal was a card-payment window leaking into the token
-- path. This does not create any new entitlement: admission qualification and
-- instance access still use their existing product rules.
create or replace function public.holder_admission_current_tier(p_user_id text)
returns text
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select case
      when bool_or(q.tier = 'power') then 'power'
      when count(*) > 0 then 'pro'
      else null
    end
  from public.token_tier_qualifications q
  where q.user_id = p_user_id
    and q.tier in ('pro','power')
    and q.last_suspend_at is null
    and (
      q.currently_eligible
      or (q.last_breach_at is not null and q.last_breach_at >= now() - interval '24 hours')
    )
    and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now());
$$;

-- Account for a resize claim as soon as it is durable. The claim is the
-- scheduler reservation; completion later makes the same size the row's base
-- allocation. greatest() avoids double-counting while the operation is in
-- flight or after completion. Deep-sleep reuse still releases compute only for
-- confirmed hibernation; disk remains charged for every backed row.
create or replace function public.holder_placement_accounting(p_targets text[], p_skip_sleep boolean)
returns table(host_id text, owner_id text, holder boolean, cpu numeric, ram_mb numeric, disk_gb numeric, launching integer, launched_cpu numeric, launched_ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with hosts as (
    select c.host_id, h.placement_skip_deep_sleep
    from public.holder_admission_host_capacity(p_targets) c
    join public.proxmox_hosts h on h.id = c.host_id
  )
  select h.proxmox_node, h.user_id, h.seat_funding = 'holder',
         case when saved.reusable then 0 else h.cpu_limit::numeric end,
         case when saved.reusable then 0 else h.ram_limit::numeric end,
         coalesce(h.disk_size_gb,30)::numeric, 0, h.cpu_limit::numeric, h.ram_limit::numeric
  from public.hermes_instances h join hosts on hosts.host_id = h.proxmox_node
  cross join lateral (select h.seat_funding='holder' and h.lifecycle_state='paused' and h.paused_reason='holder_idle'
    and h.lifecycle_substate='holder_hibernated' and (p_skip_sleep or coalesce(hosts.placement_skip_deep_sleep,false)) as reusable) saved
  where h.lifecycle_state in ('provisioning','active') or
    (h.lifecycle_state='paused' and h.seat_funding='holder' and h.paused_reason='holder_idle')
  union all
  select a.proxmox_host, a.user_id, a.seat_funding = 'holder',
         case when powered.holds_compute then sz.cpu else 0 end,
         case when powered.holds_compute then sz.ram_mb else 0 end,
         40::numeric, case when a.status = 'provisioning' then 1 else 0 end,
         case when a.status in ('running','provisioning') then sz.cpu else 0 end,
         case when a.status in ('running','provisioning') then sz.ram_mb else 0 end
  from public.hivra_agents a join hosts on hosts.host_id = a.proxmox_host
  cross join lateral public.holder_hivra_size(a.cpu,a.ram,a.operation_kind,a.operation_payload) sz
  cross join lateral (select a.status in ('running','provisioning')
    and not (a.sleep_state is not distinct from 'hibernated'
             and (p_skip_sleep or coalesce(hosts.placement_skip_deep_sleep,false))) as holds_compute) powered
  where a.status <> 'deleted' and (a.status in ('running','provisioning') or a.vmid is not null);
$$;

create or replace function public.normalize_proxmox_capacity_scope_id(p_value text)
returns text
language sql immutable strict
as $$
  select nullif(btrim(regexp_replace(lower(p_value), '[^a-z0-9]+', '_', 'g'), '_'),'')
$$;

-- Validate one proposed durable allocation against the same accounting shape
-- used by placement. The lock key is deliberately the holder-admission key:
-- advance_holder_admissions already holds it for the whole reservation batch,
-- and every managed placement write now holds it for its check-and-write.
create or replace function public.assert_proxmox_placement_capacity(
  p_host_id text,
  p_owner_id text,
  p_seat_funding text,
  p_cpu numeric,
  p_ram_mb numeric,
  p_disk_gb numeric default null,
  p_hivra_agent_id uuid default null,
  p_hermes_instance_id uuid default null,
  p_ratio numeric default null,
  p_skip_sleep boolean default false
)
returns void
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_host text;
  v_avail record;
  v_free_cpu numeric;
  v_free_ram numeric;
  v_free_disk numeric;
  v_needed_disk numeric;
  v_disk_sizes jsonb;
  v_powered record;
  v_existing record;
  v_admission record;
  v_remaining_cpu numeric := 0;
  v_remaining_ram numeric := 0;
  v_reservation_disk boolean := false;
  v_old_cpu numeric := 0;
  v_old_ram numeric := 0;
begin
  if p_host_id is null or btrim(p_host_id)=''
    or p_cpu is null or p_ram_mb is null or p_cpu <= 0 or p_ram_mb <= 0
    or p_cpu::text in ('NaN','Infinity','-Infinity')
    or coalesce(p_seat_funding,'paid') not in ('paid','holder') then
    raise exception 'invalid Proxmox placement allocation' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));

  select c.host_id into v_host
  from public.holder_admission_host_capacity(array[p_host_id],p_ratio) c;
  if v_host is null then
    raise exception 'proxmox host is not available for placement' using errcode='P0058';
  end if;

  -- Add back the allocation being replaced. Resize validation must compare the
  -- proposed row with other occupants, not with its own current allocation.
  if p_hivra_agent_id is not null then
    select case when a.status in ('running','provisioning')
                 and not (a.sleep_state='hibernated' and (p_skip_sleep or h.placement_skip_deep_sleep))
                then sz.cpu else 0::numeric end,
           case when a.status in ('running','provisioning')
                 and not (a.sleep_state='hibernated' and (p_skip_sleep or h.placement_skip_deep_sleep))
                then sz.ram_mb else 0::numeric end
      into v_old_cpu, v_old_ram
    from public.hivra_agents a
    join public.proxmox_hosts h on h.id=a.proxmox_host
    cross join lateral public.holder_hivra_size(a.cpu,a.ram,a.operation_kind,a.operation_payload) sz
    where a.id=p_hivra_agent_id and a.proxmox_host=v_host and a.status <> 'deleted'
      and (a.status in ('running','provisioning') or a.vmid is not null);
  elsif p_hermes_instance_id is not null then
    select case when h.lifecycle_state='paused' and h.paused_reason='holder_idle'
                 and h.lifecycle_substate='holder_hibernated'
                 and (p_skip_sleep or hosts.placement_skip_deep_sleep)
                then 0::numeric else h.cpu_limit::numeric end,
           case when h.lifecycle_state='paused' and h.paused_reason='holder_idle'
                 and h.lifecycle_substate='holder_hibernated'
                 and (p_skip_sleep or hosts.placement_skip_deep_sleep)
                then 0::numeric else h.ram_limit::numeric end
      into v_old_cpu, v_old_ram
    from public.hermes_instances h
    join public.proxmox_hosts hosts on hosts.id=h.proxmox_node
    where h.id=p_hermes_instance_id and h.proxmox_node=v_host
      and (h.lifecycle_state in ('provisioning','active')
        or (h.lifecycle_state='paused' and h.seat_funding='holder' and h.paused_reason='holder_idle'));
  end if;
  v_old_cpu := coalesce(v_old_cpu,0);
  v_old_ram := coalesce(v_old_ram,0);

  v_disk_sizes := case when p_disk_gb is null then '{}'::jsonb else jsonb_build_object(
    'defaultDiskGb', p_disk_gb,
    public.normalize_proxmox_capacity_scope_id(v_host), p_disk_gb
  ) end;

  select * into v_avail
  from public.holder_admission_host_availability(
    array[v_host], p_ratio, p_skip_sleep, v_disk_sizes, null
  )
  where host_id=v_host;
  if not found then
    raise exception 'proxmox host is not available for placement' using errcode='P0058';
  end if;

  v_free_cpu := v_avail.free_cpu + v_old_cpu;
  v_free_ram := v_avail.free_ram_mb + v_old_ram;
  v_free_disk := v_avail.free_disk_gb;
  v_needed_disk := v_avail.needed_disk_gb;

  -- A holder launch on its admission host spends the unlaunched remainder of
  -- its reservation. The generic availability result has already charged that
  -- remainder, so hand back only the part this launch consumes. Reservations
  -- on another host are not spendable here and remain fully charged.
  if p_seat_funding='holder' and p_owner_id is not null then
    select * into v_admission
    from public.holder_admissions a
    where a.user_id=p_owner_id and a.state='admitted'
      and public.normalize_proxmox_capacity_scope_id(a.assigned_host_id)=public.normalize_proxmox_capacity_scope_id(v_host);
    if found then
      select * into v_powered from public.holder_admission_powered_usage(p_owner_id,array[v_host],p_skip_sleep);
      v_remaining_cpu := greatest(0,v_admission.reserved_cpu - coalesce(v_powered.cpu,0));
      v_remaining_ram := greatest(0,v_admission.reserved_ram_mb - coalesce(v_powered.ram_mb,0));
      v_free_cpu := v_free_cpu + least(p_cpu,v_remaining_cpu);
      v_free_ram := v_free_ram + least(p_ram_mb,v_remaining_ram);

      select * into v_existing from public.holder_admission_existing_usage(p_owner_id);
      if (v_admission.reserved_cpu > v_existing.cpu or v_admission.reserved_ram_mb > v_existing.ram_mb
          or not exists(select 1 from public.hermes_instances h
             where h.user_id=p_owner_id and h.seat_funding='holder'
               and public.holder_hermes_allocated(h.status,h.lifecycle_state)
               and public.normalize_proxmox_capacity_scope_id(h.proxmox_node)=public.normalize_proxmox_capacity_scope_id(v_host)
           union all
           select 1 from public.hivra_agents a
             where a.user_id=p_owner_id and a.seat_funding='holder' and a.status <> 'deleted'
               and a.vmid is not null
               and public.normalize_proxmox_capacity_scope_id(a.proxmox_host)=public.normalize_proxmox_capacity_scope_id(v_host)))
        and v_remaining_cpu > 0 and v_remaining_ram > 0 then
        v_reservation_disk := true;
      end if;
      if v_reservation_disk and v_free_disk is not null and v_needed_disk is not null then
        v_free_disk := v_free_disk + v_needed_disk;
      end if;
    end if;
  end if;

  if v_free_cpu + 1e-9 < p_cpu or v_free_ram + 1e-9 < p_ram_mb then
    raise exception 'proxmox host does not have enough remaining compute capacity' using errcode='P0058';
  end if;
  if p_disk_gb is not null and v_free_disk is not null and v_needed_disk is not null
    and v_free_disk + 1e-9 < v_needed_disk then
    raise exception 'proxmox host does not have enough remaining disk capacity' using errcode='P0058';
  end if;
end;
$$;

revoke all on function public.assert_proxmox_placement_capacity(text,text,text,numeric,numeric,numeric,uuid,uuid,numeric,boolean)
  from public,anon,authenticated;
grant execute on function public.assert_proxmox_placement_capacity(text,text,text,numeric,numeric,numeric,uuid,uuid,numeric,boolean)
  to service_role;

-- Atomic check-and-insert for Classic rows. The application still chooses a
-- candidate order, but the host assignment becomes durable in this same
-- transaction; a competing launch cannot use a stale pre-insert snapshot.
create or replace function public.insert_hermes_instance(p_row jsonb)
returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_columns text;
  v_unknown integer;
  v_inserted jsonb;
begin
  if jsonb_typeof(p_row) is distinct from 'object' or octet_length(p_row::text)>65536 then
    raise exception 'invalid instance row' using errcode='22023';
  end if;
  select count(*) into v_unknown from jsonb_object_keys(p_row) k
    where not exists(select 1 from pg_attribute where attrelid='public.hermes_instances'::regclass
      and attnum>0 and not attisdropped and attname=k);
  if v_unknown<>0 then
    raise exception 'invalid instance row columns' using errcode='22023';
  end if;

  if p_row->>'infrastructure_provider' = 'proxmox' and nullif(p_row->>'proxmox_node','') is not null then
    perform public.assert_proxmox_placement_capacity(
      p_row->>'proxmox_node', p_row->>'user_id', coalesce(p_row->>'seat_funding','paid'),
      (p_row->>'cpu_limit')::numeric, (p_row->>'ram_limit')::numeric,
      coalesce((p_row->>'disk_size_gb')::numeric,30), null, null, null, false
    );
  end if;

  select string_agg(quote_ident(k), ',' order by k) into v_columns from jsonb_object_keys(p_row) k;
  execute format('insert into public.hermes_instances(%s) select %s from jsonb_populate_record(null::public.hermes_instances,$1) returning to_jsonb(hermes_instances.*)',
    v_columns, v_columns) into v_inserted using p_row;
  return v_inserted;
end;
$$;

revoke all on function public.insert_hermes_instance(jsonb) from public,anon,authenticated;
grant execute on function public.insert_hermes_instance(jsonb) to service_role;

-- Managed Hivra direct inserts use the same host authority before the row is
-- created. Everything else about the prior reviewed writer is unchanged.
create or replace function public.insert_hivra_managed_agent(p_row jsonb, p_agent_limit integer)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_owner text;
  v_count integer;
  v_columns text;
  v_unknown integer;
  v_inserted jsonb;
begin
  if jsonb_typeof(p_row) is distinct from 'object' or octet_length(p_row::text)>65536
    or p_agent_limit is null or p_agent_limit<0 or p_agent_limit>100000
    or jsonb_typeof(p_row->'user_id') is distinct from 'string'
    or p_row->>'deployment_mode' is distinct from 'hivra-managed'
    or coalesce(p_row->>'seat_funding','') not in ('paid','holder')
  then return jsonb_build_object('status','invalid_request'); end if;
  v_owner := p_row->>'user_id';
  if length(v_owner) not between 1 and 256 or btrim(v_owner)='' then
    return jsonb_build_object('status','invalid_request');
  end if;
  select count(*) into v_unknown from jsonb_object_keys(p_row) k
    where not exists(select 1 from pg_attribute where attrelid='public.hivra_agents'::regclass
      and attnum>0 and not attisdropped and attname=k);
  if v_unknown<>0 then return jsonb_build_object('status','invalid_request'); end if;

  perform public.lock_hivra_owner_agent_slots(v_owner);
  v_count := public.hivra_owner_agent_slot_count(v_owner);
  if v_count>=p_agent_limit then
    return jsonb_build_object('status','plan_agent_limit','activeCount',v_count,'limit',p_agent_limit);
  end if;
  if nullif(p_row->>'proxmox_host','') is not null then
    perform public.assert_proxmox_placement_capacity(
      p_row->>'proxmox_host', v_owner, p_row->>'seat_funding',
      (p_row->>'cpu')::numeric, ((p_row->>'ram')::numeric)*1024,
      40, null, null, null, false
    );
  end if;

  select string_agg(quote_ident(k), ',' order by k) into v_columns from jsonb_object_keys(p_row) k;
  perform set_config('hivra.agent_slot_checked','on',true);
  execute format('insert into public.hivra_agents(%s) select %s from jsonb_populate_record(null::public.hivra_agents,$1) returning to_jsonb(hivra_agents.*)',
    v_columns, v_columns) into v_inserted using p_row;
  perform set_config('hivra.agent_slot_checked','off',true);
  return jsonb_build_object('status','inserted','row',v_inserted);
end;
$$;

-- Launch-model reservations write the row inside the nested v2 RPC, so the
-- capacity check must happen in this same transaction before entering it.
create or replace function public.reserve_hivra_launch_model_request_v3(
  p_user_id text,p_request_id uuid,p_fingerprints jsonb,p_model_operation_id uuid,
  p_agent jsonb,p_selection jsonb,p_encrypted_key text,p_agent_limit integer
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_count integer;
  v_result jsonb;
  v_legacy_agent jsonb;
  v_funding text;
begin
  if p_user_id is null or length(p_user_id) not between 1 and 256 or btrim(p_user_id)=''
    or p_agent_limit is null or p_agent_limit<0 or p_agent_limit>100000
    or jsonb_typeof(p_agent) is distinct from 'object'
  then return jsonb_build_object('status','invalid_request'); end if;

  v_funding := p_agent->>'seat_funding';
  if p_agent->>'deployment_mode' = 'hivra-managed' then
    if v_funding is null or v_funding not in ('paid','holder') then
      return jsonb_build_object('status','invalid_request');
    end if;
  elsif v_funding is not null then
    return jsonb_build_object('status','invalid_request');
  end if;
  v_legacy_agent := p_agent - 'seat_funding';

  if p_request_id is not null and exists(select 1 from public.hivra_launch_model_requests
      where user_id=p_user_id and request_id=p_request_id)
    or p_agent->>'deployment_mode' is distinct from 'hivra-managed' then
    return public.reserve_hivra_launch_model_request_v2(p_user_id,p_request_id,p_fingerprints,
      p_model_operation_id,v_legacy_agent,p_selection,p_encrypted_key);
  end if;
  perform public.lock_hivra_owner_agent_slots(p_user_id);
  if p_request_id is not null and exists(select 1 from public.hivra_launch_model_requests
      where user_id=p_user_id and request_id=p_request_id) then
    return public.reserve_hivra_launch_model_request_v2(p_user_id,p_request_id,p_fingerprints,
      p_model_operation_id,v_legacy_agent,p_selection,p_encrypted_key);
  end if;
  v_count := public.hivra_owner_agent_slot_count(p_user_id);
  if v_count>=p_agent_limit then
    return jsonb_build_object('status','plan_agent_limit','activeCount',v_count,'limit',p_agent_limit);
  end if;
  if nullif(p_agent->>'proxmox_host','') is not null then
    perform public.assert_proxmox_placement_capacity(
      p_agent->>'proxmox_host', p_user_id, v_funding,
      (p_agent->>'cpu')::numeric, ((p_agent->>'ram')::numeric)*1024,
      40, null, null, null, false
    );
  end if;
  perform set_config('hivra.agent_slot_checked','on',true);
  v_result := public.reserve_hivra_launch_model_request_v2(p_user_id,p_request_id,p_fingerprints,
    p_model_operation_id,v_legacy_agent,p_selection,p_encrypted_key);
  perform set_config('hivra.agent_slot_checked','off',true);

  if v_result->>'status' = 'reserved' then
    perform set_config('hivra.seat_funding_writer','on',true);
    update public.hivra_agents
      set seat_funding = v_funding
      where id = (v_result->>'agentId')::uuid
        and user_id = p_user_id
        and deployment_mode = 'hivra-managed'
        and seat_funding is null;
    if not found then
      raise exception 'seat funding reservation was not persisted';
    end if;
    perform set_config('hivra.seat_funding_writer','off',true);
  end if;
  return v_result;
end;
$$;

-- Validate a Classic allocation increase in the same transaction that writes
-- it. The patch route uses this before persisting a live resize; batch tier
-- transitions use apply_hermes_tier_allocations below.
create or replace function public.resize_hermes_instance_allocation(
  p_instance_id uuid,
  p_user_id text,
  p_cpu numeric,
  p_ram_mb numeric
)
returns boolean
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_node text;
begin
  select proxmox_node into v_node
  from public.hermes_instances
  where id=p_instance_id and user_id=p_user_id
  for update;
  if v_node is null then return false; end if;
  perform public.assert_proxmox_placement_capacity(
    v_node,p_user_id,'paid',p_cpu,p_ram_mb,null,null,p_instance_id,null,false
  );
  update public.hermes_instances
  set cpu_limit=p_cpu, ram_limit=p_ram_mb
  where id=p_instance_id and user_id=p_user_id;
  return found;
end;
$$;

revoke all on function public.resize_hermes_instance_allocation(uuid,text,numeric,numeric) from public,anon,authenticated;
grant execute on function public.resize_hermes_instance_allocation(uuid,text,numeric,numeric) to service_role;

-- Host-local failover is itself placement. Move the durable row before the
-- next provision attempt so capacity is charged to the host being tried, not
-- to the host that just failed.
create or replace function public.move_hermes_instance_placement(
  p_instance_id uuid,
  p_user_id text,
  p_host_id text,
  p_disk_gb numeric default null
)
returns boolean
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_row public.hermes_instances%rowtype;
begin
  select * into v_row
  from public.hermes_instances
  where id=p_instance_id and user_id=p_user_id
    and infrastructure_provider='proxmox'
  for update;
  if not found then return false; end if;
  perform public.assert_proxmox_placement_capacity(
    p_host_id,p_user_id,coalesce(v_row.seat_funding,'paid'),
    v_row.cpu_limit,v_row.ram_limit,
    coalesce(p_disk_gb,v_row.disk_size_gb,30),null,p_instance_id,null,false
  );
  update public.hermes_instances
  set proxmox_node=p_host_id,
      disk_size_gb=coalesce(p_disk_gb,disk_size_gb)
  where id=p_instance_id and user_id=p_user_id;
  return found;
end;
$$;

revoke all on function public.move_hermes_instance_placement(uuid,text,text,numeric) from public,anon,authenticated;
grant execute on function public.move_hermes_instance_placement(uuid,text,text,numeric) to service_role;

-- Resize claims reserve host capacity before the durable operation is
-- visible to other placements. The rest of the reviewed operation-claim
-- fencing is unchanged.
create or replace function public.claim_hivra_agent_operation(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_operation_kind text,
  p_desired_state text,
  p_operation_payload jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_agent public.hivra_agents%rowtype;
  v_connection_revision bigint;
  v_connection_status text;
  v_target_revision bigint;
  v_target_status text;
  v_target_capabilities jsonb;
  v_target_isolation_class text;
begin
  if p_operation_id is null
    or p_operation_kind not in ('start', 'stop', 'restart', 'resize', 'snapshot', 'restore')
    or p_desired_state not in ('running', 'stopped')
  then
    raise exception 'invalid Hivra operation claim' using errcode = '22023';
  end if;
  if (
    p_operation_kind = 'resize'
    and (
      p_operation_payload is null
      or jsonb_typeof(p_operation_payload) <> 'object'
      or jsonb_typeof(p_operation_payload -> 'cpu') <> 'number'
      or jsonb_typeof(p_operation_payload -> 'ram') <> 'number'
      or (p_operation_payload ->> 'cpu')::numeric <= 0
      or (p_operation_payload ->> 'ram')::integer <= 0
    )
  ) or (
    p_operation_kind in ('snapshot', 'restore')
    and (
      p_operation_payload is null
      or jsonb_typeof(p_operation_payload) <> 'object'
      or coalesce(p_operation_payload ->> 'snapshotId', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(p_operation_payload ->> 'providerSnapshotId', '')
        !~ '^hivra_[0-9a-f]{32}$'
    )
  ) or (
    p_operation_kind not in ('resize', 'snapshot', 'restore')
    and p_operation_payload is not null
  ) then
    raise exception 'invalid Hivra operation payload' using errcode = '22023';
  end if;

  select * into v_agent
  from public.hivra_agents
  where id = p_agent_id
    and user_id = p_user_id
  for update;

  if not found
    or v_agent.status = 'deleted'
    or v_agent.desired_state = 'deleted'
    or v_agent.operation_id is not null
  then
    return false;
  end if;

  if p_operation_kind = 'snapshot' and (
    v_agent.status not in ('running', 'stopped')
    or p_desired_state <> v_agent.desired_state
  ) then
    return false;
  end if;
  if p_operation_kind = 'restore' and (
    v_agent.status not in ('running', 'stopped')
    or p_desired_state <> 'stopped'
  ) then
    return false;
  end if;

  if v_agent.deployment_mode = 'self-managed' then
    select revision, status
    into v_connection_revision, v_connection_status
    from public.infrastructure_connections
    where id = v_agent.infrastructure_connection_id
      and user_id = p_user_id
    for key share;

    if not found
      or v_connection_status <> 'ready'
      or v_connection_revision <> v_agent.infrastructure_connection_revision
    then
      return false;
    end if;

    select evidence_connection_revision, status, capabilities, isolation_class
    into v_target_revision, v_target_status, v_target_capabilities, v_target_isolation_class
    from public.deployment_targets
    where id = v_agent.deployment_target_id
      and connection_id = v_agent.infrastructure_connection_id
      and user_id = p_user_id
    for key share;

    if not found
      or v_target_status <> 'ready'
      or v_target_revision <> v_agent.infrastructure_connection_revision
      or not coalesce(v_target_capabilities @> '{"launchReady": true}'::jsonb, false)
      or v_target_isolation_class <> 'hardware-vm'
    then
      return false;
    end if;
  end if;

  if p_operation_kind = 'resize'
    and v_agent.deployment_mode = 'hivra-managed'
    and nullif(v_agent.proxmox_host,'') is not null
  then
    perform public.assert_proxmox_placement_capacity(
      v_agent.proxmox_host,
      v_agent.user_id,
      coalesce(v_agent.seat_funding,'paid'),
      (p_operation_payload->>'cpu')::numeric,
      ((p_operation_payload->>'ram')::numeric)*1024,
      null,
      p_agent_id,
      null,
      null,
      false
    );
  end if;

  update public.hivra_agents
  set desired_state = p_desired_state,
      operation_id = p_operation_id,
      operation_kind = p_operation_kind,
      operation_started_at = now(),
      operation_payload = p_operation_payload
  where id = p_agent_id
    and user_id = p_user_id;
  return true;
end;
$$;
