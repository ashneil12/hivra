-- Add a `purpose` column to bankr_deposit_wallet_credentials so a single
-- user can hold separate Bankr-provisioned wallets for distinct uses:
--
--   credit_deposit  — receives USDC top-ups that mint platform credits.
--   hermesos_lock   — receives $HERMESOS deposits for tier eligibility
--                     (the hold-not-lock model). Same wallet shape, but
--                     never swept into the credit ledger.
--
-- The application code (src/lib/billing/bankr-deposit-wallets.ts) has
-- already been written against this schema — it filters by `purpose`
-- and upserts on (user_id, purpose). Without this column, every read
-- and every provision throws "column ... does not exist" and the
-- /dashboard/wallet page surfaces a generic Bankr error.
--
-- Backwards compatibility:
--   - Existing rows (if any) default to 'credit_deposit', matching the
--     pre-purpose semantic where each user had exactly one row.
--   - The legacy `unique (user_id)` constraint is dropped because a
--     user may now legitimately have one credit_deposit row AND one
--     hermesos_lock row. Replaced with `unique (user_id, purpose)`.

alter table public.bankr_deposit_wallet_credentials
  add column if not exists purpose text not null default 'credit_deposit'
    check (purpose in ('credit_deposit', 'hermesos_lock'));

-- Drop the auto-generated unique constraint on (user_id) only; keep
-- the unique constraints on bankr_wallet_id, wallet_id, and
-- normalized_evm_address — those identify the underlying wallet and
-- must stay globally unique regardless of purpose.
alter table public.bankr_deposit_wallet_credentials
  drop constraint if exists bankr_deposit_wallet_credentials_user_id_key;

alter table public.bankr_deposit_wallet_credentials
  drop constraint if exists bankr_deposit_wallet_credentials_user_purpose_key;

alter table public.bankr_deposit_wallet_credentials
  add constraint bankr_deposit_wallet_credentials_user_purpose_key
  unique (user_id, purpose);

-- Index supporting the dominant query: find a user's credential for a
-- specific purpose. Without this, every wallet-page read is a seq scan
-- on the table.
create index if not exists bankr_deposit_wallet_credentials_user_purpose_idx
  on public.bankr_deposit_wallet_credentials(user_id, purpose);
