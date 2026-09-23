-- Close five SECURITY DEFINER functions to the API roles.
--
-- A read-only check on canary (2026-09-23) found anon and authenticated could
-- execute these through PostgREST (/rest/v1/rpc). Two causes:
--   * The three balance-guard trigger functions were never revoked, so they
--     kept PostgreSQL's default EXECUTE for PUBLIC plus the explicit
--     anon/authenticated/service_role grants Supabase's default privileges add
--     to every new public function.
--   * record_cron_heartbeat and refresh_credit_account_cached_balance revoked
--     the explicit anon/authenticated grants but not PUBLIC's, and both roles
--     inherit EXECUTE through PUBLIC.
-- Revoking from public, anon and authenticated together closes both paths.
--
-- Who still needs EXECUTE:
--   * The trigger functions: no role. PostgreSQL checks EXECUTE on a trigger
--     function when the trigger is created, not when it fires, so the overdraft
--     guards keep running for every inserting role. Nothing calls them
--     directly, so service_role's default grant goes too.
--   * record_cron_heartbeat and refresh_credit_account_cached_balance:
--     service_role only. Their sole callers use the service-role admin client
--     (src/lib/cron-heartbeat.ts, src/lib/billing/credits.ts).
--
-- Rerun-safe: revoke and grant are idempotent.

revoke all on function public.enforce_credit_reservation_balance()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_managed_venice_card_balance()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_managed_venice_reservation_balance()
  from public, anon, authenticated, service_role;

revoke all on function public.record_cron_heartbeat(text)
  from public, anon, authenticated;
grant execute on function public.record_cron_heartbeat(text)
  to service_role;

revoke all on function public.refresh_credit_account_cached_balance(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_credit_account_cached_balance(uuid)
  to service_role;
