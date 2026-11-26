-- Overlapping minute ticks must not both shut down the same classic Hermes VM.
alter table public.hermes_instances
  add column if not exists holder_idle_claimed_at timestamptz;

create or replace function public.holder_admission_has_active_wake(p_user_id text)
returns boolean
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select exists (
    select 1
    from public.hermes_instances h
    where h.user_id = p_user_id
      and h.seat_funding = 'holder'
      and h.lifecycle_state = 'paused'
      and h.status = 'stopped'
      and h.paused_reason = 'holder_idle'
      and h.lifecycle_substate = 'holder_wake'
      and h.holder_idle_claimed_at > now() - interval '6 minutes'
      and h.deleted_at is null
  );
$$;

revoke all on function public.holder_admission_has_active_wake(text) from public,anon,authenticated,service_role;
grant execute on function public.holder_admission_has_active_wake(text) to service_role;
