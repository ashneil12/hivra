-- Hermes Agent on a Hivra computer: its software record and its provider-VM update.
--
-- WHY
-- A Hermes computer runs the official Hermes, installed and updated by Hermes's
-- own tools (`hermes update`). Hivra does not pin a version for it, so its
-- software row follows the same shape as the other hosted apps with two
-- differences: cli_name may be 'hermes', and an update's target (and the
-- "tested" version the row compares against) is the word 'latest', meaning
-- whatever Hermes's own updater finds. The installed version stays an x.y.z.
--
-- Additive: every row the old checks allowed still passes. Each constraint is
-- dropped and re-added under its own name, so the migration re-runs cleanly.

alter table public.hivra_agent_cli_updates
  drop constraint if exists hivra_agent_cli_updates_cli_name_check,
  drop constraint if exists hivra_agent_cli_updates_tested_version_check,
  drop constraint if exists hivra_agent_cli_updates_update_target_check,
  drop constraint if exists hivra_agent_cli_updates_requested_target_check;

alter table public.hivra_agent_cli_updates
  add constraint hivra_agent_cli_updates_cli_name_check
    check (cli_name in ('claude-code', 'codex', 'aeon', 'openclaw', 'agent-zero', 'hermes')),
  add constraint hivra_agent_cli_updates_tested_version_check
    check (tested_version ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|[0-9a-f]{40}|sha256:[0-9a-f]{64}|latest)$'),
  add constraint hivra_agent_cli_updates_update_target_check
    check (update_target ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|[0-9a-f]{40}|sha256:[0-9a-f]{64}|latest)$'),
  add constraint hivra_agent_cli_updates_requested_target_check
    check (requested_target ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|[0-9a-f]{40}|sha256:[0-9a-f]{64}|latest)$');

comment on table public.hivra_agent_cli_updates is
  'Claude Code / Codex and Aeon / OpenClaw / Agent Zero / Hermes version observations, update requests and the owner''s automatic-update choice (CLIs only) per Hivra agent; service role only.';

-- A provider-VM Hermes computer can be updated in place like the other hosted
-- apps. The claim function's allow-list of agent types gains 'hermes'; the
-- function is patched in place from its stored definition, so nothing else in
-- it is restated here. The anchor appears exactly once. Idempotent.
do $migration$
declare signature constant text := 'public.claim_hivra_provider_runtime_update(text,uuid,uuid)';
  anchor constant text := '''agent-zero'')';
  addition constant text := '''agent-zero'',''hermes'')';
  definition text;
begin
  definition := pg_get_functiondef(signature::regprocedure);
  if position(addition in definition) > 0 then return; end if;
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'Provider runtime update anchor mismatch: %', signature;
  end if;
  execute replace(definition, anchor, addition);
end;
$migration$;
