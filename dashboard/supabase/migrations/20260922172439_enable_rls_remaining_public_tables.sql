-- Close the remaining rls_disabled_in_public (ERROR) findings from the Supabase
-- security advisor. These tables sat in the PostgREST-exposed public schema
-- with RLS off and default anon/authenticated grants, so anyone holding the
-- browser-shipped NEXT_PUBLIC_SUPABASE_ANON_KEY could read, edit and delete
-- every row.
--
--   instance_deletion_archives — never covered by an earlier RLS sweep.
--   referral_codes / referral_attributions — listed in
--     20260625120000_enable_rls_service_role_tables, but present with RLS off
--     on canary (the sweep's IF EXISTS guard skipped them there).
--
-- Every app read/write goes through supabaseAdmin (service role, bypasses RLS):
-- src/lib/referral.ts and src/app/api/cron/purge-expired/route.ts. The stats
-- RPCs that read these tables (get_public_stats, get_platform_stats,
-- get_agents_deployed_stats, compute_platform_stats_snapshot) are SECURITY
-- DEFINER owned by postgres, so they are unaffected. RLS with no policies is
-- deny-all for anon + authenticated.
--
-- Idempotent + guarded so it applies cleanly on every environment.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'instance_deletion_archives',
    'referral_codes',
    'referral_attributions'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
