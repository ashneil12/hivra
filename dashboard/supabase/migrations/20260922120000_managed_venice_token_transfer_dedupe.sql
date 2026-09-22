-- Managed Venice $HermesOS deposits: one reconciliation item per on-chain
-- transfer, durable surfacing for settled / in-review quotes, and an index for
-- quote-anchored transfer attribution.
--
-- Settlement and the reconciler surface every transfer they cannot credit
-- (under-payments, over-ceiling or late payments, extra transfers, replays)
-- as a managed_venice_reconciliation_items row keyed by
--   dedupe_key = 'managed_venice_token_transfer:<lowercased tx>'
-- (src/lib/billing/managed-venice-token-quotes.ts). The key is the tx hash
-- alone, so the bearer settle route (which has no log index) and the
-- reconciler key the same transfer identically. The partial unique index
-- makes a repeat insert (every cron tick, the cron racing a user's check, a
-- bearer redelivery) fail with 23505, which the code treats as "already
-- surfaced", so each transfer is surfaced exactly once. Existing rows (usage
-- items, legacy token-deposit items) keep dedupe_key null and are unaffected.
--
-- managed_venice_token_quotes.transfer_surfacing_pending is set to true in the
-- same compare-and-set update that settles a quote or sends it to manual
-- review. While it is true, the reconciler cron runs a surface-only pass over
-- the quote's own attribution range (window + 2 h grace, cut at the user's
-- next payment session): every confirmed transfer there that is not bound to
-- a quote or lot tx gets its item, including ones that confirm or arrive after
-- the quote went terminal and ones whose item insert failed after the flip.
-- The pass clears the flag once that range is fully confirmed. Legacy rows
-- default to false, so quotes settled or reviewed before this migration are
-- never rescanned. The partial index serves the cron's newest-first query for
-- quotes that still owe a pass.
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

alter table public.managed_venice_token_quotes
  add column if not exists transfer_surfacing_pending boolean not null default false;

create index if not exists ix_managed_venice_token_quotes_transfer_surfacing_pending
  on public.managed_venice_token_quotes (created_at desc)
  where transfer_surfacing_pending;
