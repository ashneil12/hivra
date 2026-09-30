-- Admit the reviewed 2026.09.24.1 provider bundle (detached chat runs) without
-- invalidating existing computers. The TypeScript identities and manifest ship
-- with the release; this keeps SQL admission and the identity gates in step so
-- provider computers prepared from it can be admitted and keep a valid
-- identity. The bundle digest is the manifest digest recorded in
-- provider-desktop-worker.ts and provider-native-worker.ts.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.22.1'',''2026.09.22.2''',
     '''2026.09.22.1'',''2026.09.22.2'',''2026.09.24.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''1569888d0f18186e8291c9752a3b2823028afb044c8596e129924ce05dfc147a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.22.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''1569888d0f18186e8291c9752a3b2823028afb044c8596e129924ce05dfc147a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.22.2'') or (p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''1569888d0f18186e8291c9752a3b2823028afb044c8596e129924ce05dfc147a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.22.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''1569888d0f18186e8291c9752a3b2823028afb044c8596e129924ce05dfc147a'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.22.2'') or (p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'')')
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
