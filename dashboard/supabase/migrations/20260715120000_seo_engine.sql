-- SEO data plane — the storage layer for the SEO engine:
--
--   seo_gsc_daily      daily Google Search Console page+query performance rows,
--                      one per (date, site, page, query). Written by the
--                      /api/cron/seo/gsc-pull cron and scripts/seo/gsc-backfill.ts.
--   seo_page_inventory one row per public URL from getSiteUrls() (the sitemap
--                      source of truth). Written by /api/cron/seo/inventory-check:
--                      HTTP status, redirect target, canonical correctness.
--   seo_targets        keyword targets the engine is working toward (cluster,
--                      intent, target URL, priority).
--   seo_actions        proposed/executed SEO actions with score + rationale and
--                      an optional PR URL + result payload.
--   seo_indexing_log   log of indexing submissions (IndexNow / GSC) per URL.
--
-- All five tables are written/read ONLY by service-role code (supabaseAdmin in
-- cron routes and the local backfill script). Row Level Security is enabled
-- with NO policies — deny-all for anon + authenticated; service_role bypasses —
-- matching 20260625120000_enable_rls_service_role_tables.sql so the tables are
-- never reachable through PostgREST with the public anon key.
--
-- Idempotent: create-if-not-exists throughout, so this is a no-op against an
-- already-migrated DB.

create table if not exists public.seo_gsc_daily (
  date        date        not null,
  site        text        not null,
  page        text        not null,
  query       text        not null,
  clicks      integer     not null default 0,
  impressions integer     not null default 0,
  ctr         float8      not null default 0,
  position    float8      not null default 0,
  created_at  timestamptz not null default now(),
  primary key (date, site, page, query)
);

-- Time-series reads ("how did this site/page trend?") scan by site + date;
-- the PK leads with date so it doesn't serve those.
create index if not exists idx_seo_gsc_daily_site_date
  on public.seo_gsc_daily (site, date);

create index if not exists idx_seo_gsc_daily_page
  on public.seo_gsc_daily (page);

create table if not exists public.seo_page_inventory (
  url             text        primary key,
  kind            text,
  first_seen      timestamptz not null default now(),
  last_checked    timestamptz,
  last_status     integer,
  redirect_target text,
  canonical_ok    boolean,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_seo_page_inventory_last_status
  on public.seo_page_inventory (last_status);

create table if not exists public.seo_targets (
  id         bigint      generated always as identity primary key,
  keyword    text        not null unique,
  cluster    text,
  intent     text,
  target_url text,
  status     text        not null default 'open',
  priority   integer     not null default 50,
  notes      text,
  created_at timestamptz not null default now()
);

create index if not exists idx_seo_targets_status_priority
  on public.seo_targets (status, priority);

create table if not exists public.seo_actions (
  id          bigint      generated always as identity primary key,
  created_at  timestamptz not null default now(),
  action_type text,
  target      text,
  score       float8,
  rationale   text,
  status      text        not null default 'proposed',
  pr_url      text,
  result      jsonb
);

create index if not exists idx_seo_actions_status
  on public.seo_actions (status);

create index if not exists idx_seo_actions_created_at
  on public.seo_actions (created_at);

create table if not exists public.seo_indexing_log (
  id         bigint      generated always as identity primary key,
  created_at timestamptz not null default now(),
  url        text,
  method     text,
  status     integer,
  detail     text
);

create index if not exists idx_seo_indexing_log_url
  on public.seo_indexing_log (url);

create index if not exists idx_seo_indexing_log_created_at
  on public.seo_indexing_log (created_at);

-- Service-role only: RLS on, zero policies (deny-all for anon/authenticated;
-- the service role bypasses RLS). ENABLE on an already-enabled table is a no-op.
alter table public.seo_gsc_daily      enable row level security;
alter table public.seo_page_inventory enable row level security;
alter table public.seo_targets        enable row level security;
alter table public.seo_actions        enable row level security;
alter table public.seo_indexing_log   enable row level security;
