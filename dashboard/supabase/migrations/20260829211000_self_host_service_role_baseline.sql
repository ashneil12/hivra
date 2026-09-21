-- A schema copied from a hosted Supabase project does not carry the platform's
-- default service_role grants into a fresh CLI database. Hivra's server routes
-- use that role, so a source-only install otherwise has tables but cannot read
-- or write them. Restore the hosted baseline, then reapply the four deliberate
-- append-only/journal restrictions introduced by later security migrations.
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

alter default privileges for role postgres in schema public
  grant all privileges on tables to service_role;
alter default privileges for role postgres in schema public
  grant all privileges on sequences to service_role;

revoke all on table public.hivra_provider_power_operations from service_role;
grant select, insert, update on table public.hivra_provider_power_operations to service_role;

revoke all on table public.hivra_model_key_operations from service_role;
grant select on table public.hivra_model_key_operations to service_role;

revoke all on table public.hivra_launch_model_requests from service_role;
grant select on table public.hivra_launch_model_requests to service_role;

revoke all on table public.infrastructure_external_cleanup_resolutions from service_role;
grant select on table public.infrastructure_external_cleanup_resolutions to service_role;
