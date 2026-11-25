-- Admit the universal catalog app release alongside its predecessor.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.20.1''',
     '''2026.11.20.1'',''2026.11.20.2'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''4f88c13c76732bc5779afda1d8199e012200fcd653567f7f700f8c3611e8e21a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''4f88c13c76732bc5779afda1d8199e012200fcd653567f7f700f8c3611e8e21a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.1'') or (p_identity->''bundle''->>''bundleSha256''=''8ca2ea94e1f70fa13a10da570b087528818386e23486a9b2692780f899f3d007'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.2'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''4f88c13c76732bc5779afda1d8199e012200fcd653567f7f700f8c3611e8e21a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''4f88c13c76732bc5779afda1d8199e012200fcd653567f7f700f8c3611e8e21a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.1'') or (p_identity->''bundle''->>''bundleSha256''=''8ca2ea94e1f70fa13a10da570b087528818386e23486a9b2692780f899f3d007'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.2'')')
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
