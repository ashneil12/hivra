-- Admit the reviewed 2026.11.15.7 provider bundle (Agent Zero plugin web UI
-- module imports under /usr/plugins now pass the no-Referer static-import
-- allowlist instead of answering 404, which broke plugin managers such as
-- Tailscale's; and the pinned Agent Zero image moves to v2.15,
-- agent0ai/agent-zero@sha256:05d6ab347bd7db4b6bd5a7d902c9965281ff852ff23f29fffcc1c8919e628bd8,
-- with the reviewed v2.2 image retained in the pin's previous list)
-- without invalidating existing computers. The TypeScript identities and
-- manifest ship with the release; this keeps SQL admission and the identity
-- gates in step. The bundle digest is the manifest digest of
-- provisioner-releases/2026.11.15.7.json, and the 2026.11.15.6 digest it
-- anchors on is the one recorded in provider-desktop-worker.ts and
-- provider-native-worker.ts.
--
-- Anchors on the 2026.11.15.6 entry, which appears exactly once in each
-- function (the 2026.11.15.6 admission is the latest one applied, so it must
-- be applied first). Idempotent: a function that already admits 2026.11.15.7
-- is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.15.6''',
     '''2026.11.15.6'',''2026.11.15.7'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''3063e0f8e3f0fbd3d256d9b6ae635bf02d129c049c99849ae376e03082896973'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.6'')',
     '(p_identity->''bundle''->>''bundleSha256''=''3063e0f8e3f0fbd3d256d9b6ae635bf02d129c049c99849ae376e03082896973'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.6'') or (p_identity->''bundle''->>''bundleSha256''=''a7e22d13919998dabdf1f80dd545b844b25eabd01f9f91cd624f53b1b2b5f7d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''3063e0f8e3f0fbd3d256d9b6ae635bf02d129c049c99849ae376e03082896973'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.6'')',
     '(p_identity->''bundle''->>''bundleSha256''=''3063e0f8e3f0fbd3d256d9b6ae635bf02d129c049c99849ae376e03082896973'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.6'') or (p_identity->''bundle''->>''bundleSha256''=''a7e22d13919998dabdf1f80dd545b844b25eabd01f9f91cd624f53b1b2b5f7d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'')')
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
