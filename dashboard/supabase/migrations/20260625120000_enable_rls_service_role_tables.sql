-- Enable Row Level Security on public tables that are accessed ONLY via the
-- service-role client (supabaseAdmin), which bypasses RLS. With RLS off these
-- tables were reachable by the anon/authenticated roles via PostgREST using the
-- public NEXT_PUBLIC_SUPABASE_ANON_KEY (shipped to the browser) — a data
-- exposure flagged by the Supabase security advisor (rls_disabled_in_public,
-- level ERROR). A code audit confirmed there are zero non-service-role reads of
-- these tables, so enabling RLS with NO policies (deny-all for anon +
-- authenticated; service_role bypasses) closes the hole without breaking the app.
--
-- Idempotent + guarded: ENABLE on an already-enabled table is a no-op, and the
-- IF EXISTS check skips tables absent on a given environment (e.g. canary has
-- neither referral table, and hivra_agents already has RLS enabled there).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_templates',
    'user_memory',
    'hivra_agents',
    'hivra_agent_events',
    'referral_codes',
    'referral_attributions',
    'pools'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
