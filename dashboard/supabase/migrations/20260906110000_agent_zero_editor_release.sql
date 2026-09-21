-- Admit the pinned native editor lifecycle release, retaining all previous
-- identity/recovery pairs. Admission is not live workflow acceptance.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.05.6'',''2026.09.05.7'',''2026.09.05.8'',''2026.09.05.9'',''2026.09.05.10''',
     '''2026.09.05.6'',''2026.09.05.7'',''2026.09.05.8'',''2026.09.05.9'',''2026.09.05.10'',''2026.09.06.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''c48b6f0df47743e4fd4978b3a886e1fb68ee5cc163d51781cd8c7a4a539b7860'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.10'')',
     '((p_identity->''bundle''->>''bundleSha256''=''c48b6f0df47743e4fd4978b3a886e1fb68ee5cc163d51781cd8c7a4a539b7860'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.10'') or (p_identity->''bundle''->>''bundleSha256''=''61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.1''))'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''c48b6f0df47743e4fd4978b3a886e1fb68ee5cc163d51781cd8c7a4a539b7860'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.10'')',
     '((p_identity->''bundle''->>''bundleSha256''=''c48b6f0df47743e4fd4978b3a886e1fb68ee5cc163d51781cd8c7a4a539b7860'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.10'') or (p_identity->''bundle''->>''bundleSha256''=''61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.06.1''))')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Agent Zero editor release anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
