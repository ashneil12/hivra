-- Light Linux computer: a small headless Ubuntu computer with a terminal and
-- files and no desktop. It is the existing linux-desktop agent type with the
-- new computer_profile 'ubuntu-server', so launch operations, the canonical
-- shadow and agent links keep working on the same type. Both changes only widen
-- what is allowed; no existing row or ubuntu-desktop binding changes.
--
-- 1. computer_profile may now be 'ubuntu-server'. The latest list is the one in
--    20260915170000_hivra_gvisor_computers.sql.
-- 2. bind_hivra_launch_operation_agent (20260904110000, never redefined since)
--    binds a linux-desktop launch to an ubuntu-desktop or ubuntu-server row. It
--    is patched in place on its one profile clause. The guard fails if that
--    clause is missing or appears more than once, and a function that already
--    admits ubuntu-server is left as it is (idempotent).
alter table public.hivra_agents
  drop constraint if exists hivra_agents_computer_profile_check,
  add constraint hivra_agents_computer_profile_check
    check (computer_profile is null or computer_profile in ('ubuntu-desktop','omarchy','windows','linux-terminal','ubuntu-server'));

do $migration$
declare
  signature constant text := 'public.bind_hivra_launch_operation_agent(text,uuid,uuid,text,text,uuid)';
  anchor constant text := 'a.computer_profile is distinct from ''ubuntu-desktop''';
  addition constant text := 'coalesce(a.computer_profile, '''') not in (''ubuntu-desktop'', ''ubuntu-server'')';
  definition text;
begin
  definition := pg_get_functiondef(signature::regprocedure);
  if position(addition in definition) > 0 then return; end if;
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'Ubuntu server profile anchor mismatch: %', signature;
  end if;
  execute replace(definition, anchor, addition);
end;
$migration$;
