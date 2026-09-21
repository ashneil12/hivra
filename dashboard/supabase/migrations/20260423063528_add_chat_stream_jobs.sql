-- Durable server-owned chat stream jobs

create table if not exists public.hermes_chat_stream_jobs (
    id uuid primary key default gen_random_uuid(),
    stream_key text not null unique,
    instance_id uuid not null references public.hermes_instances(id) on delete cascade,
    conversation_id uuid not null references public.hermes_conversations(id) on delete cascade,
    message_id uuid not null references public.hermes_messages(id) on delete cascade,
    parent_id uuid references public.hermes_messages(id) on delete set null,
    user_id text not null,
    profile_name text not null default 'default',
    status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'stopped')),
    stream_request jsonb not null,
    fallback_request jsonb not null,
    runner_id text,
    lease_expires_at timestamptz,
    last_heartbeat_at timestamptz,
    stop_requested boolean not null default false,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    started_at timestamptz,
    completed_at timestamptz
);

create index if not exists hermes_chat_stream_jobs_status_idx
    on public.hermes_chat_stream_jobs(status, lease_expires_at, created_at);

create index if not exists hermes_chat_stream_jobs_instance_profile_idx
    on public.hermes_chat_stream_jobs(instance_id, profile_name, status, created_at);

create index if not exists hermes_chat_stream_jobs_conversation_idx
    on public.hermes_chat_stream_jobs(conversation_id, status, created_at);

create unique index if not exists hermes_chat_stream_jobs_message_idx
    on public.hermes_chat_stream_jobs(message_id);

drop trigger if exists hermes_chat_stream_jobs_updated_at on public.hermes_chat_stream_jobs;
create trigger hermes_chat_stream_jobs_updated_at
    before update on public.hermes_chat_stream_jobs
    for each row execute function update_updated_at();

alter table public.hermes_chat_stream_jobs enable row level security;

drop policy if exists "users see own chat stream jobs" on public.hermes_chat_stream_jobs;
create policy "users see own chat stream jobs"
    on public.hermes_chat_stream_jobs for all
    using (auth.uid()::text = user_id)
    with check (auth.uid()::text = user_id);

create or replace function public.claim_hermes_chat_stream_jobs(
    p_runner_id text,
    p_limit integer default 1,
    p_lease_seconds integer default 30
)
returns setof public.hermes_chat_stream_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
    v_now timestamptz := now();
begin
    return query
    with claimable as (
        select j.id
        from public.hermes_chat_stream_jobs j
        where j.stop_requested = false
          and (
            j.status = 'pending'
            or (
              j.status = 'running'
              and j.lease_expires_at is not null
              and j.lease_expires_at <= v_now
            )
          )
        order by j.created_at asc
        for update skip locked
        limit greatest(coalesce(p_limit, 1), 1)
    ), updated as (
        update public.hermes_chat_stream_jobs j
        set status = 'running',
            runner_id = p_runner_id,
            lease_expires_at = v_now + make_interval(secs => greatest(coalesce(p_lease_seconds, 30), 1)),
            last_heartbeat_at = v_now,
            started_at = coalesce(j.started_at, v_now),
            completed_at = null,
            updated_at = v_now
        from claimable
        where j.id = claimable.id
        returning j.*
    )
    select * from updated;
end;
$$;
