-- Admit the reviewed 2026.11.11.7 provider bundle (Hermes's own Desktop Webapp served at
-- /hermes, with the dashboard kept as the fallback) without invalidating existing
-- computers. The TypeScript identities and manifest ship with the release; this keeps SQL
-- admission and the identity gates in step. The bundle digest is the manifest digest
-- recorded in provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.11.6 entry, which appears exactly once in each function (the
-- 2026.11.11.6 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.11.7 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.11.6''',
     '''2026.11.11.6'',''2026.11.11.7'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''f2148144fee2ab681d36c584d882198c8bded295c3f6375780919e113ad0ef86'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.6'')',
     '(p_identity->''bundle''->>''bundleSha256''=''f2148144fee2ab681d36c584d882198c8bded295c3f6375780919e113ad0ef86'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.6'') or (p_identity->''bundle''->>''bundleSha256''=''880754711e2f8bd3d57eaa11b8dc1be47780de107214f610d2fbbe261d32eb0e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.7'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''f2148144fee2ab681d36c584d882198c8bded295c3f6375780919e113ad0ef86'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.6'')',
     '(p_identity->''bundle''->>''bundleSha256''=''f2148144fee2ab681d36c584d882198c8bded295c3f6375780919e113ad0ef86'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.6'') or (p_identity->''bundle''->>''bundleSha256''=''880754711e2f8bd3d57eaa11b8dc1be47780de107214f610d2fbbe261d32eb0e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.7'')')
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
