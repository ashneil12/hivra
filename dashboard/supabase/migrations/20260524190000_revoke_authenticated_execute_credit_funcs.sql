-- Revoke authenticated/anon/public EXECUTE on SECURITY DEFINER credit + trigger funcs
--
-- The canary security advisor (0029_authenticated_security_definer_function_executable)
-- flagged these SECURITY DEFINER functions as executable by the `authenticated` role.
-- They take an arbitrary p_user_id and perform NO caller authorization, so any logged-in
-- user could call them via /rest/v1/rpc/<fn> to grant/reset/drain credits on any account
-- (privilege escalation). The legitimate callers are server-side and use service_role; the
-- two *_updated_at functions are trigger functions (triggers fire regardless of EXECUTE
-- grant). This converges canary to the PROD ACL, which is already {postgres, service_role}.
--
-- Revoking from PUBLIC is the load-bearing part; anon/authenticated are revoked defensively.

revoke execute on function public.add_credits(text, integer) from public, anon, authenticated;
grant  execute on function public.add_credits(text, integer) to service_role;

revoke execute on function public.add_credits(text, numeric) from public, anon, authenticated;
grant  execute on function public.add_credits(text, numeric) to service_role;

revoke execute on function public.deduct_credits(text, numeric, text, text, integer, integer, text) from public, anon, authenticated;
grant  execute on function public.deduct_credits(text, numeric, text, text, integer, integer, text) to service_role;

revoke execute on function public.reset_credits(text, integer) from public, anon, authenticated;
grant  execute on function public.reset_credits(text, integer) to service_role;

revoke execute on function public.reset_credits(uuid, integer) from public, anon, authenticated;
grant  execute on function public.reset_credits(uuid, integer) to service_role;

revoke execute on function public.update_user_api_keys_updated_at() from public, anon, authenticated;
grant  execute on function public.update_user_api_keys_updated_at() to service_role;

revoke execute on function public.update_user_balances_updated_at() from public, anon, authenticated;
grant  execute on function public.update_user_balances_updated_at() to service_role;
