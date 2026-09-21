-- Database Security: lock down SECURITY DEFINER functions that still carry the
-- default PUBLIC EXECUTE grant, so the anon/authenticated PostgREST roles can no
-- longer invoke them via /rest/v1/rpc/<fn>.
--
-- These functions were added after 20260402150000_revoke_rpc_public_access.sql
-- (which bulk-revoked the functions that existed then), so they were never
-- locked down:
--   * claim_hermes_chat_stream_jobs (added 2026-04-23) — server-side worker
--     claim. SECURITY DEFINER, and it bypasses the per-user RLS on
--     hermes_chat_stream_jobs to lease jobs across all users, so it must only
--     ever run as service_role, never as a public/anon caller.
--   * reservations_set_updated_at (added 2026-04-29) — a trigger function;
--     never meant to be called over the API at all.
--
-- Flagged by Supabase security advisors:
--   0028_anon_security_definer_function_executable
--   0029_authenticated_security_definer_function_executable

revoke execute on function public.claim_hermes_chat_stream_jobs(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.claim_hermes_chat_stream_jobs(text, integer, integer, uuid) from public, anon, authenticated;
revoke execute on function public.reservations_set_updated_at() from public, anon, authenticated;

-- Keep the server-side worker path working (idempotent; service_role already
-- holds an explicit grant on these in both prod and canary).
grant execute on function public.claim_hermes_chat_stream_jobs(text, integer, integer) to service_role;
grant execute on function public.claim_hermes_chat_stream_jobs(text, integer, integer, uuid) to service_role;
