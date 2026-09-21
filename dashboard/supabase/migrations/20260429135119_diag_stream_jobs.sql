-- Diagnostic: dump current chat-stream-jobs state. RAISE NOTICE it so we
-- can read it from supabase db push output. No data mutation.
do $$
declare
  rec record;
  total integer;
begin
  select count(*) into total from public.hermes_chat_stream_jobs
    where status in ('pending','running');
  raise notice 'Active stream jobs (pending+running): %', total;

  for rec in
    select stream_key, status, instance_id, message_id, stop_requested,
           runner_id, lease_expires_at, created_at, updated_at
    from public.hermes_chat_stream_jobs
    where status in ('pending','running')
    order by created_at desc
    limit 10
  loop
    raise notice 'JOB key=% status=% stop=% runner=% age_s=% lease_s_left=%',
      substring(rec.stream_key, 1, 16),
      rec.status,
      rec.stop_requested,
      coalesce(substring(rec.runner_id, 1, 16), '<none>'),
      extract(epoch from (now() - rec.created_at))::int,
      coalesce(extract(epoch from (rec.lease_expires_at - now()))::int::text, '<no lease>');
  end loop;
end $$;
