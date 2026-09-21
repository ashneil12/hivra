-- Add the sealed workspace-capable guest without rewriting any predecessor.
-- This is release admission, not proof of installed workspace functionality.
do $migration$
declare signature text; definition text; anchor text; addition text;
begin
  for signature, anchor, addition in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     '''2026.09.05.6'',''2026.09.05.7'',''2026.09.05.8''',
     '''2026.09.05.6'',''2026.09.05.7'',''2026.09.05.8'',''2026.09.05.9'''),
    ('public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.8'')',
     '((p_identity->''bundle''->>''bundleSha256''=''007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.8'') or (p_identity->''bundle''->>''bundleSha256''=''89b5e64591d3cff0f2a4f28460ee9075221946ed37694ec5eb566c5a40af4127'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.9''))'),
    ('public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid)',
     '(p_identity->''bundle''->>''bundleSha256''=''007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.8'')',
     '((p_identity->''bundle''->>''bundleSha256''=''007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.8'') or (p_identity->''bundle''->>''bundleSha256''=''89b5e64591d3cff0f2a4f28460ee9075221946ed37694ec5eb566c5a40af4127'' and p_identity->''bundle''->>''provisionerVersion''=''2026.09.05.9''))')
  ) as patches(signature, anchor, addition)
  loop
    definition := pg_get_functiondef(signature::regprocedure);
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'Workspace release anchor mismatch: %', signature;
    end if;
    execute replace(definition, anchor, addition);
  end loop;
end;
$migration$;
