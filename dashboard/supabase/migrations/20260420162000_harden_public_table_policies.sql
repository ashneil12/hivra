-- Harden public-schema table exposure and normalize row-level security policies.
-- This focuses on safe database-side changes only:
--   * enable RLS where needed
--   * make user-owned tables explicitly user-scoped
--   * make internal operational tables service-role only
--   * reduce anonymous schema visibility on sensitive tables

CREATE OR REPLACE FUNCTION public.requesting_user_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::text;
$$;

-- User-owned application tables
ALTER TABLE IF EXISTS public.hermes_instances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users see own instances" ON public.hermes_instances;
DROP POLICY IF EXISTS "users manage own instances" ON public.hermes_instances;
CREATE POLICY "users manage own instances"
    ON public.hermes_instances
    FOR ALL
    TO authenticated
    USING (public.requesting_user_id() = user_id)
    WITH CHECK (public.requesting_user_id() = user_id);
REVOKE ALL ON public.hermes_instances FROM anon;

ALTER TABLE IF EXISTS public.hermes_hosts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users see own hosts" ON public.hermes_hosts;
DROP POLICY IF EXISTS "users manage own hosts" ON public.hermes_hosts;
CREATE POLICY "users manage own hosts"
    ON public.hermes_hosts
    FOR ALL
    TO authenticated
    USING (public.requesting_user_id() = user_id)
    WITH CHECK (public.requesting_user_id() = user_id);
REVOKE ALL ON public.hermes_hosts FROM anon;

ALTER TABLE IF EXISTS public.hermes_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users see own conversations" ON public.hermes_conversations;
DROP POLICY IF EXISTS "users manage own conversations" ON public.hermes_conversations;
CREATE POLICY "users manage own conversations"
    ON public.hermes_conversations
    FOR ALL
    TO authenticated
    USING (public.requesting_user_id() = user_id)
    WITH CHECK (public.requesting_user_id() = user_id);
REVOKE ALL ON public.hermes_conversations FROM anon;

ALTER TABLE IF EXISTS public.hermes_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users see own messages" ON public.hermes_messages;
DROP POLICY IF EXISTS "users manage own messages" ON public.hermes_messages;
CREATE POLICY "users manage own messages"
    ON public.hermes_messages
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.hermes_conversations c
            WHERE c.id = hermes_messages.conversation_id
              AND c.user_id = public.requesting_user_id()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.hermes_conversations c
            WHERE c.id = hermes_messages.conversation_id
              AND c.user_id = public.requesting_user_id()
        )
    );
REVOKE ALL ON public.hermes_messages FROM anon;

ALTER TABLE IF EXISTS public.hermes_scheduled_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own scheduled tasks" ON public.hermes_scheduled_tasks;
DROP POLICY IF EXISTS "Users can create their own scheduled tasks" ON public.hermes_scheduled_tasks;
DROP POLICY IF EXISTS "Users can update their own scheduled tasks" ON public.hermes_scheduled_tasks;
DROP POLICY IF EXISTS "Users can delete their own scheduled tasks" ON public.hermes_scheduled_tasks;
DROP POLICY IF EXISTS "users manage own scheduled tasks" ON public.hermes_scheduled_tasks;
CREATE POLICY "users manage own scheduled tasks"
    ON public.hermes_scheduled_tasks
    FOR ALL
    TO authenticated
    USING (public.requesting_user_id() = user_id)
    WITH CHECK (public.requesting_user_id() = user_id);
REVOKE ALL ON public.hermes_scheduled_tasks FROM anon;

ALTER TABLE IF EXISTS public.user_api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users manage own api keys" ON public.user_api_keys;
CREATE POLICY "users manage own api keys"
    ON public.user_api_keys
    FOR ALL
    TO authenticated
    USING (public.requesting_user_id() = user_id)
    WITH CHECK (public.requesting_user_id() = user_id);
REVOKE ALL ON public.user_api_keys FROM anon;

ALTER TABLE IF EXISTS public.hermes_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own subscription" ON public.hermes_subscriptions;
DROP POLICY IF EXISTS "users can read own subscription" ON public.hermes_subscriptions;
DROP POLICY IF EXISTS "Service role full access" ON public.hermes_subscriptions;
DROP POLICY IF EXISTS "service role full access" ON public.hermes_subscriptions;
CREATE POLICY "users can read own subscription"
    ON public.hermes_subscriptions
    FOR SELECT
    TO authenticated
    USING (public.requesting_user_id() = user_id);
CREATE POLICY "service role full access"
    ON public.hermes_subscriptions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
REVOKE ALL ON public.hermes_subscriptions FROM anon;

ALTER TABLE IF EXISTS public.ops_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users can view own ops events" ON public.ops_events;
DROP POLICY IF EXISTS "service role full access" ON public.ops_events;
CREATE POLICY "users can view own ops events"
    ON public.ops_events
    FOR SELECT
    TO authenticated
    USING (public.requesting_user_id() = user_id);
CREATE POLICY "service role full access"
    ON public.ops_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
REVOKE ALL ON public.ops_events FROM anon;

-- This table exists in the live app but is not part of the committed migration history.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'profiles'
    ) THEN
        EXECUTE 'ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS "users manage own profiles" ON public.profiles';
        EXECUTE 'CREATE POLICY "users manage own profiles"
            ON public.profiles
            FOR ALL
            TO authenticated
            USING (public.requesting_user_id() = user_id)
            WITH CHECK (public.requesting_user_id() = user_id)';
        EXECUTE 'REVOKE ALL ON public.profiles FROM anon';
    END IF;
END $$;

-- Internal operational tables should never be directly accessible to browser roles.
ALTER TABLE IF EXISTS public.hermes_trial_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hermes_trial_usage FROM anon, authenticated;
DROP POLICY IF EXISTS "service role full access" ON public.hermes_trial_usage;
DROP POLICY IF EXISTS "Service role can do all" ON public.hermes_trial_usage;
CREATE POLICY "service role full access"
    ON public.hermes_trial_usage
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

ALTER TABLE IF EXISTS public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_webhook_events FROM anon, authenticated;
DROP POLICY IF EXISTS "Service role full access" ON public.stripe_webhook_events;
DROP POLICY IF EXISTS "service role full access" ON public.stripe_webhook_events;
CREATE POLICY "service role full access"
    ON public.stripe_webhook_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
