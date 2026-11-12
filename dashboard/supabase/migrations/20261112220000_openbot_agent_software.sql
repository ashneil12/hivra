-- OpenBot (CopilotKit) on a Hivra computer: its software record, its in-place
-- update, and its canonical resource surfaces.
--
-- WHY
-- An OpenBot computer runs CopilotKit's official OpenBot image. Hivra pins no
-- version: like Hermes, its update target (and the "tested" version a row
-- compares against) is the word 'latest', and the installed version is the
-- x.y.z release the image names. The version patterns already allow both, so
-- only the app name is added.
--
-- Additive and idempotent: every row the old checks allowed still passes, each
-- constraint is dropped and re-added under its own name, and each function is
-- patched in place from its stored definition only when it lacks 'openbot'.

alter table public.hivra_agent_cli_updates
  drop constraint if exists hivra_agent_cli_updates_cli_name_check;

alter table public.hivra_agent_cli_updates
  add constraint hivra_agent_cli_updates_cli_name_check
    check (cli_name in ('claude-code', 'codex', 'aeon', 'openclaw', 'agent-zero', 'hermes', 'openbot'));

comment on table public.hivra_agent_cli_updates is
  'Claude Code / Codex and Aeon / OpenClaw / Agent Zero / Hermes / OpenBot version observations, update requests and the owner''s automatic-update choice (CLIs only) per Hivra agent; service role only.';

-- The provider-VM runtime update claim, and the canonical surfaces and
-- actions, list the hosted agent types; each gains 'openbot' next to the
-- type it is modelled on. Each anchor appears exactly once.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.claim_hivra_provider_runtime_update(text,uuid,uuid)',
     '''agent-zero'',''hermes'')',
     '''agent-zero'',''hermes'',''openbot'')'),
    ('public.hivra_canonical_surfaces(text,jsonb,boolean,boolean)',
     '''agent-zero'',''deepseek-harness'')',
     '''agent-zero'',''deepseek-harness'',''openbot'')'),
    ('public.hivra_canonical_actions(text,jsonb,boolean,boolean)',
     '''agent-zero'',''deepseek-harness'',''aeon'')',
     '''agent-zero'',''deepseek-harness'',''aeon'',''openbot'')')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position(addition in definition) > 0 then continue; end if;
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'OpenBot agent type anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
