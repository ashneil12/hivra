-- Admit the sealed 96 DPI desktop bundle without invalidating existing computers.
-- This release changes only guest desktop density; it does not grant a new OS profile.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.06.3'',''2026.09.06.4''',
     '''2026.09.06.3'',''2026.09.06.4'',''2026.09.07.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.4'')',
     '((p_identity->''bundle''->>''bundleSha256''=''a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.4'') or (p_identity->''bundle''->>''bundleSha256''=''73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.07.1''))'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.4'')',
     '((p_identity->''bundle''->>''bundleSha256''=''a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.4'') or (p_identity->''bundle''->>''bundleSha256''=''73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.07.1''))')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Desktop 96 DPI release anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
