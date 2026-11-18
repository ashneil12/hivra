-- Admit the reviewed 2026.11.17.8 provider bundle (the installer checks
-- OpenClaw's Control UI readiness at its basePath /openclaw, where 2026.11.17.7
-- asked for the gateway root, which answers 503 once a base path is set) without
-- invalidating existing computers. The TypeScript identities and manifest ship
-- with the release; this keeps SQL admission and the identity gates in step. The
-- bundle digest is the manifest digest of provisioner-releases/2026.11.17.8.json,
-- and the 2026.11.17.7 digest it anchors on is the one recorded in
-- provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.17.7 entry, which appears exactly once in each
-- function (the 2026.11.17.7 admission must be applied first). Idempotent: a
-- function that already admits 2026.11.17.8 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.17.7''',
     '''2026.11.17.7'',''2026.11.17.8'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''2a7bcbfa2c1f5ee25763ee24c9da67d2adb9b7d7d8f6e8ed67fb4af631a1bda8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.7'')',
     '(p_identity->''bundle''->>''bundleSha256''=''2a7bcbfa2c1f5ee25763ee24c9da67d2adb9b7d7d8f6e8ed67fb4af631a1bda8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.7'') or (p_identity->''bundle''->>''bundleSha256''=''35e68e27defa35a87bc1534c2ac8892bf1bbcdb4247486bc6bd098ee71261790'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.8'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''2a7bcbfa2c1f5ee25763ee24c9da67d2adb9b7d7d8f6e8ed67fb4af631a1bda8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.7'')',
     '(p_identity->''bundle''->>''bundleSha256''=''2a7bcbfa2c1f5ee25763ee24c9da67d2adb9b7d7d8f6e8ed67fb4af631a1bda8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.7'') or (p_identity->''bundle''->>''bundleSha256''=''35e68e27defa35a87bc1534c2ac8892bf1bbcdb4247486bc6bd098ee71261790'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.8'')')
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
