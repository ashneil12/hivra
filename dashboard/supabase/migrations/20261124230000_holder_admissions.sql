-- Token-holder admissions and waitlist.
--
-- A token qualification is necessary but not sufficient for new hosted-compute
-- access. This migration makes admission durable and service-only: the queue,
-- the capacity reservation and the FIFO transition are database state, not a
-- client assertion. Only holders with evidenced legacy token-funded seats are
-- admitted by the backfill below; every other newly observed qualification
-- enters as waitlisted.

create table if not exists public.holder_admissions (
  user_id text primary key,
  state text not null check (state in ('waitlisted','admitted','released')),
  tier text not null check (tier in ('pro','power')),
  token_key text,
  queued_at timestamptz not null default now(),
  admitted_at timestamptz,
  assigned_host_id text,
  reserved_cpu numeric(8,2) not null check (reserved_cpu > 0),
  reserved_ram_mb integer not null check (reserved_ram_mb > 0),
  qualification_checked_at timestamptz,
  grandfathered boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint holder_admissions_admitted_shape check (
    state <> 'admitted' or admitted_at is not null
  )
);

create index if not exists holder_admissions_waitlist_fifo_idx
  on public.holder_admissions (queued_at, user_id)
  where state = 'waitlisted';

alter table public.holder_admissions enable row level security;

comment on table public.holder_admissions is
  'Service-only durable token-holder admission/waitlist state. No client policies: reads go through backend endpoints and writes through service-role RPCs.';

create or replace function public.holder_admission_tier_resources(p_tier text)
returns table(cpu numeric, ram_mb integer)
language sql immutable strict
as $$
  select case p_tier when 'power' then 4::numeric else 2::numeric end,
         case p_tier when 'power' then 8192 else 4096 end;
$$;

-- Paid-access evidence is used ONLY while classifying rows that already
-- existed when this migration was introduced. Runtime holder accounting must
-- not infer funding from the account's current payment state: after a mixed
-- account buys a paid plan, seats already funded by tokens remain in the
-- holder cohort because funding is fixed per seat at provisioning time.
create or replace function public.holder_admission_has_paid_access(p_user_id text)
returns boolean
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select exists (
      select 1 from public.hermes_subscriptions s
      where s.user_id = p_user_id
        and s.plan <> 'free'
        and s.status in ('active','trialing','past_due')
        and coalesce(s.instance_limit, 0) > 0
        and (
          s.status <> 'past_due'
          or s.grace_period_ends_at is null
          or s.grace_period_ends_at > now()
        )
    )
    or exists (
      select 1 from public.apple_iap_subscriptions a
      where a.user_id = p_user_id
        and a.status in ('active','trialing','grace_period')
    )
    or exists (
      select 1 from public.yearly_token_subscriptions y
      where y.user_id = p_user_id
        and y.status in ('active','grace')
    );
$$;

-- Live compute occupied by seats whose own persisted funding is holder.
-- Provisioning rows count as reservations because their VM write is in flight.
-- Rows with null/paid funding never count here, even when the owner currently
-- holds tokens or currently lacks a paid subscription.
create or replace function public.holder_admission_existing_usage(p_user_id text)
returns table(cpu numeric, ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select coalesce(sum(v.cpu), 0)::numeric, coalesce(sum(v.ram_mb), 0)::numeric
  from (
    select a.cpu::numeric as cpu, (a.ram::numeric * 1024) as ram_mb
    from public.hivra_agents a
    where a.user_id = p_user_id
      and a.deployment_mode = 'hivra-managed'
      and a.status in ('provisioning','running')
      and a.seat_funding = 'holder'
    union all
    select h.cpu_limit::numeric as cpu, h.ram_limit::numeric as ram_mb
    from public.hermes_instances h
    where h.user_id = p_user_id
      and h.lifecycle_state in ('provisioning','active')
      and h.seat_funding = 'holder'
  ) v;
$$;

-- Eligible scheduler inventory. This mirrors the registry-backed placement
-- authority: active hosts only, never maintenance/draining/decommissioned
-- inventory; host-reserved cores/RAM and the wake headroom are not scheduler
-- capacity; the host CPU overcommit ratio applies to vCPU only.
create or replace function public.holder_admission_host_capacity()
returns table(
  host_id text,
  cpu numeric,
  ram_mb numeric
)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select h.id,
         greatest((h.total_cpu::numeric - h.reserved_cpu::numeric) * coalesce(h.cpu_overcommit_ratio, 5)::numeric, 0),
         greatest(h.total_ram_mb::numeric - h.reserved_ram_mb::numeric - h.wake_headroom_ram_mb::numeric, 0)
  from public.proxmox_hosts h
  where h.status = 'active'
    and h.decommissioned_at is null
    and h.total_cpu > h.reserved_cpu
    and h.total_ram_mb > h.reserved_ram_mb + h.wake_headroom_ram_mb;
$$;

-- Occupied scheduler resources per host, independent of billing cohort. This
-- deliberately counts concurrent provisioning rows as occupied. It is
-- conservative about sleep state: a stopped/sleeping row still owns its
-- guaranteed placement envelope until the scheduler's normal placement rules
-- reuse it.
create or replace function public.holder_admission_host_usage()
returns table(host_id text, cpu numeric, ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select v.host_id, coalesce(sum(v.cpu), 0)::numeric, coalesce(sum(v.ram_mb), 0)::numeric
  from (
    select a.proxmox_host as host_id, a.cpu::numeric as cpu, (a.ram::numeric * 1024) as ram_mb
    from public.hivra_agents a
    left join public.proxmox_hosts ph on ph.id = a.proxmox_host
    where a.deployment_mode = 'hivra-managed'
      and a.status in ('provisioning','running')
      and not (
        a.sleep_state = 'hibernated'
        and coalesce(ph.placement_skip_deep_sleep, false)
      )
    union all
    select h.proxmox_node as host_id, h.cpu_limit::numeric as cpu, h.ram_limit::numeric as ram_mb
    from public.hermes_instances h
    where h.lifecycle_state in ('provisioning','active')
      and h.proxmox_node is not null
    union all
    select r.assigned_host_id as host_id,
           greatest(r.reserved_cpu - coalesce(u.cpu, 0), 0)::numeric as cpu,
           greatest(r.reserved_ram_mb - coalesce(u.ram_mb, 0), 0)::numeric as ram_mb
    from public.holder_admissions r
    left join public.holder_admission_existing_usage(r.user_id) u on true
    where r.state = 'admitted'
      and r.assigned_host_id is not null
  ) v
  where v.host_id is not null
  group by v.host_id;
$$;

-- The holder-cohort resources charged against the global one-fifth ceiling.
-- An admission reserves the unlaunched remainder of the seat budget; existing
-- compute plus that remainder is exactly max(existing, reservation) per axis.
-- This avoids double-counting a launched admitted seat while retaining an
-- existing holder whose live use already exceeds the current ceiling.
create or replace function public.holder_admission_cohort_usage()
returns table(user_id text, cpu numeric, ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with users as (
    select a.user_id, a.reserved_cpu, a.reserved_ram_mb
    from public.holder_admissions a
    where a.state = 'admitted'
  )
  select c.user_id,
         greatest(coalesce(u.cpu, 0), c.reserved_cpu)::numeric,
         greatest(coalesce(u.ram_mb, 0), c.reserved_ram_mb)::numeric
  from users c
  left join public.holder_admission_existing_usage(c.user_id) u on true;
$$;

-- Insert waitlist rows for currently qualified holders. Idempotent by primary
-- key; a later call updates only the qualification evidence, never queue order.
create or replace function public.sync_holder_admission_candidates()
returns integer
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_inserted integer := 0;
begin
  with ranked as (
    select q.user_id,
           case when bool_or(q.tier = 'power') then 'power' else 'pro' end as tier,
           (array_agg(q.token_key order by q.tier = 'power' desc, q.tier))[1] as token_key
    from public.token_tier_qualifications q
    where q.currently_eligible = true
      and q.tier in ('pro','power')
      and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now())
    group by q.user_id
  ), inserted as (
    insert into public.holder_admissions (
      user_id, state, tier, token_key, reserved_cpu, reserved_ram_mb, qualification_checked_at
    )
    select r.user_id,
           'waitlisted',
           r.tier,
           r.token_key,
           res.cpu,
           res.ram_mb,
           now()
    from ranked r
    cross join lateral public.holder_admission_tier_resources(r.tier) res
    on conflict (user_id) do nothing
    returning 1
  )
  select count(*) into v_inserted from inserted;

  with ranked as (
    select q.user_id,
           case when bool_or(q.tier = 'power') then 'power' else 'pro' end as tier
    from public.token_tier_qualifications q
    where q.currently_eligible = true
      and q.tier in ('pro','power')
      and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now())
    group by q.user_id
  )
  update public.holder_admissions a
  set state = 'waitlisted',
      tier = ranked.tier,
      queued_at = now(),
      admitted_at = null,
      assigned_host_id = null,
      qualification_checked_at = now(),
      updated_at = now()
  from ranked
  where ranked.user_id = a.user_id
    and a.state = 'released';

  update public.holder_admissions a
  set qualification_checked_at = now(),
      updated_at = now()
  where exists (
    select 1 from public.token_tier_qualifications q
    where q.user_id = a.user_id
      and q.currently_eligible = true
      and q.tier in ('pro','power')
  );

  return v_inserted;
end;
$$;

-- Advance the durable FIFO queue. A single advisory lock makes independent
-- service transactions serialize; row updates happen in the same transaction as
-- the capacity accounting, so retries are idempotent and a crashed caller cannot
-- half-advance a seat. Ineligible waiters are skipped. Eligible waiters are
-- strictly FIFO: when the head cannot fit, smaller later seats cannot jump it.
create or replace function public.advance_holder_admissions()
returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_candidate record;
  v_tier text;
  v_reserve_cpu numeric;
  v_reserve_ram_mb integer;
  v_capacity_cpu numeric := 0;
  v_capacity_ram numeric := 0;
  v_used_cpu numeric := 0;
  v_used_ram numeric := 0;
  v_host record;
  v_reservation record;
  v_existing_cpu numeric;
  v_existing_ram numeric;
  v_needed_cpu numeric;
  v_needed_ram numeric;
  v_inserted integer;
  v_released integer := 0;
  v_advanced integer := 0;
  v_skipped_ineligible integer := 0;
  v_blocked boolean := false;
  v_block_reason text := null;
begin
  -- Serialize the whole sync+advance critical section, not merely the state
  -- transition. Two independent service transactions therefore observe the
  -- same queue snapshot and cannot interleave candidate insertion with fit
  -- accounting.
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1', 0));
  v_inserted := public.sync_holder_admission_candidates();

  -- Suspension is the evaluator's authoritative end-of-grace state. A breach
  -- row that is not suspended keeps its reservation through grace; once every
  -- holder-tier row is suspended, release the reservation. The released row is
  -- durable history and returns to the back of the queue only if a later
  -- authoritative evaluation qualifies the holder again.
  with released as (
    update public.holder_admissions a
    set state = 'released',
        assigned_host_id = null,
        qualification_checked_at = now(),
        updated_at = now()
    where a.state = 'admitted'
      and exists (
        select 1 from public.token_tier_qualifications q
        where q.user_id = a.user_id and q.tier in ('pro','power')
      )
      and not exists (
        select 1 from public.token_tier_qualifications q
        where q.user_id = a.user_id
          and q.tier in ('pro','power')
          and q.last_suspend_at is null
          and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now())
      )
    returning 1
  )
  select count(*) into v_released from released;

  -- Reconcile stale or never-assigned reservations before measuring the queue.
  -- Grandfathered rows intentionally start without a host, and an operator can
  -- drain the host after admission. The admission itself stays durable either
  -- way; when there is an unlaunched remainder and a currently eligible host
  -- fits it, move that remainder back onto real inventory so later non-holder
  -- placement cannot consume it. If no host fits, leave the admitted row
  -- unassigned rather than revoking an existing entitlement.
  for v_reservation in
    select a.user_id, a.assigned_host_id, a.reserved_cpu, a.reserved_ram_mb
    from public.holder_admissions a
    where a.state = 'admitted'
    order by a.admitted_at asc nulls first, a.user_id asc
    for update
  loop
    select coalesce(u.cpu, 0), coalesce(u.ram_mb, 0)
      into v_existing_cpu, v_existing_ram
    from public.holder_admission_existing_usage(v_reservation.user_id) u;
    v_needed_cpu := greatest(v_reservation.reserved_cpu - v_existing_cpu, 0);
    v_needed_ram := greatest(v_reservation.reserved_ram_mb - v_existing_ram, 0);

    if v_needed_cpu <= 0 and v_needed_ram <= 0 then
      continue;
    end if;

    if v_reservation.assigned_host_id is not null and exists (
      select 1 from public.holder_admission_host_capacity() h
      where h.host_id = v_reservation.assigned_host_id
    ) then
      continue;
    end if;

    select h.host_id into v_host
    from public.holder_admission_host_capacity() h
    left join public.holder_admission_host_usage() u on u.host_id = h.host_id
    where h.cpu - coalesce(u.cpu, 0) >= v_needed_cpu
      and h.ram_mb - coalesce(u.ram_mb, 0) >= v_needed_ram
    order by (h.cpu - coalesce(u.cpu, 0)) - v_needed_cpu asc,
             (h.ram_mb - coalesce(u.ram_mb, 0)) - v_needed_ram asc,
             h.host_id asc
    limit 1;

    update public.holder_admissions
    set assigned_host_id = v_host.host_id,
        updated_at = now()
    where user_id = v_reservation.user_id
      and state = 'admitted';
  end loop;

  select coalesce(sum(h.cpu), 0), coalesce(sum(h.ram_mb), 0)
    into v_capacity_cpu, v_capacity_ram
  from public.holder_admission_host_capacity() h;

  if v_capacity_cpu <= 0 or v_capacity_ram <= 0 then
    return jsonb_build_object(
      'status','no_eligible_capacity','inserted',v_inserted,
      'advanced',0,'skippedIneligible',0,'released',v_released,
      'capacityCpu',v_capacity_cpu,'capacityRamMb',v_capacity_ram
    );
  end if;

  select coalesce(sum(u.cpu), 0), coalesce(sum(u.ram_mb), 0)
    into v_used_cpu, v_used_ram
  from public.holder_admission_cohort_usage() u;

  for v_candidate in
    select a.*
    from public.holder_admissions a
    where a.state = 'waitlisted'
    order by a.queued_at asc, a.user_id asc
    for update of a
  loop
    select case
        when bool_or(q.tier = 'power') then 'power'
        when count(*) > 0 then 'pro'
        else null
      end
      into v_tier
    from public.token_tier_qualifications q
    where q.user_id = v_candidate.user_id
      and q.currently_eligible = true
      and q.tier in ('pro','power')
      and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now());

    if v_tier is null then
      update public.holder_admissions
      set qualification_checked_at = now(), updated_at = now()
      where user_id = v_candidate.user_id;
      v_skipped_ineligible := v_skipped_ineligible + 1;
      continue;
    end if;

    if v_blocked then
      continue;
    end if;

    select res.cpu, res.ram_mb into v_reserve_cpu, v_reserve_ram_mb
    from public.holder_admission_tier_resources(v_tier) res;

    -- Exact independent one-fifth ceilings. numeric arithmetic keeps half-core
    -- sizes exact; both axes must fit before any state transition is written.
    if v_used_cpu + v_reserve_cpu > (v_capacity_cpu / 5)::numeric
       or v_used_ram + v_reserve_ram_mb > (v_capacity_ram / 5)::numeric then
      v_blocked := true;
      v_block_reason := 'holder_capacity_ceiling';
      continue;
    end if;

    -- Placement fit is per-host, not merely aggregate. Existing non-holder and
    -- holder allocations (including provisioning reservations) consume the host
    -- first; already admitted holder remainders consume their assigned host.
    select h.host_id, h.cpu, h.ram_mb
      into v_host
    from public.holder_admission_host_capacity() h
    left join public.holder_admission_host_usage() u on u.host_id = h.host_id
    where h.cpu - coalesce(u.cpu, 0) >= v_reserve_cpu
      and h.ram_mb - coalesce(u.ram_mb, 0) >= v_reserve_ram_mb
    order by (h.cpu - coalesce(u.cpu, 0)) - v_reserve_cpu asc,
             (h.ram_mb - coalesce(u.ram_mb, 0)) - v_reserve_ram_mb asc,
             h.host_id asc
    limit 1;

    if v_host.host_id is null then
      v_blocked := true;
      v_block_reason := 'no_single_host_fit';
      continue;
    end if;

    update public.holder_admissions
    set state = 'admitted',
        tier = v_tier,
        admitted_at = now(),
        assigned_host_id = v_host.host_id,
        reserved_cpu = v_reserve_cpu,
        reserved_ram_mb = v_reserve_ram_mb,
        qualification_checked_at = now(),
        updated_at = now()
    where user_id = v_candidate.user_id
      and state = 'waitlisted';

    if found then
      v_advanced := v_advanced + 1;
      v_used_cpu := v_used_cpu + v_reserve_cpu;
      v_used_ram := v_used_ram + v_reserve_ram_mb;
    end if;
  end loop;

  return jsonb_build_object(
    'status','ok','inserted',v_inserted,'released',v_released,'advanced',v_advanced,
    'skippedIneligible',v_skipped_ineligible,
    'blocked',v_blocked,'blockReason',v_block_reason,
    'usedCpu',v_used_cpu,'usedRamMb',v_used_ram,
    'capacityCpu',v_capacity_cpu,'capacityRamMb',v_capacity_ram,
    'ceilingCpu',(v_capacity_cpu / 5)::numeric,
    'ceilingRamMb',(v_capacity_ram / 5)::numeric
  );
end;
$$;

-- Validate that one new holder-funded seat fits the admitted reservation.
-- The per-owner advisory lock is held for the remainder of the inserting
-- transaction. Concurrent Hivra and Hermes creations therefore serialize on
-- the same authority, and the second transaction re-reads usage only after the
-- first insert commits or rolls back. This is the atomic consumption half of
-- the admission reservation: placement can race elsewhere, but two holder rows
-- cannot both consume the same reservation.
create or replace function public.holder_seat_funding_valid(
  p_user_id text,
  p_cpu numeric,
  p_ram_mb numeric
)
returns boolean
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_admission public.holder_admissions%rowtype;
  v_cpu numeric := 0;
  v_ram_mb numeric := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('holder-seat-funding-v1:' || p_user_id, 0));

  select * into v_admission
  from public.holder_admissions a
  where a.user_id = p_user_id
    and a.state = 'admitted'
  for update;

  if not found then
    return false;
  end if;

  if not exists (
    select 1
    from public.token_tier_qualifications q
    where q.user_id = p_user_id
      and q.tier in ('pro','power')
      and q.last_suspend_at is null
      and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now())
  ) then
    return false;
  end if;

  select coalesce(u.cpu, 0), coalesce(u.ram_mb, 0)
    into v_cpu, v_ram_mb
  from public.holder_admission_existing_usage(p_user_id) u;

  return v_cpu + coalesce(p_cpu, 0) <= v_admission.reserved_cpu
     and v_ram_mb + coalesce(p_ram_mb, 0) <= v_admission.reserved_ram_mb;
end;
$$;

create or replace function public.enforce_hivra_agent_seat_funding()
returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
begin
  if tg_op = 'UPDATE'
    and new.seat_funding is distinct from old.seat_funding
    and coalesce(current_setting('hivra.seat_funding_writer', true), 'off') <> 'on'
  then
    raise exception 'seat_funding is immutable after provisioning';
  end if;

  if new.deployment_mode = 'hivra-managed' and new.seat_funding = 'holder' then
    if not public.holder_seat_funding_valid(new.user_id, new.cpu::numeric, new.ram::numeric * 1024) then
      raise exception 'holder seat funding is not admitted or exceeds the reserved seat resources';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_hermes_instance_seat_funding()
returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
begin
  if tg_op = 'UPDATE'
    and new.seat_funding is distinct from old.seat_funding
    and coalesce(current_setting('hivra.seat_funding_writer', true), 'off') <> 'on'
  then
    raise exception 'seat_funding is immutable after provisioning';
  end if;

  if new.seat_funding = 'holder' then
    if not public.holder_seat_funding_valid(new.user_id, new.cpu_limit::numeric, new.ram_limit::numeric) then
      raise exception 'holder seat funding is not admitted or exceeds the reserved seat resources';
    end if;
  end if;
  return new;
end;
$$;

-- The launch-model reservation chain predates per-seat funding and its inner
-- v1 whitelist cannot know the new column. Keep that chain intact, strip the
-- funding key for the legacy shape check, then write the cohort onto the exact
-- newly reserved row inside this same transaction. If holder validation fails,
-- the reservation and agent insert roll back together; if the RPC succeeds, the
-- row is born with exactly one authoritative funding value.
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
  -- A concurrent reservation of the same request may have won while we waited.
  if p_request_id is not null and exists(select 1 from public.hivra_launch_model_requests
      where user_id=p_user_id and request_id=p_request_id) then
    return public.reserve_hivra_launch_model_request_v2(p_user_id,p_request_id,p_fingerprints,
      p_model_operation_id,v_legacy_agent,p_selection,p_encrypted_key);
  end if;
  v_count := public.hivra_owner_agent_slot_count(p_user_id);
  if v_count>=p_agent_limit then
    return jsonb_build_object('status','plan_agent_limit','activeCount',v_count,'limit',p_agent_limit);
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

-- The direct managed-agent writer predates per-seat funding as well. Unlike
-- the launch-model chain it receives the final row shape, so the server-side
-- funding decision is required before the slot lock is even taken. This keeps
-- a future caller or application regression from creating a new hosted managed
-- seat in the legacy NULL cohort; only rows that existed before the feature may
-- remain unknown.
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

  select string_agg(quote_ident(k), ',' order by k) into v_columns from jsonb_object_keys(p_row) k;
  perform set_config('hivra.agent_slot_checked','on',true);
  execute format('insert into public.hivra_agents(%s) select %s from jsonb_populate_record(null::public.hivra_agents,$1) returning to_jsonb(hivra_agents.*)',
    v_columns, v_columns) into v_inserted using p_row;
  perform set_config('hivra.agent_slot_checked','off',true);
  return jsonb_build_object('status','inserted','row',v_inserted);
end;
$$;

create or replace function public.holder_admission_state(p_user_id text)
returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select jsonb_build_object('state', coalesce(
    case (select a.state from public.holder_admissions a where a.user_id = p_user_id)
      when 'waitlisted' then 'waitlisted'
      when 'admitted' then 'admitted'
      else 'none'
    end,
    'none'
  ));
$$;

-- Migration-time grandfathering is deliberately narrower than qualification.
-- Qualification alone proves that a user MAY join the new queue; it does not
-- prove that any particular pre-existing seat was token-funded. A pre-feature
-- seat is grandfathered only when both facts are evidenced at migration time:
-- the owner currently qualifies, has no live paid hosted-compute access, and
-- still owns live hosted compute. Under the pre-feature entitlement rules that
-- combination is the only conservative evidence that the existing compute was
-- token-funded. Mixed accounts therefore keep those pre-feature rows unknown
-- (NULL) instead of guessing; new provisioning writes an explicit cohort.
select public.sync_holder_admission_candidates();

with ranked as (
  select q.user_id,
         case when bool_or(q.tier = 'power') then 'power' else 'pro' end as tier,
         (array_agg(q.token_key order by q.tier = 'power' desc, q.tier))[1] as token_key
  from public.token_tier_qualifications q
  where q.currently_eligible = true
    and q.tier in ('pro','power')
    and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now())
  group by q.user_id
), evidenced as (
  select r.*
  from ranked r
  where not public.holder_admission_has_paid_access(r.user_id)
    and (
      exists (
        select 1
        from public.hivra_agents a
        where a.user_id = r.user_id
          and a.deployment_mode = 'hivra-managed'
          and a.status <> 'deleted'
      )
      or exists (
        select 1
        from public.hermes_instances h
        where h.user_id = r.user_id
          and h.status <> 'deleted'
          and h.lifecycle_state not in ('deleted','cold_archived','pending_deletion')
      )
    )
)
update public.hivra_agents a
set seat_funding = 'holder'
from evidenced e
where a.user_id = e.user_id
  and a.deployment_mode = 'hivra-managed'
  and a.status <> 'deleted'
  and a.seat_funding is null;

with ranked as (
  select q.user_id,
         case when bool_or(q.tier = 'power') then 'power' else 'pro' end as tier,
         (array_agg(q.token_key order by q.tier = 'power' desc, q.tier))[1] as token_key
  from public.token_tier_qualifications q
  where q.currently_eligible = true
    and q.tier in ('pro','power')
    and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now())
  group by q.user_id
), evidenced as (
  select r.*
  from ranked r
  where not public.holder_admission_has_paid_access(r.user_id)
    and (
      exists (
        select 1
        from public.hivra_agents a
        where a.user_id = r.user_id
          and a.deployment_mode = 'hivra-managed'
          and a.status <> 'deleted'
      )
      or exists (
        select 1
        from public.hermes_instances h
        where h.user_id = r.user_id
          and h.status <> 'deleted'
          and h.lifecycle_state not in ('deleted','cold_archived','pending_deletion')
      )
    )
)
update public.hermes_instances h
set seat_funding = 'holder'
from evidenced e
where h.user_id = e.user_id
  and h.status <> 'deleted'
  and h.lifecycle_state not in ('deleted','cold_archived','pending_deletion')
  and h.seat_funding is null;

with ranked as (
  select q.user_id,
         case when bool_or(q.tier = 'power') then 'power' else 'pro' end as tier,
         (array_agg(q.token_key order by q.tier = 'power' desc, q.tier))[1] as token_key
  from public.token_tier_qualifications q
  where q.currently_eligible = true
    and q.tier in ('pro','power')
    and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now())
  group by q.user_id
), evidenced as (
  select r.*
  from ranked r
  where not public.holder_admission_has_paid_access(r.user_id)
    and (
      exists (
        select 1
        from public.hivra_agents a
        where a.user_id = r.user_id
          and a.deployment_mode = 'hivra-managed'
          and a.status <> 'deleted'
          and a.seat_funding = 'holder'
      )
      or exists (
        select 1
        from public.hermes_instances h
        where h.user_id = r.user_id
          and h.status <> 'deleted'
          and h.lifecycle_state not in ('deleted','cold_archived','pending_deletion')
          and h.seat_funding = 'holder'
      )
    )
)
update public.holder_admissions a
set state = 'admitted',
    tier = e.tier,
    token_key = e.token_key,
    admitted_at = now(),
    reserved_cpu = res.cpu,
    reserved_ram_mb = res.ram_mb,
    qualification_checked_at = now(),
    grandfathered = true,
    updated_at = now()
from evidenced e
cross join lateral public.holder_admission_tier_resources(e.tier) res
where a.user_id = e.user_id
  and a.state = 'waitlisted';

drop trigger if exists hivra_agents_enforce_seat_funding on public.hivra_agents;
create trigger hivra_agents_enforce_seat_funding
before insert or update of seat_funding on public.hivra_agents
for each row execute function public.enforce_hivra_agent_seat_funding();

drop trigger if exists hermes_instances_enforce_seat_funding on public.hermes_instances;
create trigger hermes_instances_enforce_seat_funding
before insert or update of seat_funding on public.hermes_instances
for each row execute function public.enforce_hermes_instance_seat_funding();

revoke all on table public.holder_admissions from public, anon, authenticated;
revoke all on function public.holder_admission_tier_resources(text),
  public.holder_admission_has_paid_access(text),
  public.holder_seat_funding_valid(text,numeric,numeric),
  public.enforce_hivra_agent_seat_funding(),
  public.enforce_hermes_instance_seat_funding(),
  public.holder_admission_existing_usage(text),
  public.holder_admission_host_capacity(),
  public.holder_admission_host_usage(),
  public.holder_admission_cohort_usage(),
  public.sync_holder_admission_candidates(),
  public.advance_holder_admissions(),
  public.holder_admission_state(text),
  public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer),
  public.insert_hivra_managed_agent(jsonb,integer)
from public, anon, authenticated, service_role;
grant execute on function public.holder_admission_tier_resources(text),
  public.holder_admission_has_paid_access(text),
  public.holder_seat_funding_valid(text,numeric,numeric),
  public.enforce_hivra_agent_seat_funding(),
  public.enforce_hermes_instance_seat_funding(),
  public.holder_admission_existing_usage(text),
  public.holder_admission_host_capacity(),
  public.holder_admission_host_usage(),
  public.holder_admission_cohort_usage(),
  public.holder_admission_state(text),
  public.advance_holder_admissions(),
  public.sync_holder_admission_candidates(),
  public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer),
  public.insert_hivra_managed_agent(jsonb,integer)
to service_role;
