-- Admit the reviewed 2026.11.15.6 provider bundle (box-side surface watchdog:
-- a root hivra-surface-watchdog service probes each registered agent surface
-- through the real gateway path, reports a bounded receipt at
-- GET /api/surface-watchdog, and restarts only the owning app unit inside a
-- sustained failure window with cooldown and a restart cap; disables legacy
-- bux-browser-keeper.service on browserless kinds; plus real-path agent
-- readiness, stale-error suppression on running rows, a unit-failure ops_events
-- sweep, and surface-metadata warning names)
-- without invalidating existing computers. The TypeScript identities and
-- manifest ship with the release; this keeps SQL admission and the identity
-- gates in step. The bundle digest is the manifest digest of
-- provisioner-releases/2026.11.15.6.json, and the 2026.11.15.5 digest it
-- anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.15.5 entry, which appears exactly once in each
-- function (the 2026.11.15.5 admission is the latest one applied, so it must
-- be applied first). Idempotent: a function that already admits 2026.11.15.6
-- is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.15.5''',
     '''2026.11.15.5'',''2026.11.15.6'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''763ce9f86132cd5051819f3a4fe35cfd296ec2551f68000818a85ad980f22c58'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''763ce9f86132cd5051819f3a4fe35cfd296ec2551f68000818a85ad980f22c58'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.5'') or (p_identity->''bundle''->>''bundleSha256''=''66a5a70eb9e0f07513d73e9f188b996d3272b6731083ffff56ea110b5c53e21f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.6'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''763ce9f86132cd5051819f3a4fe35cfd296ec2551f68000818a85ad980f22c58'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''763ce9f86132cd5051819f3a4fe35cfd296ec2551f68000818a85ad980f22c58'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.5'') or (p_identity->''bundle''->>''bundleSha256''=''66a5a70eb9e0f07513d73e9f188b996d3272b6731083ffff56ea110b5c53e21f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.6'')')
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
