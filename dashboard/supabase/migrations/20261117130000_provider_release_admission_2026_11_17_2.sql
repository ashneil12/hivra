-- Admit the reviewed 2026.11.17.2 provider bundle (the wake proxy treats a
-- request carrying X-Hivra-Background: 1, Hivra's own background reads, as no
-- proof: it never counts as use and never wakes a napped computer) without
-- invalidating existing computers. The TypeScript identities and manifest
-- ship with the release; this keeps SQL admission and the identity gates in
-- step. The bundle digest is the manifest digest of
-- provisioner-releases/2026.11.17.2.json, and the 2026.11.17.1 digest it
-- anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.17.1 entry, which appears exactly once in each
-- function (the 2026.11.17.1 admission must be applied first). Idempotent: a
-- function that already admits 2026.11.17.2 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.17.1''',
     '''2026.11.17.1'',''2026.11.17.2'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''992ed8cd0bbfda5a5d2774394000339c0a7245f1ce15775c74f6d9424238493e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''992ed8cd0bbfda5a5d2774394000339c0a7245f1ce15775c74f6d9424238493e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.1'') or (p_identity->''bundle''->>''bundleSha256''=''9010b4c2b0abf9863fc70b3e8482fc500ecb4cfa8ced51f3776006e2066ebb02'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.2'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''992ed8cd0bbfda5a5d2774394000339c0a7245f1ce15775c74f6d9424238493e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''992ed8cd0bbfda5a5d2774394000339c0a7245f1ce15775c74f6d9424238493e'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.1'') or (p_identity->''bundle''->>''bundleSha256''=''9010b4c2b0abf9863fc70b3e8482fc500ecb4cfa8ced51f3776006e2066ebb02'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.2'')')
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
