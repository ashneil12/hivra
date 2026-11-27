-- Same registry-scoped rows as rankProxmoxHostsForPlacement. Every Hivra
-- row on these nodes counts, including a stopped VM's disk. Deep sleep can
-- release compute without releasing disk.
create or replace function public.holder_placement_accounting(p_targets text[], p_skip_sleep boolean)
returns table(host_id text, owner_id text, holder boolean, cpu numeric, ram_mb numeric, disk_gb numeric, launching integer, launched_cpu numeric, launched_ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with hosts as (
    select c.host_id, h.placement_skip_deep_sleep
    from public.holder_admission_host_capacity(p_targets) c
    join public.proxmox_hosts h on h.id = c.host_id
  )
  select h.proxmox_node, h.user_id, h.seat_funding = 'holder', h.cpu_limit::numeric,
         h.ram_limit::numeric, coalesce(h.disk_size_gb,30)::numeric, 0, h.cpu_limit::numeric, h.ram_limit::numeric
  from public.hermes_instances h join hosts on hosts.host_id = h.proxmox_node
  where h.lifecycle_state in ('provisioning','active')
  union all
  select a.proxmox_host, a.user_id, a.seat_funding = 'holder',
         case when powered.holds_compute then a.cpu else 0 end,
         case when powered.holds_compute then a.ram::numeric * 1024 else 0 end,
         40::numeric, case when a.status = 'provisioning' then 1 else 0 end,
         case when a.status in ('running','provisioning') then a.cpu else 0 end,
         case when a.status in ('running','provisioning') then a.ram::numeric * 1024 else 0 end
  from public.hivra_agents a join hosts on hosts.host_id = a.proxmox_host
  cross join lateral (select a.status in ('running','provisioning')
    and not (a.sleep_state is not distinct from 'hibernated'
             and (p_skip_sleep or coalesce(hosts.placement_skip_deep_sleep,false))) as holds_compute) powered
  where a.status <> 'deleted' and (a.status in ('running','provisioning') or a.vmid is not null);
$$;

revoke all on function public.holder_placement_accounting(text[], boolean) from public, anon, authenticated;
grant execute on function public.holder_placement_accounting(text[], boolean) to service_role;

create or replace function public.holder_placement_rows(p_targets text[], p_skip_sleep boolean)
returns table(host_id text, owner_id text, holder boolean, cpu numeric, ram_mb numeric, disk_gb numeric, launching integer)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select r.host_id,r.owner_id,r.holder,r.cpu,r.ram_mb,r.disk_gb,r.launching
  from public.holder_placement_accounting(p_targets,p_skip_sleep) r;
$$;

create or replace function public.holder_admission_powered_usage(p_user_id text, p_targets text[], p_skip_sleep boolean)
returns table(cpu numeric, ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select coalesce(sum(r.launched_cpu),0), coalesce(sum(r.launched_ram_mb),0)
  from public.holder_placement_accounting(p_targets,p_skip_sleep) r where r.holder and r.owner_id = p_user_id;
$$;

-- Charge unlaunched reservations to their assigned host. Measured thin-pool
-- space uses physical launch headroom, fallback space uses logical VM sizes.
create or replace function public.holder_admission_host_availability(
  p_targets text[], p_ratio numeric, p_skip_sleep boolean, p_disk_sizes jsonb, p_ignore_user_id text
)
returns table(host_id text, free_cpu numeric, free_ram_mb numeric, free_disk_gb numeric, needed_disk_gb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with occupied as materialized (select * from public.holder_placement_accounting(p_targets,p_skip_sleep)),
  actual as (
    select o.host_id, sum(o.cpu) cpu, sum(o.ram_mb) ram, sum(o.disk_gb) disk, sum(o.launching)::int launching
    from occupied o group by o.host_id
  ), powered as (
    select o.owner_id, sum(o.launched_cpu) cpu, sum(o.launched_ram_mb) ram
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

-- Only reserve a launch host capable of acting on the holder sleep policy.
create or replace function public.holder_admission_fit_host(
  p_targets text[], p_ratio numeric, p_skip_sleep boolean, p_disk_sizes jsonb,
  p_owner text, p_cpu numeric, p_ram_mb numeric, p_preferred text default null
)
returns text language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select a.host_id
  from public.holder_admission_host_availability(p_targets,p_ratio,p_skip_sleep,p_disk_sizes,p_owner) a
  join public.proxmox_hosts h on h.id=a.host_id and h.sleep_mode in ('canary','on')
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

-- Commit the tier label, chosen size and deferred container work in one
-- transaction. A stale read or a holder admission trigger rejects every row.
create or replace function public.apply_hermes_tier_allocations(
  p_owner text, p_holder boolean, p_tier text, p_changes jsonb
)
returns integer language plpgsql security invoker set search_path=pg_catalog,pg_temp
as $$
declare
  written integer;
begin
  if p_holder then
    perform pg_advisory_xact_lock(hashtextextended('holder-seat-funding-v1:' || p_owner, 0));
  end if;
  update public.hermes_instances h
  set resource_tier=p_tier, cpu_limit=c.cpu_limit, ram_limit=c.ram_limit, updated_at=now(),
      tier_change_pending=case
        when h.lifecycle_state is distinct from 'deleting' and h.lifecycle_state is distinct from 'deleted'
         and (h.cpu_limit is distinct from c.cpu_limit or h.ram_limit is distinct from c.ram_limit)
        then true else h.tier_change_pending end
  from jsonb_to_recordset(p_changes) as c(
    id uuid, previous_tier text, previous_cpu numeric, previous_ram integer, cpu_limit numeric, ram_limit integer
  )
  where h.id=c.id and h.user_id=p_owner and (h.seat_funding is not distinct from 'holder')=p_holder
    and h.status not in ('deleted','scheduled_for_deletion')
    and h.resource_tier is not distinct from c.previous_tier
    and h.cpu_limit is not distinct from c.previous_cpu and h.ram_limit is not distinct from c.previous_ram;
  get diagnostics written = row_count;
  if written <> jsonb_array_length(p_changes) then
    raise exception 'tier allocation changed before the update';
  end if;
  return written;
end;
$$;
revoke all on function public.apply_hermes_tier_allocations(text,boolean,text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_hermes_tier_allocations(text,boolean,text,jsonb) to service_role;
