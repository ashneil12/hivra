-- Admit the reviewed 2026.09.24.3 provider bundle (computer hardening: the two
-- ttyd terminals move to owner-only unix sockets and /api/git/* answers 404 in
-- the computer profile; attached agents get their units, workspace helper,
-- network and DNS relay) without invalidating existing computers. The
-- TypeScript identities and manifest ship with the release; this keeps SQL
-- admission and the identity gates in step. The bundle digest is the manifest
-- digest recorded in provider-desktop-worker.ts and provider-native-worker.ts.
--
-- 2026.09.24.2 belongs to a sibling release (persistent sessions, #124), which
-- merged first; 2026.09.24.3 is sealed on top of its bundle. Each admission
-- anchors on the 2026.09.24.1 entry, which either one leaves in place exactly
-- once, so the two admit each other's release in either apply order.
-- Idempotent: a function that already admits 2026.09.24.3 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.22.1'',''2026.09.22.2'',''2026.09.24.1''',
     '''2026.09.22.1'',''2026.09.22.2'',''2026.09.24.1'',''2026.09.24.3'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'') or (p_identity->''bundle''->>''bundleSha256''=''bd19950142f7c8e76f615b2ed1de075f76372a3b49bedd5291fa2242c540ce73'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.3'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''23214684196ddc161e76df3b49501c2239c4843e751497b332d81088802e5e04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.1'') or (p_identity->''bundle''->>''bundleSha256''=''bd19950142f7c8e76f615b2ed1de075f76372a3b49bedd5291fa2242c540ce73'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.24.3'')')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if left(addition, length(anchor)) <> anchor then
      raise exception 'Provider release admission must extend its anchor: %', signature;
    end if;
    -- Applied already: the anchor is a prefix of its own addition, so it would
    -- still match once and the admission would grow on every re-apply. Look for
    -- the added 2026.09.24.3 entry itself, not the whole addition: a sibling
    -- admission applied later inserts its release between the two.
    if position(substr(addition, length(anchor) + 1) in definition) > 0 then continue; end if;
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Provider release admission anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
