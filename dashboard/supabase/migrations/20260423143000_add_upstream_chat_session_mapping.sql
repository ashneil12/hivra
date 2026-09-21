-- Track upstream Hermes session identity while keeping Supabase as a mirror.

alter table public.hermes_conversations
  add column if not exists upstream_session_id text,
  add column if not exists upstream_source text not null default 'supabase',
  add column if not exists last_active_at timestamptz;

update public.hermes_conversations
set profile_name = 'default'
where profile_name is null;

alter table public.hermes_conversations
  alter column profile_name set not null;

alter table public.hermes_messages
  add column if not exists upstream_message_id text;

alter table public.hermes_chat_stream_jobs
  add column if not exists session_key text;

create unique index if not exists hermes_conversations_upstream_session_unique_idx
  on public.hermes_conversations(user_id, instance_id, profile_name, upstream_session_id)
  where upstream_session_id is not null;

create index if not exists hermes_conversations_last_active_idx
  on public.hermes_conversations(user_id, instance_id, profile_name, last_active_at desc)
  where last_active_at is not null;

create index if not exists hermes_messages_upstream_message_idx
  on public.hermes_messages(conversation_id, upstream_message_id)
  where upstream_message_id is not null;

create index if not exists hermes_chat_stream_jobs_session_key_idx
  on public.hermes_chat_stream_jobs(user_id, instance_id, profile_name, session_key, status)
  where session_key is not null;
