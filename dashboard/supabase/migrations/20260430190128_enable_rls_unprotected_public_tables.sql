-- Address Supabase security advisor (lint=0013_rls_disabled_in_public) for
-- three tables in the public schema that were exposed via PostgREST without
-- row level security. Surfaced post-DDL after applying signup_risk_assessments.
--
-- Triage (verified before this migration):
--
--   public.vm_response_seconds_daily  — Per-instance daily rollups of
--     chat-stream wallclock seconds. Written by the out-of-process
--     hermes-warden daemon via the service role (bypasses RLS). Currently
--     no V2 dashboard code reads this, but enabling RLS without a SELECT
--     policy would silently break any future end-user read. We add a
--     "users read own" policy that traverses instance ownership through
--     hermes_instances.user_id, matching the same pattern other per-
--     instance tables in this schema use.
--
--   public.scheduled_tasks  — Legacy V1-era stub. Single column (`id` uuid),
--     zero rows, zero V2 dashboard references (V2 uses hermes_scheduled_tasks
--     instead). Could probably be DROPped in a future cleanup, but the
--     minimum-viable advisor fix is RLS enabled + no policies — service
--     role still works, public/authenticated access is denied by default.
--
--   public.task_history  — Same shape and disposition as scheduled_tasks.
--     V1 stub, no V2 references, RLS enabled with no policies.
--
-- All three operations are idempotent against re-application:
--   - alter table ... enable row level security is a no-op if already on
--   - the policy is wrapped in a do-block guard against pg_policies

alter table public.vm_response_seconds_daily enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vm_response_seconds_daily'
      and policyname = 'users read own vm response seconds'
  ) then
    create policy "users read own vm response seconds"
      on public.vm_response_seconds_daily for select
      using (
        exists (
          select 1
          from public.hermes_instances
          where hermes_instances.id = vm_response_seconds_daily.instance_id
            and hermes_instances.user_id = auth.uid()::text
        )
      );
  end if;
end $$;

alter table public.scheduled_tasks enable row level security;
alter table public.task_history enable row level security;

comment on table public.vm_response_seconds_daily is
  'Per-instance daily cumulative chat-stream wallclock seconds, written by hermes-warden from host Caddy access logs. Source of truth for free/starter tier daily caps. RLS: users SELECT own via hermes_instances ownership.';
comment on table public.scheduled_tasks is
  'Legacy V1 stub table (single id column, zero rows). Kept for safety; V2 uses hermes_scheduled_tasks. RLS enabled with no policies — service role only.';
comment on table public.task_history is
  'Legacy V1 stub table (single id column, zero rows). RLS enabled with no policies — service role only.';
