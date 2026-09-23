-- One spendable deposit lot per managed-Venice quote, in either platform token.
--
-- 20260606130100 made settlement's lot insert idempotent with a unique index
-- on quote_id WHERE source = 'hermesos_deposit'. $HIVRA deposits create lots
-- with source 'hivra_deposit' (20260923150000), which that index does not
-- cover: two concurrent completions of the same $HIVRA claim (the bearer
-- settle route racing the reconciler) could both insert a lot and credit the
-- deposit twice. This index covers both token deposit sources, so the second
-- insert fails with 23505 and settlement converges on the first lot.
--
-- Safe on existing data: the old index already kept $HermesOS deposit lots
-- unique per quote, and no $HIVRA lot exists before activation. Rerun-safe.

create unique index if not exists uq_managed_venice_token_lots_token_deposit_quote
  on public.managed_venice_token_lots (quote_id)
  where source in ('hermesos_deposit', 'hivra_deposit') and quote_id is not null;
