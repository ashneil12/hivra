-- Index managed_venice_financial_events for the per-user fast paths.
--
-- The table grows ~1 row per managed-Venice billing event (per inference for
-- subsidy/usage rows) across ALL users, but the only index today is the
-- idempotency unique index (managed_venice_financial_events_idempotency_idx,
-- migration 20260512180000). Hot per-user reads therefore seq-scan the whole
-- table:
--   - /api/billing/managed-venice/summary  → .eq(user_id).eq(event_type='subsidy_applied')
--   - getBillingActivity (activity.ts)      → .eq(user_id).order(created_at desc)
--   - loadManagedVeniceTopUpSubsidyState    → .eq(user_id) lookups
-- Every sibling activity table (credit_ledger_entries, payment_transactions,
-- llm_usage_events, managed_venice_usage_events …) already has a
-- (user_id, created_at) index; this is the odd one out.
--
-- (user_id, event_type, created_at desc) serves the summary filter
-- (user_id + event_type) and the activity ordering (user_id + created_at desc)
-- with a single index, turning a full seq scan into an index range-scan over
-- only this user's rows.
--
-- Pure index add (no data change), CREATE INDEX IF NOT EXISTS so it's
-- rerun-safe and applies cleanly in any order relative to the code.

create index if not exists managed_venice_financial_events_user_event_idx
  on public.managed_venice_financial_events (user_id, event_type, created_at desc);
