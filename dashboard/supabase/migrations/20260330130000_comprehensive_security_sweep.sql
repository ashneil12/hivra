-- Comprehensive Security Sweep Fixes
-- This migration hardens the system against IDOR, Role Search Path Exploit, and brittle JWT claims.

-- 1. Create a robust function for resolving current user ID regardless of Clerk vs Supabase standard Auth.
CREATE OR REPLACE FUNCTION requesting_user_id()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::text;
$$;
-- 2. Fix mutable search path in trigger function
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = current_timestamp;
    RETURN NEW;
END;
$$;
-- 3. Replace RLS Policies to use requesting_user_id() and add explicit WITH CHECK constraints

-- hermes_instances
DROP POLICY IF EXISTS "users see own instances" ON hermes_instances;
CREATE POLICY "users manage own instances"
    ON hermes_instances FOR ALL
    USING (requesting_user_id() = user_id)
    WITH CHECK (requesting_user_id() = user_id);
-- hermes_conversations
DROP POLICY IF EXISTS "users see own conversations" ON hermes_conversations;
CREATE POLICY "users manage own conversations"
    ON hermes_conversations FOR ALL
    USING (requesting_user_id() = user_id)
    WITH CHECK (requesting_user_id() = user_id);
-- hermes_messages
DROP POLICY IF EXISTS "users see own messages" ON hermes_messages;
CREATE POLICY "users manage own messages"
    ON hermes_messages FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM hermes_conversations c
            WHERE c.id = hermes_messages.conversation_id
              AND c.user_id = requesting_user_id()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM hermes_conversations c
            WHERE c.id = hermes_messages.conversation_id
              AND c.user_id = requesting_user_id()
        )
    );
-- hermes_hosts
DROP POLICY IF EXISTS "users see own hosts" ON hermes_hosts;
CREATE POLICY "users manage own hosts"
    ON hermes_hosts FOR ALL
    USING (requesting_user_id() = user_id)
    WITH CHECK (requesting_user_id() = user_id);
-- Removed user_vault and user_vault_profiles as they were manually dropped remotely


-- user_api_keys
DROP POLICY IF EXISTS "users manage own api keys" ON user_api_keys;
CREATE POLICY "users manage own api keys"
    ON user_api_keys FOR ALL
    USING (requesting_user_id() = user_id)
    WITH CHECK (requesting_user_id() = user_id);
-- hermes_scheduled_tasks
DROP POLICY IF EXISTS "Users can view their own scheduled tasks" ON hermes_scheduled_tasks;
DROP POLICY IF EXISTS "Users can create their own scheduled tasks" ON hermes_scheduled_tasks;
DROP POLICY IF EXISTS "Users can update their own scheduled tasks" ON hermes_scheduled_tasks;
DROP POLICY IF EXISTS "Users can delete their own scheduled tasks" ON hermes_scheduled_tasks;
CREATE POLICY "users manage own scheduled tasks"
    ON hermes_scheduled_tasks FOR ALL
    USING (requesting_user_id() = user_id)
    WITH CHECK (requesting_user_id() = user_id);
-- 4. Fix Storage IDOR vulnerability
DROP POLICY IF EXISTS "users upload own attachments" ON storage.objects;
DROP POLICY IF EXISTS "users read own attachments" ON storage.objects;
-- Insert allows only user_id prefixed paths or migrations/user_id/ paths
CREATE POLICY "users upload own attachments"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'hermes-attachments' 
        AND requesting_user_id() IS NOT NULL
        AND (
            ( (storage.foldername(name))[1] = requesting_user_id() ) OR
            ( (storage.foldername(name))[1] = 'migrations' AND (storage.foldername(name))[2] = requesting_user_id() )
        )
    );
-- Select allows only user_id prefixed paths or migrations/user_id/ paths
CREATE POLICY "users read own attachments"
    ON storage.objects FOR SELECT
    USING (
        bucket_id = 'hermes-attachments' 
        AND requesting_user_id() IS NOT NULL
        AND (
            ( (storage.foldername(name))[1] = requesting_user_id() ) OR
            ( (storage.foldername(name))[1] = 'migrations' AND (storage.foldername(name))[2] = requesting_user_id() )
        )
    );
