-- Admit the reviewed 2026.11.12.3 provider bundle (Hermes restore points: the box gateway can
-- turn Hermes's own checkpoints on and off) without invalidating existing computers. The
-- TypeScript identities and manifest ship with the release; this keeps SQL admission and the
-- identity gates in step. The bundle digest is the manifest digest recorded in
-- provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.12.2 entry, which appears exactly once in each function (the
-- 2026.11.12.2 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.12.3 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.12.2''',
     '''2026.11.12.2'',''2026.11.12.3'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''b42e5c39bbc4f7ce155816e8db4944a951a8040b1c4b80238df00ff575cd6737'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''b42e5c39bbc4f7ce155816e8db4944a951a8040b1c4b80238df00ff575cd6737'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.2'') or (p_identity->''bundle''->>''bundleSha256''=''12ea5f0465a901a5b27a6b780fa3f497bf26006346209f7a7028d2b413d1e1a9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.3'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''b42e5c39bbc4f7ce155816e8db4944a951a8040b1c4b80238df00ff575cd6737'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''b42e5c39bbc4f7ce155816e8db4944a951a8040b1c4b80238df00ff575cd6737'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.2'') or (p_identity->''bundle''->>''bundleSha256''=''12ea5f0465a901a5b27a6b780fa3f497bf26006346209f7a7028d2b413d1e1a9'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.12.3'')')
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
