-- Wave 6.1: credit-economy safety foundation for the builder marketplace.
--
-- Two independent, idempotent parts:
--   1. Widen the credit_ledger_entries reason CHECK to admit the three new
--      marketplace/transfer money flows (keeps all existing reasons).
--   2. Add the missing overdraft guard on credit_reservations. Today the table
--      only enforces amount_credits > 0 and non-empty reason/reference_id; a
--      generic reservation can over-reserve past the user's available balance
--      under concurrency (two check-then-act callers both pass the app-level
--      check, both insert). This BEFORE INSERT trigger makes the check atomic
--      with the insert, mirroring the managed-Venice reservation guard
--      (20260606140100).
--
-- MONEY change. Do NOT run by hand; applied on owner approval to BOTH DBs.

-- --------------------------------------------------------------------------
-- Part 1: widen the credit_ledger_entries reason CHECK.
--
-- Mirrors the DO-block drop/re-add pattern from
-- 20260504120000_allow_agent_instance_backend.sql. The inline check in the
-- foundation migration (20260425120000) was auto-named
-- credit_ledger_entries_reason_check by Postgres; resolve it dynamically so we
-- never fight a renamed constraint. Existing rows are unaffected.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  existing_constraint_name text;
BEGIN
  SELECT c.conname
    INTO existing_constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'credit_ledger_entries'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%reason%'
  ORDER BY c.conname
  LIMIT 1;

  IF existing_constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.credit_ledger_entries DROP CONSTRAINT %I',
      existing_constraint_name
    );
  END IF;

  ALTER TABLE public.credit_ledger_entries
    ADD CONSTRAINT credit_ledger_entries_reason_check
    CHECK (
      reason IN (
        'stripe_topup',
        'subscription_grant',
        'admin_adjustment',
        'refund',
        'bonus_credit',
        'compute_debit',
        'llm_debit',
        'crypto_topup',
        'marketplace_purchase',
        'marketplace_earn',
        'transfer'
      )
    );
END $$;

-- --------------------------------------------------------------------------
-- Part 2: overdraft guard on credit_reservations.
--
-- Available balance is computed from the CREDIT ledger:
--   available = sum(credit_ledger_entries.amount_credits for the user)
--             - sum(active credit_reservations.amount_credits for the user)
-- The NEW row is not yet counted (BEFORE INSERT), so the existing available
-- must cover it. Only active reservations consume balance. Idempotent retries
-- (a row with the same (user_id, reason, reference_id) already exists — the
-- upsert in createCreditReservation conflicts on exactly that key) reserve
-- nothing new and are exempt, so a racing retry is never wrongly rejected. A
-- per-user transaction advisory lock serializes concurrent reserve/debit so a
-- second insert blocks until the first commits and then sees it in the sum.
--
-- Rerun-safe: create-or-replace + drop/recreate trigger.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_credit_reservation_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available bigint;
BEGIN
  -- Only newly-created active reservations consume balance.
  IF new.status IS DISTINCT FROM 'active' THEN
    RETURN new;
  END IF;

  -- Same (user_id, reason, reference_id) already present => idempotent retry
  -- whose INSERT will be turned into an ON CONFLICT DO UPDATE by
  -- createCreditReservation. It reserves nothing new, so skip the balance
  -- check (otherwise a racing retry could be wrongly rejected once the
  -- original reservation is counted).
  IF EXISTS (
    SELECT 1 FROM public.credit_reservations
    WHERE user_id = new.user_id
      AND reason = new.reason
      AND reference_id = new.reference_id
  ) THEN
    RETURN new;
  END IF;

  -- Serialize concurrent reserve/debit for this user.
  PERFORM pg_advisory_xact_lock(hashtext('credit_reservation:' || new.user_id));

  v_available :=
    coalesce((SELECT sum(amount_credits) FROM public.credit_ledger_entries
              WHERE user_id = new.user_id), 0)
    - coalesce((SELECT sum(amount_credits) FROM public.credit_reservations
                WHERE user_id = new.user_id AND status = 'active'), 0);

  -- NEW row is not yet counted (BEFORE INSERT), so the existing available must
  -- cover it.
  IF new.amount_credits > v_available THEN
    RAISE EXCEPTION 'credit_reservation_insufficient_balance: available=% requested=%',
      v_available, new.amount_credits
      USING errcode = 'P0001';
  END IF;

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_credit_reservation_balance ON public.credit_reservations;
CREATE TRIGGER trg_enforce_credit_reservation_balance
  BEFORE INSERT ON public.credit_reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_credit_reservation_balance();
