-- Admit the reviewed 2026.11.17.4 provider bundle (the box gateway drops
-- forwarded-client headers on /openclaw so OpenClaw 2026.11.5+ serves its
-- Control UI, and Aeon keeps its own Next config with only the /aeon mount
-- added, and the host capacity check counts a paused guest as active) without
-- invalidating existing computers. The TypeScript identities and
-- manifest ship with the release; this keeps SQL admission and the identity
-- gates in step. The bundle digest is the manifest digest of
-- provisioner-releases/2026.11.17.4.json, and the 2026.11.17.3 digest it
-- anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.17.3 entry, which appears exactly once in each
-- function (the 2026.11.17.3 admission must be applied first). Idempotent: a
-- function that already admits 2026.11.17.4 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.17.3''',
     '''2026.11.17.3'',''2026.11.17.4'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''1346e7abf511d196a889b87231c098b7c6c9694690177db57a28ae2e8c368485'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''1346e7abf511d196a889b87231c098b7c6c9694690177db57a28ae2e8c368485'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.3'') or (p_identity->''bundle''->>''bundleSha256''=''001acfd88189bb756f0fee77209ade989f990d1eaae7b5bc992604cea514cbdf'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.4'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''1346e7abf511d196a889b87231c098b7c6c9694690177db57a28ae2e8c368485'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''1346e7abf511d196a889b87231c098b7c6c9694690177db57a28ae2e8c368485'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.3'') or (p_identity->''bundle''->>''bundleSha256''=''001acfd88189bb756f0fee77209ade989f990d1eaae7b5bc992604cea514cbdf'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.4'')')
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
