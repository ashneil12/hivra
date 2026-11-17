-- Admit the reviewed 2026.11.15.8 provider bundle (Agent Zero's login and
-- managed model are seeded into /a0/usr/.env, the only settings file the pinned
-- Agent Zero v2.15 image reads) without invalidating existing computers. The
-- TypeScript identities and manifest ship with the release; this keeps SQL
-- admission and the identity gates in step. The bundle digest is the manifest
-- digest of provisioner-releases/2026.11.15.8.json, and the 2026.11.15.7 digest
-- it anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.15.7 entry, which appears exactly once in each
-- function (the 2026.11.15.7 admission must be applied first). Idempotent: a
-- function that already admits 2026.11.15.8 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.15.7''',
     '''2026.11.15.7'',''2026.11.15.8'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''28ae48475970fd17617292ae3a3b9823769ed3c9c8fc9d9a6774d32199a510ff'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'')',
     '(p_identity->''bundle''->>''bundleSha256''=''28ae48475970fd17617292ae3a3b9823769ed3c9c8fc9d9a6774d32199a510ff'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'') or (p_identity->''bundle''->>''bundleSha256''=''e91d8e656f52f2df7b1c51ad910bfc5403b92c20fb62a4f4f0d05a7750bdd29e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.8'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''28ae48475970fd17617292ae3a3b9823769ed3c9c8fc9d9a6774d32199a510ff'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'')',
     '(p_identity->''bundle''->>''bundleSha256''=''28ae48475970fd17617292ae3a3b9823769ed3c9c8fc9d9a6774d32199a510ff'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'') or (p_identity->''bundle''->>''bundleSha256''=''e91d8e656f52f2df7b1c51ad910bfc5403b92c20fb62a4f4f0d05a7750bdd29e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.8'')')
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
