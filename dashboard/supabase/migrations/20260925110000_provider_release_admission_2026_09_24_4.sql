-- Admit the reviewed 2026.09.24.4 provider bundle (terminal follow-ups: the runtime
-- updater counts socket clients before restarting a terminal, and the gateway
-- never falls back to a socket-release terminal's loopback port) without
-- invalidating existing computers. The TypeScript identities and manifest ship
-- with the release; this keeps SQL admission and the identity gates in step. The
-- bundle digest is the manifest digest recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.09.24.3 entry, which appears exactly once whichever order the
-- 2026.09.24.3 and 2026.09.24.2 admissions were applied in. Idempotent: a function
-- that already admits 2026.09.24.4 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.24.3''',
     '''2026.09.24.3'',''2026.09.24.4'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''bd19950142f7c8e76f615b2ed1de075f76372a3b49bedd5291fa2242c540ce73'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''bd19950142f7c8e76f615b2ed1de075f76372a3b49bedd5291fa2242c540ce73'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.3'') or (p_identity->''bundle''->>''bundleSha256''=''3bc4df89f60582b8f9505e3ab9ee6b5a4a751a2633b2d709a1f4b12549fd3b49'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.4'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''bd19950142f7c8e76f615b2ed1de075f76372a3b49bedd5291fa2242c540ce73'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''bd19950142f7c8e76f615b2ed1de075f76372a3b49bedd5291fa2242c540ce73'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.3'') or (p_identity->''bundle''->>''bundleSha256''=''3bc4df89f60582b8f9505e3ab9ee6b5a4a751a2633b2d709a1f4b12549fd3b49'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.4'')')
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
