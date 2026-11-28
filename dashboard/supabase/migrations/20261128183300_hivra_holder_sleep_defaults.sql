create function public.set_hivra_holder_sleep_defaults()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  new.always_on := false;
  new.sleep_policy := 'full';
  return new;
end;
$$;

revoke all on function public.set_hivra_holder_sleep_defaults() from public, anon, authenticated, service_role;

create trigger hivra_agents_holder_sleep_defaults
before insert or update of seat_funding on public.hivra_agents
for each row when (new.seat_funding = 'holder' and new.deployment_mode = 'hivra-managed'
  and new.computer_substrate = 'proxmox-kvm' and new.deployment_target_id is null
  and new.infrastructure_connection_id is null)
execute function public.set_hivra_holder_sleep_defaults();
