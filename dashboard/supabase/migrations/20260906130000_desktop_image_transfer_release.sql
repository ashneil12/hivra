-- Correct exclusive image transfer in a new sealed release. Retained identities and
-- recovery pairs remain valid; this does not assert live image acceptance.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.06.1'',''2026.09.06.2''',
     '''2026.09.06.1'',''2026.09.06.2'',''2026.09.06.3'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.2'')',
     '((p_identity->''bundle''->>''bundleSha256''=''9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.2'') or (p_identity->''bundle''->>''bundleSha256''=''5ea99797e6a1f7b105d1af07c191585c386df5590bd65a3389f045a41466dbef'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.3''))'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.2'')',
     '((p_identity->''bundle''->>''bundleSha256''=''9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.2'') or (p_identity->''bundle''->>''bundleSha256''=''5ea99797e6a1f7b105d1af07c191585c386df5590bd65a3389f045a41466dbef'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.3''))')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Desktop image transfer release anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
