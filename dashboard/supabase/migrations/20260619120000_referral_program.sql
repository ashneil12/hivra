-- Invite & Earn referral program (paioclaw rip-list).
--
-- Two account-scoped tables, both keyed on the Clerk user_id string (there is NO
-- public.users table — identity is the Clerk user_id everywhere in this schema,
-- exactly like credit_accounts / user_memory / hivra_agents).
--
--   referral_codes        — one stable share code per user. The user's invite
--                           link is built from this code at read time.
--   referral_attributions — one row per *referee* (unique on referee_user_id), so
--                           a given new user can only ever be attributed to one
--                           referrer, recorded at signup (Clerk user.created).
--                           `status` walks pending → rewarded; `rewarded_at`
--                           stamps when both sides were granted their bonus.
--
-- Service-role only, mirroring user_memory: no RLS, no anon/authenticated grants,
-- no PostgREST exposure path. Everything is written/read through supabaseAdmin in
-- src/lib/referral.ts. Idempotent (create-if-not-exists throughout) so this is a
-- no-op against an already-migrated DB and safe to land behind the OFF-by-default
-- NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED flag before it is applied.

create table if not exists public.referral_codes (
  id         uuid        primary key default gen_random_uuid(),
  user_id    text        not null unique,
  code       text        not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_referral_codes_code
  on public.referral_codes (code);

comment on table public.referral_codes is
  'One stable invite code per Clerk user (Invite & Earn). The share link is built '
  'from this code at read time. Service-role only via src/lib/referral.ts.';

create table if not exists public.referral_attributions (
  id               uuid        primary key default gen_random_uuid(),
  referee_user_id  text        not null unique,
  referrer_user_id text        not null,
  code             text        not null,
  status           text        not null default 'pending',
  created_at       timestamptz not null default now(),
  rewarded_at      timestamptz
);

create index if not exists idx_referral_attributions_referrer
  on public.referral_attributions (referrer_user_id);

create index if not exists idx_referral_attributions_status
  on public.referral_attributions (status);

comment on table public.referral_attributions is
  'One row per referee (unique on referee_user_id) recording who referred them, '
  'set at Clerk user.created. status: pending -> rewarded; rewarded_at stamps the '
  'moment both sides were granted their bonus_credit. Service-role only.';
