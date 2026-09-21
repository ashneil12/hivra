-- Security Pass 1, finding H2: withdraw in-flight DB lock.
--
-- The /api/billing/bankr/wallet/withdraw route already has an in-process
-- lock + per-user rate limit. But two concurrent POSTs hitting different
-- Node instances (horizontal scaling) can still both observe a non-zero
-- balance, both mint a Bankr API key, and both submit a transfer.
--
-- This migration adds the row-level claim. The route inserts a row with
-- status='in_flight' BEFORE calling Bankr; a partial unique index
-- guarantees only one in-flight withdrawal per user across all Node
-- instances. A duplicate concurrent attempt fails with 23505.

CREATE TABLE IF NOT EXISTS public.bankr_withdrawals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('in_flight', 'submitted', 'failed', 'cancelled')),
    amount_raw    NUMERIC,
    recipient     TEXT,
    tx_hash       TEXT,
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bankr_withdrawals_user
    ON public.bankr_withdrawals (user_id, created_at DESC);

-- Only one in-flight withdrawal per user. Insert with status='in_flight'
-- fails with 23505 (unique_violation) if another is still pending.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bankr_withdrawals_one_in_flight_per_user
    ON public.bankr_withdrawals (user_id)
    WHERE status = 'in_flight';

-- Lock down: only the service role writes to this table. Users never
-- query it directly — the route returns the relevant fields in its
-- response. Empty policy set under RLS = no user role can access.
ALTER TABLE public.bankr_withdrawals ENABLE ROW LEVEL SECURITY;
