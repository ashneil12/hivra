-- Performance-advisor RLS policy tuning (Supabase advisor, 2026-06-25).
-- Two semantics-preserving changes; no access behavior changes.
--
--   A. auth_rls_initplan (54 advisor line-items / 38 distinct policies): wrap
--      bare auth.uid()/auth.role()/auth.jwt()/auth.email() AND current_setting()
--      calls in a scalar subselect so Postgres evaluates them ONCE per query
--      (initplan) instead of once per row. The returned value is identical; only
--      evaluation timing changes. Self-discovering + idempotent: re-running skips
--      already-wrapped policies (they match 'select (auth.' / 'select (current_setting').
--      (No policy mixes the two function families, so per-policy wrapping is safe.)
--
--   B. multiple_permissive_policies (the wallet/token tables): the redundant
--      "service role manages ..." policies were TO public with qual
--      auth.role()='service_role'. service_role BYPASSES RLS, and anon/
--      authenticated were already denied by that qual, so scoping these TO
--      service_role removes the permissive-policy overlap with the per-user
--      SELECT policies WITHOUT changing who can read/write anything.
--
-- Intentionally NOT touched: the multiple-permissive overlaps on profiles,
-- instances and user_api_keys are legacy Clerk-migration dual policies
-- (requesting_user_id() vs auth.uid()); consolidating them needs a deliberate
-- review and is out of scope for a perf pass.

-- ── A. Wrap bare auth.*() calls (initplan) ──────────────────────────────────
DO $$
DECLARE
  r record;
  stmt text;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND ( qual ~ 'auth\.(uid|role|jwt|email)\(\)' OR with_check ~ 'auth\.(uid|role|jwt|email)\(\)'
         OR qual ~ 'current_setting\(' OR with_check ~ 'current_setting\(' )
      AND NOT ((coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* 'select \(*(auth\.|current_setting)')
  LOOP
    stmt := 'ALTER POLICY ' || quote_ident(r.policyname) || ' ON public.' || quote_ident(r.tablename);
    IF r.qual IS NOT NULL THEN
      stmt := stmt || ' USING (' || regexp_replace(
        regexp_replace(r.qual, 'auth\.(uid|role|jwt|email)\(\)', '(select auth.\1())', 'g'),
        '(current_setting\([^()]*\))', '(select \1)', 'g') || ')';
    END IF;
    IF r.with_check IS NOT NULL THEN
      stmt := stmt || ' WITH CHECK (' || regexp_replace(
        regexp_replace(r.with_check, 'auth\.(uid|role|jwt|email)\(\)', '(select auth.\1())', 'g'),
        '(current_setting\([^()]*\))', '(select \1)', 'g') || ')';
    END IF;
    EXECUTE stmt;
  END LOOP;
END $$;

-- ── B. Scope redundant service-role manage policies TO service_role ─────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('crypto_wallet_sweeps', 'service role manages crypto wallet sweeps'),
      ('token_entitlement_configs', 'service role manages token entitlement configs'),
      ('token_holding_snapshots', 'service role manages token snapshots'),
      ('user_wallets', 'service role manages wallets'),
      ('wallet_verification_challenges', 'service role manages wallet verification challenges')
    ) AS v(tbl, pol)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.pol) THEN
      EXECUTE format('ALTER POLICY %I ON public.%I TO service_role', r.pol, r.tbl);
    END IF;
  END LOOP;
END $$;
