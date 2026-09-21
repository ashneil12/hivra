-- Security Pass 1, finding M1: confirm-checkout replay protection.
--
-- The /api/billing/confirm-checkout route accepts any Stripe session id
-- whose `customer` matches the caller's stored Stripe customer id —
-- there's no per-session activation flag. A stale session URL (browser
-- back, bookmark, attacker-supplied link) can re-trigger
-- handleSubscriptionChange.
--
-- This table records each checkout session's first activation. Repeat
-- attempts hit the PRIMARY KEY conflict and the route returns
-- already_activated=true without re-running handleSubscriptionChange.

CREATE TABLE IF NOT EXISTS public.stripe_checkout_session_activations (
    stripe_session_id TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    activated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_session_activations_user
    ON public.stripe_checkout_session_activations (user_id, activated_at DESC);

-- Service-role only. No user policies → RLS blocks all user-facing
-- access by default; the service role bypasses RLS for webhook +
-- confirm-checkout writes.
ALTER TABLE public.stripe_checkout_session_activations ENABLE ROW LEVEL SECURITY;
