-- Admit the reviewed 2026.09.15.1, 2026.09.15.2 and 2026.09.21.1 provider
-- bundles without invalidating existing computers. Those releases shipped
-- their TypeScript identities and manifests, but the SQL admission and
-- identity gates were never extended past 2026.09.08.3, so provider computers
-- on them could not be admitted or keep a valid identity. Bundle digests are
-- the manifest digests recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts (2026.09.21.1 recomputed from its manifest).
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.08.2'',''2026.09.08.3''',
     '''2026.09.08.2'',''2026.09.08.3'',''2026.09.15.1'',''2026.09.15.2'',''2026.09.21.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''9f7d173d1912dc3001770ecbb5fc31b601660b331591b0526311f666057318f9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''9f7d173d1912dc3001770ecbb5fc31b601660b331591b0526311f666057318f9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.3'') or (p_identity->''bundle''->>''bundleSha256''=''8c78992766b7f6f5aa499556342e3ff4e340bd5f8718850b488b4ce09e8dcf49'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.15.1'') or (p_identity->''bundle''->>''bundleSha256''=''17f367fbffbda1212fd61e4aab5e45f0646528de388b0667d0e4dc33c011711f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.15.2'') or (p_identity->''bundle''->>''bundleSha256''=''ff60ff578397dbb49f3405762b4733adc0187b9912e8340671678351295a1469'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.21.1'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''9f7d173d1912dc3001770ecbb5fc31b601660b331591b0526311f666057318f9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''9f7d173d1912dc3001770ecbb5fc31b601660b331591b0526311f666057318f9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.08.3'') or (p_identity->''bundle''->>''bundleSha256''=''8c78992766b7f6f5aa499556342e3ff4e340bd5f8718850b488b4ce09e8dcf49'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.15.1'') or (p_identity->''bundle''->>''bundleSha256''=''17f367fbffbda1212fd61e4aab5e45f0646528de388b0667d0e4dc33c011711f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.15.2'') or (p_identity->''bundle''->>''bundleSha256''=''ff60ff578397dbb49f3405762b4733adc0187b9912e8340671678351295a1469'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.21.1'')')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Provider release admission anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
