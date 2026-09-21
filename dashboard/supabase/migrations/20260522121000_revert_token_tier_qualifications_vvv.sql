-- Revert the out-of-band `token_tier_qualifications_vvv` migration.
--
-- That migration was applied directly to the canary database (it was never
-- committed to this repo). It extended `token_tier_qualifications` with a
-- `token` discriminator ('hermesos' | 'vvv') and a 'boost' tier so VVV could
-- ride the shared $HERMESOS hold-not-lock state machine.
--
-- We instead ship the Venice compute boost as its OWN isolated table
-- (`venice_compute_boost_qualifications`, 20260522120000) so that a 'boost'
-- row can never leak into the Pro/Power entitlement reads — several callers
-- (resolveEffectiveSubscription, refresh-token-tiers) query this table
-- WITHOUT a token filter and map any non-'power' eligible row to operator
-- compute, which would have wrongly granted paid compute to a free VVV holder.
--
-- This restores `token_tier_qualifications` to its original 20260429150000
-- shape. The table is empty in every environment, so the column drop and
-- constraint swaps are safe. Idempotent (drop ... if exists / if not exists).

-- Indexes that reference the `token` column must go before the column drop.
drop index if exists public.token_tier_qualifications_vvv_eligible_idx;
drop index if exists public.token_tier_qualifications_user_token_tier_idx;

-- Restore the original unique key on (user_id, tier).
alter table public.token_tier_qualifications
  drop constraint if exists token_tier_qualifications_user_token_tier_key;
alter table public.token_tier_qualifications
  drop constraint if exists token_tier_qualifications_user_id_tier_key;
alter table public.token_tier_qualifications
  add constraint token_tier_qualifications_user_id_tier_key unique (user_id, tier);

-- Restore the original tier check (no 'boost').
alter table public.token_tier_qualifications
  drop constraint if exists token_tier_qualifications_tier_check;
alter table public.token_tier_qualifications
  add constraint token_tier_qualifications_tier_check
    check (tier in ('pro', 'power'));

-- Restore the original qualifying_threshold_tier check (no 'VVV_COMPUTE_BOOST').
alter table public.token_tier_qualifications
  drop constraint if exists token_tier_qualifications_qualifying_threshold_tier_check;
alter table public.token_tier_qualifications
  add constraint token_tier_qualifications_qualifying_threshold_tier_check
    check (qualifying_threshold_tier in (
      'PRO_LAUNCH', 'PRO_STANDARD', 'POWER_LAUNCH', 'POWER_STANDARD'
    ));

-- Restore the original (user_id, tier) lookup index.
create index if not exists token_tier_qualifications_user_idx
  on public.token_tier_qualifications(user_id, tier);

-- Finally drop the discriminator column itself.
alter table public.token_tier_qualifications
  drop column if exists token;
