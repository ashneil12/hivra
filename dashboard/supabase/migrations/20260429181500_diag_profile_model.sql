-- Diagnostic: dump the new instance's stored model + provider, plus any
-- per-profile model overrides, so we can see whether the user's "switch
-- to Anthropic Claude 4.7 in BASE LLM OVERRIDE" actually persisted to
-- the DB or got dropped silently. The dashboard's chat-send reads
--   analyticsModel = activeProfile?.model || instance.config?.model
-- so we need to see BOTH layers.
do $$
declare
  rec record;
begin
  raise notice '=== ACTIVE Proxmox WebUI instance + stored config.model + provider ===';
  for rec in
    select
      i.id,
      i.name,
      i.provider,
      i.config->>'model' as cfg_model,
      i.lifecycle_state,
      i.created_at
    from public.hermes_instances i
    where i.lifecycle_state is distinct from 'deleted'
      and (i.config->>'backend' = 'webui' or i.backend = 'webui')
    order by i.created_at desc
    limit 5
  loop
    raise notice 'INSTANCE id=% name=% provider=% cfg.model=% state=%',
      substring(rec.id::text, 1, 8),
      rec.name,
      rec.provider,
      coalesce(rec.cfg_model, '<null>'),
      rec.lifecycle_state;
  end loop;

  raise notice '=== Profiles table (per-instance per-profile model overrides) ===';
  for rec in
    select
      p.id,
      p.instance_id,
      p.profile_name,
      p.config->>'model' as profile_model,
      p.config->>'provider' as profile_provider,
      p.created_at,
      p.updated_at
    from public.hermes_instance_profiles p
    join public.hermes_instances i on i.id = p.instance_id
    where i.lifecycle_state is distinct from 'deleted'
    order by p.updated_at desc nulls last
    limit 10
  loop
    raise notice 'PROFILE inst=% name=% model=% provider=% created=% updated=%',
      substring(rec.instance_id::text, 1, 8),
      rec.profile_name,
      coalesce(rec.profile_model, '<null>'),
      coalesce(rec.profile_provider, '<null>'),
      rec.created_at,
      rec.updated_at;
  end loop;
exception when undefined_table then
  raise notice 'NOTE: hermes_instance_profiles table does not exist; profiles must live elsewhere';
end $$;
