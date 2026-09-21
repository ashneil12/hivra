-- Apple IAP entitlement lane (iOS app, Phase 1).
--
-- A fully parallel money lane for App Store subscriptions, blueprinted on the
-- workspace_cloud lane (20260521120000): its OWN tables, its OWN webhook
-- (/api/webhooks/apple), its OWN reconciler. The Stripe machinery
-- (hermes_subscriptions + stripe webhooks + grace/state reconcilers) never
-- reads or writes these tables, and vice versa — the only shared surface is
-- the entitlement resolver, which gains an additive "apple_iap" branch, and
-- the instance suspend/resume helpers.
--
-- Additive-only. DO NOT run by hand; applied on owner approval to BOTH DBs
-- with schema_migrations stamped identically (standing drift rule).

-- 1. Per-user Apple subscription state — the lane's hermes_subscriptions.
--
-- One row per user (user_id unique, mirroring hermes_subscriptions'
-- single-row-per-user shape so the resolver can .eq(user_id).maybeSingle()),
-- and one row per Apple subscription (apple_original_transaction_id unique —
-- the stable identifier Apple keeps across renewals/resubscribes; a
-- redelivered or re-signed notification can never fork a second row).
create table if not exists public.apple_iap_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique check (btrim(user_id) <> ''),
  apple_original_transaction_id text not null unique
    check (btrim(apple_original_transaction_id) <> ''),
  product_id text not null check (btrim(product_id) <> ''),
  -- Mapped platform plan key (operator/fleet/...), NOT the Apple product id.
  plan text not null,
  status text not null check (
    status in ('active', 'trialing', 'grace_period', 'past_due', 'expired', 'revoked')
  ),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- appAccountToken the app attached at purchase time (UUID minted server-side
  -- pre-paywall; maps back through apple_iap_account_tokens).
  app_account_token uuid,
  -- Which App Store environment signed the transaction. Sandbox rows can then
  -- never grant prod entitlement by accident and are trivially identifiable.
  environment text not null default 'Production'
    check (environment in ('Sandbox', 'Production')),
  -- Audit breadcrumbs: the last App Store Server Notification applied.
  last_notification_type text,
  last_notification_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Reconciler scan: non-terminal rows past their period end.
create index if not exists apple_iap_subscriptions_status_period_end_idx
  on public.apple_iap_subscriptions (status, current_period_end);

alter table public.apple_iap_subscriptions enable row level security;

comment on table public.apple_iap_subscriptions is
  'Per-user billing entitlement for the Apple IAP (iOS App Store) lane. '
  'Separate from hermes_subscriptions so the Stripe and Apple products'' '
  'billing stay fully partitioned. Written ONLY by the Apple webhook service, '
  'the Apple subscription reconciler, and the mobile attach endpoint; read by '
  'resolveEffectiveSubscription (source ''apple_iap''). Service role only.';

comment on column public.apple_iap_subscriptions.apple_original_transaction_id is
  'Apple originalTransactionId — stable across renewals and resubscribes; the '
  'canonical identity of the subscription at Apple. Used as the idempotency '
  'anchor for credit grants and as the App Store Server API lookup key.';

comment on column public.apple_iap_subscriptions.status is
  'active/trialing grant access; grace_period keeps access while Apple retries '
  'billing inside the ASC Billing Grace Period; past_due (billing retry, no '
  'grace) does NOT grant access; expired/revoked are terminal until a new '
  'SUBSCRIBED arrives.';

-- 2. appAccountToken -> Clerk user mapping.
--
-- The server mints one UUID per user (pre-paywall); the app passes it as
-- StoreKit''s appAccountToken so every Apple notification carries it and the
-- webhook can find the owner without any client round-trip.
create table if not exists public.apple_iap_account_tokens (
  user_id text primary key check (btrim(user_id) <> ''),
  token uuid not null unique,
  created_at timestamptz not null default now()
);

alter table public.apple_iap_account_tokens enable row level security;

comment on table public.apple_iap_account_tokens is
  'Server-minted appAccountToken (UUID) per Clerk user for Apple StoreKit '
  'purchases. The Apple webhook resolves appAccountToken -> user_id here. '
  'Service role only.';

-- 3. Webhook idempotency ledger — mirrors stripe_webhook_events exactly
-- (20260417190000 + 20260420103000), keyed on Apple''s notificationUUID.
create table if not exists public.apple_webhook_events (
  notification_uuid text primary key,
  notification_type text not null,
  subtype text null,
  status text not null check (status in ('processing', 'processed', 'failed')),
  received_at timestamptz not null default timezone('utc'::text, now()),
  processed_at timestamptz null,
  updated_at timestamptz not null default timezone('utc'::text, now()),
  last_error text null
);

create index if not exists apple_webhook_events_status_idx
  on public.apple_webhook_events (status);

alter table public.apple_webhook_events enable row level security;

drop policy if exists "Service role full access" on public.apple_webhook_events;
create policy "Service role full access"
    on public.apple_webhook_events
    as permissive
    for all
    to service_role
    using (true)
    with check (true);

comment on table public.apple_webhook_events is
  'Idempotency ledger for App Store Server Notifications V2, keyed on '
  'notificationUUID. Same semantics as stripe_webhook_events: begin/mark '
  'pattern, prod refuses to process untracked, stale processing rows are '
  'reclaimable after 15 minutes.';
