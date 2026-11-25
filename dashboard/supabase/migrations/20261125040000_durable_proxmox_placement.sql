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
         coalesce(h.disk_size_gb,30)::numeric, case when h.lifecycle_state = 'provisioning' then 1 else 0 end, h.cpu_limit::numeric, h.ram_limit::numeric
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
  p_skip_sleep boolean default false,
  p_allow_inactive_registered_host boolean default false,
  p_allow_empty_registry_host boolean default false
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

  if coalesce(p_seat_funding,'paid') = 'holder' and p_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('holder-seat-funding-v1:' || p_owner_id, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));

  select c.host_id into v_host
  from public.holder_admission_host_capacity(array[p_host_id],p_ratio) c;
  if v_host is null then
    -- Two reviewed legacy placement contracts predate the active-host registry:
    -- Workspace Cloud owns a dedicated host outside the Hivra rotation, and a
    -- genuinely empty registry uses the explicit env-order fallback. Those
    -- callers serialize here, but there is no active registry capacity authority
    -- to validate against. A registered active host never uses this exception:
    -- if the capacity authority rejects it, placement must fail rather than
    -- bypass validation.
    if p_allow_inactive_registered_host and exists (
      select 1 from public.proxmox_hosts h
      where public.holder_admission_normalize_host_id(h.id)=public.holder_admission_normalize_host_id(p_host_id)
        and h.decommissioned_at is null
        and coalesce(h.status,'active') <> 'active'
    ) then
      return;
    end if;
    if p_allow_inactive_registered_host and not exists (
      select 1 from public.proxmox_hosts h
      where public.holder_admission_normalize_host_id(h.id)=public.holder_admission_normalize_host_id(p_host_id)
    ) then
      return;
    end if;
    if p_allow_empty_registry_host and not exists(select 1 from public.proxmox_hosts) then
      return;
    end if;
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

revoke all on function public.assert_proxmox_placement_capacity(text,text,text,numeric,numeric,numeric,uuid,uuid,numeric,boolean,boolean,boolean)
  from public,anon,authenticated;
grant execute on function public.assert_proxmox_placement_capacity(text,text,text,numeric,numeric,numeric,uuid,uuid,numeric,boolean,boolean,boolean)
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
      coalesce((p_row->>'disk_size_gb')::numeric,30), null, null, null, false,
      p_row->>'product_surface' = 'workspace_cloud', true
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
      40, null, null, null, false, false, true
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
      40, null, null, null, false, false, true
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

alter table public.hermes_instances
  add column if not exists resize_operation_id uuid,
  add column if not exists resize_operation_started_at timestamptz,
  add column if not exists resize_previous_cpu numeric,
  add column if not exists resize_previous_ram_mb integer,
  add column if not exists resize_target_cpu numeric,
  add column if not exists resize_target_ram_mb integer,
  add column if not exists resize_host_config_applied_at timestamptz;

-- Validate a Classic allocation increase in the same transaction that writes
-- it. The patch route uses this before persisting a live resize; batch tier
-- transitions use apply_hermes_tier_allocations below.
drop function if exists public.resize_hermes_instance_allocation(uuid,text,numeric,numeric,uuid);
create or replace function public.resize_hermes_instance_allocation(
  p_instance_id uuid,
  p_user_id text,
  p_cpu numeric,
  p_ram_mb numeric,
  p_operation_id uuid
)
returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_row public.hermes_instances%rowtype;
begin
  if p_operation_id is null then
    raise exception 'invalid resize operation' using errcode='22023';
  end if;
  select * into v_row
  from public.hermes_instances
  where id=p_instance_id and user_id=p_user_id
  for update;
  if not found then
    return jsonb_build_object('status','not_found');
  end if;
  if v_row.resize_operation_id is not null then
    if v_row.resize_operation_id = p_operation_id
      and v_row.resize_target_cpu is not distinct from p_cpu
      and v_row.resize_target_ram_mb is not distinct from p_ram_mb then
      return jsonb_build_object(
        'status','reused',
        'operationId',v_row.resize_operation_id,
        'hostConfigApplied',(v_row.resize_host_config_applied_at is not null)
      );
    end if;
    raise exception 'instance resize operation already in progress' using errcode='P0058';
  end if;
  perform public.assert_proxmox_placement_capacity(
    v_row.proxmox_node,p_user_id,coalesce(v_row.seat_funding,'paid'),
    greatest(coalesce(v_row.cpu_limit,p_cpu),p_cpu),
    greatest(coalesce(v_row.ram_limit,p_ram_mb),p_ram_mb),
    null,null,p_instance_id,null,false,
    coalesce(v_row.product_surface,'')='workspace_cloud',true
  );
  update public.hermes_instances
  set resize_operation_id=p_operation_id,
      resize_operation_started_at=now(),
      resize_previous_cpu=v_row.cpu_limit,
      resize_previous_ram_mb=v_row.ram_limit,
      resize_target_cpu=p_cpu,
      resize_target_ram_mb=p_ram_mb,
      resize_host_config_applied_at=null,
      cpu_limit=greatest(coalesce(v_row.cpu_limit,p_cpu),p_cpu),
      ram_limit=greatest(coalesce(v_row.ram_limit,p_ram_mb),p_ram_mb),
      updated_at=now()
  where id=p_instance_id and user_id=p_user_id;
  if not found then
    return jsonb_build_object('status','not_found');
  end if;
  return jsonb_build_object(
    'status','claimed',
    'operationId',p_operation_id,
    'hostConfigApplied',false
  );
end;
$$;

create or replace function public.mark_hermes_instance_resize_host_config_applied(
  p_instance_id uuid,
  p_user_id text,
  p_operation_id uuid
)
returns boolean
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
begin
  update public.hermes_instances
  set resize_host_config_applied_at=now(),
      updated_at=now()
  where id=p_instance_id and user_id=p_user_id
    and resize_operation_id=p_operation_id;
  return found;
end;
$$;

create or replace function public.complete_hermes_instance_resize_allocation(
  p_instance_id uuid,
  p_user_id text,
  p_operation_id uuid
)
returns boolean
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
begin
  update public.hermes_instances
  set cpu_limit=resize_target_cpu,
      ram_limit=resize_target_ram_mb,
      resize_operation_id=null,
      resize_operation_started_at=null,
      resize_previous_cpu=null,
      resize_previous_ram_mb=null,
      resize_target_cpu=null,
      resize_target_ram_mb=null,
      resize_host_config_applied_at=null,
      updated_at=now()
  where id=p_instance_id and user_id=p_user_id
    and resize_operation_id=p_operation_id;
  return found;
end;
$$;

create or replace function public.rollback_hermes_instance_resize_allocation(
  p_instance_id uuid,
  p_user_id text,
  p_operation_id uuid
)
returns boolean
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
begin
  update public.hermes_instances
  set cpu_limit=resize_previous_cpu,
      ram_limit=resize_previous_ram_mb,
      resize_operation_id=null,
      resize_operation_started_at=null,
      resize_previous_cpu=null,
      resize_previous_ram_mb=null,
      resize_target_cpu=null,
      resize_target_ram_mb=null,
      resize_host_config_applied_at=null,
      updated_at=now()
  where id=p_instance_id and user_id=p_user_id
    and resize_operation_id=p_operation_id;
  return found;
end;
$$;

revoke all on function public.resize_hermes_instance_allocation(uuid,text,numeric,numeric,uuid) from public,anon,authenticated;
grant execute on function public.resize_hermes_instance_allocation(uuid,text,numeric,numeric,uuid) to service_role;
revoke all on function public.mark_hermes_instance_resize_host_config_applied(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.mark_hermes_instance_resize_host_config_applied(uuid,text,uuid) to service_role;
revoke all on function public.complete_hermes_instance_resize_allocation(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.complete_hermes_instance_resize_allocation(uuid,text,uuid) to service_role;
revoke all on function public.rollback_hermes_instance_resize_allocation(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.rollback_hermes_instance_resize_allocation(uuid,text,uuid) to service_role;

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
    coalesce(p_disk_gb,v_row.disk_size_gb,30),null,p_instance_id,null,false,
    coalesce(v_row.product_surface,'')='workspace_cloud',true
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

-- Batch tier writes share the placement authority for every allocation
-- increase. Every live Proxmox size change is fenced like a resize: the row
-- keeps the larger allocation on each axis until completion. Reductions
-- therefore do not free capacity before the host mutation is confirmed, and a
-- conflicting resize claim rejects the batch.
create or replace function public.apply_hermes_tier_allocations(
  p_owner text, p_holder boolean, p_tier text, p_changes jsonb
)
returns integer language plpgsql security invoker set search_path=pg_catalog,pg_temp
as $$
declare
  v_change record;
  v_row public.hermes_instances%rowtype;
  v_written integer := 0;
  v_increase boolean;
  v_size_change boolean;
  v_needs_fence boolean;
  v_reconcile boolean;
  v_operation_id uuid;
begin
  if p_holder then
    perform pg_advisory_xact_lock(hashtextextended('holder-seat-funding-v1:' || p_owner, 0));
  end if;
  for v_change in
    select * from jsonb_to_recordset(p_changes) as c(
      id uuid, previous_tier text, previous_cpu numeric, previous_ram integer, cpu_limit numeric, ram_limit integer, operation_id uuid
    )
    order by ((c.cpu_limit > coalesce(c.previous_cpu,0) or c.ram_limit > coalesce(c.previous_ram,0))) asc, c.id
  loop
    select * into v_row
    from public.hermes_instances h
    where h.id=v_change.id and h.user_id=p_owner
      and (h.seat_funding is not distinct from 'holder')=p_holder
      and h.status not in ('deleted','scheduled_for_deletion')
    for update;
    if not found
      or not (v_row.resource_tier is not distinct from v_change.previous_tier)
      or not (v_row.cpu_limit is not distinct from v_change.previous_cpu)
      or not (v_row.ram_limit is not distinct from v_change.previous_ram) then
      raise exception 'tier allocation changed before the update';
    end if;
    v_operation_id := coalesce(v_change.operation_id, gen_random_uuid());
    v_size_change := v_row.cpu_limit is distinct from v_change.cpu_limit
      or v_row.ram_limit is distinct from v_change.ram_limit;
    v_reconcile := false;
    if v_row.resize_operation_id is not null then
      if v_row.resize_operation_id = v_operation_id
        and v_row.resize_target_cpu is not distinct from v_change.cpu_limit
        and v_row.resize_target_ram_mb is not distinct from v_change.ram_limit then
        v_reconcile := true;
      else
        raise exception 'instance resize operation already in progress' using errcode='P0058';
      end if;
    end if;
    v_needs_fence := v_reconcile or (
      nullif(v_row.proxmox_node,'') is not null
      and v_row.lifecycle_state in ('provisioning','active')
      and v_size_change
    );
    v_increase := v_change.cpu_limit > coalesce(v_row.cpu_limit,0)
      or v_change.ram_limit > coalesce(v_row.ram_limit,0);
    if v_increase and v_row.infrastructure_provider='proxmox' and nullif(v_row.proxmox_node,'') is not null then
      perform public.assert_proxmox_placement_capacity(
        v_row.proxmox_node,p_owner,coalesce(v_row.seat_funding,'paid'),
        greatest(coalesce(v_row.cpu_limit,v_change.cpu_limit),v_change.cpu_limit),
        greatest(coalesce(v_row.ram_limit,v_change.ram_limit),v_change.ram_limit),null,null,v_row.id,null,false,
        coalesce(v_row.product_surface,'')='workspace_cloud',true
      );
    end if;
    update public.hermes_instances h
    set resource_tier=p_tier,
        cpu_limit=case when v_needs_fence then greatest(coalesce(v_row.cpu_limit,v_change.cpu_limit),v_change.cpu_limit) else v_change.cpu_limit end,
        ram_limit=case when v_needs_fence then greatest(coalesce(v_row.ram_limit,v_change.ram_limit),v_change.ram_limit) else v_change.ram_limit end,
        updated_at=now(),
        resize_operation_id=case when v_needs_fence then v_operation_id else null end,
        resize_operation_started_at=case
          when v_needs_fence and v_reconcile then v_row.resize_operation_started_at
          when v_needs_fence then now()
          else null end,
        resize_previous_cpu=case
          when v_needs_fence and v_reconcile then v_row.resize_previous_cpu
          when v_needs_fence then v_row.cpu_limit
          else null end,
        resize_previous_ram_mb=case
          when v_needs_fence and v_reconcile then v_row.resize_previous_ram_mb
          when v_needs_fence then v_row.ram_limit
          else null end,
        resize_target_cpu=case when v_needs_fence then v_change.cpu_limit else null end,
        resize_target_ram_mb=case when v_needs_fence then v_change.ram_limit else null end,
        resize_host_config_applied_at=case
          when v_needs_fence and v_reconcile then v_row.resize_host_config_applied_at
          else null end,
        tier_change_pending=case
          when h.lifecycle_state is distinct from 'deleting' and h.lifecycle_state is distinct from 'deleted'
           and (h.cpu_limit is distinct from v_change.cpu_limit or h.ram_limit is distinct from v_change.ram_limit)
          then true else h.tier_change_pending end
    where h.id=v_row.id;
    v_written := v_written + 1;
  end loop;
  if v_written <> jsonb_array_length(p_changes) then
    raise exception 'tier allocation changed before the update';
  end if;
  return v_written;
end;
$$;
revoke all on function public.apply_hermes_tier_allocations(text,boolean,text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_hermes_tier_allocations(text,boolean,text,jsonb) to service_role;

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
      false,
      false,
      true
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
