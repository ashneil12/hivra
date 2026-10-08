-- SYNTHETIC production overlay. Applied after the baseline (every migration that
-- is NOT in the chain) when building a stand-in for a production schema dump.
--
-- It models the KINDS of difference the Promote packet reports, with invented
-- objects. It is not a copy of anything on production, and it cannot stand in
-- for the real dump. What it models:
--   * extensions that only production has (queue, scheduler, outbound HTTP)
--   * tables that only production has (a search-console style set), RLS on
--   * a stale SECURITY DEFINER helper that anon can still execute, which the
--     chain's grant migrations are expected to close
--   * a table with an older same-named index, to prove the chain's
--     "create index if not exists" files skip it instead of failing
-- What it does NOT model: the real older column and constraint variants, the
-- real function bodies, production grants, cron.job contents.

create extension if not exists pg_net;
create extension if not exists pgmq;

create table public.seo_pages (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  last_crawled_at timestamptz
);
create table public.seo_keywords (
  id uuid primary key default gen_random_uuid(),
  page_id uuid references public.seo_pages(id) on delete cascade,
  keyword text not null
);
create table public.seo_gsc_queries (
  id uuid primary key default gen_random_uuid(),
  query text not null,
  clicks integer not null default 0
);
alter table public.seo_pages enable row level security;
alter table public.seo_keywords enable row level security;
alter table public.seo_gsc_queries enable row level security;

create function public.prod_only_stale_definer()
returns integer
language sql
security definer
set search_path = public
as 'select 1';
-- left callable by anon/authenticated on purpose (default privileges grant it)

-- older same-named index: the chain creates this name with "if not exists"
create index ix_yearly_token_quotes_user_quoted_at on public.yearly_token_quotes (user_id);
