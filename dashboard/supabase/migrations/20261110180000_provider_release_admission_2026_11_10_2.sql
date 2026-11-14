-- Admit the reviewed 2026.11.10.2 provider bundle (Claude Code on Hivra credits: the
-- installer writes the CLI's managed-model settings) without invalidating existing
-- computers. The TypeScript identities and manifest ship with the release;
-- this keeps SQL admission and the identity gates in step. The bundle digest is the
-- manifest digest recorded in provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.10.1 entry, which appears exactly once in each function (the
-- 2026.11.10.1 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.10.2 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.10.1''',
     '''2026.11.10.1'',''2026.11.10.2'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''e57d625db5e9f9b79d99f8a245a7f743ece2f7f1359d1a0a667a0d2918044c84'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.10.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''e57d625db5e9f9b79d99f8a245a7f743ece2f7f1359d1a0a667a0d2918044c84'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.10.1'') or (p_identity->''bundle''->>''bundleSha256''=''0236e50ffda2ef8f88c1334a6088f8e673c751263dc6184ab70ba37c9365b827'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.10.2'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''e57d625db5e9f9b79d99f8a245a7f743ece2f7f1359d1a0a667a0d2918044c84'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.10.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''e57d625db5e9f9b79d99f8a245a7f743ece2f7f1359d1a0a667a0d2918044c84'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.10.1'') or (p_identity->''bundle''->>''bundleSha256''=''0236e50ffda2ef8f88c1334a6088f8e673c751263dc6184ab70ba37c9365b827'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.10.2'')')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if left(addition, length(anchor)) <> anchor then
      raise exception 'Provider release admission must extend its anchor: %', signature;
    end if;
    if position(substr(addition, length(anchor) + 1) in definition) > 0 then continue; end if;
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Provider release admission anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
