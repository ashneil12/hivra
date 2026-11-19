-- Admit the reviewed 2026.11.11.3 provider bundle (the gateway passes the chat's reasoning
-- effort to Claude Code and Codex and advertises it) without invalidating existing computers.
-- The TypeScript identities and manifest ship with the release; this keeps SQL
-- admission and the identity gates in step. The bundle digest is the manifest digest
-- recorded in provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.11.2 entry, which appears exactly once in each function (the
-- 2026.11.11.2 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.11.3 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.11.2''',
     '''2026.11.11.2'',''2026.11.11.3'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''21d6f9aaed7820ef3c80c5fecc2c237ebe9fdc63bcd7b819dae0b341de81a15f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''21d6f9aaed7820ef3c80c5fecc2c237ebe9fdc63bcd7b819dae0b341de81a15f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.2'') or (p_identity->''bundle''->>''bundleSha256''=''b0a1ff631ab30fdda0c4ec5016a8c7d22888064134a82ae88594679c107b78e8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.3'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''21d6f9aaed7820ef3c80c5fecc2c237ebe9fdc63bcd7b819dae0b341de81a15f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.2'')',
     '(p_identity->''bundle''->>''bundleSha256''=''21d6f9aaed7820ef3c80c5fecc2c237ebe9fdc63bcd7b819dae0b341de81a15f'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.2'') or (p_identity->''bundle''->>''bundleSha256''=''b0a1ff631ab30fdda0c4ec5016a8c7d22888064134a82ae88594679c107b78e8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.3'')')
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
