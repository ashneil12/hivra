-- Admit the reviewed 2026.11.15.2 provider bundle (box state import: the
-- gateway gains /api/import routes that restore a user's existing local agent
-- state from a tar.gz bundle into per-kind state roots behind an allowlist,
-- plus hivra-chat/import-state.cjs; no other guest asset changes) without
-- invalidating existing computers. The TypeScript identities and manifest
-- ship with the release; this keeps SQL admission and the identity gates in
-- step. The bundle digest is the manifest digest of
-- provisioner-releases/2026.11.15.2.json, and the 2026.11.15.1 digest it
-- anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.15.1 entry, which appears exactly once in each
-- function (the 2026.11.15.1 admission is the latest one applied, so it must
-- be applied first). Idempotent: a function that already admits 2026.11.15.2
-- is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.15.1''',
     '''2026.11.15.1'',''2026.11.15.2'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''4729a8faca0ab45d854ad48423ee6d87bfb94e818ce27599817998fdf2ababd8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''4729a8faca0ab45d854ad48423ee6d87bfb94e818ce27599817998fdf2ababd8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.1'') or (p_identity->''bundle''->>''bundleSha256''=''49a8f66e3fca1577e7932a2338de16e9c04d77bc9eb130ae81ccb7ac3a692cef'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.2'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''4729a8faca0ab45d854ad48423ee6d87bfb94e818ce27599817998fdf2ababd8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''4729a8faca0ab45d854ad48423ee6d87bfb94e818ce27599817998fdf2ababd8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.1'') or (p_identity->''bundle''->>''bundleSha256''=''49a8f66e3fca1577e7932a2338de16e9c04d77bc9eb130ae81ccb7ac3a692cef'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.2'')')
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
