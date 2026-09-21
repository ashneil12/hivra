-- Diagnostic: dump the user's hermes_conversations rows alongside the
-- corresponding instance lifecycle_state, so we can see whether the
-- "Managed chat stream closed before completion" bug is being caused by
-- conversations from a soft-deleted previous instance leaking into the
-- new instance's chat list (sending the agent a stale upstream_session_id
-- that no longer exists on the freshly-provisioned VM).
-- No data mutation. Output is read from `supabase db push` stdout.
do $$
declare
  rec record;
  active_count integer;
  deleted_count integer;
begin
  select count(*) into active_count
    from public.hermes_conversations c
    join public.hermes_instances i on i.id = c.instance_id
    where i.lifecycle_state is distinct from 'deleted';
  select count(*) into deleted_count
    from public.hermes_conversations c
    join public.hermes_instances i on i.id = c.instance_id
    where i.lifecycle_state = 'deleted';
  raise notice 'Conversations on ACTIVE instances: %', active_count;
  raise notice 'Conversations on DELETED instances (orphaned): %', deleted_count;

  -- Last 12 conversations per user, including which instance they're on
  -- and whether that instance is still alive.
  for rec in
    select
      c.id          as conv_id,
      c.instance_id,
      i.name        as instance_name,
      i.lifecycle_state,
      i.proxmox_vmid,
      c.profile_name,
      c.upstream_session_id,
      c.upstream_source,
      c.created_at  as conv_created,
      c.updated_at  as conv_updated
    from public.hermes_conversations c
    left join public.hermes_instances i on i.id = c.instance_id
    order by c.updated_at desc nulls last
    limit 12
  loop
    raise notice 'CONV id=% inst=% (%) state=% vmid=% profile=% upstream_sid=% src=% created=% updated=%',
      substring(rec.conv_id::text, 1, 8),
      substring(rec.instance_id::text, 1, 8),
      coalesce(rec.instance_name, '<no instance>'),
      coalesce(rec.lifecycle_state, '<null>'),
      coalesce(rec.proxmox_vmid::text, '<null>'),
      coalesce(rec.profile_name, '<null>'),
      coalesce(rec.upstream_session_id, '<null>'),
      coalesce(rec.upstream_source, '<null>'),
      rec.conv_created,
      rec.conv_updated;
  end loop;
end $$;
