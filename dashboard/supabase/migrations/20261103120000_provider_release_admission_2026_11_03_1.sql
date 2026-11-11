-- Admit the reviewed 2026.11.03.1 provider bundle (the desktop clipboard switch, the
-- Claude app's Code tab backup and the agent browser's sandbox) without invalidating
-- existing computers. The TypeScript identities and manifest ship with the release;
-- this keeps SQL admission and the identity gates in step. The bundle digest is the
-- manifest digest recorded in provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.10.20.2 entry, which appears exactly once in each function (the
-- 2026.10.20.2 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.03.1 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.10.20.2''',
     '''2026.10.20.2'',''2026.11.03.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''e89fbe1b10c5ed4c365a0d300b79c4b8f836a6c4811e7eb8b579defb0cd67f42'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.20.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''e89fbe1b10c5ed4c365a0d300b79c4b8f836a6c4811e7eb8b579defb0cd67f42'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.20.2'') or (p_identity->''bundle''->>''bundleSha256''=''7d2d002b3e312c953930a6c18a5dc4c03632d6b55d4877d944d8c52084050b86'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.03.1'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''e89fbe1b10c5ed4c365a0d300b79c4b8f836a6c4811e7eb8b579defb0cd67f42'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.20.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''e89fbe1b10c5ed4c365a0d300b79c4b8f836a6c4811e7eb8b579defb0cd67f42'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.20.2'') or (p_identity->''bundle''->>''bundleSha256''=''7d2d002b3e312c953930a6c18a5dc4c03632d6b55d4877d944d8c52084050b86'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.03.1'')')
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
