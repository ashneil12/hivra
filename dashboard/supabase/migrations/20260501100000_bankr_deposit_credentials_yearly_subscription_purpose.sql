-- Add 'yearly_subscription' to the purpose enum on
-- bankr_deposit_wallet_credentials so a single user can hold three
-- distinct Bankr-provisioned wallets:
--
--   credit_deposit       — receives USDC top-ups that mint platform credits
--   hermesos_lock        — receives $HERMESOS held to qualify for Pro/Power
--                          (the hold-not-spend model)
--   yearly_subscription  — receives $HERMESOS spent on a yearly Pro/Power
--                          subscription. Hidden from the main wallet UI.
--                          Tokens here are SWEPT to HERMES_TREASURY_ADDRESS
--                          by the yearly-token-sweep cron, never returned
--                          to the user. Distinct wallet from credit_deposit
--                          so subscription revenue stays cleanly separated
--                          from credit-top-up revenue.
--
-- The purpose column already has a CHECK constraint from
-- 20260430062000_bankr_deposit_credentials_purpose.sql; this just
-- widens the allowed values. The unique (user_id, purpose) constraint
-- already accommodates a third row per user.

alter table public.bankr_deposit_wallet_credentials
  drop constraint if exists bankr_deposit_wallet_credentials_purpose_check;

alter table public.bankr_deposit_wallet_credentials
  add constraint bankr_deposit_wallet_credentials_purpose_check
  check (purpose in ('credit_deposit', 'hermesos_lock', 'yearly_subscription'));
