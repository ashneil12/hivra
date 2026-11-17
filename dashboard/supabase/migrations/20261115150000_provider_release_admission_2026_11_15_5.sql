-- Admit the reviewed 2026.11.15.5 provider bundle (lifecycle lock fd
-- hygiene: qm start no longer inherits the shared allocation/lifecycle
-- lock fd into the long-lived kvm child, which pinned the lock open for the
-- VM's whole lifetime and deadlocked every host-side mutation against that
-- box; no other guest asset changes) without invalidating existing
-- computers. The TypeScript identities and manifest ship with the release;
-- this keeps SQL admission and the identity gates in step. The bundle digest
-- is the manifest digest of
-- provisioner-releases/2026.11.15.5.json, and the 2026.11.15.3 digest it
-- anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.15.3 entry, which appears exactly once in each
-- function (the 2026.11.15.3 admission is the latest one applied, so it must
-- be applied first). Idempotent: a function that already admits 2026.11.15.5
-- is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.15.3''',
     '''2026.11.15.3'',''2026.11.15.5'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''a96d8c478acb7d8a2d97cc86e23515a7968cdf0e298307ca200b6d8512a0f5d8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''a96d8c478acb7d8a2d97cc86e23515a7968cdf0e298307ca200b6d8512a0f5d8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.3'') or (p_identity->''bundle''->>''bundleSha256''=''763ce9f86132cd5051819f3a4fe35cfd296ec2551f68000818a85ad980f22c58'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.5'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''a96d8c478acb7d8a2d97cc86e23515a7968cdf0e298307ca200b6d8512a0f5d8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''a96d8c478acb7d8a2d97cc86e23515a7968cdf0e298307ca200b6d8512a0f5d8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.3'') or (p_identity->''bundle''->>''bundleSha256''=''763ce9f86132cd5051819f3a4fe35cfd296ec2551f68000818a85ad980f22c58'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.5'')')
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
