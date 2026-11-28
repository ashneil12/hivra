create table if not exists public.hivra_canary_lite_qa_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  owner_id text check (owner_id ~ '^user_[A-Za-z0-9]+$'),
  expires_at timestamptz check (isfinite(expires_at)),
  worker_origin text,
  signing_secret_enc text,
  check (not enabled or (owner_id is not null and expires_at is not null
    and worker_origin is not null and signing_secret_enc is not null))
);

alter table public.hivra_canary_lite_qa_settings enable row level security;
revoke all on table public.hivra_canary_lite_qa_settings from public, anon, authenticated, service_role;
grant select on table public.hivra_canary_lite_qa_settings to service_role;
