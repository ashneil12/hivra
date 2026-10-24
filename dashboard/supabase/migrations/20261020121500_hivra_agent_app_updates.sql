-- Aeon dashboard, OpenClaw and Agent Zero versions on Hivra agents.
--
-- WHY
-- Owners must be able to update every agent's software themselves (owner
-- rule, 2026-10-19). Claude Code and Codex already are
-- (20260925140000_hivra_agent_cli_updates). The three hosted apps now follow
-- the same pattern: a tested pin per app in the provisioner release
-- (provisioner/agent-app-versions.json), the computer reporting its installed
-- version on its authenticated /api/meta (agentApp), and Update now in Manage,
-- which runs the in-place connection-service update and, through it,
-- hivra-agent-app-update.sh on the computer.
--
-- The observation and request records are the same shape, so they share
-- public.hivra_agent_cli_updates: cli_name now names the CLI or the app, and
-- each version column also takes the forms these apps name versions in (an
-- Aeon upstream commit, an x.y.z OpenClaw release, an Agent Zero image
-- digest). Automatic updates stay CLI-only: the claim function is unchanged,
-- and the automatic-update sweep never selects app agents.
--
-- Additive: every row the old checks allowed still passes. Each constraint is
-- dropped and re-added under its own name, so the migration re-runs cleanly.

alter table public.hivra_agent_cli_updates
  drop constraint if exists hivra_agent_cli_updates_cli_name_check,
  drop constraint if exists hivra_agent_cli_updates_installed_version_check,
  drop constraint if exists hivra_agent_cli_updates_tested_version_check,
  drop constraint if exists hivra_agent_cli_updates_hivra_installed_version_check,
  drop constraint if exists hivra_agent_cli_updates_update_target_check,
  drop constraint if exists hivra_agent_cli_updates_requested_target_check,
  drop constraint if exists hivra_agent_cli_updates_auto_paused_target_check;

alter table public.hivra_agent_cli_updates
  add constraint hivra_agent_cli_updates_cli_name_check
    check (cli_name in ('claude-code', 'codex', 'aeon', 'openclaw', 'agent-zero')),
  add constraint hivra_agent_cli_updates_installed_version_check
    check (installed_version ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|[0-9a-f]{40}|sha256:[0-9a-f]{64})$'),
  add constraint hivra_agent_cli_updates_tested_version_check
    check (tested_version ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|[0-9a-f]{40}|sha256:[0-9a-f]{64})$'),
  add constraint hivra_agent_cli_updates_hivra_installed_version_check
    check (hivra_installed_version ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|[0-9a-f]{40}|sha256:[0-9a-f]{64})$'),
  add constraint hivra_agent_cli_updates_update_target_check
    check (update_target ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|[0-9a-f]{40}|sha256:[0-9a-f]{64})$'),
  add constraint hivra_agent_cli_updates_requested_target_check
    check (requested_target ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|[0-9a-f]{40}|sha256:[0-9a-f]{64})$'),
  -- Pauses follow only automatic updates, which only the CLIs get.
  add constraint hivra_agent_cli_updates_auto_paused_target_check
    check (auto_paused_target ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$');

comment on table public.hivra_agent_cli_updates is
  'Claude Code / Codex and Aeon / OpenClaw / Agent Zero version observations, update requests and the owner''s automatic-update choice (CLIs only) per Hivra agent; service role only.';
