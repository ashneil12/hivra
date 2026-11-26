-- Universal catalog apps & agents: open software update tracking and canonical
-- surfaces for manifest-driven catalog apps so adding new open-source agents
-- and apps does not require per-slug constraint migrations.
--
-- WHY
-- Previously every new agent (OpenBot, Nuphos, ...) required a bespoke
-- migration expanding a closed CHECK list on public.hivra_agent_cli_updates
-- and patching three Postgres functions. Replacing the closed CHECK with a
-- validated slug pattern (excluding computer profiles) and supporting both the
-- Wave 1 catalog slugs and future catalog-app payloads keeps fail-closed
-- behavior for arbitrary unknown types while eliminating per-app migrations.
--
-- Additive and idempotent: every row previously allowed still passes, the
-- constraint is dropped and re-added under its own name, and each function is
-- patched in place from its stored definition only when not already patched.

alter table public.hivra_agent_cli_updates
  drop constraint if exists hivra_agent_cli_updates_cli_name_check;

alter table public.hivra_agent_cli_updates
  add constraint hivra_agent_cli_updates_cli_name_check
    check (
      cli_name ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'
      and cli_name not in ('linux-desktop', 'linux-server', 'linux-terminal', 'omarchy', 'windows')
    );

comment on table public.hivra_agent_cli_updates is
  'Agent CLI and hosted catalog app version observations, update requests and the owner''s automatic-update choice (CLIs only) per Hivra agent; service role only.';

do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.claim_hivra_provider_runtime_update(text,uuid,uuid)',
     'a.type not in (''claude-code'',''codex'',''aeon'',''openclaw'',''agent-zero'',''hermes'',''openbot'',''nuphos'')',
     '(a.type !~ ''^[a-z][a-z0-9-]{1,38}[a-z0-9]$'' or a.type in (''linux-desktop'',''linux-server'',''linux-terminal'',''omarchy'',''windows'',''deepseek-harness''))'),
    ('public.hivra_canonical_surfaces(text,jsonb,boolean,boolean)',
     '''deepseek-harness'',''openbot'',''nuphos'')',
     '''deepseek-harness'',''openbot'',''nuphos'',''nanobot'',''zeroclaw'',''picoclaw'',''opencode'',''goose'',''openhands'',''anythingllm'',''activepieces'',''uptime-kuma'',''gitea'')'),
    ('public.hivra_canonical_actions(text,jsonb,boolean,boolean)',
     '''aeon'',''openbot'',''nuphos'')',
     '''aeon'',''openbot'',''nuphos'',''nanobot'',''zeroclaw'',''picoclaw'',''opencode'',''goose'',''openhands'',''anythingllm'',''activepieces'',''uptime-kuma'',''gitea'')')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position(addition in definition) > 0 then continue; end if;
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Universal catalog app anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
