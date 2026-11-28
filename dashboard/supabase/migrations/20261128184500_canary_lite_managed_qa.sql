alter table public.hivra_canary_lite_qa_settings
  add column if not exists managed_enabled boolean not null default false,
  add column if not exists managed_model text,
  add column if not exists managed_proxy_key_id uuid,
  add column if not exists managed_proxy_key_enc text;

create table if not exists public.hivra_canary_lite_managed_qa_requests (
  owner_id text not null check (owner_id ~ '^user_[A-Za-z0-9]+$'),
  request_id uuid not null,
  reference_id uuid not null unique,
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);

alter table public.hivra_canary_lite_managed_qa_requests enable row level security;
revoke all on table public.hivra_canary_lite_managed_qa_requests from public, anon, authenticated, service_role;
grant insert on table public.hivra_canary_lite_managed_qa_requests to service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.hivra_canary_lite_qa_settings'::regclass
      and conname = 'hivra_canary_lite_managed_qa_requires_config'
  ) then
    alter table public.hivra_canary_lite_qa_settings
      add constraint hivra_canary_lite_managed_qa_requires_config check (
        not managed_enabled or (enabled and managed_model is not null
          and managed_proxy_key_id is not null and managed_proxy_key_enc is not null)
      );
  end if;
end $$;
