-- Admit the reviewed 2026.11.15.1 provider bundle (Agent Zero self-update
-- layout: upstream v2.15+ serves a splash bootstrap at / that installs the
-- real document from /ui/index, so the box gateway falls back from / to the
-- canonical /index.html document and still serves only documents that satisfy
-- the pinned entry transform; /agent-zero/ui/index redirects to the mount
-- root; no guest asset changes beyond the gateway) without invalidating
-- existing computers. The TypeScript identities and manifest ship with the
-- release; this keeps SQL admission and the identity gates in step. The
-- bundle digest is the manifest digest of
-- provisioner-releases/2026.11.15.1.json, and the 2026.11.14.1 digest it
-- anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.14.1 entry, which appears exactly once in each
-- function (the 2026.11.14.1 admission is the latest one applied, so it must
-- be applied first). Idempotent: a function that already admits 2026.11.15.1
-- is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.14.1''',
     '''2026.11.14.1'',''2026.11.15.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''03f424cd434b5142c8f482c67ad5b2a61787a5404a2cb8ec6a2ecd4fec72fd04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.14.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''03f424cd434b5142c8f482c67ad5b2a61787a5404a2cb8ec6a2ecd4fec72fd04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.14.1'') or (p_identity->''bundle''->>''bundleSha256''=''4729a8faca0ab45d854ad48423ee6d87bfb94e818ce27599817998fdf2ababd8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.1'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''03f424cd434b5142c8f482c67ad5b2a61787a5404a2cb8ec6a2ecd4fec72fd04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.14.1'')',
     '(p_identity->''bundle''->>''bundleSha256''=''03f424cd434b5142c8f482c67ad5b2a61787a5404a2cb8ec6a2ecd4fec72fd04'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.14.1'') or (p_identity->''bundle''->>''bundleSha256''=''4729a8faca0ab45d854ad48423ee6d87bfb94e818ce27599817998fdf2ababd8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.1'')')
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
