CREATE TABLE public.hermes_trial_usage (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id text NOT NULL,
    ip_address text,
    device_fingerprint text,
    created_at timestamp with time zone DEFAULT now()
);

-- Index to quickly look up IP addresses
CREATE INDEX idx_hermes_trial_usage_ip ON public.hermes_trial_usage(ip_address);

-- Optional: constraint so the same user+ip isn't duplicated redundantly
CREATE UNIQUE INDEX idx_hermes_trial_usage_user_ip ON public.hermes_trial_usage(user_id, ip_address);

-- Turn on RLS for safety (even if we just use Service Role for now)
ALTER TABLE public.hermes_trial_usage ENABLE ROW LEVEL SECURITY;

-- Create policy for Service Role to do everything (Supabase usually handles this by default, but it's good practice)
-- CREATE POLICY "Service role can do all" ON public.hermes_trial_usage TO service_role USING (true) WITH CHECK (true);
