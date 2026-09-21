-- Protect webhook event ledger rows from public access.
-- Only trusted server-side code using the service role should be able to read/write here.

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.stripe_webhook_events;
CREATE POLICY "Service role full access"
    ON public.stripe_webhook_events
    AS PERMISSIVE
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
