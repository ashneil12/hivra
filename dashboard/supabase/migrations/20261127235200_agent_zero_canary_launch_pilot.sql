alter table public.hivra_canary_launch_pilots
  drop constraint hivra_canary_launch_pilots_pilot_check,
  add constraint hivra_canary_launch_pilots_pilot_check
    check (pilot in ('hermes', 'bux-dependencies', 'agent-zero'));
