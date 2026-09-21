-- WebUI chat durability overlay
--
-- WebUI agent sessions are the source of truth for chat messages. Keep
-- hermes_conversations as a thin dashboard metadata overlay keyed by the
-- upstream session id.

alter table public.hermes_conversations
  add column if not exists project_id text,
  add column if not exists soft_deleted_at timestamptz;

create index if not exists hermes_conversations_webui_overlay_idx
  on public.hermes_conversations(user_id, instance_id, profile_name, upstream_session_id)
  where upstream_session_id is not null;

create index if not exists hermes_conversations_soft_deleted_idx
  on public.hermes_conversations(user_id, instance_id, profile_name, soft_deleted_at)
  where soft_deleted_at is not null;
