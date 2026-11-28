set local lock_timeout = '2s';

create function public.hivra_deep_hibernate_allowed(p_plan_key text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_plan_key in ('holder'), false);
$$;

comment on function public.hivra_deep_hibernate_allowed(text) is
  'Allowlist of server-recorded per-seat funding keys eligible for disk offload. Extend only when admission records a new authoritative lower-tier key. Price strings, account plan, and hardware are not per-seat authority.';

revoke all on function public.hivra_deep_hibernate_allowed(text) from public, anon, authenticated, service_role;

create function public.guard_hivra_deep_hibernate_store()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.sleep_store_job_id is not null
    and not public.hivra_deep_hibernate_allowed(new.seat_funding)
    and (tg_op = 'INSERT' or new.sleep_store_job_id is distinct from old.sleep_store_job_id
      or new.seat_funding is distinct from old.seat_funding)
  then
    raise exception 'computer funding is ineligible for disk offload' using errcode='55000';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_hivra_deep_hibernate_store() from public, anon, authenticated, service_role;

create trigger guard_hivra_deep_hibernate_store before insert or update of sleep_store_job_id, seat_funding
on public.hivra_agents for each row execute function public.guard_hivra_deep_hibernate_store();

do $$
begin
  if exists (select 1 from public.hivra_agents a where a.sleep_store_job_id is not null
    and not public.hivra_deep_hibernate_allowed(a.seat_funding))
  then
    raise exception 'ineligible disk offload is in flight; let it settle before installing the guard' using errcode='55000';
  end if;
end;
$$;

create or replace function public.hivra_sleep_store_candidates(p_cutoff timestamptz, p_limit integer)
returns table (id uuid, proxmox_host text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.id, a.proxmox_host
    from public.hivra_agents a
   where a.status = 'running'
     and a.desired_state = 'running'
     and a.sleep_state = 'hibernated'
     and a.operation_id is null
     and a.deployment_mode = 'hivra-managed'
     and a.computer_substrate = 'proxmox-kvm'
     and a.deployment_target_id is null
     and public.hivra_deep_hibernate_allowed(a.seat_funding)
     and a.sleep_tier_changed_at <= p_cutoff
     and a.sleep_memory_dropped_at is not null
     and a.sleep_memory_dropped_at >= a.sleep_tier_changed_at
     and a.sleep_stored_at is null
     and a.sleep_store_job_id is null
     and a.sleep_unstore_requested_at is null
     and a.sleep_unstore_job_id is null
     and (a.sleep_store_tried_at is null or a.sleep_store_tried_at < now() - interval '1 day')
     and (a.next_wake_at is null or a.next_wake_at > now() + interval '1 day')
   order by a.sleep_tier_changed_at asc
   limit greatest(1, least(coalesce(p_limit, 10), 100));
$$;

revoke all on function public.hivra_sleep_store_candidates(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.hivra_sleep_store_candidates(timestamptz, integer) to service_role;
