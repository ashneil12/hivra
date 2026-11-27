create table if not exists public.operator_usage_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_type text not null default 'internal_operator_canary',
  api_key_sha256 text not null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operator_usage_sources_api_key_sha256_len check (length(api_key_sha256) = 64),
  constraint operator_usage_sources_source_type_check check (source_type in ('internal_operator_canary', 'internal_operator_local', 'internal_operator_other'))
);

create table if not exists public.operator_usage_snapshots (
  source_id uuid not null references public.operator_usage_sources(id) on delete cascade,
  stat_date date not null,
  source_type text not null default 'internal_operator_canary',
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  estimated_cost_usd numeric(14, 6) not null default 0,
  sessions integer not null default 0,
  api_calls integer not null default 0,
  by_model jsonb not null default '{}'::jsonb,
  by_provider jsonb not null default '{}'::jsonb,
  source text not null default 'operator_usage_beacon',
  harvested_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, stat_date),
  constraint operator_usage_snapshots_nonnegative check (
    input_tokens >= 0 and output_tokens >= 0 and total_tokens >= 0 and
    cache_read_tokens >= 0 and reasoning_tokens >= 0 and estimated_cost_usd >= 0 and
    sessions >= 0 and api_calls >= 0
  )
);

create index if not exists operator_usage_snapshots_stat_date_idx
  on public.operator_usage_snapshots(stat_date);

alter table public.operator_usage_sources enable row level security;
alter table public.operator_usage_snapshots enable row level security;

do $restore$
begin
  if not exists (select 1 from pg_policy
      where polrelid = 'public.operator_usage_sources'::regclass
        and polname = 'operator_usage_sources_no_client_access') then
    create policy operator_usage_sources_no_client_access
      on public.operator_usage_sources for all using (false) with check (false);
  end if;

  if not exists (select 1 from pg_policy
      where polrelid = 'public.operator_usage_snapshots'::regclass
        and polname = 'operator_usage_snapshots_no_client_access') then
    create policy operator_usage_snapshots_no_client_access
      on public.operator_usage_snapshots for all using (false) with check (false);
  end if;

  if to_regprocedure('public.operator_usage_tokens_total()') is null then
    create function public.operator_usage_tokens_total()
    returns bigint
    language sql
    stable
    security definer
    set search_path = public, pg_temp
    as $total$
  select coalesce(sum(total_tokens + coalesce(cache_read_tokens, 0) + coalesce(reasoning_tokens, 0)), 0)::bigint
  from public.operator_usage_snapshots;
$total$;
  end if;
end;
$restore$;

revoke all on table public.operator_usage_sources, public.operator_usage_snapshots from public, anon, authenticated;
grant all on table public.operator_usage_sources, public.operator_usage_snapshots to service_role;
revoke all on function public.operator_usage_tokens_total() from public, anon, authenticated;
grant execute on function public.operator_usage_tokens_total() to service_role;

comment on table public.operator_usage_sources is
  'Internal HermesOS operator usage sources that may contribute to public token throughput without affecting prod deployment/customer/fleet counts.';
comment on table public.operator_usage_snapshots is
  'Daily token/session snapshots from registered internal operator/canary instances, segmented from prod instance_usage_snapshots.';
