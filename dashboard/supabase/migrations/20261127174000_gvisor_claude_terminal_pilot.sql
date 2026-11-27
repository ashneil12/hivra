alter table public.hivra_agents
  add column gvisor_claude_terminal_image text,
  add constraint hivra_agents_claude_terminal_scope_check check (
    gvisor_claude_terminal_image is null or (
      gvisor_claude_terminal_image ~ '^sha256:[0-9a-f]{64}$'
      and computer_substrate = 'gvisor' and deployment_mode = 'self-managed'
      and type = 'linux-terminal' and computer_profile is not distinct from 'linux-terminal'
    )
  );

create unique index hivra_agents_one_live_claude_terminal_per_target
  on public.hivra_agents (deployment_target_id)
  where gvisor_claude_terminal_image is not null and status <> 'deleted';

create function public.guard_hivra_claude_terminal_image()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if new.gvisor_claude_terminal_image is distinct from old.gvisor_claude_terminal_image then
    raise exception 'The sandbox workload image is immutable' using errcode = '55006';
  end if;
  return new;
end;
$$;

create trigger hivra_agents_claude_terminal_image_immutable
  before update of gvisor_claude_terminal_image on public.hivra_agents
  for each row execute function public.guard_hivra_claude_terminal_image();
