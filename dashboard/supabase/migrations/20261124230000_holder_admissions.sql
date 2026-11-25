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
    )
    or exists (
      select 1 from public.workspace_cloud_subscriptions w
      where w.user_id = p_user_id
        and w.status in ('active','trialing','past_due')
        and coalesce(w.instance_limit, 0) > 0
        and (
          w.status <> 'past_due'
          or w.current_period_end is null
          or w.current_period_end > now()
        )
    );
$$;

-- A resize holds the larger of the old and claimed sizes on each axis until
-- provider confirmation or rollback clears the operation. Never spend a
-- pending shrink, or allow another lane to spend a pending increase.
create or replace function public.holder_hivra_size(p_cpu numeric, p_ram numeric, p_kind text, p_payload jsonb)
returns table(cpu numeric, ram_mb numeric)
language sql immutable
as $$
  select greatest(p_cpu, case when p_kind = 'resize' then (p_payload->>'cpu')::numeric end),
         greatest(p_ram, case when p_kind = 'resize' then (p_payload->>'ram')::numeric end) * 1024;
$$;

create or replace function public.holder_hermes_allocated(p_status text, p_lifecycle text)
returns boolean language sql immutable
as $$
  select coalesce(p_status <> 'deleted' and p_lifecycle not in ('deleted','cold_archived','pending_deletion')
    and (p_status in ('running','provisioning','stopped') or p_lifecycle in ('provisioning','active','paused','suspended','archiving','restoring')), false);
$$;

create or replace function public.holder_admission_existing_usage(
  p_user_id text,
  p_exclude_hivra_agent_id uuid default null,
  p_exclude_hermes_instance_id uuid default null
)
returns table(cpu numeric, ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select coalesce(sum(v.cpu), 0)::numeric, coalesce(sum(v.ram_mb), 0)::numeric
  from (
    select sz.cpu, sz.ram_mb
    from public.hivra_agents a
    cross join lateral public.holder_hivra_size(a.cpu, a.ram, a.operation_kind, a.operation_payload) sz
    where a.user_id = p_user_id
      and a.deployment_mode = 'hivra-managed'
      and (a.status in ('provisioning','running','stopped') or a.operation_kind in ('resize','start','restart'))
      and a.seat_funding = 'holder'
      and (p_exclude_hivra_agent_id is null or a.id <> p_exclude_hivra_agent_id)
    union all
    select h.cpu_limit::numeric as cpu, h.ram_limit::numeric as ram_mb
    from public.hermes_instances h
    where h.user_id = p_user_id
      and public.holder_hermes_allocated(h.status,h.lifecycle_state)
      and h.seat_funding = 'holder'
      and (p_exclude_hermes_instance_id is null or h.id <> p_exclude_hermes_instance_id)
  ) v;
$$;

-- Exact host-id normalization used by the application placement target list.
create or replace function public.holder_admission_normalize_host_id(p_host_id text)
returns text
language sql immutable strict
as $$
  select nullif(btrim(regexp_replace(regexp_replace(lower(btrim(p_host_id)), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g')), '');
$$;

-- Fresh host-capacity readings use real thin-pool occupancy. Mirror the
-- application placement constants exactly: 85% fill ceiling, 20GB reserved
-- for the incoming launch and each already-in-flight launch, readings expire
-- after 15 minutes.
create or replace function public.holder_admission_measured_free_disk_gb(
  p_reading jsonb,
  p_launches_in_progress integer
)
returns numeric
language plpgsql stable security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_at timestamptz;
  v_pool jsonb;
  v_size_gb numeric;
  v_used_percent numeric;
begin
  if p_reading is null or jsonb_typeof(p_reading) is distinct from 'object'
    or p_reading->'v' is distinct from '1'::jsonb
    or jsonb_typeof(p_reading->'at') is distinct from 'string' then
    return null;
  end if;
  begin
    v_at := (p_reading->>'at')::timestamptz;
  exception when others then
    return null;
  end;
  if v_at > now() or v_at < now() - interval '15 minutes' then
    return null;
  end if;
  v_pool := p_reading->'pool';
  if v_pool is null or jsonb_typeof(v_pool) is distinct from 'object' then
    return null;
  end if;
  begin
    v_size_gb := (v_pool->>'sizeMb')::numeric / 1024;
    v_used_percent := (v_pool->>'usedPercent')::numeric;
  exception when others then
    return null;
  end;
  if v_size_gb is null or v_used_percent is null or v_size_gb <= 0 or v_used_percent < 0
    or v_size_gb::text in ('NaN','Infinity') or v_used_percent::text in ('NaN','Infinity') then
    return null;
  end if;
  return v_size_gb * 0.85
    - (v_size_gb * v_used_percent / 100)
    - greatest(coalesce(p_launches_in_progress, 0), 0) * 20;
end;
$$;

-- Eligible scheduler inventory. This mirrors the registry-backed placement
-- authority: active hosts only, never maintenance/draining/decommissioned
-- inventory; host-reserved cores/RAM and the wake headroom are not scheduler
-- capacity; the host CPU overcommit ratio applies to vCPU only.
create or replace function public.holder_admission_host_capacity(
  p_target_host_ids text[] default null,
  p_cpu_overcommit_ratio numeric default null
)
returns table(
  host_id text,
  cpu numeric,
  ram_mb numeric,
  disk_gb numeric,
  capacity_reading jsonb
)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select h.id,
         greatest((h.total_cpu::numeric - h.reserved_cpu::numeric) *
           (case
              when h.cpu_overcommit_ratio is not null and h.cpu_overcommit_ratio > 0 and h.cpu_overcommit_ratio <= 20
                then h.cpu_overcommit_ratio::numeric
              when p_cpu_overcommit_ratio is not null and p_cpu_overcommit_ratio >= 1
                then p_cpu_overcommit_ratio::numeric
              else 5::numeric
            end), 0),
         greatest(h.total_ram_mb::numeric - h.reserved_ram_mb::numeric - h.wake_headroom_ram_mb::numeric, 0),
         case
           when h.thinpool_size_gb is null then null
           else h.thinpool_size_gb::numeric * coalesce(h.thinpool_overcommit_ratio, 1.5)::numeric
         end,
         h.capacity_reading
  from public.proxmox_hosts h
  where h.status = 'active'
    and h.decommissioned_at is null
    and h.total_cpu > h.reserved_cpu
    and h.total_ram_mb > h.reserved_ram_mb + h.wake_headroom_ram_mb
    and (
      p_target_host_ids is null
      or exists (
        select 1
        from unnest(p_target_host_ids) target(id)
        where public.holder_admission_normalize_host_id(h.id) = public.holder_admission_normalize_host_id(target.id)
      )
    );
$$;

-- Same registry-scoped rows as rankProxmoxHostsForPlacement. Every Hivra
-- row on these nodes counts, including a stopped VM's disk. Deep sleep can
-- release compute without releasing disk.
create or replace function public.holder_placement_rows(p_targets text[], p_skip_sleep boolean)
returns table(host_id text, owner_id text, holder boolean, cpu numeric, ram_mb numeric, disk_gb numeric, launching integer)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with hosts as (
    select c.host_id, h.placement_skip_deep_sleep
    from public.holder_admission_host_capacity(p_targets) c
    join public.proxmox_hosts h on h.id = c.host_id
  )
  select h.proxmox_node, h.user_id, h.seat_funding = 'holder', h.cpu_limit::numeric,
         h.ram_limit::numeric, coalesce(h.disk_size_gb,30)::numeric, 0
  from public.hermes_instances h join hosts on hosts.host_id = h.proxmox_node
  where h.lifecycle_state in ('provisioning','active')
  union all
  select a.proxmox_host, a.user_id, a.seat_funding = 'holder',
         case when powered.holds_compute then a.cpu else 0 end,
         case when powered.holds_compute then a.ram::numeric * 1024 else 0 end,
         40::numeric, case when a.status = 'provisioning' then 1 else 0 end
  from public.hivra_agents a join hosts on hosts.host_id = a.proxmox_host
  cross join lateral (select a.status in ('running','provisioning')
    and not (a.sleep_state is not distinct from 'hibernated'
             and (p_skip_sleep or coalesce(hosts.placement_skip_deep_sleep,false))) as holds_compute) powered
  where a.status <> 'deleted' and (a.status in ('running','provisioning') or a.vmid is not null);
$$;

create or replace function public.holder_admission_powered_usage(p_user_id text, p_targets text[], p_skip_sleep boolean)
returns table(cpu numeric, ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select coalesce(sum(r.cpu),0), coalesce(sum(r.ram_mb),0)
  from public.holder_placement_rows(p_targets,p_skip_sleep) r where r.holder and r.owner_id = p_user_id;
$$;

-- Charge unlaunched reservations to their assigned host. Measured thin-pool
-- space uses physical launch headroom, fallback space uses logical VM sizes.
create or replace function public.holder_admission_host_availability(
  p_targets text[], p_ratio numeric, p_skip_sleep boolean, p_disk_sizes jsonb, p_ignore_user_id text
)
returns table(host_id text, free_cpu numeric, free_ram_mb numeric, free_disk_gb numeric, needed_disk_gb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with occupied as materialized (select * from public.holder_placement_rows(p_targets,p_skip_sleep)),
  actual as (
    select o.host_id, sum(o.cpu) cpu, sum(o.ram_mb) ram, sum(o.disk_gb) disk, sum(o.launching)::int launching
    from occupied o group by o.host_id
  ), powered as (
    select o.owner_id, sum(o.cpu) cpu, sum(o.ram_mb) ram
    from occupied o where o.holder group by o.owner_id
  ), reservations as (
    select a.assigned_host_id, sum(greatest(a.reserved_cpu-coalesce(p.cpu,0),0)) cpu,
           sum(greatest(a.reserved_ram_mb-coalesce(p.ram,0),0)) ram,
           count(*) filter (where a.reserved_cpu > u.cpu or a.reserved_ram_mb > u.ram_mb or not exists (
             select 1 from occupied o where o.holder and o.owner_id=a.user_id and o.host_id=a.assigned_host_id and o.disk_gb>0
           )) seats
    from public.holder_admissions a left join powered p on p.owner_id=a.user_id
    cross join lateral public.holder_admission_existing_usage(a.user_id) u
    where a.state='admitted' and a.user_id is distinct from p_ignore_user_id
      and (a.reserved_cpu > coalesce(p.cpu,0) or a.reserved_ram_mb > coalesce(p.ram,0))
    group by a.assigned_host_id
  )
  select c.host_id, c.cpu-coalesce(o.cpu,0)-coalesce(r.cpu,0),
         c.ram_mb-coalesce(o.ram,0)-coalesce(r.ram,0),
         coalesce(m.measured, c.disk_gb-coalesce(o.disk,0)) - coalesce(r.seats,0)*d.needed,
         d.needed
  from public.holder_admission_host_capacity(p_targets,p_ratio) c
  left join actual o on o.host_id=c.host_id
  left join reservations r on r.assigned_host_id=c.host_id
  cross join lateral (select public.holder_admission_measured_free_disk_gb(c.capacity_reading,o.launching) measured) m
  cross join lateral (select case when m.measured is not null then 20 else greatest(40,
    coalesce((p_disk_sizes->>public.holder_admission_normalize_host_id(c.host_id))::numeric,
             (p_disk_sizes->>'defaultDiskGb')::numeric)) end needed) d;
$$;

-- Prefer an existing assignment while it still fits. Otherwise use the
-- scheduler ordering. A stopped seat already owns its disk; resuming it
-- needs host compute, whereas unallocated reservation headroom needs disk.
create or replace function public.holder_admission_fit_host(
  p_targets text[], p_ratio numeric, p_skip_sleep boolean, p_disk_sizes jsonb,
  p_owner text, p_cpu numeric, p_ram_mb numeric, p_preferred text default null
)
returns text language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select a.host_id
  from public.holder_admission_host_availability(p_targets,p_ratio,p_skip_sleep,p_disk_sizes,p_owner) a
  cross join public.holder_admission_powered_usage(p_owner,p_targets,p_skip_sleep) powered
  cross join public.holder_admission_existing_usage(p_owner) allocated
  where a.free_cpu >= greatest(0,p_cpu-powered.cpu)
    and a.free_ram_mb >= greatest(0,p_ram_mb-powered.ram_mb)
    and (a.free_disk_gb is null or a.free_disk_gb >= a.needed_disk_gb
         or (p_cpu <= allocated.cpu and p_ram_mb <= allocated.ram_mb and exists (
           select 1 from public.holder_placement_rows(p_targets,p_skip_sleep) r
           where r.holder and r.owner_id=p_owner and r.host_id=a.host_id and r.disk_gb>0
         )))
  order by (a.host_id=p_preferred) desc nulls last, a.free_ram_mb desc,
           a.free_disk_gb desc nulls first, a.free_cpu desc, a.host_id
  limit 1;
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
    select a.user_id, case when a.state='admitted' then a.reserved_cpu else 0 end reserved_cpu,
           case when a.state='admitted' then a.reserved_ram_mb else 0 end reserved_ram_mb
    from public.holder_admissions a
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

-- The durable post-admission tier. Deliberately based on unsuspended rows rather
-- than the strict currently_eligible boolean: a breach inside grace still holds
-- the tier, while suspension is the evaluator's authoritative end-of-grace.
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
    and (q.currently_eligible or q.last_breach_at > now() - interval '24 hours')
    and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now());
$$;

create or replace function public.holder_admission_has_active_wake(p_user_id text)
returns boolean
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select false;
$$;

-- Advance the durable FIFO queue. A single advisory lock makes independent
-- service transactions serialize; row updates happen in the same transaction as
-- the capacity accounting, so retries are idempotent and a crashed caller cannot
-- half-advance a seat. Ineligible waiters are skipped. Eligible waiters are
-- strictly FIFO: when the head cannot fit, smaller later seats cannot jump it.
create or replace function public.advance_holder_admissions(
  p_target_host_ids text[] default null,
  p_cpu_overcommit_ratio numeric default null,
  p_skip_sleep boolean default false,
  p_disk_sizes jsonb default null
)
returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_candidate record;
  v_tier text;
  v_reserve_cpu numeric;
  v_reserve_ram_mb integer;
  v_target_cpu numeric;
  v_target_ram_mb integer;
  v_capacity_cpu numeric := 0;
  v_capacity_ram numeric := 0;
  v_used_cpu numeric := 0;
  v_used_ram numeric := 0;
  v_old_cohort_cpu numeric;
  v_old_cohort_ram numeric;
  v_new_cohort_cpu numeric;
  v_new_cohort_ram numeric;
  v_prospective_cpu numeric;
  v_prospective_ram numeric;
  v_fit_host_id text;
  v_reservation record;
  v_existing_cpu numeric;
  v_existing_ram numeric;
  v_powered_cpu numeric;
  v_powered_ram numeric;
  v_needed_cpu numeric;
  v_needed_ram numeric;
  v_inserted integer;
  v_released integer := 0;
  v_retiered integer := 0;
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

  select coalesce(sum(h.cpu), 0), coalesce(sum(h.ram_mb), 0)
    into v_capacity_cpu, v_capacity_ram
  from public.holder_admission_host_capacity(p_target_host_ids, p_cpu_overcommit_ratio) h;

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
      and public.holder_admission_current_tier(a.user_id) is null
      and not public.holder_admission_has_active_wake(a.user_id)
    returning 1
  )
  select count(*) into v_released from released;

  -- Shrink reservations before advancing the queue. Actual oversized rows
  -- remain charged until their allocations really shrink.
  update public.holder_admissions a
  set tier = 'pro', reserved_cpu = r.cpu, reserved_ram_mb = r.ram_mb,
      qualification_checked_at = now(), updated_at = now()
  from public.holder_admission_tier_resources('pro') r
  where a.state = 'admitted' and a.tier = 'power'
    and public.holder_admission_current_tier(a.user_id) = 'pro';
  get diagnostics v_retiered = row_count;

  -- Reconcile stale, full, or never-assigned reservations before measuring the
  -- queue. The host fit uses the same CPU/RAM/disk inventory as real placement;
  -- the user's own old reservation remainder is ignored while re-fitting it,
  -- so moving a reservation does not require double capacity.
  for v_reservation in
    select a.user_id, a.assigned_host_id, a.reserved_cpu, a.reserved_ram_mb
    from public.holder_admissions a
    where a.state = 'admitted'
    order by a.admitted_at asc nulls first, a.user_id asc
    for update
  loop
    select coalesce(u.cpu, 0), coalesce(u.ram_mb, 0)
      into v_powered_cpu, v_powered_ram
    from public.holder_admission_powered_usage(v_reservation.user_id,p_target_host_ids,p_skip_sleep) u;
    v_needed_cpu := greatest(v_reservation.reserved_cpu - v_powered_cpu, 0);
    v_needed_ram := greatest(v_reservation.reserved_ram_mb - v_powered_ram, 0);

    if v_needed_cpu <= 0 and v_needed_ram <= 0 then
      continue;
    end if;

    v_fit_host_id := public.holder_admission_fit_host(
      p_target_host_ids,p_cpu_overcommit_ratio,p_skip_sleep,p_disk_sizes,
      v_reservation.user_id,v_reservation.reserved_cpu,v_reservation.reserved_ram_mb,v_reservation.assigned_host_id
    );
    if v_fit_host_id is not distinct from v_reservation.assigned_host_id then
      continue;
    end if;

    update public.holder_admissions
    set assigned_host_id = v_fit_host_id,
        updated_at = now()
    where user_id = v_reservation.user_id
      and state = 'admitted';
  end loop;

  if v_capacity_cpu <= 0 or v_capacity_ram <= 0 then
    return jsonb_build_object(
      'status','no_eligible_capacity','inserted',v_inserted,
      'advanced',0,'skippedIneligible',0,'released',v_released,'retiered',v_retiered,
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
    select greatest(v_reserve_cpu-u.cpu,0), greatest(v_reserve_ram_mb-u.ram_mb,0)
      into v_new_cohort_cpu, v_new_cohort_ram
    from public.holder_admission_existing_usage(v_candidate.user_id) u;
    if v_used_cpu + v_new_cohort_cpu > (v_capacity_cpu / 5)::numeric
       or v_used_ram + v_new_cohort_ram > (v_capacity_ram / 5)::numeric then
      v_blocked := true;
      v_block_reason := 'holder_capacity_ceiling';
      continue;
    end if;

    -- Placement fit is per-host, not merely aggregate. Existing non-holder and
    -- holder allocations (including provisioning reservations) consume the host
    -- first; already admitted holder remainders consume their assigned host.
    v_fit_host_id := public.holder_admission_fit_host(
      p_target_host_ids,p_cpu_overcommit_ratio,p_skip_sleep,p_disk_sizes,
      v_candidate.user_id,v_reserve_cpu,v_reserve_ram_mb
    );
    if v_fit_host_id is null then
      v_blocked := true;
      v_block_reason := 'no_single_host_fit';
      continue;
    end if;

    update public.holder_admissions
    set state = 'admitted',
        tier = v_tier,
        admitted_at = now(),
        assigned_host_id = v_fit_host_id,
        reserved_cpu = v_reserve_cpu,
        reserved_ram_mb = v_reserve_ram_mb,
        qualification_checked_at = now(),
        updated_at = now()
    where user_id = v_candidate.user_id
      and state = 'waitlisted';

    if found then
      v_advanced := v_advanced + 1;
      v_used_cpu := v_used_cpu + v_new_cohort_cpu;
      v_used_ram := v_used_ram + v_new_cohort_ram;
    end if;
  end loop;

  -- Existing holders retain their Pro reservation until Power fits. Do not
  -- let an upgrade spend headroom ahead of an eligible, blocked FIFO waiter.
  for v_reservation in
    select a.user_id, a.assigned_host_id, a.reserved_cpu, a.reserved_ram_mb
    from public.holder_admissions a
    where not v_blocked and a.state='admitted' and a.tier='pro'
      and public.holder_admission_current_tier(a.user_id)='power'
    order by a.admitted_at, a.user_id
    for update
  loop
    select res.cpu, res.ram_mb into v_target_cpu, v_target_ram_mb
    from public.holder_admission_tier_resources('power') res;

    select coalesce(u.cpu, 0), coalesce(u.ram_mb, 0)
      into v_existing_cpu, v_existing_ram
    from public.holder_admission_existing_usage(v_reservation.user_id) u;

    v_old_cohort_cpu := greatest(v_existing_cpu, v_reservation.reserved_cpu);
    v_old_cohort_ram := greatest(v_existing_ram, v_reservation.reserved_ram_mb);
    v_new_cohort_cpu := greatest(v_existing_cpu, v_target_cpu);
    v_new_cohort_ram := greatest(v_existing_ram, v_target_ram_mb);

    select coalesce(sum(u.cpu), 0), coalesce(sum(u.ram_mb), 0)
      into v_used_cpu, v_used_ram
    from public.holder_admission_cohort_usage() u;
    v_prospective_cpu := v_used_cpu - v_old_cohort_cpu + v_new_cohort_cpu;
    v_prospective_ram := v_used_ram - v_old_cohort_ram + v_new_cohort_ram;

    if v_capacity_cpu <= 0 or v_capacity_ram <= 0
       or v_prospective_cpu > (v_capacity_cpu / 5)::numeric
       or v_prospective_ram > (v_capacity_ram / 5)::numeric then
      continue;
    end if;

    v_fit_host_id := public.holder_admission_fit_host(
      p_target_host_ids,p_cpu_overcommit_ratio,p_skip_sleep,p_disk_sizes,
      v_reservation.user_id,v_target_cpu,v_target_ram_mb,v_reservation.assigned_host_id
    );
    if v_fit_host_id is null then
      continue;
    end if;

    update public.holder_admissions
    set tier = 'power',
        reserved_cpu = v_target_cpu,
        reserved_ram_mb = v_target_ram_mb,
        assigned_host_id = coalesce(v_fit_host_id, assigned_host_id),
        qualification_checked_at = now(),
        updated_at = now()
    where user_id = v_reservation.user_id
      and state = 'admitted';
    if found then
      v_retiered := v_retiered + 1;
      v_used_cpu := v_prospective_cpu;
      v_used_ram := v_prospective_ram;
    end if;
  end loop;

  return jsonb_build_object(
    'status','ok','inserted',v_inserted,'released',v_released,'retiered',v_retiered,'advanced',v_advanced,
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
  p_ram_mb numeric,
  p_exclude_hivra_agent_id uuid default null,
  p_exclude_hermes_instance_id uuid default null,
  p_max_cpu numeric default null,
  p_max_ram_mb numeric default null
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

  -- A failed or delayed advancement must not grant the old Power cap
  -- after the last countable Power qualification was suspended.
  select least(v_admission.reserved_cpu,r.cpu), least(v_admission.reserved_ram_mb,r.ram_mb)
    into v_admission.reserved_cpu, v_admission.reserved_ram_mb
  from public.holder_admission_tier_resources(public.holder_admission_current_tier(p_user_id)) r;
  if not found or p_cpu is null or p_ram_mb is null or p_cpu <= 0 or p_ram_mb <= 0 then
    return false;
  end if;

  select coalesce(u.cpu, 0), coalesce(u.ram_mb, 0)
    into v_cpu, v_ram_mb
  from public.holder_admission_existing_usage(p_user_id, p_exclude_hivra_agent_id, p_exclude_hermes_instance_id) u;

  return v_cpu + coalesce(p_cpu, 0) <= v_admission.reserved_cpu
     and v_ram_mb + coalesce(p_ram_mb, 0) <= v_admission.reserved_ram_mb
     and coalesce(p_max_cpu,p_cpu) <= v_admission.reserved_cpu
     and coalesce(p_max_ram_mb,p_ram_mb) <= v_admission.reserved_ram_mb;
end;
$$;

create or replace function public.enforce_hivra_agent_seat_funding()
returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
declare
  before_size record;
  after_size record;
  before_allocated boolean;
  new_claim boolean;
  before_max_cpu numeric;
  before_max_ram numeric;
  after_max_cpu numeric;
  after_max_ram numeric;
begin
  if tg_op = 'UPDATE'
    and new.seat_funding is distinct from old.seat_funding
    and coalesce(current_setting('hivra.seat_funding_writer', true), 'off') <> 'on'
  then
    raise exception 'seat_funding is immutable after provisioning';
  end if;

  if new.deployment_mode = 'hivra-managed' and new.seat_funding = 'holder'
    and (tg_op='INSERT' or new.seat_funding is distinct from old.seat_funding
         or new.status in ('running','provisioning','stopped') or new.operation_kind in ('resize','start','restart')) then
    select * into after_size from public.holder_hivra_size(new.cpu,new.ram,new.operation_kind,new.operation_payload);
    select * into before_size from public.holder_hivra_size(old.cpu,old.ram,old.operation_kind,old.operation_payload);
    before_allocated := old.seat_funding = 'holder' and old.deployment_mode='hivra-managed'
      and (old.status in ('running','provisioning','stopped') or old.operation_kind in ('resize','start','restart'));
    new_claim := new.operation_kind in ('start','restart','resize') and
      (old.operation_kind is distinct from new.operation_kind or old.operation_id is distinct from new.operation_id);
    before_max_cpu := greatest(old.cpu,old.cpu_max,case when old.operation_kind='resize' then (old.operation_payload->>'maximumCpu')::numeric end);
    before_max_ram := greatest(old.ram,old.ram_max,case when old.operation_kind='resize' then (old.operation_payload->>'maximumRam')::numeric end);
    after_max_cpu := greatest(new.cpu,new.cpu_max,case when new.operation_kind='resize' then (new.operation_payload->>'maximumCpu')::numeric end);
    after_max_ram := greatest(new.ram,new.ram_max,case when new.operation_kind='resize' then (new.operation_payload->>'maximumRam')::numeric end);

    if tg_op='INSERT' or before_allocated is not true or old.user_id is distinct from new.user_id
      or after_size.cpu > coalesce(before_size.cpu,0) or after_size.ram_mb > coalesce(before_size.ram_mb,0)
      or after_max_cpu > coalesce(before_max_cpu,0) or after_max_ram > coalesce(before_max_ram,0)
      or (new_claim and (old.status <> 'running' or new.operation_kind in ('start','restart')
          or not ((new.operation_payload->>'cpu')::numeric < old.cpu
                  or (new.operation_payload->>'ram')::numeric < old.ram
                  or coalesce(new.operation_payload->>'maximumCpu',new.operation_payload->>'cpu')::numeric < before_max_cpu
                  or coalesce(new.operation_payload->>'maximumRam',new.operation_payload->>'ram')::numeric < before_max_ram)))
      or (old.status='stopped' and new.status in ('provisioning','running')
          and coalesce(old.operation_kind,'') not in ('start','restart','resize'))
    then
      if not public.holder_seat_funding_valid(new.user_id,after_size.cpu,after_size.ram_mb,new.id,null,after_max_cpu,after_max_ram*1024) then
        raise exception using errcode='P0057', message='holder seat funding is not admitted or exceeds the reserved seat resources';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_hermes_instance_seat_funding()
returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
declare
  holder_idle_awake_reconciliation boolean := false;
begin
  if tg_op = 'UPDATE' then
    holder_idle_awake_reconciliation := coalesce((
      old.seat_funding = 'holder'
      and old.lifecycle_state = 'paused'
      and old.status = 'stopped'
      and old.paused_reason = 'holder_idle'
      and old.lifecycle_substate = 'holder_wake'
      and new.lifecycle_state = 'active'
      and new.status = 'running'
      and new.paused_reason is null
      and new.lifecycle_substate is null
      and new.user_id is not distinct from old.user_id
      and new.cpu_limit is not distinct from old.cpu_limit
      and new.ram_limit is not distinct from old.ram_limit
    ), false);
  end if;

  if tg_op = 'UPDATE'
    and new.seat_funding is distinct from old.seat_funding
    and coalesce(current_setting('hivra.seat_funding_writer', true), 'off') <> 'on'
  then
    raise exception 'seat_funding is immutable after provisioning';
  end if;

  if new.seat_funding='holder' and not holder_idle_awake_reconciliation and (
    tg_op='INSERT' or new.seat_funding is distinct from old.seat_funding
    or new.user_id is distinct from old.user_id
    or new.cpu_limit > coalesce(old.cpu_limit,0) or new.ram_limit > coalesce(old.ram_limit,0)
    or (public.holder_hermes_allocated(new.status,new.lifecycle_state)
        and not public.holder_hermes_allocated(old.status,old.lifecycle_state))
    or (new.lifecycle_state in ('active','provisioning','restoring') and old.lifecycle_state in ('paused','suspended','cold_archived'))
    or (new.status in ('running','provisioning') and old.status='stopped')
  ) then
    if not public.holder_seat_funding_valid(new.user_id,new.cpu_limit,new.ram_limit,null,new.id) then
      raise exception using errcode='P0057', message='holder seat funding is not admitted or exceeds the reserved seat resources';
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
  select jsonb_build_object(
    'state', coalesce((
      select case a.state
        when 'waitlisted' then 'waitlisted'
        when 'admitted' then 'admitted'
        else 'none'
      end
      from public.holder_admissions a
      where a.user_id = p_user_id
    ), 'none'),
    'tier', (
      select case when a.state = 'admitted' then (
        select case when count(*)=0 then null
                    when a.tier='power' and bool_or(q.tier='power') then 'power' else 'pro' end
        from public.token_tier_qualifications q where q.user_id=a.user_id and q.currently_eligible
          and q.last_suspend_at is null and q.tier in ('pro','power')
          and public.token_tier_row_counts_for_user(q.user_id,coalesce(q.token_key,'hermesos'),now())
      ) end
      from public.holder_admissions a
      where a.user_id = p_user_id
    )
  );
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
  where q.last_suspend_at is null
    and (q.currently_eligible or q.last_breach_at > now() - interval '24 hours')
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
          and h.product_surface = 'hermesos'
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
  where q.last_suspend_at is null
    and (q.currently_eligible or q.last_breach_at > now() - interval '24 hours')
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
          and h.product_surface = 'hermesos'
      )
    )
)
update public.hermes_instances h
set seat_funding = 'holder'
from evidenced e
where h.user_id = e.user_id
  and h.status <> 'deleted'
  and h.lifecycle_state not in ('deleted','cold_archived','pending_deletion')
  and h.product_surface = 'hermesos'
  and h.seat_funding is null;

with ranked as (
  select q.user_id,
         case when bool_or(q.tier = 'power') then 'power' else 'pro' end as tier,
         (array_agg(q.token_key order by q.tier = 'power' desc, q.tier))[1] as token_key
  from public.token_tier_qualifications q
  where q.last_suspend_at is null
    and (q.currently_eligible or q.last_breach_at > now() - interval '24 hours')
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
          and h.product_surface = 'hermesos'
          and h.seat_funding = 'holder'
      )
    )
)
insert into public.holder_admissions as a (
  user_id, state, tier, token_key, queued_at, admitted_at,
  reserved_cpu, reserved_ram_mb, qualification_checked_at, grandfathered
)
select e.user_id,
       'admitted',
       e.tier,
       e.token_key,
       now(),
       now(),
       res.cpu,
       res.ram_mb,
       now(),
       true
from evidenced e
cross join lateral public.holder_admission_tier_resources(e.tier) res
on conflict (user_id) do update
set state = 'admitted',
    tier = excluded.tier,
    token_key = excluded.token_key,
    admitted_at = excluded.admitted_at,
    reserved_cpu = excluded.reserved_cpu,
    reserved_ram_mb = excluded.reserved_ram_mb,
    qualification_checked_at = excluded.qualification_checked_at,
    grandfathered = true,
    updated_at = now()
where a.state = 'waitlisted';

drop trigger if exists hivra_agents_enforce_seat_funding on public.hivra_agents;
create trigger hivra_agents_enforce_seat_funding
before insert or update of seat_funding, user_id, deployment_mode, status, cpu, ram, cpu_max, ram_max, operation_id, operation_kind, operation_payload on public.hivra_agents
for each row execute function public.enforce_hivra_agent_seat_funding();

drop trigger if exists hermes_instances_enforce_seat_funding on public.hermes_instances;
create trigger hermes_instances_enforce_seat_funding
before insert or update of seat_funding, user_id, status, lifecycle_state, cpu_limit, ram_limit on public.hermes_instances
for each row execute function public.enforce_hermes_instance_seat_funding();

revoke all on table public.holder_admissions from public, anon, authenticated;
revoke all on function public.holder_admission_tier_resources(text),
  public.holder_admission_has_paid_access(text),
  public.holder_admission_has_active_wake(text),
  public.holder_seat_funding_valid(text,numeric,numeric,uuid,uuid,numeric,numeric),
  public.enforce_hivra_agent_seat_funding(),
  public.enforce_hermes_instance_seat_funding(),
  public.holder_admission_existing_usage(text,uuid,uuid),
  public.holder_hivra_size(numeric,numeric,text,jsonb),
  public.holder_hermes_allocated(text,text),
  public.holder_placement_rows(text[],boolean),
  public.holder_admission_powered_usage(text,text[],boolean),
  public.holder_admission_normalize_host_id(text),
  public.holder_admission_measured_free_disk_gb(jsonb,integer),
  public.holder_admission_current_tier(text),
  public.holder_admission_host_capacity(text[],numeric),
  public.holder_admission_host_availability(text[],numeric,boolean,jsonb,text),
  public.holder_admission_fit_host(text[],numeric,boolean,jsonb,text,numeric,numeric,text),
  public.holder_admission_cohort_usage(),
  public.sync_holder_admission_candidates(),
  public.advance_holder_admissions(text[],numeric,boolean,jsonb),
  public.holder_admission_state(text),
  public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer),
  public.insert_hivra_managed_agent(jsonb,integer)
from public, anon, authenticated, service_role;
grant execute on function public.holder_admission_tier_resources(text),
  public.holder_admission_has_paid_access(text),
  public.holder_admission_has_active_wake(text),
  public.holder_seat_funding_valid(text,numeric,numeric,uuid,uuid,numeric,numeric),
  public.enforce_hivra_agent_seat_funding(),
  public.enforce_hermes_instance_seat_funding(),
  public.holder_admission_existing_usage(text,uuid,uuid),
  public.holder_hivra_size(numeric,numeric,text,jsonb),
  public.holder_hermes_allocated(text,text),
  public.holder_placement_rows(text[],boolean),
  public.holder_admission_powered_usage(text,text[],boolean),
  public.holder_admission_normalize_host_id(text),
  public.holder_admission_measured_free_disk_gb(jsonb,integer),
  public.holder_admission_current_tier(text),
  public.holder_admission_host_capacity(text[],numeric),
  public.holder_admission_host_availability(text[],numeric,boolean,jsonb,text),
  public.holder_admission_fit_host(text[],numeric,boolean,jsonb,text,numeric,numeric,text),
  public.holder_admission_cohort_usage(),
  public.holder_admission_state(text),
  public.advance_holder_admissions(text[],numeric,boolean,jsonb),
  public.sync_holder_admission_candidates(),
  public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer),
  public.insert_hivra_managed_agent(jsonb,integer)
to service_role;

-- Backend services may read admission state, but only the security-definer
-- RPCs above may write it. No anon/authenticated table privilege exists.
grant select on table public.holder_admissions to service_role;
