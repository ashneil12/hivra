-- Admit the reviewed 2026.11.18.5 provider bundle (the connection service of an Agent
-- Zero computer lets the A0 CLI reach the connector plugin) without invalidating
-- existing computers. The TypeScript identities and manifest ship with the release;
-- this keeps SQL admission and the identity gates in step. The bundle digest is the
-- manifest digest of provisioner-releases/2026.11.18.5.json, and the 2026.11.18.4
-- digest it anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.18.4 entry, which appears exactly once in each function (the
-- 2026.11.18.4 admission must be applied first). Idempotent: a function that already
-- admits 2026.11.18.5 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.18.4''',
     '''2026.11.18.4'',''2026.11.18.5'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''4eff220ba9a6b103e0a7892204aeccced297674749d0a269916f71736810b6d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.4'')',
     '(p_identity->''bundle''->>''bundleSha256''=''4eff220ba9a6b103e0a7892204aeccced297674749d0a269916f71736810b6d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.4'') or (p_identity->''bundle''->>''bundleSha256''=''7728d82d75d26e95ab4b9ed61ae5f267bed89825618d252b6699701f0819de6c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.5'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''4eff220ba9a6b103e0a7892204aeccced297674749d0a269916f71736810b6d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.4'')',
     '(p_identity->''bundle''->>''bundleSha256''=''4eff220ba9a6b103e0a7892204aeccced297674749d0a269916f71736810b6d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.4'') or (p_identity->''bundle''->>''bundleSha256''=''7728d82d75d26e95ab4b9ed61ae5f267bed89825618d252b6699701f0819de6c'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.5'')')
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
