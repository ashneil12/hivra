-- Supabase's default table ACL grants ALL to service_role before an explicit
-- GRANT adds permissions. Narrowing requires revocation first; otherwise
-- DELETE/TRUNCATE/TRIGGER (including trigger-bypassing TRUNCATE) survive.
-- Keep the already-applied operation-fence migration and its history intact.
revoke all on table public.hivra_provider_power_operations from public,anon,authenticated,service_role;
grant select,insert,update on table public.hivra_provider_power_operations to service_role;
