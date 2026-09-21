-- Belt-and-suspenders for the settlement double-credit guard.
--
-- settleManagedVeniceTokenQuote (src/lib/billing/managed-venice-token-quotes.ts)
-- now checks for an existing lot before inserting, but a check-then-insert
-- still has a true-concurrency window: two settlements of the same quote could
-- both pass the existence check and both insert a spendable lot (double
-- credit). A deposit produces exactly one lot per quote, so this partial
-- unique index makes the second concurrent insert fail with 23505 — which the
-- settlement code already tolerates as "already credited".
--
-- Safe to add: a deposit lot is 1:1 with its quote_id (verified no duplicates
-- exist on canary). Rerun-safe (if not exists).

create unique index if not exists uq_managed_venice_token_lots_deposit_quote
  on public.managed_venice_token_lots (quote_id)
  where source = 'hermesos_deposit' and quote_id is not null;
