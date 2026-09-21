-- Admit the sealed desktop handoff-latency bundle without invalidating
-- existing computers. The release removes one redundant pre-takeover control
-- request while retaining takeover and post-takeover authorization fences.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.06.4'',''2026.09.07.1'',''2026.09.08.1'',''2026.09.08.2''',
     '''2026.09.06.4'',''2026.09.07.1'',''2026.09.08.1'',''2026.09.08.2'',''2026.09.08.3'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '((p_identity->''bundle''->>''bundleSha256''=''a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.4'') or (p_identity->''bundle''->>''bundleSha256''=''73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.07.1'') or (p_identity->''bundle''->>''bundleSha256''=''734f446f832cce01d9218c2500ab7fd294148076711c1fd104b46fe2e28eb72e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.1'') or (p_identity->''bundle''->>''bundleSha256''=''1660674e4927585463122666f3471de1ce7e6bc391f476c83f2fb96548f9672e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.2''))',
     '((p_identity->''bundle''->>''bundleSha256''=''a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.4'') or (p_identity->''bundle''->>''bundleSha256''=''73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.07.1'') or (p_identity->''bundle''->>''bundleSha256''=''734f446f832cce01d9218c2500ab7fd294148076711c1fd104b46fe2e28eb72e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.1'') or (p_identity->''bundle''->>''bundleSha256''=''1660674e4927585463122666f3471de1ce7e6bc391f476c83f2fb96548f9672e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.2'') or (p_identity->''bundle''->>''bundleSha256''=''9f7d173d1912dc3001770ecbb5fc31b601660b331591b0526311f666057318f9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.3''))'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '((p_identity->''bundle''->>''bundleSha256''=''a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.4'') or (p_identity->''bundle''->>''bundleSha256''=''73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.07.1'') or (p_identity->''bundle''->>''bundleSha256''=''734f446f832cce01d9218c2500ab7fd294148076711c1fd104b46fe2e28eb72e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.1'') or (p_identity->''bundle''->>''bundleSha256''=''1660674e4927585463122666f3471de1ce7e6bc391f476c83f2fb96548f9672e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.2''))',
     '((p_identity->''bundle''->>''bundleSha256''=''a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.4'') or (p_identity->''bundle''->>''bundleSha256''=''73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.07.1'') or (p_identity->''bundle''->>''bundleSha256''=''734f446f832cce01d9218c2500ab7fd294148076711c1fd104b46fe2e28eb72e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.1'') or (p_identity->''bundle''->>''bundleSha256''=''1660674e4927585463122666f3471de1ce7e6bc391f476c83f2fb96548f9672e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.2'') or (p_identity->''bundle''->>''bundleSha256''=''9f7d173d1912dc3001770ecbb5fc31b601660b331591b0526311f666057318f9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.3''))')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Desktop handoff latency release anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
