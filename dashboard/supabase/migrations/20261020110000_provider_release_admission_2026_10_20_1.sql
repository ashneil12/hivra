-- Admit the reviewed 2026.10.20.1 provider bundle (the owned DeepSeek runtime update and the
-- runtime updater's guest half in its own file) without invalidating existing computers.
-- The TypeScript identities and manifest ship with the release; this keeps SQL admission
-- and the identity gates in step. The bundle digest is the manifest digest recorded in
-- provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.10.07.1 entry, which appears exactly once in each function (the
-- 2026.10.07.1 admission is the latest one applied). Idempotent: a function that already
-- admits 2026.10.20.1 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.10.07.1''',
     '''2026.10.07.1'',''2026.10.20.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''bbebf7e4d12adbb75069b86f6eb9681d173066437d2b29ce49cff1250159a3d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.07.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''bbebf7e4d12adbb75069b86f6eb9681d173066437d2b29ce49cff1250159a3d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.07.1'') or (p_identity->''bundle''->>''bundleSha256''=''a7cfd091959224909f5d416885a8dbdcc840d216b11d7d92546d44eb54342bdb'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.20.1'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''bbebf7e4d12adbb75069b86f6eb9681d173066437d2b29ce49cff1250159a3d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.07.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''bbebf7e4d12adbb75069b86f6eb9681d173066437d2b29ce49cff1250159a3d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.07.1'') or (p_identity->''bundle''->>''bundleSha256''=''a7cfd091959224909f5d416885a8dbdcc840d216b11d7d92546d44eb54342bdb'' and p_identity->''bundle''->>''provisionerVersion''=''2026.10.20.1'')')
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
