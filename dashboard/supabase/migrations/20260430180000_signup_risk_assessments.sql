-- Per-user risk assessment captured at first instance provisioning, used to
-- gate free-tier abuse (crypto miners, port scanners, spam bots, etc).
--
-- One row per user (primary key on user_id). Upserted on every risk check
-- so the latest assessment is always queryable in O(1). Stripe / proxycheck
-- / FingerprintJS provide their own audit trails if we ever need to
-- reconstruct what the signals looked like at signup time; we keep `raw_signals`
-- as a jsonb dump for the same-session debugging case.
--
-- Decision semantics (enforced by check constraint):
--   - allow:        provisioning proceeds normally
--   - require_card: provisioning blocked until a Stripe SetupIntent succeeds
--                   for this user (card-on-file with $0 auth — no charge)
--   - block:        provisioning denied outright (e.g. confirmed Tor + disposable
--                   email + fingerprint collision with a banned account)
--
-- The card-on-file lifecycle is tracked inline rather than in a side table:
-- card_required_at is set when decision flips to require_card, and
-- card_satisfied_at + card_setup_intent_id + card_payment_method_id are
-- written by the Stripe webhook when setup_intent.succeeded fires.
--
-- RLS posture: end users may SELECT their own row (so support agents can
-- show "we're holding your account because <reason>" if asked). All writes
-- go through the service role, which bypasses RLS — there's deliberately no
-- INSERT/UPDATE/DELETE policy.

create table if not exists public.signup_risk_assessments (
    user_id text primary key,

    -- Network signals (from proxycheck.io)
    ip_address text,
    asn text,
    asn_organization text,
    country_code text,
    is_vpn boolean not null default false,
    is_proxy boolean not null default false,
    is_tor boolean not null default false,
    is_datacenter boolean not null default false,

    -- Email signals
    email_domain text,
    is_disposable_email boolean not null default false,

    -- Device signals (from FingerprintJS Pro)
    fingerprint_visitor_id text,
    fingerprint_request_id text,
    fingerprint_confidence numeric(3,2),

    -- Aggregated decision
    risk_score integer not null default 0
        check (risk_score >= 0 and risk_score <= 100),
    risk_tier text not null
        check (risk_tier in ('low', 'medium', 'high', 'critical')),
    decision text not null
        check (decision in ('allow', 'require_card', 'block')),

    -- Card-on-file tracking (Stripe SetupIntent)
    card_required_at timestamptz,
    card_satisfied_at timestamptz,
    card_setup_intent_id text,
    card_payment_method_id text,

    -- Raw provider responses for same-session debugging
    raw_signals jsonb not null default '{}'::jsonb,

    last_checked_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Fingerprint lookups: "how many accounts share this visitor_id?" — used
-- both at risk-check time (collision detection) and for ops investigations.
create index if not exists idx_signup_risk_assessments_fingerprint
    on public.signup_risk_assessments (fingerprint_visitor_id)
    where fingerprint_visitor_id is not null;

-- IP lookups: rate-limit / detect signup bursts from the same IP.
create index if not exists idx_signup_risk_assessments_ip
    on public.signup_risk_assessments (ip_address)
    where ip_address is not null;

-- SetupIntent webhook lookups: when setup_intent.succeeded fires we need
-- to find the matching row by intent id to mark card_satisfied_at.
create index if not exists idx_signup_risk_assessments_setup_intent
    on public.signup_risk_assessments (card_setup_intent_id)
    where card_setup_intent_id is not null;

create trigger signup_risk_assessments_updated_at
    before update on public.signup_risk_assessments
    for each row execute function update_updated_at();

alter table public.signup_risk_assessments enable row level security;

create policy "users read own risk assessment"
    on public.signup_risk_assessments for select
    using (auth.uid()::text = user_id);

comment on table public.signup_risk_assessments is
    'Latest free-tier abuse-prevention risk assessment per user. Gates instance provisioning via decision column.';
comment on column public.signup_risk_assessments.decision is
    'Gate decision: allow | require_card (card-on-file required first) | block (denied outright).';
comment on column public.signup_risk_assessments.risk_tier is
    'Bucketed risk_score for quick filtering: low (0-29) | medium (30-59) | high (60-84) | critical (85-100).';
comment on column public.signup_risk_assessments.raw_signals is
    'JSON dump of the raw provider responses (proxycheck, fingerprint, disposable-email check) for debugging.';
