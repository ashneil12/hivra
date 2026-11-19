-- Admit the reviewed 2026.11.12.1 provider bundle (Hivra reads and sets a Hermes computer's own
-- model through Hermes's CLI) without invalidating existing computers. The TypeScript
-- identities and manifest ship with the release; this keeps SQL admission and the identity
-- gates in step. The bundle digest is the manifest digest recorded in
-- provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.11.7 entry, which appears exactly once in each function (the
-- 2026.11.11.7 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.12.1 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.11.7''',
     '''2026.11.11.7'',''2026.11.12.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''880754711e2f8bd3d57eaa11b8dc1be47780de107214f610d2fbbe261d32eb0e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.7'')',
     '(p_identity->''bundle''->>''bundleSha256''=''880754711e2f8bd3d57eaa11b8dc1be47780de107214f610d2fbbe261d32eb0e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.7'') or (p_identity->''bundle''->>''bundleSha256''=''d79a91eccf3d7aacc65efe2fdbe55e00f564caabc24f0ff4c0a5a324985d8e1c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.1'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''880754711e2f8bd3d57eaa11b8dc1be47780de107214f610d2fbbe261d32eb0e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.7'')',
     '(p_identity->''bundle''->>''bundleSha256''=''880754711e2f8bd3d57eaa11b8dc1be47780de107214f610d2fbbe261d32eb0e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.7'') or (p_identity->''bundle''->>''bundleSha256''=''d79a91eccf3d7aacc65efe2fdbe55e00f564caabc24f0ff4c0a5a324985d8e1c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.1'')')
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
