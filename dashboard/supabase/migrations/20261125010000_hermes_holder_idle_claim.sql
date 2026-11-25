-- Overlapping minute ticks must not both shut down the same classic Hermes VM.
alter table public.hermes_instances
  add column if not exists holder_idle_claimed_at timestamptz;
