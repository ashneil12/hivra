-- Universal catalog apps & agents: canonical surfaces and actions follow the
-- catalog slug shape instead of a closed per-app list, so a new manifest entry
-- needs no SQL change.
--
-- WHY
-- 20261120160000 opened update tracking and the launch document to any slug,
-- but hivra_canonical_surfaces and hivra_canonical_actions still named every
-- catalog app. Any slug matching the catalog shape now gets the same surfaces
-- (workspace, files, git, terminal) and the same delete action, except the
-- values that name something else: 'aeon' keeps its own narrower surfaces
-- branch, and the computer/OS profile types keep their computer handling.
-- Arbitrary non-slug types still get '{}', so the functions stay fail-closed.
--
-- Additive and idempotent: every row previously allowed still passes, and each
-- function is patched in place from its stored definition only when not
-- already patched. Anchors on the Wave 1 tails left by 20261120160000.

do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.hivra_canonical_surfaces(text,jsonb,boolean,boolean)',
     '''deepseek-harness'',''openbot'',''nuphos'',''nanobot'',''zeroclaw'',''picoclaw'',''opencode'',''goose'',''openhands'',''anythingllm'',''activepieces'',''uptime-kuma'',''gitea'')',
     '''deepseek-harness'',''openbot'',''nuphos'',''nanobot'',''zeroclaw'',''picoclaw'',''opencode'',''goose'',''openhands'',''anythingllm'',''activepieces'',''uptime-kuma'',''gitea'') or (lower(btrim(coalesce(p_payload->>''type'',''''))) ~ ''^[a-z][a-z0-9-]{1,38}[a-z0-9]$'' and lower(btrim(coalesce(p_payload->>''type'',''''))) not in (''aeon'',''linux-desktop'',''linux-server'',''linux-terminal'',''omarchy'',''windows'',''ubuntu-desktop'',''ubuntu-server''))'),
    ('public.hivra_canonical_actions(text,jsonb,boolean,boolean)',
     'p_source_kind=''hivra'' and lower(btrim(coalesce(p_payload->>''type'',''''))) in (''hermes'',''claude-code'',''codex'',''openclaw'',''agent-zero'',''deepseek-harness'',''aeon'',''openbot'',''nuphos'',''nanobot'',''zeroclaw'',''picoclaw'',''opencode'',''goose'',''openhands'',''anythingllm'',''activepieces'',''uptime-kuma'',''gitea'')',
     'p_source_kind=''hivra'' and (lower(btrim(coalesce(p_payload->>''type'',''''))) in (''hermes'',''claude-code'',''codex'',''openclaw'',''agent-zero'',''deepseek-harness'',''aeon'',''openbot'',''nuphos'',''nanobot'',''zeroclaw'',''picoclaw'',''opencode'',''goose'',''openhands'',''anythingllm'',''activepieces'',''uptime-kuma'',''gitea'') or (lower(btrim(coalesce(p_payload->>''type'',''''))) ~ ''^[a-z][a-z0-9-]{1,38}[a-z0-9]$'' and lower(btrim(coalesce(p_payload->>''type'',''''))) not in (''aeon'',''linux-desktop'',''linux-server'',''linux-terminal'',''omarchy'',''windows'',''ubuntu-desktop'',''ubuntu-server'')))')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position(addition in definition) > 0 then continue; end if;
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Catalog app slug anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
