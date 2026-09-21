-- Hermes OS: Subscription tracking table
-- Run this against your Supabase project via SQL Editor or Supabase CLI

CREATE TABLE IF NOT EXISTS hermes_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Clerk user ID — one subscription per user
  user_id TEXT NOT NULL UNIQUE,

  -- Stripe references
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,

  -- Plan configuration
  plan TEXT NOT NULL DEFAULT 'operator',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, active, past_due, canceled

  -- Resource budgets (populated from plan config on subscribe/change)
  instance_limit INT NOT NULL DEFAULT 2,
  total_cpu_budget NUMERIC NOT NULL DEFAULT 2,
  total_ram_budget INT NOT NULL DEFAULT 4096,

  -- Billing period
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  grace_period_ends_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_hermes_subs_user
  ON hermes_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_hermes_subs_stripe
  ON hermes_subscriptions(stripe_subscription_id);
-- Add scheduled_deletion_at column to hermes_instances if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hermes_instances'
    AND column_name = 'scheduled_deletion_at'
  ) THEN
    ALTER TABLE hermes_instances
      ADD COLUMN scheduled_deletion_at TIMESTAMPTZ;
  END IF;
END $$;
-- Enable RLS
ALTER TABLE hermes_subscriptions ENABLE ROW LEVEL SECURITY;
-- Policy: users can read their own subscription
CREATE POLICY "Users can read own subscription"
  ON hermes_subscriptions FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');
-- Service role can do everything (for webhooks)
CREATE POLICY "Service role full access"
  ON hermes_subscriptions FOR ALL
  USING (true)
  WITH CHECK (true);
