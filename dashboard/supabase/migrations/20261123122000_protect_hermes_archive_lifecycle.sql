create or replace function public.hermes_instance_lifecycle_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_from = p_to or (p_from, p_to) in (
    ('pending','provisioning'), ('pending','failed'), ('pending','deleting'), ('pending','deleted'),
    ('provisioning','active'), ('provisioning','paused'), ('provisioning','failed'), ('provisioning','deleting'), ('provisioning','deleted'),
    ('active','provisioning'), ('active','paused'), ('active','suspended'), ('active','failed'), ('active','deleting'), ('active','deleted'),
    ('paused','provisioning'), ('paused','active'), ('paused','suspended'), ('paused','failed'), ('paused','deleting'), ('paused','deleted'), ('paused','archiving'),
    ('suspended','provisioning'), ('suspended','active'), ('suspended','paused'), ('suspended','failed'), ('suspended','deleting'), ('suspended','deleted'),
    ('failed','provisioning'), ('failed','active'), ('failed','paused'), ('failed','restoring'), ('failed','deleting'), ('failed','deleted'),
    ('deleting','deleted'), ('deleting','failed'),
    ('archiving','paused'), ('archiving','cold_archived'), ('archiving','failed'),
    ('cold_archived','restoring'), ('cold_archived','pending_deletion'), ('cold_archived','deleting'), ('cold_archived','deleted'),
    ('pending_deletion','restoring'), ('pending_deletion','deleting'), ('pending_deletion','deleted'),
    ('restoring','active'), ('restoring','cold_archived'), ('restoring','pending_deletion'), ('restoring','failed')
  );
$$;

create or replace function public.hermes_instance_protect_archive_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lifecycle_state is not distinct from old.lifecycle_state then
    return new;
  end if;

  if (new.lifecycle_state = 'deleted' and (
        old.lifecycle_state in ('archiving', 'restoring')
        or ((old.lifecycle_state in ('cold_archived', 'pending_deletion', 'failed')
             or old.lifecycle_substate = 'owner_archive_delete')
            and old.archive_uri is not null and new.archive_uri is not null)
      ))
     or (old.lifecycle_substate = 'cold_archive_reencrypt')
     or (old.lifecycle_substate = 'retention_archive_purge' and new.lifecycle_state <> 'deleted')
     or (old.lifecycle_state in ('cold_archived', 'pending_deletion')
      and not public.hermes_instance_lifecycle_allowed(old.lifecycle_state, new.lifecycle_state))
     or (old.lifecycle_state = 'failed' and old.archive_uri is not null
         and old.archive_sha256 is not null and old.proxmox_vmid is null
         and new.lifecycle_state not in ('restoring', 'deleting', 'deleted'))
     or (old.lifecycle_state = 'deleting' and old.lifecycle_substate = 'owner_archive_delete'
         and new.lifecycle_state <> 'deleted') then
    raise exception 'A Hermes archive cannot move from % to %', old.lifecycle_state, new.lifecycle_state
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists hermes_instances_protect_archive_lifecycle on public.hermes_instances;
create trigger hermes_instances_protect_archive_lifecycle
  before update of lifecycle_state on public.hermes_instances
  for each row execute function public.hermes_instance_protect_archive_lifecycle();
