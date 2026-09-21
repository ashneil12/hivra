-- Card-on-file dedup signals for the free-tier abuse gate.
--
-- Two new columns on signup_risk_assessments captured when the
-- setup_intent.succeeded webhook resolves a PaymentMethod:
--
--   card_fingerprint  Stripe's stable per-card fingerprint. Same physical
--                     card produces the same fingerprint across customers,
--                     unlike payment_method_id which is per-attachment.
--                     Used to reject "I'll just sign up again with the
--                     same card" abuse.
--
--   card_funding      'credit' | 'debit' | 'prepaid' | 'unknown'. Prepaid
--                     covers virtual-card services (Privacy.com, Lithic,
--                     Revolut Disposable, etc.) which are the most common
--                     way to bypass card-fingerprint dedup. Rejected at
--                     the webhook layer.
--
-- Both nullable: legacy rows pre-dating this migration have neither
-- value and are left untouched. Going forward the webhook always sets
-- them when a PaymentMethod is attached, even on rejection (so we keep
-- the audit record).

alter table public.signup_risk_assessments
    add column if not exists card_fingerprint text,
    add column if not exists card_funding text;

-- Fingerprint lookups: "is there another satisfied user with this card?"
-- Partial index — we only ever query rows that have a satisfied card,
-- so excluding the rest keeps the index small.
create index if not exists idx_signup_risk_assessments_card_fingerprint
    on public.signup_risk_assessments (card_fingerprint)
    where card_fingerprint is not null and card_satisfied_at is not null;

comment on column public.signup_risk_assessments.card_fingerprint is
    'Stripe PaymentMethod.card.fingerprint — stable across customers for the same physical card. Used for cross-account dedup.';
comment on column public.signup_risk_assessments.card_funding is
    'Stripe PaymentMethod.card.funding — credit | debit | prepaid | unknown. Prepaid is rejected to block virtual-card abuse.';
