-- Admit the reviewed 2026.09.24.2 provider bundle (computer hardening: the two
-- ttyd terminals move to owner-only unix sockets and /api/git/* answers 404 in
-- the computer profile) without invalidating existing computers. The TypeScript
-- identities and manifest ship with the release; this keeps SQL admission and
-- the identity gates in step. The bundle digest is the manifest digest recorded
-- in provider-desktop-worker.ts and provider-native-worker.ts.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.22.1'',''2026.09.22.2'',''2026.09.24.1''',
     '''2026.09.22.1'',''2026.09.22.2'',''2026.09.24.1'',''2026.09.24.2'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'') or (p_identity->''bundle''->>''bundleSha256''=''c1d942f5473f5df22778b2adbd6720e35f4db30c061a3c03bf7848eac2c1d705'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.2'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'') or (p_identity->''bundle''->>''bundleSha256''=''c1d942f5473f5df22778b2adbd6720e35f4db30c061a3c03bf7848eac2c1d705'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.2'')')
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
