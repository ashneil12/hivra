-- Admit the docker-stack catalog runtime release alongside its predecessors.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.20.3'',''2026.11.20.4''',
     '''2026.11.20.3'',''2026.11.20.4'',''2026.11.20.5'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''06d38a6e4baedfe8ae7ce029f39c6cdaf30fa842c186d6f430d06db5a08f3d4a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.4'')',
     '(p_identity->''bundle''->>''bundleSha256''=''06d38a6e4baedfe8ae7ce029f39c6cdaf30fa842c186d6f430d06db5a08f3d4a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.4'') or (p_identity->''bundle''->>''bundleSha256''=''4a567238a31067773d0e74d3184c97b983044c330a4b075f7c484bfd06b7100f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.5'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''06d38a6e4baedfe8ae7ce029f39c6cdaf30fa842c186d6f430d06db5a08f3d4a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.4'')',
     '(p_identity->''bundle''->>''bundleSha256''=''06d38a6e4baedfe8ae7ce029f39c6cdaf30fa842c186d6f430d06db5a08f3d4a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.4'') or (p_identity->''bundle''->>''bundleSha256''=''4a567238a31067773d0e74d3184c97b983044c330a4b075f7c484bfd06b7100f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.20.5'')')
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
