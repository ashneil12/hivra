-- Demote the old Postgres chat-content mirror.
--
-- WebUI/agent session storage is now the source of truth for chat content.
-- Postgres keeps dashboard metadata overlays only. These comments and
-- triggers are rollback-safe guardrails: tables stay in place, but new chat
-- message mirror inserts fail loudly instead of silently recreating ghosts.

COMMENT ON TABLE public.hermes_messages IS
  'DEPRECATED: chat content mirror retained for rollback/read-only legacy inspection only. Do not insert new chat content; WebUI/agent sessions are authoritative.';

COMMENT ON COLUMN public.hermes_messages.content IS
  'DEPRECATED mirror content. Chat message bodies are read from WebUI/agent sessions, not Postgres.';

COMMENT ON COLUMN public.hermes_messages.metadata IS
  'DEPRECATED mirror metadata. New stream/message metadata belongs in the agent session record.';

COMMENT ON COLUMN public.hermes_conversations.upstream_session_id IS
  'Authoritative WebUI/agent session id used to attach dashboard metadata overlays. Do not treat this row as chat content truth.';

COMMENT ON COLUMN public.hermes_conversations.upstream_source IS
  'Source label for the upstream agent session. Postgres is metadata-only for chat.';

COMMENT ON COLUMN public.hermes_conversations.last_active_at IS
  'Cached dashboard ordering hint from the agent session. The agent remains authoritative for chat activity.';

DO $$
DECLARE
  mirror_column record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hermes_conversations'
      AND column_name = 'message_count'
  ) THEN
    EXECUTE
      'COMMENT ON COLUMN public.hermes_conversations.message_count IS ' ||
      quote_literal('DEPRECATED: do not read for chat content. Message counts come from the WebUI/agent session response.');
  END IF;

  IF to_regclass('public.chat_session_mirror') IS NOT NULL THEN
    EXECUTE
      'COMMENT ON TABLE public.chat_session_mirror IS ' ||
      quote_literal('DEPRECATED: retained for rollback only. Do not read or write chat content from this mirror.');

    FOR mirror_column IN
      SELECT attname
      FROM pg_attribute
      WHERE attrelid = 'public.chat_session_mirror'::regclass
        AND attnum > 0
        AND NOT attisdropped
    LOOP
      EXECUTE format(
        'COMMENT ON COLUMN public.chat_session_mirror.%I IS %L',
        mirror_column.attname,
        'DEPRECATED: retained for rollback only. Do not read or write chat content from this mirror.'
      );
    END LOOP;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.prevent_deprecated_chat_content_mirror_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'deprecated_chat_content_mirror_write'
    USING
      ERRCODE = 'check_violation',
      DETAIL = 'Chat content is authoritative in WebUI/agent sessions. Postgres mirror inserts are blocked to prevent ghost rows.';
END;
$$;

DROP TRIGGER IF EXISTS prevent_deprecated_hermes_messages_insert
  ON public.hermes_messages;

CREATE TRIGGER prevent_deprecated_hermes_messages_insert
  BEFORE INSERT ON public.hermes_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_deprecated_chat_content_mirror_write();

DO $$
BEGIN
  IF to_regclass('public.chat_session_mirror') IS NOT NULL THEN
    EXECUTE
      'DROP TRIGGER IF EXISTS prevent_deprecated_chat_session_mirror_insert ON public.chat_session_mirror';
    EXECUTE
      'CREATE TRIGGER prevent_deprecated_chat_session_mirror_insert ' ||
      'BEFORE INSERT ON public.chat_session_mirror ' ||
      'FOR EACH ROW EXECUTE FUNCTION public.prevent_deprecated_chat_content_mirror_write()';
  END IF;
END
$$;
