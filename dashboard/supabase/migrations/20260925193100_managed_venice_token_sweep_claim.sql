-- Managed-Venice platform-token treasury sweep: an atomic claim and an
-- in-doubt state.
--
-- Why: the sweep read settled quotes in 'pending' or 'failed' and transferred
-- with no claim. Two overlapping runs could both transfer the same quote's
-- amount, and a transfer whose response was lost (a timeout, a 5xx) was marked
-- 'failed' and sent again on the next run. The deposit wallet is usually the
-- user's shared credit_deposit wallet, so the second transfer took other
-- funds (an unswept yearly payment, a later deposit) into the treasury.
--
-- The sweep now follows the yearly sweep's state machine
-- (20260922222737_yearly_token_payment_attribution.sql):
--   * sweep_status 'sweeping': claimed by one sweeper with a compare-and-set
--     from 'pending'/'failed'; sweep_attempted_at is the claim's token.
--   * sweep_status 'needs_operator': terminal. The transfer's outcome is
--     unknown, or a claim went stale after a transfer was submitted. Never
--     retried automatically.
--   * sweep_submitted_at: stamped under the claim right before Bankr is asked
--     to transfer, so a stale claim is retried only when nothing was sent.
--
-- Additive and rerun-safe: no rows change. The check constraint only widens,
-- so the previous code keeps working. Existing 'failed' rows carry no submit
-- marker and stay retryable, as before.

alter table public.managed_venice_token_quotes
  add column if not exists sweep_submitted_at timestamptz;

alter table public.managed_venice_token_quotes
  drop constraint if exists managed_venice_token_quotes_sweep_status_check;
alter table public.managed_venice_token_quotes
  add constraint managed_venice_token_quotes_sweep_status_check
  check (sweep_status in ('pending', 'sweeping', 'swept', 'failed', 'skipped', 'needs_operator'));

-- Stale-claim recovery reads 'sweeping' rows by claim age.
create index if not exists ix_managed_venice_token_quotes_sweep_claims
  on public.managed_venice_token_quotes (sweep_attempted_at)
  where sweep_status = 'sweeping';
