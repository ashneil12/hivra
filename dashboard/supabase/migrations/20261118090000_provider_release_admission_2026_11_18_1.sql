-- Admit the reviewed 2026.11.18.1 provider bundle (OpenClaw's Venice requests stay
-- inside Venice's chat schema; Aeon keeps a newer gh) without
-- invalidating existing computers. The TypeScript identities and manifest ship
-- with the release; this keeps SQL admission and the identity gates in step. The
-- bundle digest is the manifest digest of provisioner-releases/2026.11.18.1.json, and
-- the 2026.11.17.9 digest it anchors on is the one recorded in provider-desktop-worker.ts
-- and provider-native-worker.ts.
--
-- Anchors on the 2026.11.17.9 entry, which appears exactly once in each function (the
-- 2026.11.17.9 admission must be applied first). Idempotent: a function that already
-- admits 2026.11.18.1 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.17.9''',
     '''2026.11.17.9'',''2026.11.18.1'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''1b4ba16a649580df24e25cd4c8c24e999756286a29bd117e24c0addc4f099d8f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.9'')',
     '(p_identity->''bundle''->>''bundleSha256''=''1b4ba16a649580df24e25cd4c8c24e999756286a29bd117e24c0addc4f099d8f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.9'') or (p_identity->''bundle''->>''bundleSha256''=''18a96a99165a0266ac83b5807ce14b83aa04b4b6701b19de8314559196dca132'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.1'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''1b4ba16a649580df24e25cd4c8c24e999756286a29bd117e24c0addc4f099d8f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.9'')',
     '(p_identity->''bundle''->>''bundleSha256''=''1b4ba16a649580df24e25cd4c8c24e999756286a29bd117e24c0addc4f099d8f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.17.9'') or (p_identity->''bundle''->>''bundleSha256''=''18a96a99165a0266ac83b5807ce14b83aa04b4b6701b19de8314559196dca132'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.18.1'')')
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
