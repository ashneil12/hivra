-- Admit the cli-web setup contract release alongside its predecessors.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.20.2'',''2026.11.20.3''',
     '''2026.11.20.2'',''2026.11.20.3'',''2026.11.20.4'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''83c49cb13db2d3356cb37d802349ed745df64a01a86795945ace8dbc50d61f3c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''83c49cb13db2d3356cb37d802349ed745df64a01a86795945ace8dbc50d61f3c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.3'') or (p_identity->''bundle''->>''bundleSha256''=''06d38a6e4baedfe8ae7ce029f39c6cdaf30fa842c186d6f430d06db5a08f3d4a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.4'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''83c49cb13db2d3356cb37d802349ed745df64a01a86795945ace8dbc50d61f3c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''83c49cb13db2d3356cb37d802349ed745df64a01a86795945ace8dbc50d61f3c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.3'') or (p_identity->''bundle''->>''bundleSha256''=''06d38a6e4baedfe8ae7ce029f39c6cdaf30fa842c186d6f430d06db5a08f3d4a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.4'')')
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
