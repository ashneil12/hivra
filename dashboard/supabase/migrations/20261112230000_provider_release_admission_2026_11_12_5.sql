-- Admit the reviewed 2026.11.12.5 provider bundle (hivra-tg-apply's environment-file write is
-- hardened against symlink redirection: staged in a root-only directory, then renamed into place)
-- without invalidating existing computers. The TypeScript identities and manifest ship with the
-- release; this keeps SQL admission and the identity gates in step. The bundle digest is the
-- manifest digest recorded in provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.12.4 entry, which appears exactly once in each function (the
-- 2026.11.12.4 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.12.5 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.12.4''',
     '''2026.11.12.4'',''2026.11.12.5'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''65e603d9fa6930b1625be3bc89396286fa511f00df539eb99bc1a51554ffbba9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.4'')',
     '(p_identity->''bundle''->>''bundleSha256''=''65e603d9fa6930b1625be3bc89396286fa511f00df539eb99bc1a51554ffbba9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.4'') or (p_identity->''bundle''->>''bundleSha256''=''857f0ec6eaac5d4cf8ef7df9c4056422e7dc5c6dea91a828a822f387a2350854'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.5'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''65e603d9fa6930b1625be3bc89396286fa511f00df539eb99bc1a51554ffbba9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.4'')',
     '(p_identity->''bundle''->>''bundleSha256''=''65e603d9fa6930b1625be3bc89396286fa511f00df539eb99bc1a51554ffbba9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.4'') or (p_identity->''bundle''->>''bundleSha256''=''857f0ec6eaac5d4cf8ef7df9c4056422e7dc5c6dea91a828a822f387a2350854'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.5'')')
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
