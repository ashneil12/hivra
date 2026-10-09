-- SEO index coverage — Google's own view of whether our pages are indexed.
--
--   seo_index_coverage  one row per public URL from getSiteUrls(), holding the
--                       GSC URL Inspection API's index status. Written by
--                       /api/cron/seo/index-coverage.
--
-- Why this exists: seo_gsc_daily only records pages that earned an impression.
-- A page with zero rows there is ambiguous — it might not be indexed, or it
-- might be indexed and simply never surfacing. That ambiguity makes it
-- impossible to tell a crawl problem from a content-quality problem, which are
-- opposite fixes. The URL Inspection API answers it directly per URL.
--
-- Written/read ONLY by service-role code (supabaseAdmin in the cron route).
-- RLS enabled with NO policies — deny-all for anon + authenticated, service_role
-- bypasses — matching the other five tables in 20260715120000_seo_engine.sql.
--
-- Idempotent: create-if-not-exists throughout, so this is a no-op against an
-- already-migrated DB.

create table if not exists public.seo_index_coverage (
  url               text        primary key,
  site              text        not null,
  first_seen        timestamptz not null default now(),
  last_checked      timestamptz,
  -- indexStatusResult.verdict: PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
  verdict           text,
  -- Human-readable state, e.g. "Submitted and indexed",
  -- "Crawled - currently not indexed", "Discovered - currently not indexed".
  -- This is the field that actually tells you what to do.
  coverage_state    text,
  robots_txt_state  text,
  indexing_state    text,
  page_fetch_state  text,
  -- The URL Google picked as canonical vs the one we declared. A mismatch is
  -- the classic silent duplicate-content failure.
  google_canonical  text,
  user_canonical    text,
  last_crawl_time   timestamptz,
  notes             text,
  created_at        timestamptz not null default now()
);

-- The two questions this table gets asked: "what is not indexed?" (verdict)
-- and "what did we last check?" (last_checked, for staleness).
create index if not exists idx_seo_index_coverage_verdict
  on public.seo_index_coverage (verdict);

create index if not exists idx_seo_index_coverage_last_checked
  on public.seo_index_coverage (last_checked);

alter table public.seo_index_coverage enable row level security;
