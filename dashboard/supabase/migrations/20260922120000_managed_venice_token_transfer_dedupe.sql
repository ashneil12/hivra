-- Managed Venice $HermesOS deposits: one reconciliation item per on-chain
-- transfer, and an index for quote-anchored transfer attribution.
--
-- Settlement and the reconciler surface every transfer they cannot credit
-- (under-payments, over-ceiling or late payments, extra transfers, replays)
-- as a managed_venice_reconciliation_items row keyed by
--   dedupe_key = 'managed_venice_token_transfer:<lowercased tx>:<logIndex|na>'
-- (src/lib/billing/managed-venice-token-quotes.ts). The partial unique index
-- makes a repeat insert (every cron tick, the cron racing a user's check, a
-- bearer redelivery) fail with 23505, which the code treats as "already
-- surfaced", so each transfer is surfaced exactly once. Existing rows (usage
-- items, legacy token-deposit items) keep dedupe_key null and are unaffected.
--
-- The (deposit_address, quoted_at) index serves the reconciler's lookup of the
-- next managed-Venice quote on the same shared credit_deposit wallet, which
-- bounds which transfers belong to a quote.
--
-- Rerun-safe (if not exists). No data is rewritten.

alter table public.managed_venice_reconciliation_items
  add column if not exists dedupe_key text;

create unique index if not exists uq_managed_venice_reconciliation_items_dedupe_key
  on public.managed_venice_reconciliation_items (dedupe_key)
  where dedupe_key is not null;

create index if not exists ix_managed_venice_token_quotes_deposit_address_quoted_at
  on public.managed_venice_token_quotes (deposit_address, quoted_at);
