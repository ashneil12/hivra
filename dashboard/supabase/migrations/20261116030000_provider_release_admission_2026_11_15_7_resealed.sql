-- Re-admit the resealed 2026.11.15.7 provider bundle. The release was re-sealed
-- after the surface-watchdog corrections (the watchdog's probe no longer counts
-- as app use — it now proves itself with a box-local shared key instead of a
-- spoofable static marker — and its receipts are readable by the bux gateway),
-- so the sealed manifest digest changed from
-- 874c0d9df653f12acb2a0d765333f0c0aa95943e73ff437f8c6fe8df86a8d4d3 to
-- 7531d349e21783765e52b6d33c507a35568b0c8830f23faab1245f26bed48869.
--
-- Migrations are append-only, so rather than editing the original admission
-- this rewrites the 2026.11.15.7 clause inside both provider identity
-- functions: the old .7 clause appears exactly once in each. Idempotent: a
-- function already carrying the resealed clause is left as it is.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''874c0d9df653f12acb2a0d765333f0c0aa95943e73ff437f8c6fe8df86a8d4d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'')',
     '(p_identity->''bundle''->>''bundleSha256''=''7531d349e21783765e52b6d33c507a35568b0c8830f23faab1245f26bed48869'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'')'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''874c0d9df653f12acb2a0d765333f0c0aa95943e73ff437f8c6fe8df86a8d4d3'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'')',
     '(p_identity->''bundle''->>''bundleSha256''=''7531d349e21783765e52b6d33c507a35568b0c8830f23faab1245f26bed48869'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.15.7'')')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position(addition in definition) > 0 then
      if position(anchor in definition) > 0 then
        raise exception 'Provider release admission: conflicting .7 clauses present: %', signature;
      end if;
      continue;
    end if;
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Provider release admission anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
