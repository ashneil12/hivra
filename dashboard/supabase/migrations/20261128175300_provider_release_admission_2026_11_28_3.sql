do $migration$
declare
  signature text;
  definition text;
  anchor text;
  suffix text;
  prior_seal text := '(p_identity->''bundle''->>''bundleSha256''=''dd1edf73e6bb8d5344ac8ef8e385e8cdbdb0efccdd32760ae99a9cdf502e0b27'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.28.2'')';
  next_seal text := '(p_identity->''bundle''->>''bundleSha256''=''fb582b188711110cf9f4c966574550297dc59fccc191619bebe2dde2f305eba2'' and p_identity->''bundle''->>''provisionerVersion''=''2026.11.28.3'')';
begin
  for signature, anchor, suffix in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.11.28.2''', ',''2026.11.28.3'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)', prior_seal, ' or ' || next_seal),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)', prior_seal, ' or ' || next_seal)
  ) as patches(signature, anchor, suffix)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position(anchor || suffix in definition) > 0 then continue; end if;
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Provider release admission anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, anchor || suffix);
  end loop;
end;
$migration$;
