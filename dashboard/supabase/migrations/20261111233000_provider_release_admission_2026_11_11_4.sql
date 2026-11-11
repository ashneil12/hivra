-- Admit the reviewed 2026.11.11.4 provider bundle (the official Hermes Agent as a computer
-- kind: its own installer, the gateway proxy for its web UI and its update) without
-- invalidating existing computers.
-- The TypeScript identities and manifest ship with the release; this keeps SQL
-- admission and the identity gates in step. The bundle digest is the manifest digest
-- recorded in provider-desktop-worker.ts and provider-native-worker.ts.
--
-- Anchors on the 2026.11.11.3 entry, which appears exactly once in each function (the
-- 2026.11.11.3 admission is the latest one applied, so it must be applied first).
-- Idempotent: a function that already admits 2026.11.11.4 is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.11.3''',
     '''2026.11.11.3'',''2026.11.11.4'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''b0a1ff631ab30fdda0c4ec5016a8c7d22888064134a82ae88594679c107b78e8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''b0a1ff631ab30fdda0c4ec5016a8c7d22888064134a82ae88594679c107b78e8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.3'') or (p_identity->''bundle''->>''bundleSha256''=''f5e0c408e47f9c1950da3e228bf4234be877ab613de966bfea7540da35daee45'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.4'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''b0a1ff631ab30fdda0c4ec5016a8c7d22888064134a82ae88594679c107b78e8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.3'')',
     '(p_identity->''bundle''->>''bundleSha256''=''b0a1ff631ab30fdda0c4ec5016a8c7d22888064134a82ae88594679c107b78e8'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.3'') or (p_identity->''bundle''->>''bundleSha256''=''f5e0c408e47f9c1950da3e228bf4234be877ab613de966bfea7540da35daee45'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.11.4'')')
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
