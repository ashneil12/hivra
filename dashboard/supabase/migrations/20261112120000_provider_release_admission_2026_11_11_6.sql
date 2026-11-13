-- Admit the reviewed 2026.11.11.6 provider bundle (libatomic1 installed before Hermes's
-- own installer, so a new Hermes computer finishes its launch) without invalidating
-- existing computers. The TypeScript identities and manifest ship with the release; this
-- keeps SQL admission and the identity gates in step. The bundle digest is the manifest
-- digest recorded in provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.11.5 entry, which appears exactly once in each function (the
-- 2026.11.11.5 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.11.6 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.11.5''',
     '''2026.11.11.5'',''2026.11.11.6'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''e4c439b7e1590de448c204232543a1a9e2b0ca695efd652d79f934e38e97c5cf'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''e4c439b7e1590de448c204232543a1a9e2b0ca695efd652d79f934e38e97c5cf'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.5'') or (p_identity->''bundle''->>''bundleSha256''=''f2148144fee2ab681d36c584d882198c8bded295c3f6375780919e113ad0ef86'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.6'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''e4c439b7e1590de448c204232543a1a9e2b0ca695efd652d79f934e38e97c5cf'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''e4c439b7e1590de448c204232543a1a9e2b0ca695efd652d79f934e38e97c5cf'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.5'') or (p_identity->''bundle''->>''bundleSha256''=''f2148144fee2ab681d36c584d882198c8bded295c3f6375780919e113ad0ef86'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.6'')')
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
