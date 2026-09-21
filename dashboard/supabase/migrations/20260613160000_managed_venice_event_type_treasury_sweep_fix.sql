-- Corrective re-assert of managed_venice_financial_events.event_type CHECK.
--
-- The 20260613150000 migration re-built this constraint from the TS union but
-- OMITTED 'treasury_sweep' — a real event_type written by the managed-Venice
-- token treasury sweeps (present in prod data + the original 20260512180000
-- constraint). On canary 20260613150000 applied to an empty table (no failure)
-- but left the constraint wrongly missing treasury_sweep; on prod it would have
-- failed outright against existing treasury_sweep rows. This re-asserts the FULL
-- canonical list so both forks converge regardless of which 20260613150000
-- variant they carry.
--
-- Rerun-safe (drop IF EXISTS + re-add). Append-only (new file).
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
      'treasury_sweep',
      'reconciliation_refund',
      'starter_grant'
    )
  );
