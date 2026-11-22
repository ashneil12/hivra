-- Admit the stale failed-unit watchdog release alongside its predecessors.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.20.3'',''2026.11.20.4'',''2026.11.20.5'',''2026.11.21.1'',''2026.11.22.1'',''2026.11.22.2''',
     '''2026.11.20.3'',''2026.11.20.4'',''2026.11.20.5'',''2026.11.21.1'',''2026.11.22.1'',''2026.11.22.2'',''2026.11.22.3'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''75e7434c68839e0bc362d8cf5f52408dfc0c31301c5f8389e96656bac1cda39d'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.22.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''75e7434c68839e0bc362d8cf5f52408dfc0c31301c5f8389e96656bac1cda39d'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.22.2'') or (p_identity->''bundle''->>''bundleSha256''=''9263f24c362351b874a52bb727700e6361495da4b75ad7a467aecd6c1c96f2d7'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.22.3'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''75e7434c68839e0bc362d8cf5f52408dfc0c31301c5f8389e96656bac1cda39d'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.22.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''75e7434c68839e0bc362d8cf5f52408dfc0c31301c5f8389e96656bac1cda39d'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.22.2'') or (p_identity->''bundle''->>''bundleSha256''=''9263f24c362351b874a52bb727700e6361495da4b75ad7a467aecd6c1c96f2d7'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.22.3'')')
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
