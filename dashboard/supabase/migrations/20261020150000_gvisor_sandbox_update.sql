-- Owner Update for Linux Sandbox (gVisor) computers. Adapter release
-- 2026.10.20.1 recreates a sandbox's container on the pinned image, keeping
-- its /workspace volume, and manages sandboxes created by release
-- 2026.09.15.1. This migration:
--  1. admits the new adapter release on rows and target evidence;
--  2. lets host setup replace Hivra's own 2026.09.15.1 adapter while
--     sandboxes pinned to it remain (they keep working on the new adapter);
--  3. lets exactly one transition re-pin a sandbox from 2026.09.15.1 to the
--     host's current adapter: the completion of its owner's Update;
--  4. adds the runtime_update operation kind (the same constraint the
--     My cloud runtime update defines, so either order applies).
-- Each function and constraint is patched from its live definition, and each
-- anchor must occur exactly once.

alter table public.hivra_agents drop constraint if exists hivra_agents_operation_shape_check;
alter table public.hivra_agents add constraint hivra_agents_operation_shape_check check (
  (operation_id is null and operation_kind is null and operation_started_at is null and operation_payload is null)
  or (operation_id is not null and operation_kind in
    ('provision','start','stop','restart','resize','snapshot','restore','delete','desktop_prepare','agent_attach',
     'private_access','agent_access_change','agent_detach','runtime_update')
    and operation_kind is not null and operation_started_at is not null
    and (operation_payload is null or jsonb_typeof(operation_payload)='object'))
);

do $migration$
declare definition text; anchor text; addition text; signature text;
begin
  -- 1. Rows may carry either admitted adapter release.
  select pg_get_constraintdef(oid) into definition from pg_constraint
    where conrelid='public.hivra_agents'::regclass and conname='hivra_agents_provider_identity_check';
  anchor := '(gvisor_adapter_version = ''2026.09.15.1''::text)';
  addition := '(gvisor_adapter_version = ANY (ARRAY[''2026.09.15.1''::text, ''2026.10.20.1''::text]))';
  if position(addition in definition) = 0 then
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'gVisor identity anchor mismatch';
    end if;
    execute 'alter table public.hivra_agents drop constraint hivra_agents_provider_identity_check, add constraint hivra_agents_provider_identity_check '
      || replace(definition, anchor, addition);
  end if;

  -- 2. Target evidence from either release; a new adapter may replace
  -- 2026.09.15.1 under the sandboxes still pinned to it.
  signature := 'public.commit_hivra_gvisor_target_preflight(text,uuid,bigint,timestamptz,uuid,jsonb)';
  definition := pg_get_functiondef(signature::regprocedure);
  for anchor, addition in select * from (values
    ('"adapter":{"version":"2026.09.15.1"}', '"adapter":{}'),
    ('or p_target->''capabilities''->''adapter''->>''version''<>''2026.09.15.1''',
     'or coalesce(p_target->''capabilities''->''adapter''->>''version'' not in (''2026.09.15.1'',''2026.10.20.1''),true)'),
    ('      and (a.gvisor_adapter_sha256<>p_target->''capabilities''->''adapter''->>''sha256''
        or a.gvisor_runtime_sha256',
     '      and ((a.gvisor_adapter_sha256<>p_target->''capabilities''->''adapter''->>''sha256''
          and not (a.gvisor_adapter_version=''2026.09.15.1''
            and a.gvisor_adapter_sha256=''2bb8ce761b72a5fc5054b8dbf9f7c79684da478b74c5f1127a212c489539695d''
            and p_target->''capabilities''->''adapter''->>''version''=''2026.10.20.1''))
        or a.gvisor_runtime_sha256')
  ) as patches(anchor, addition)
  loop
    if position(addition in definition) > 0 then continue; end if;  -- Already patched.
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'gVisor preflight anchor mismatch: %', left(anchor, 60);
    end if;
    definition := replace(definition, anchor, addition);
  end loop;
  execute definition;

  -- 3. The one re-pin: the completion of the owner's Update, from the
  -- admitted earlier adapter to the ready target's current one.
  signature := 'public.guard_hivra_gvisor_computer()';
  definition := pg_get_functiondef(signature::regprocedure);
  anchor := '      )) then raise exception ''gVisor computer authority is immutable''';
  addition := '      ) or (
        old.operation_kind=''runtime_update'' and new.operation_id is null and new.operation_kind is null
        and old.status<>''deleted'' and new.status<>''deleted''
        and old.gvisor_adapter_version=''2026.09.15.1''
        and old.gvisor_adapter_sha256=''2bb8ce761b72a5fc5054b8dbf9f7c79684da478b74c5f1127a212c489539695d''
        and new.gvisor_adapter_version=''2026.10.20.1''
        and row(new.id,new.user_id,new.computer_substrate,new.deployment_mode,new.infrastructure_connection_id,
          new.deployment_target_id,new.infrastructure_connection_revision,new.gvisor_sandbox_id,new.gvisor_runtime_sha256,
          new.infrastructure_binding_token_hash,new.infrastructure_binding_token_enforced)
        is not distinct from row(old.id,old.user_id,old.computer_substrate,old.deployment_mode,old.infrastructure_connection_id,
          old.deployment_target_id,old.infrastructure_connection_revision,old.gvisor_sandbox_id,old.gvisor_runtime_sha256,
          old.infrastructure_binding_token_hash,old.infrastructure_binding_token_enforced)
        and exists (select 1 from public.deployment_targets t
          where t.id=new.deployment_target_id and t.user_id=new.user_id
            and t.connection_id=new.infrastructure_connection_id
            and t.evidence_connection_revision=new.infrastructure_connection_revision
            and t.status=''ready'' and t.capabilities->>''kind''=''gvisor''
            and t.capabilities->''adapter''->>''version''=new.gvisor_adapter_version
            and t.capabilities->''adapter''->>''sha256''=new.gvisor_adapter_sha256
            and t.capabilities->''runtime''->>''sha256''=new.gvisor_runtime_sha256)
' || anchor;
  if position('old.operation_kind=''runtime_update''' in definition) = 0 then
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'gVisor guard anchor mismatch';
    end if;
    execute replace(definition, anchor, addition);
  end if;
end;
$migration$;
