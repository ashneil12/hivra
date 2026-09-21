-- Attachment groundwork only: no write-authority cutover or new writer grants.
-- Existing conflicting bindings cause migration failure, never silent cleanup.
create unique index hivra_canonical_one_active_computer_per_identity
  on public.hivra_canonical_primary_bindings(agent_identity_id)
  where status = 'active';

create function public.guard_hivra_canonical_source_provenance()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'canonical source provenance must be retained'
      using errcode = '23514';
  end if;
  if row(new.source_kind, new.source_id, new.user_id, new.resource_kind,
      new.compatibility_alias, new.computer_id, new.agent_identity_id,
      new.runtime_installation_id, new.primary_binding_id,
      new.first_source_event_id, new.created_at)
    is distinct from
    row(old.source_kind, old.source_id, old.user_id, old.resource_kind,
      old.compatibility_alias, old.computer_id, old.agent_identity_id,
      old.runtime_installation_id, old.primary_binding_id,
      old.first_source_event_id, old.created_at)
    or new.last_source_event_id < old.last_source_event_id then
    raise exception 'canonical source provenance is immutable and its cursor cannot regress'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_hivra_canonical_source_provenance()
  from public, anon, authenticated, service_role;

create trigger hivra_canonical_source_provenance_guard
before update or delete on public.hivra_canonical_source_mappings
for each row execute function public.guard_hivra_canonical_source_provenance();

comment on function public.guard_hivra_canonical_source_provenance() is
  'Preserves original source lineage through projection and tombstones. Current relationships require a separate authority cutover; this does not enable attachment.';
