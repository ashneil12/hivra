alter table public.compute_usage_events
  add column if not exists reference_id text,
  add column if not exists usage_period_start timestamptz,
  add column if not exists usage_period_end timestamptz,
  add column if not exists status text not null default 'recorded'
    check (status in ('recorded', 'voided'));

update public.compute_usage_events
set reference_id = id::text
where reference_id is null;

alter table public.compute_usage_events
  alter column reference_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'compute_usage_events_usage_kind_reference_id_key'
  ) then
    alter table public.compute_usage_events
      add constraint compute_usage_events_usage_kind_reference_id_key
      unique (usage_kind, reference_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'credit_reservations_user_reason_reference_key'
  ) then
    alter table public.credit_reservations
      add constraint credit_reservations_user_reason_reference_key
      unique (user_id, reason, reference_id);
  end if;
end $$;

drop trigger if exists credit_reservations_updated_at on public.credit_reservations;
create trigger credit_reservations_updated_at
  before update on public.credit_reservations
  for each row execute function update_updated_at();

create index if not exists compute_usage_events_reference_idx
  on public.compute_usage_events(usage_kind, reference_id);

create index if not exists compute_usage_events_instance_period_idx
  on public.compute_usage_events(instance_id, usage_period_start desc);
