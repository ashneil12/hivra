create table if not exists public.hivra_canary_launch_pilots (
  pilot text primary key check (pilot in ('hermes', 'bux-dependencies')),
  host_id text not null check (host_id ~ '^[a-z0-9][a-z0-9-]*$'),
  image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  owner_id text check (owner_id ~ '^user_[A-Za-z0-9]+$'),
  standby_enabled boolean not null default false,
  check (owner_id is not null or (pilot = 'hermes' and not standby_enabled)),
  check (not standby_enabled or pilot = 'hermes')
);

alter table public.hivra_canary_launch_pilots enable row level security;
revoke all on table public.hivra_canary_launch_pilots from public, anon, authenticated, service_role;
grant select on table public.hivra_canary_launch_pilots to service_role;
