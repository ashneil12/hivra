create table if not exists public.provider_model_catalogs (
    provider text primary key,
    models jsonb not null default '[]'::jsonb,
    model_count integer not null default 0,
    model_hash text,
    added_models text[] not null default '{}'::text[],
    removed_models text[] not null default '{}'::text[],
    last_error text,
    checked_at timestamptz,
    last_changed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.provider_model_catalogs enable row level security;

drop policy if exists "service role manages provider model catalogs" on public.provider_model_catalogs;
create policy "service role manages provider model catalogs"
    on public.provider_model_catalogs
    for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

revoke all on public.provider_model_catalogs from anon;
revoke all on public.provider_model_catalogs from authenticated;

create index if not exists provider_model_catalogs_checked_at_idx
    on public.provider_model_catalogs (checked_at desc);
