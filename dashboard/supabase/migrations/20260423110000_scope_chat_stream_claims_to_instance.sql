create or replace function public.claim_hermes_chat_stream_jobs(
    p_runner_id text,
    p_limit integer default 1,
    p_lease_seconds integer default 30,
    p_instance_id uuid default null
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
          and (p_instance_id is null or j.instance_id = p_instance_id)
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
