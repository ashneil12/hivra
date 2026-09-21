-- Widen the managed_venice_financial_events.event_type CHECK constraint to:
--   1. add 'starter_grant' (Batch 3: one-time managed-Venice starter credit
--      granted on a user's first managed deploy via grantManagedVeniceStarterCredit).
--   2. re-assert 'reconciliation_refund', which already exists in the
--      ManagedVeniceFinancialEventType TS union and is written by
--      refundManagedVeniceOvercharge(), but was never added to the DB CHECK
--      (the original 20260512180000 migration predates that event type). That
--      is a latent gap: a reconciliation refund row would be rejected by the
--      constraint at insert time. This migration closes it.
--
-- Rerun-safe: drops the constraint IF EXISTS, then re-adds the full canonical
-- list. Append-only (a new migration file; the original is untouched).

alter table public.managed_venice_financial_events
  drop constraint if exists managed_venice_financial_events_event_type_check;

alter table public.managed_venice_financial_events
  add constraint managed_venice_financial_events_event_type_check
  check (
    event_type in (
      'token_deposit',
      'card_topup',
      'reservation_created',
      'reservation_captured',
      'reservation_released',
      'usage_capture',
      'subsidy_applied',
      'refund_exception',
      'reconciliation_adjustment',
      'reconciliation_refund',
      'starter_grant'
    )
  );
