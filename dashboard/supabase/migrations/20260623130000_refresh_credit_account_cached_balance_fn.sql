-- Atomic recompute of a credit account's cached balance.
--
-- appendCreditLedgerEntry (src/lib/billing/credits.ts) previously derived the
-- balance in app code: read all ledger rows, sum them, then
--   UPDATE credit_accounts SET balance_cached_credits = <snapshot>.
-- Two concurrent appends could each compute a stale snapshot and the later
-- UPDATE could overwrite the newer one, transiently UNDERCOUNTING the cached
-- balance until the next write.
--
-- This function recomputes the sum from the ledger and writes it in a SINGLE
-- statement, so concurrent callers each write a fresh, fully-committed sum and
-- no update is lost. The app calls it via
--   rpc('refresh_credit_account_cached_balance', { p_account_id })
-- and FALLS BACK to the old derive+update path when this function is absent, so
-- the code is safe to deploy in any order relative to this migration.
--
-- Rerun-safe (CREATE OR REPLACE). SECURITY DEFINER so the admin client writes
-- without a per-call grant; locked out for anon/authenticated like the other
-- service-role-only billing helpers.

create or replace function public.refresh_credit_account_cached_balance(p_account_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.credit_accounts
  set balance_cached_credits = (
        select coalesce(sum(amount_credits), 0)
        from public.credit_ledger_entries
        where account_id = p_account_id
      ),
      updated_at = now()
  where id = p_account_id
  returning balance_cached_credits;
$$;

revoke all on function public.refresh_credit_account_cached_balance(uuid) from anon;
revoke all on function public.refresh_credit_account_cached_balance(uuid) from authenticated;
