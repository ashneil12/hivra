-- Give operating-system computers a first-class profile identity instead of
-- inferring Ubuntu forever from the temporary `linux-desktop` runtime id.
-- Existing Ubuntu alpha rows are backfilled; agent-only computers stay null.

alter table public.hivra_agents
  add column if not exists computer_profile text;

update public.hivra_agents
set computer_profile = 'ubuntu-desktop'
where type = 'linux-desktop'
  and computer_profile is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.hivra_agents'::regclass
      and conname = 'hivra_agents_computer_profile_check'
  ) then
    alter table public.hivra_agents
      add constraint hivra_agents_computer_profile_check
      check (computer_profile is null or computer_profile in ('ubuntu-desktop', 'omarchy', 'windows'));
  end if;
end $$;

create index if not exists hivra_agents_computer_profile_idx
  on public.hivra_agents (user_id, computer_profile, created_at desc)
  where computer_profile is not null;
