-- Admit 'apple' as a credit_ledger_entries source for Apple IAP subscription
-- cycle grants (iOS lane, Phase 1).
--
-- Mirrors the DO-block drop/re-add pattern from
-- 20260613200000_credit_marketplace_reasons_and_guard.sql: the inline source
-- CHECK in the foundation migration (20260425120000) was auto-named by
-- Postgres, so resolve it dynamically instead of hardcoding the name.
-- Existing rows are unaffected; every previously-valid source stays valid.
--
-- MONEY change. Do NOT run by hand; applied on owner approval to BOTH DBs
-- with schema_migrations stamped identically.
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
    AND pg_get_constraintdef(c.oid) LIKE '%source%'
  ORDER BY c.conname
  LIMIT 1;

  IF existing_constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.credit_ledger_entries DROP CONSTRAINT %I',
      existing_constraint_name
    );
  END IF;

  ALTER TABLE public.credit_ledger_entries
    ADD CONSTRAINT credit_ledger_entries_source_check
    CHECK (
      source IN (
        'stripe',
        'bankr',
        'admin',
        'system',
        'apple'
      )
    );
END $$;
