-- Venice compute-boost qualifications.
--
-- A user on a PAID tier (operator/fleet/command, reached via Stripe card OR
-- $HERMESOS token qualification) who ALSO holds >= $199 of VVV (Venice's
-- token, valued via DEX) earns +1 vCPU / +2 GB RAM per instance on top of
-- their tier. This table tracks ONLY the "holds enough VVV" half — the
-- paid-tier gate is applied at spec-resolution time (tier-specs.isPaidTier),
-- so a free holder is recorded as eligible here but gets no boost until they
-- upgrade, at which point the boost applies with no re-evaluation needed.
--
-- Grace model (deliberately simpler than token_tier_qualifications — this is
-- a bonus, not a paid entitlement, so there is no cooldown / re-qualification
-- cap):
--   - currently_eligible = true once value held >= threshold.
--   - On a drop below threshold, last_breach_at is set; currently_eligible
--     stays true through a 48h grace window.
--   - If value recovers within grace, last_breach_at clears, no penalty.
--   - If grace expires while still below, currently_eligible flips to false.
--
-- One row per user. The `refresh-token-holdings` cron is the only writer;
-- users have read access to their own row for dashboard UX.

create table if not exists public.venice_compute_boost_qualifications (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  -- True when the most recent valuation was at/above the USD threshold, OR
  -- below it but still within the 48h grace window.
  currently_eligible boolean not null default false,
  -- USD threshold the user was evaluated against (audit; lets us change the
  -- threshold later without losing what each row qualified under).
  threshold_usd numeric(12, 2) not null,
  -- Last VVV balance the evaluator saw, in raw base units (numeric so it
  -- scales to 18-decimal tokens without lossy floats).
  last_balance_seen numeric(78, 0),
  -- Last computed USD value of the holding (balance * DEX price).
  last_usd_value numeric(20, 6),
  -- DEX price-per-VVV string used at the last evaluation (audit).
  last_vvv_price_usd text,
  last_evaluated_at timestamptz,
  -- Set when value drops below threshold. Cleared on recovery within grace
  -- or on the flip to ineligible after grace expires.
  last_breach_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

drop trigger if exists venice_compute_boost_qualifications_updated_at
  on public.venice_compute_boost_qualifications;
create trigger venice_compute_boost_qualifications_updated_at
  before update on public.venice_compute_boost_qualifications
  for each row execute function update_updated_at();

create index if not exists venice_compute_boost_qualifications_user_idx
  on public.venice_compute_boost_qualifications(user_id);

-- Cron reads "who is currently boost-eligible" every tick.
create index if not exists venice_compute_boost_qualifications_eligible_idx
  on public.venice_compute_boost_qualifications(currently_eligible, last_evaluated_at desc);

-- Ops: "who is about to fall out of grace?"
create index if not exists venice_compute_boost_qualifications_breach_idx
  on public.venice_compute_boost_qualifications(last_breach_at)
  where last_breach_at is not null;

alter table public.venice_compute_boost_qualifications enable row level security;

drop policy if exists "users can read own venice compute boost qualifications"
  on public.venice_compute_boost_qualifications;
create policy "users can read own venice compute boost qualifications"
  on public.venice_compute_boost_qualifications
  for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "service role manages venice compute boost qualifications"
  on public.venice_compute_boost_qualifications;
create policy "service role manages venice compute boost qualifications"
  on public.venice_compute_boost_qualifications
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.venice_compute_boost_qualifications from anon;
