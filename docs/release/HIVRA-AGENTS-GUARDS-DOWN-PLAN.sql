-- hivra_agents guards: DOWN PLAN (emergency script, never auto-applied)
--
-- WHAT THIS IS
--   Drops every trigger and CHECK constraint that the 16 "NOT-AS-IS" chain files
--   (docs/release/PROMOTE-PACKET-2026-10-08.md section 4.2) put on
--   public.hivra_agents, so the build that was live before the cutover can write
--   to the table again if a guard rejects one of its writes. Nothing else.
--
-- WHEN TO RUN IT
--   Only when the old build is live AGAINST the migrated schema and its writes to
--   hivra_agents are being rejected by one of the guards named below. It is the
--   owner's call. No agent, cron, migration runner or deploy step applies it. It
--   lives under docs/release/ on purpose, NOT under dashboard/supabase/migrations/.
--   Preferred recovery when the new build is the broken one is to Promote the
--   rollback target and fix forward; do not touch the database to make the old
--   build happy unless it is actually blocked.
--
-- WHAT IT LOSES
--   While these guards are gone the database no longer enforces, for
--   hivra_agents rows:
--     * the deployment authority matrix (managed vs self-managed rows, the
--       self-managed binding and revision checks, the rollback fuse)
--     * the lifecycle operation shape and its compatibility normaliser
--     * provider computer ownership, the installer, native and desktop fences,
--       and the provider identity and install shape checks
--     * lease and terminal-evidence guards for attachments, desktop preparation
--       and private access, and the restore-while-attached guard
--     * the gVisor and managed-session identity and cleanup guards
--     * the managed provisioner channel immutability rule
--     * the CPU and RAM envelope checks, the Windows ISO source check, the
--       desired-state and binding-token-hash checks
--   The NEW build relies on these. Do not run the new build against the table
--   while they are off: it can write rows its own readers will refuse. After
--   running this, the way back to the new build is the re-arm script
--   (HIVRA-AGENTS-GUARDS-REARM.sql), which re-validates every row.
--
-- WHAT IT KEEPS
--   Columns, defaults, indexes, row level security, the primary key, foreign keys,
--   the trigger functions, and every guard that was introduced by a file outside
--   the 16 (see docs/release/PROD-CHAIN-REHEARSAL.md for that list and why none of
--   them rejected an old-shaped write in the rehearsal). Row data is not touched.
--
-- HOW IT WAS CHECKED
--   Rehearsed by scripts/release/prod-chain-rehearsal.mjs on a SYNTHETIC
--   production-shaped schema: after the chain, this script was applied, the
--   guards it names were confirmed gone and exactly those, the old-build write
--   probe passed, and the re-arm script restored an identical guard set. It has
--   not been run against a dump of the real database.
--
-- Run as the migration owner, in a short window. One transaction; if any
-- statement fails nothing changes.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- triggers ---------------------------------------------------------------
-- 20260826130000_hivra_agent_authority_operations
drop trigger if exists a_hivra_agents_operation_compatibility on public.hivra_agents;
drop trigger if exists hivra_agents_deployment_authority_guard on public.hivra_agents;
-- 20260828010000_provider_computer_ownership
drop trigger if exists hivra_agents_provider_ownership_guard on public.hivra_agents;
-- 20260828020000_provider_installer_operation_fence
drop trigger if exists hivra_agents_provider_installer_guard on public.hivra_agents;
-- 20260831235500_provider_native_access_binding
drop trigger if exists hivra_agents_provider_native_access_guard on public.hivra_agents;
-- 20260905140000_managed_provisioner_channels
drop trigger if exists hivra_agents_managed_provisioner_channel_guard on public.hivra_agents;
-- 20260905150000_hivra_desktop_prepare_lifecycle
drop trigger if exists hivra_desktop_prepare_lease_guard on public.hivra_agents;
-- 20260905220000_provider_desktop_lifecycle
drop trigger if exists hivra_agents_provider_desktop_access_guard on public.hivra_agents;
drop trigger if exists hivra_agents_provider_desktop_lifecycle_guard on public.hivra_agents;
-- 20260906190000_hivra_attachment_lease
drop trigger if exists hivra_agent_attachment_lease_guard on public.hivra_agents;
-- 20260915153000_hivra_private_access
drop trigger if exists hivra_private_access_lease_guard on public.hivra_agents;
-- 20260915170000_hivra_gvisor_computers
drop trigger if exists hivra_gvisor_computer_guard on public.hivra_agents;
-- 20260923120000_digitalocean_managed_agent_sessions
drop trigger if exists hivra_do_managed_session_guard on public.hivra_agents;
-- 20260925100200_hivra_agent_attachment_lifecycle
drop trigger if exists hivra_agent_attachment_operation_lease_guard on public.hivra_agents;
drop trigger if exists hivra_restore_while_attached_guard on public.hivra_agents;
drop trigger if exists hivra_agents_detach_on_computer_delete on public.hivra_agents;

-- CHECK constraints ------------------------------------------------------
-- 20260826130000_hivra_agent_authority_operations (operation_shape_check is
-- redefined by 20260905150000, 20260906190000, 20260915153000 and 20260925100200)
alter table public.hivra_agents drop constraint if exists hivra_agents_binding_token_hash_check;
alter table public.hivra_agents drop constraint if exists hivra_agents_deployment_authority_matrix_check;
alter table public.hivra_agents drop constraint if exists hivra_agents_deployment_mode_check;
alter table public.hivra_agents drop constraint if exists hivra_agents_desired_state_check;
alter table public.hivra_agents drop constraint if exists hivra_agents_operation_shape_check;
-- 20260828010000_provider_computer_ownership (both redefined by 20260915170000
-- and 20260923120000)
alter table public.hivra_agents drop constraint if exists hivra_agents_computer_substrate_check;
alter table public.hivra_agents drop constraint if exists hivra_agents_provider_identity_check;
-- 20260828020000_provider_installer_operation_fence
alter table public.hivra_agents drop constraint if exists hivra_agents_provider_install_shape_check;
-- 20260831235500_provider_native_access_binding
alter table public.hivra_agents drop constraint if exists hivra_provider_native_access_shape;
-- 20260831235900_provider_native_gateway_credentials
alter table public.hivra_agents drop constraint if exists hivra_provider_native_running_no_api_token;
-- 20260905140000_managed_provisioner_channels
alter table public.hivra_agents drop constraint if exists hivra_agents_canary_provisioner_binding_check;
alter table public.hivra_agents drop constraint if exists hivra_agents_managed_provisioner_channel_check;
-- 20260905220000_provider_desktop_lifecycle
alter table public.hivra_agents drop constraint if exists hivra_provider_desktop_access_shape;
-- 20260915143000_windows_iso_source
alter table public.hivra_agents drop constraint if exists hivra_agents_windows_iso_source_check;
-- 20260915150000_hivra_resource_envelopes
alter table public.hivra_agents drop constraint if exists hivra_agents_cpu_max_valid;
alter table public.hivra_agents drop constraint if exists hivra_agents_ram_max_valid;
-- 20260915170000_hivra_gvisor_computers
alter table public.hivra_agents drop constraint if exists hivra_agents_gvisor_observation_check;
-- 20260923120000_digitalocean_managed_agent_sessions (redefined by 20260924101500)
alter table public.hivra_agents drop constraint if exists hivra_agents_do_session_identity_check;

commit;
