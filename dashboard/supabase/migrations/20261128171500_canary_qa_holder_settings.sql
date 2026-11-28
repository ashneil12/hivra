create table public.hivra_canary_qa_holder_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  owner_id text check (owner_id ~ '^user_[A-Za-z0-9]+$'),
  expires_at timestamptz check (isfinite(expires_at)),
  check (not enabled or (owner_id is not null and expires_at is not null))
);

alter table public.hivra_canary_qa_holder_settings enable row level security;
revoke all on table public.hivra_canary_qa_holder_settings from public, anon, authenticated, service_role;
grant select on table public.hivra_canary_qa_holder_settings to service_role;
