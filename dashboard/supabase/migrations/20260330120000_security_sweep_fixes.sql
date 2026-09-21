-- Fix mutable search path in trigger function
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
-- Fix dangerous unrestricted RLS policy in hermes_subscriptions
DROP POLICY IF EXISTS "Service role full access" ON hermes_subscriptions;
CREATE POLICY "Service role full access" 
    ON hermes_subscriptions 
    AS PERMISSIVE 
    FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);
