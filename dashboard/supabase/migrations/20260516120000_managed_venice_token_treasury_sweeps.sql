-- Managed Venice $HermesOS treasury sweeps.
--
-- A settled managed_venice_token_quotes row means the user has received
-- spendable managed Venice inference credit. This migration adds the
-- separate treasury movement state that moves the actual $HERMESOS out of
-- the per-user Bankr deposit wallet and into the managed Venice treasury.

alter table public.managed_venice_token_quotes
  add column if not exists sweep_status text not null default 'pending',
  add column if not exists sweep_tx_hash text,
  add column if not exists sweep_attempted_at timestamptz,
  add column if not exists sweep_error text,
  add column if not exists sweep_destination_address text;

alter table public.managed_venice_token_quotes
  drop constraint if exists managed_venice_token_quotes_sweep_status_check;

alter table public.managed_venice_token_quotes
  add constraint managed_venice_token_quotes_sweep_status_check
  check (sweep_status in ('pending', 'swept', 'failed', 'skipped'));

create index if not exists managed_venice_token_quotes_sweep_retry_idx
  on public.managed_venice_token_quotes(sweep_status, settled_at)
  where status = 'settled' and sweep_status in ('pending', 'failed');

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
      'treasury_sweep'
    )
  );
