-- Lifecycle email send ledger.
--
-- One row per (user, lifecycle email key) ever sent. The lifecycle-emails
-- cron checks this table before sending and inserts after a successful
-- Resend accept, so each lifecycle email goes out at most once per user
-- regardless of how often the cron runs or how its selection windows drift.
--
-- Rerun-safe: create table / create index guarded with IF NOT EXISTS.

create table if not exists public.lifecycle_email_sends (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  email_key text not null,
  sent_at timestamptz not null default now(),
  unique (user_id, email_key)
);

create index if not exists idx_lifecycle_email_sends_user
  on public.lifecycle_email_sends (user_id);

comment on table public.lifecycle_email_sends is
  'At-most-once ledger for lifecycle emails (day1/day3/day7/stalled). '
  'Written by /api/cron/lifecycle-emails after Resend accepts a send.';

-- Service-role only: the table is written exclusively by the cron via the
-- admin client. Lock out anon/authenticated like the other ops tables.
alter table public.lifecycle_email_sends enable row level security;
revoke all on public.lifecycle_email_sends from anon;
revoke all on public.lifecycle_email_sends from authenticated;
