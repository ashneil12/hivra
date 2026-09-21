-- Segment internal operator/canary usage so public prod token counters can include
-- genuine HermesOS operator throughput without inflating prod deployments,
-- customers, builders, or fleet gauges.

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

create index if not exists operator_usage_sources_active_idx
  on public.operator_usage_sources(active) where active;
create index if not exists operator_usage_snapshots_stat_date_idx
  on public.operator_usage_snapshots(stat_date);
create index if not exists operator_usage_snapshots_source_type_idx
  on public.operator_usage_snapshots(source_type, stat_date);

alter table public.operator_usage_sources enable row level security;
alter table public.operator_usage_snapshots enable row level security;

drop policy if exists operator_usage_sources_no_client_access on public.operator_usage_sources;
create policy operator_usage_sources_no_client_access
  on public.operator_usage_sources for all
  using (false)
  with check (false);

drop policy if exists operator_usage_snapshots_no_client_access on public.operator_usage_snapshots;
create policy operator_usage_snapshots_no_client_access
  on public.operator_usage_snapshots for all
  using (false)
  with check (false);

revoke all on public.operator_usage_sources from anon, authenticated;
revoke all on public.operator_usage_snapshots from anon, authenticated;
grant all on public.operator_usage_sources to service_role;
grant all on public.operator_usage_snapshots to service_role;

create or replace function public.operator_usage_tokens_total()
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(total_tokens + coalesce(cache_read_tokens, 0) + coalesce(reasoning_tokens, 0)), 0)::bigint
  from public.operator_usage_snapshots;
$$;
revoke all on function public.operator_usage_tokens_total() from public;
revoke all on function public.operator_usage_tokens_total() from anon, authenticated;
grant execute on function public.operator_usage_tokens_total() to service_role;

create or replace function public.roll_token_anchor()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total bigint := coalesce((select sum(tokens_total) from public.platform_stats_daily), 0)
    + public.operator_usage_tokens_total();
begin
  update public.platform_geo
  set
    tokens_anchor_prev = tokens_anchor_curr,
    tokens_anchor_prev_at = tokens_anchor_curr_at,
    tokens_anchor_curr = v_total,
    tokens_anchor_curr_at = now()
  where id = 1
    and (tokens_anchor_curr_at is null
         or date_trunc('hour', tokens_anchor_curr_at) < date_trunc('hour', now()));
end;
$$;
revoke all on function public.roll_token_anchor() from public;
revoke all on function public.roll_token_anchor() from anon, authenticated;
grant execute on function public.roll_token_anchor() to service_role;

create or replace function public.get_public_stats()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_cut90 date := (v_now at time zone 'utc')::date - 90;
  v_operator_tokens bigint := public.operator_usage_tokens_total();
  v_result jsonb;
begin
  v_result := jsonb_build_object(
    'generatedAt', v_now,
    'agentsDeployed',
      (select count(*) from public.hermes_instances where first_active_at is not null)
      + (select count(*) from public.instance_deletion_archives),
    'runningNow',
      (select count(*) from public.hermes_instances where lifecycle_state = 'active'),
    'builders',
      coalesce((select total_users from public.platform_geo where id = 1), 0),
    'tokensProcessed',
      coalesce((select sum(tokens_total) from public.platform_stats_daily), 0) + v_operator_tokens,
    'tokensAnchorPrev', (select tokens_anchor_prev from public.platform_geo where id = 1),
    'tokensAnchorPrevAt', (select tokens_anchor_prev_at from public.platform_geo where id = 1),
    'tokensAnchorCurr', (select tokens_anchor_curr from public.platform_geo where id = 1),
    'tokensAnchorCurrAt', (select tokens_anchor_curr_at from public.platform_geo where id = 1),
    'countries',
      coalesce((select distinct_countries from public.platform_geo where id = 1), 0),
    'models',
      (
        select count(distinct model_key) from (
          select key as model_key from public.platform_stats_daily p,
            lateral jsonb_object_keys(p.model_distribution) as keys(key)
          where p.stat_date > v_cut90 and p.model_distribution <> '{}'::jsonb
          union
          select key as model_key from public.operator_usage_snapshots o,
            lateral jsonb_object_keys(o.by_model) as keys(key)
          where o.stat_date > v_cut90 and o.by_model <> '{}'::jsonb
        ) models
      ),
    'providers',
      (
        select count(distinct provider_key) from (
          select key as provider_key from public.platform_stats_daily p,
            lateral jsonb_object_keys(p.provider_distribution) as keys(key)
          where p.stat_date > v_cut90 and p.provider_distribution <> '{}'::jsonb
          union
          select key as provider_key from public.operator_usage_snapshots o,
            lateral jsonb_object_keys(o.by_provider) as keys(key)
          where o.stat_date > v_cut90 and o.by_provider <> '{}'::jsonb
        ) providers
      ),
    'last7dDeployed',
      (select count(*) from public.hermes_instances where first_active_at > v_now - interval '7 days')
  );
  return v_result;
end;
$$;
revoke all on function public.get_public_stats() from public;
revoke all on function public.get_public_stats() from anon, authenticated;
grant execute on function public.get_public_stats() to service_role;

comment on table public.operator_usage_sources is
  'Internal HermesOS operator usage sources that may contribute to public token throughput without affecting prod deployment/customer/fleet counts.';
comment on table public.operator_usage_snapshots is
  'Daily token/session snapshots from registered internal operator/canary instances, segmented from prod instance_usage_snapshots.';
