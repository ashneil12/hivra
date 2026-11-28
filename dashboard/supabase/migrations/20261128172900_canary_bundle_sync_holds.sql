create table if not exists public.hivra_canary_bundle_sync_holds (
  host_id text primary key check (host_id ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  version text not null check (version ~ '^[0-9]+([.][0-9]+){3}$'),
  expires_at timestamptz not null check (isfinite(expires_at))
);

alter table public.hivra_canary_bundle_sync_holds enable row level security;
revoke all on table public.hivra_canary_bundle_sync_holds from public, anon, authenticated, service_role;

create or replace function public.get_hivra_canary_bundle_sync_held(p_host_id text, p_installed_version text)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from public.hivra_canary_bundle_sync_holds h
    where h.host_id = p_host_id and h.expires_at > statement_timestamp()
      and (p_installed_version is null or h.version = p_installed_version)
  );
$$;

revoke all on function public.get_hivra_canary_bundle_sync_held(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_hivra_canary_bundle_sync_held(text, text) to service_role;
