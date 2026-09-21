-- device_tokens — Expo push tokens for the Hivra mobile app (iOS lane, Phase 2).
--
-- One row per Expo push token. A token is device-scoped, so it is UNIQUE
-- table-wide and re-registering it (same device, new/other signed-in user)
-- reassigns the row via upsert on expo_push_token — the token must always
-- notify whoever is CURRENTLY signed in on that device, never a previous
-- account.
--
-- Tokens are DISABLED (enabled=false), not deleted, when:
--   * the user turns notifications off in the app (DELETE /api/mobile/push-tokens), or
--   * Expo reports DeviceNotRegistered for the token (ticket or receipt), at
--     which point the sender prunes it so we stop paying for dead sends.
-- Keeping the row (disabled) preserves created_at/last_seen_at history and lets
-- a re-registration flip it back on without churning ids.
--
-- Additive + idempotent. Written/read ONLY via the service-role client
-- (supabaseAdmin) from the dashboard API — RLS is enabled with no
-- anon/authenticated policies (deny-all; service_role bypasses), per the
-- 20260625120000_enable_rls_service_role_tables convention.

create table if not exists public.device_tokens (
  id              uuid        primary key default gen_random_uuid(),
  user_id         text        not null,
  expo_push_token text        not null,
  platform        text        not null default 'ios'
                              check (platform in ('ios', 'android')),
  enabled         boolean     not null default true,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

-- Upsert key for POST /api/mobile/push-tokens (onConflict: expo_push_token).
create unique index if not exists device_tokens_expo_push_token_key
  on public.device_tokens using btree (expo_push_token);

-- The hot read: "all enabled tokens for a user" (push fan-out).
create index if not exists device_tokens_user_enabled_idx
  on public.device_tokens using btree (user_id)
  where enabled;

alter table public.device_tokens enable row level security;

revoke all on public.device_tokens from anon;

comment on table public.device_tokens is
  'Expo push tokens registered by the Hivra mobile app. Service-role-only access (RLS deny-all); upserted by POST /api/mobile/push-tokens, consumed by src/lib/push/expo-push.ts.';

comment on column public.device_tokens.expo_push_token is
  'Expo push token (ExponentPushToken[...]). Unique table-wide; re-registration reassigns the row to the currently signed-in user.';

comment on column public.device_tokens.enabled is
  'False when the user opted out or Expo reported DeviceNotRegistered. Disabled rows are kept (not deleted) so re-registration can re-enable them.';

comment on column public.device_tokens.last_seen_at is
  'Bumped on every registration so stale tokens can be aged out later.';
