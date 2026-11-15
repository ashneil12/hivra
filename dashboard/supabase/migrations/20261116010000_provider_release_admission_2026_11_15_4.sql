-- Admit the reviewed 2026.11.15.4 provider bundle (box-side surface watchdog:
-- a root hivra-surface-watchdog service probes each registered agent surface
-- through the real gateway path, reports a bounded receipt at
-- GET /api/surface-watchdog, and restarts only the owning app unit inside a
-- sustained failure window with cooldown and a restart cap; plus real-path
-- agent readiness, stale-error suppression on running rows, a unit-failure
-- ops_events sweep, and surface-metadata warning names)
-- without invalidating existing computers. The TypeScript identities and
-- manifest ship with the release; this keeps SQL admission and the identity
-- gates in step. The bundle digest is the manifest digest of
-- provisioner-releases/2026.11.15.4.json, and the 2026.11.15.3 digest it
-- anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.15.3 entry, which appears exactly once in each
-- function (the 2026.11.15.3 admission is the latest one applied, so it must
-- be applied first). Idempotent: a function that already admits 2026.11.15.4
-- is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.15.3''',
     '''2026.11.15.3'',''2026.11.15.4'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''a96d8c478acb7d8a2d97cc86e23515a7968cdf0e298307ca200b6d8512a0f5d8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''a96d8c478acb7d8a2d97cc86e23515a7968cdf0e298307ca200b6d8512a0f5d8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.3'') or (p_identity->''bundle''->>''bundleSha256''=''4692cb2b8564922adadc434727dbcc3df4b37ab0e56a8d4726b2e5316eaa9bbc'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.4'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''a96d8c478acb7d8a2d97cc86e23515a7968cdf0e298307ca200b6d8512a0f5d8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''a96d8c478acb7d8a2d97cc86e23515a7968cdf0e298307ca200b6d8512a0f5d8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.3'') or (p_identity->''bundle''->>''bundleSha256''=''4692cb2b8564922adadc434727dbcc3df4b37ab0e56a8d4726b2e5316eaa9bbc'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.4'')')
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
