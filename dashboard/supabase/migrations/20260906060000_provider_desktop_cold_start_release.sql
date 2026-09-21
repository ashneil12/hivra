-- Add the sealed .05.8 identity without replacing newer ownership/lifecycle
-- logic or changing historical release identities. Fail on unexpected drift.
do $migration$
declare
  signature text;
  definition text;
  anchor text;
  addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.05.6'',''2026.09.05.7''',
     '''2026.09.05.6'',''2026.09.05.7'',''2026.09.05.8'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.7'')',
     '((p_identity->''bundle''->>''bundleSha256''=''d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.7'') or (p_identity->''bundle''->>''bundleSha256''=''007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.8''))'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b''
      and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.7'')',
     '((p_identity->''bundle''->>''bundleSha256''=''d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b''
      and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.7'') or (p_identity->''bundle''->>''bundleSha256''=''007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.8''))')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Cold-start release anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
