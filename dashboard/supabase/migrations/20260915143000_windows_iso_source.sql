alter table public.hivra_agents
  add column if not exists windows_iso_source text;

alter table public.hivra_agents
  drop constraint if exists hivra_agents_windows_iso_source_check;

alter table public.hivra_agents
  add constraint hivra_agents_windows_iso_source_check
  check (
    windows_iso_source is null
    or windows_iso_source in ('unknown', 'windows-11', 'windows-server-evaluation')
  );
