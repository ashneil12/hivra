-- Admit the reviewed 2026.11.17.6 provider bundle (a managed-Venice Agent Zero
-- launch also seeds Agent Zero's Default model preset, which current images
-- read instead of the A0_SET_* defaults) without invalidating existing
-- computers. The TypeScript identities and manifest ship with the release;
-- this keeps SQL admission and the identity gates in step. The bundle digest
-- is the manifest digest of provisioner-releases/2026.11.17.6.json, and the
-- 2026.11.17.5 digest it anchors on is the one recorded in
-- provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.17.5 entry, which appears exactly once in each
-- function (the 2026.11.17.5 admission must be applied first). Idempotent: a
-- function that already admits 2026.11.17.6 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.17.5''',
     '''2026.11.17.5'',''2026.11.17.6'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''8c726d7c0c3959256bc42c935cedf9f6223e56941afb5caca16e1a8a2a13259c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''8c726d7c0c3959256bc42c935cedf9f6223e56941afb5caca16e1a8a2a13259c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.5'') or (p_identity->''bundle''->>''bundleSha256''=''32f390c60478608464840c4471a10de28ddb8538cad795c63604df97b47c00f7'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.6'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''8c726d7c0c3959256bc42c935cedf9f6223e56941afb5caca16e1a8a2a13259c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''8c726d7c0c3959256bc42c935cedf9f6223e56941afb5caca16e1a8a2a13259c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.5'') or (p_identity->''bundle''->>''bundleSha256''=''32f390c60478608464840c4471a10de28ddb8538cad795c63604df97b47c00f7'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.6'')')
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
