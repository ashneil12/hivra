-- Token-tier qualifications for the hold-not-lock model.
--
-- A user qualifies for a Pro or Power tier by depositing $HermesOS into
-- their Bankr-provisioned wallet such that their balance meets or exceeds
-- the active threshold for that tier at the time of deposit.
--
-- Three core rules from BUILD_PLAN.md (locked spec, 2026-04-29):
--
--   1. Thresholds are denominated in TOKEN UNITS (base units), not USD.
--      Qualifying quantity is locked in at the moment of qualification;
--      price moves never trigger downgrade for existing holders.
--
--   2. New entrants pay the CURRENT threshold at the time they deposit.
--      Existing holders are grandfathered at their original quantity.
--
--   3. Two threshold epochs per Pro/Power exist: a launch promo rate
--      (first 30 days from public launch) and a standard rate (after the
--      launch window closes). The epoch the user qualified against is
--      recorded in `qualifying_threshold_tier` so the system always
--      knows which deal a holder is grandfathered into.
--
-- Re-qualification state machine (post-breach):
--   - 48h grace from breach. If balance returns above qualifying_quantity
--     within grace, currently_eligible flips back to true with no penalty.
--   - If grace expires, the row is suspended (last_suspend_at set,
--     cooldown_ends_at set to last_suspend_at + 7 days).
--   - During cooldown, re-qualification is blocked even if balance returns
--     above the current threshold.
--   - After cooldown, balance >= current threshold re-qualifies the user
--     at the CURRENT epoch's rate (not the original). This means a launch
--     entrant who breached and re-qualifies post-launch loses the launch
--     deal — they pay standard from then on.
--   - Re-qualification is capped at 2 per rolling 365-day window. A third
--     attempt within the window is rejected; the user must wait for the
--     window to roll over.
--
-- One row per (user_id, tier). Insert on first qualification, update
-- thereafter. The cron `refresh-token-holdings` (or its successor) is the
-- only writer; users have read access to their own rows for dashboard UX.

create table if not exists public.token_tier_qualifications (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  tier text not null check (tier in ('pro', 'power')),
  -- The threshold quantity at the time the user first qualified for this
  -- tier (or the time they re-qualified after dropping below). Stored as
  -- a base-units numeric so it scales to any token decimals without lossy
  -- floating-point.
  qualifying_quantity numeric(78, 0) not null check (qualifying_quantity > 0),
  -- The threshold value the system used at qualification time. Records the
  -- calibration the user qualified against, in case the threshold changes
  -- later. Same units as qualifying_quantity.
  threshold_at_qualification numeric(78, 0) not null check (threshold_at_qualification > 0),
  -- Which epoch this user qualified against. Persists the grandfathered
  -- "deal" — a user with PRO_LAUNCH keeps that deal until they re-qualify,
  -- at which point they get the active epoch's code (likely PRO_STANDARD
  -- once the launch window closes).
  qualifying_threshold_tier text not null
    check (qualifying_threshold_tier in (
      'PRO_LAUNCH', 'PRO_STANDARD', 'POWER_LAUNCH', 'POWER_STANDARD'
    )),
  qualified_at timestamptz not null default now(),
  -- True when the most recent balance read was at or above qualifying_quantity,
  -- OR when balance is below but we're still within the 48h grace window.
  currently_eligible boolean not null default true,
  -- Last balance the evaluator saw. Used for the dashboard UI and to detect
  -- transitions for email notifications.
  last_balance_seen numeric(78, 0),
  last_evaluated_at timestamptz,
  -- Set when balance drops below qualifying_quantity. Cleared on
  -- re-qualification or on grace recovery.
  last_breach_at timestamptz,
  -- Set when a breach hardens past the 48h grace window into a suspend.
  -- This is what starts the 7-day cooldown clock. Cleared on re-qualification.
  last_suspend_at timestamptz,
  -- Computed at suspend time as last_suspend_at + 7 days. Re-qualification
  -- attempts during this window are rejected. Cleared on re-qualification.
  cooldown_ends_at timestamptz,
  -- Rolling 365-day cap on re-qualifications. A user can re-qualify at
  -- most twice per window. The window starts at the FIRST re-qualification
  -- and rolls 365 days from there.
  requalification_count integer not null default 0
    check (requalification_count >= 0),
  requalification_window_start timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tier)
);

drop trigger if exists token_tier_qualifications_updated_at on public.token_tier_qualifications;
create trigger token_tier_qualifications_updated_at
  before update on public.token_tier_qualifications
  for each row execute function update_updated_at();

create index if not exists token_tier_qualifications_user_idx
  on public.token_tier_qualifications(user_id, tier);

create index if not exists token_tier_qualifications_currently_eligible_idx
  on public.token_tier_qualifications(currently_eligible, last_evaluated_at desc);

-- Useful for ops queries: "who is in cooldown right now?" and "who is
-- about to fall out of grace?"
create index if not exists token_tier_qualifications_cooldown_idx
  on public.token_tier_qualifications(cooldown_ends_at)
  where cooldown_ends_at is not null;

create index if not exists token_tier_qualifications_breach_idx
  on public.token_tier_qualifications(last_breach_at)
  where last_breach_at is not null and last_suspend_at is null;

alter table public.token_tier_qualifications enable row level security;

drop policy if exists "users can read own token tier qualifications" on public.token_tier_qualifications;
create policy "users can read own token tier qualifications"
  on public.token_tier_qualifications
  for select
  to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "service role manages token tier qualifications" on public.token_tier_qualifications;
create policy "service role manages token tier qualifications"
  on public.token_tier_qualifications
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.token_tier_qualifications from anon;
