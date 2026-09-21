-- Churn surveys — the one-question cancel save-flow answer.
--
-- One row per submission (a user may cancel more than once over their
-- lifetime, so no unique constraint on user_id). Written exclusively by
-- POST /api/billing/churn-survey via the service-role client; the modal
-- also fires a churn_survey_submitted PostHog event, but this table is the
-- durable record we can join against hermes_subscriptions.
--
-- Rerun-safe: create table / create index guarded with IF NOT EXISTS.

create table if not exists public.churn_surveys (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  plan text,
  reason text not null,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists idx_churn_surveys_user
  on public.churn_surveys (user_id);

create index if not exists idx_churn_surveys_created_at
  on public.churn_surveys (created_at);

comment on table public.churn_surveys is
  'Cancel save-flow survey answers (reason: too_expensive | not_using | '
  'missing_feature | something_broke | other). Written by '
  '/api/billing/churn-survey.';

-- Service-role only: written via the admin client from the authed route.
-- Lock out anon/authenticated like the other ops tables.
alter table public.churn_surveys enable row level security;
revoke all on public.churn_surveys from anon;
revoke all on public.churn_surveys from authenticated;
