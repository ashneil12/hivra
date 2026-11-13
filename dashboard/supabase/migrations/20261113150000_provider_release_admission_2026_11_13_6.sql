-- Admit the reviewed 2026.11.13.6 provider bundle (review hardening of the host wake proxy, the
-- doorbell and their units, and the pin re-apply command the boot unit runs; no guest asset changes)
-- without invalidating existing computers. The TypeScript identities and manifest ship with the release; this keeps SQL admission and the identity gates in
-- step. The bundle digest is the manifest digest of provisioner-releases/2026.11.13.6.json, and the
-- 2026.11.13.5 digest it anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.13.5 entry, which appears exactly once in each function (the
-- 2026.11.13.5 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.13.6 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.13.5''',
     '''2026.11.13.5'',''2026.11.13.6'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''c7c400fdd3009867c86ed21610c765f077b03e038f1ddcbec75966304ac5bd9f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.13.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''c7c400fdd3009867c86ed21610c765f077b03e038f1ddcbec75966304ac5bd9f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.13.5'') or (p_identity->''bundle''->>''bundleSha256''=''e402a4a3b2359852034c43354eac986014db92f354f204ea13728edcbf073f25'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.13.6'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''c7c400fdd3009867c86ed21610c765f077b03e038f1ddcbec75966304ac5bd9f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.13.5'')',
     '(p_identity->''bundle''->>''bundleSha256''=''c7c400fdd3009867c86ed21610c765f077b03e038f1ddcbec75966304ac5bd9f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.13.5'') or (p_identity->''bundle''->>''bundleSha256''=''e402a4a3b2359852034c43354eac986014db92f354f204ea13728edcbf073f25'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.13.6'')')
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
