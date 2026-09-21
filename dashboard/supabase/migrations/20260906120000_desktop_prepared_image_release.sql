-- Add the pinned optional desktop-image release. Retained identities and
-- recovery pairs remain valid; this does not assert live image acceptance.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.05.10'',''2026.09.06.1''',
     '''2026.09.05.10'',''2026.09.06.1'',''2026.09.06.2'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.1'')',
     '((p_identity->''bundle''->>''bundleSha256''=''61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.1'') or (p_identity->''bundle''->>''bundleSha256''=''9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.2''))'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.1'')',
     '((p_identity->''bundle''->>''bundleSha256''=''61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.1'') or (p_identity->''bundle''->>''bundleSha256''=''9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.2''))')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Prepared desktop image release anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
