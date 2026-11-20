-- Admit the Agent Zero browser routing release alongside its predecessor.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.18.5''',
     '''2026.11.18.5'',''2026.11.19.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''7728d82d75d26e95ab4b9ed61ae5f267bed89825618d252b6699701f0819de6c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''7728d82d75d26e95ab4b9ed61ae5f267bed89825618d252b6699701f0819de6c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.5'') or (p_identity->''bundle''->>''bundleSha256''=''c8e4bbf72a7e39b1d8c5ddd4f42ee9390fded2925e6c7c1ebb9f61ecde00ba03'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.19.1'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''7728d82d75d26e95ab4b9ed61ae5f267bed89825618d252b6699701f0819de6c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''7728d82d75d26e95ab4b9ed61ae5f267bed89825618d252b6699701f0819de6c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.5'') or (p_identity->''bundle''->>''bundleSha256''=''c8e4bbf72a7e39b1d8c5ddd4f42ee9390fded2925e6c7c1ebb9f61ecde00ba03'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.19.1'')')
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
