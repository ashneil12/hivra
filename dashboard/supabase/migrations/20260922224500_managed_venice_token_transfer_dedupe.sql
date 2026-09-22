-- Managed Venice $HermesOS deposits: one reconciliation item per on-chain
-- transfer, durable surfacing for settled / in-review quotes, one claim or
-- review per deposit address and tx, and an index for quote-anchored transfer
-- attribution.
--
-- Settlement and the reconciler surface every transfer they cannot credit
-- (under-payments, over-ceiling or late payments, extra transfers, replays,
-- claim conflicts) as a managed_venice_reconciliation_items row keyed by
--   dedupe_key = 'managed_venice_token_transfer:<lowercased tx>:<lowercased deposit address>'
-- for a tx's first ERC-20 Transfer log to that address, and that key plus
-- ':<log index>' for any later log of the same tx to the same address
-- (src/lib/billing/managed-venice-token-quotes.ts). A transfer is one log, not
-- one tx: one tx can pay several users' deposit addresses (an ERC-4337
-- bundle, an exchange or disperse batch withdrawal) or one address twice, and
-- each of those transfers gets its own item. The first log is the lowest log
-- index among the tx's $HermesOS Transfer logs that pay the address. The
-- reconciler reads each log from its scan; the bearer settle route resolves a
-- delivery (tx and amount) from the tx receipt to the one such log carrying
-- that amount before it writes anything, and refuses it as retryable when
-- none or several do. So both key the same transfer identically, and never
-- key two transfers alike. The partial unique index makes a repeat insert
-- (every cron tick, the cron racing a user's check, a bearer redelivery) fail
-- with 23505, which the code treats as "already surfaced", so each transfer is
-- surfaced exactly once. Existing rows (usage items, legacy token-deposit items) keep
-- dedupe_key null and are unaffected.
--
-- A transfer is excluded from a quote only when it is bound on the SAME
-- deposit address (a quote claim or another quote's review trigger on the
-- address, a lot or yearly payment of the same user). A tx claimed on another
-- address stays attributable; because quotes.transaction_hash is unique per
-- tx it can never be claimed here, so the quote goes to manual review with
-- reason managed_venice_token_deposit_claim_conflict and one item.
--
-- uq_managed_venice_token_quotes_address_transfer_binding makes that binding
-- exclusive in the database: per deposit address (case-insensitive) at most
-- one quote holds a tx (case-insensitive), as its settlement claim
-- (transaction_hash) or, while in manual review without a claim, as its review
-- trigger (metadata->>'reviewTransactionHash', which a review writes instead
-- of transaction_hash). Settlement checks bindings with plain reads, so a
-- claim of a tx on one quote and a review of another quote on the same
-- address with the same tx could otherwise both commit (a bearer delivery
-- naming the wrong quote racing the reconciler), leaving money credited AND
-- an open item for it. The second writer's compare-and-set now fails with
-- 23505, writes nothing, and re-evaluates to transaction_already_claimed. The
-- same tx on different addresses (one tx paying several wallets) is allowed.
--
-- managed_venice_token_quotes.transfer_surfacing_pending is set to true in the
-- same compare-and-set update that settles a quote or sends it to manual
-- review. While it is true, the reconciler cron runs a surface-only pass over
-- the quote's own attribution range (window + 2 h grace, cut at the user's
-- next payment session): every confirmed transfer there that is not bound on
-- the quote's deposit address gets its item, including ones that confirm or
-- arrive after the quote went terminal, a later log of the credited tx, and
-- ones whose item insert failed after the flip. The pass clears the flag once
-- the chain is confirmed a 30-block finality margin past that range. Legacy rows
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

create unique index if not exists uq_managed_venice_token_quotes_address_transfer_binding
  on public.managed_venice_token_quotes (
    lower(deposit_address),
    lower(coalesce(
      transaction_hash,
      case when status = 'manual_review_required' then metadata->>'reviewTransactionHash' end
    ))
  )
  where coalesce(
    transaction_hash,
    case when status = 'manual_review_required' then metadata->>'reviewTransactionHash' end
  ) is not null;

create index if not exists ix_managed_venice_token_quotes_deposit_address_quoted_at
  on public.managed_venice_token_quotes (deposit_address, quoted_at);

alter table public.managed_venice_token_quotes
  add column if not exists transfer_surfacing_pending boolean not null default false;

create index if not exists ix_managed_venice_token_quotes_transfer_surfacing_pending
  on public.managed_venice_token_quotes (created_at desc)
  where transfer_surfacing_pending;
