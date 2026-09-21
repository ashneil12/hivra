-- A successful read-only host discovery is durable inspection evidence even
-- when no runtime has passed its stricter readiness check. Preserve readiness
-- status and revision; only record when the current connection was observed.

create or replace function public.record_infrastructure_host_discovery_time()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.infrastructure_connections
  set last_checked_at = greatest(coalesce(last_checked_at, new.observed_at), new.observed_at)
  where id = new.connection_id
    and user_id = new.user_id
    and revision = new.connection_revision;
  if not found then
    raise exception 'host discovery connection revision changed'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists infrastructure_host_discovery_record_inspection
  on public.infrastructure_host_discovery_snapshots;
create trigger infrastructure_host_discovery_record_inspection
  after insert on public.infrastructure_host_discovery_snapshots
  for each row execute function public.record_infrastructure_host_discovery_time();

revoke all on function public.record_infrastructure_host_discovery_time()
  from public, anon, authenticated;
