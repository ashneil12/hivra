-- Admit the reviewed 2026.11.17.3 provider bundle (Agent Zero's login and
-- managed model are seeded into /a0/usr/.env, the only settings file current
-- Agent Zero images read) without invalidating existing computers. The
-- TypeScript identities and manifest ship with the release; this keeps SQL
-- admission and the identity gates in step. The bundle digest is the manifest
-- digest of provisioner-releases/2026.11.17.3.json, and the 2026.11.17.2 digest
-- it anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.17.2 entry, which appears exactly once in each
-- function (the 2026.11.17.2 admission must be applied first). Idempotent: a
-- function that already admits 2026.11.17.3 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.17.2''',
     '''2026.11.17.2'',''2026.11.17.3'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''9010b4c2b0abf9863fc70b3e8482fc500ecb4cfa8ced51f3776006e2066ebb02'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''9010b4c2b0abf9863fc70b3e8482fc500ecb4cfa8ced51f3776006e2066ebb02'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.2'') or (p_identity->''bundle''->>''bundleSha256''=''1346e7abf511d196a889b87231c098b7c6c9694690177db57a28ae2e8c368485'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.3'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''9010b4c2b0abf9863fc70b3e8482fc500ecb4cfa8ced51f3776006e2066ebb02'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''9010b4c2b0abf9863fc70b3e8482fc500ecb4cfa8ced51f3776006e2066ebb02'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.2'') or (p_identity->''bundle''->>''bundleSha256''=''1346e7abf511d196a889b87231c098b7c6c9694690177db57a28ae2e8c368485'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.3'')')
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
