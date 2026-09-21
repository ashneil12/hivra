-- Explicit whole-computer deletion may remove the original exclusive provider
-- VM after its installer has stopped, even before desktop ownership publication.
-- Keep provision/allocation held until separately observed provider absence.
create function public.hivra_provider_desktop_teardown_allowed(a public.hivra_agents)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select (a.computer_substrate='provider-vm' and a.type='linux-desktop'
    and a.computer_profile='ubuntu-desktop' and a.status='provisioning'
    and a.desired_state='deleted' and a.operation_kind='provision'
    and a.operation_id=a.allocation_operation_id and a.provider_install_stopped_at is not null
    and a.provider_install_outcome in ('failed','cancelled','succeeded')
    and public.hivra_provider_desktop_identity_valid(a.provider_install_identity,a.id,a.operation_id)
    and exists(select 1 from public.hivra_provider_desktop_cleanup j
      where j.agent_id=a.id and j.user_id=a.user_id and j.operation_id=a.operation_id
        and j.identity=a.provider_install_identity)) is true;
$$;
revoke all on function public.hivra_provider_desktop_teardown_allowed(public.hivra_agents) from public,anon,authenticated;
grant execute on function public.hivra_provider_desktop_teardown_allowed(public.hivra_agents) to service_role;

-- Extend only the original target retirement and leased provider cleanup path.
-- Existing exact owner, resource, revision, firewall, lease and identity checks
-- remain. No operation release, guest cleanup proof or deletion completion here.
do $migration$
declare spec record; definition text;
begin
  for spec in select * from (values
    ('public.retire_hivra_provider_target(text,uuid,bigint,uuid,uuid,text,uuid,uuid)',
      $old$or v_agent.operation_kind is distinct from 'delete'$old$,
      $new$or (v_agent.operation_kind is distinct from 'delete' and not public.hivra_provider_desktop_teardown_allowed(v_agent))$new$),
    ('public.claim_hetzner_cleanup_with_firewall(text,uuid,bigint,uuid,uuid,uuid,text,text,jsonb)',
      $old$or a.operation_kind is distinct from 'delete'$old$,
      $new$or (a.operation_kind is distinct from 'delete' and not public.hivra_provider_desktop_teardown_allowed(a))$new$),
    ('public.guard_provider_agent_parent()',
      $old$and a.operation_kind='delete' and a.operation_id is not null$old$,
      $new$and (a.operation_kind='delete' or public.hivra_provider_desktop_teardown_allowed(a)) and a.operation_id is not null$new$)
  ) as changes(signature,anchor,replacement) loop
    select pg_get_functiondef(spec.signature::regprocedure) into definition;
    if length(definition)-length(replace(definition,spec.anchor,''))<>length(spec.anchor) then
      raise exception 'Unexpected provider cleanup definition: %',spec.signature; end if;
    execute replace(definition,spec.anchor,spec.replacement);
  end loop;
end;
$migration$;
