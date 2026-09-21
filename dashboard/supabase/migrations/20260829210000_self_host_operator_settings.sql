create table if not exists public.self_host_operator_settings (
  operator_id text primary key,
  public_metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint self_host_operator_settings_single_identity
    check (operator_id = 'hivra-local-operator')
);

alter table public.self_host_operator_settings enable row level security;

revoke all on table public.self_host_operator_settings from anon, authenticated;
grant all on table public.self_host_operator_settings to service_role;

comment on table public.self_host_operator_settings is
  'Installation-local metadata for the single self-host operator. Service-role access only.';
