-- Sync Remote Schema
-- Repairs migration drift and adds columns that were manually added to the remote database.

-- ── Repair migration history ─────────────────────────────────────────────────
-- These migrations were applied remotely but not tracked locally.
-- Mark them as applied so `supabase db pull` works correctly.
-- (No schema changes here — these are historical repairs only.)

-- ── user_api_keys: ensure all remote columns exist ───────────────────────────
-- The original migration (20260327220000) defined `key_encrypted` but the remote
-- DB uses `encrypted_key`. Additional columns were added manually.

ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS encrypted_key text;
ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS selected_model text;
-- Migrate data from key_encrypted to encrypted_key if the old column exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_api_keys' AND column_name = 'key_encrypted'
  ) THEN
    -- Copy data from old column to new
    UPDATE user_api_keys SET encrypted_key = key_encrypted WHERE encrypted_key IS NULL AND key_encrypted IS NOT NULL;
    -- Drop the old column
    ALTER TABLE user_api_keys DROP COLUMN key_encrypted;
  END IF;
END $$;
-- ── hermes_instances: ensure all remote columns exist ────────────────────────
ALTER TABLE hermes_instances ADD COLUMN IF NOT EXISTS scheduled_deletion_at timestamptz;
ALTER TABLE hermes_instances ADD COLUMN IF NOT EXISTS disk_size_gb int;
ALTER TABLE hermes_instances ADD COLUMN IF NOT EXISTS disk_upgraded boolean DEFAULT false;
ALTER TABLE hermes_instances ADD COLUMN IF NOT EXISTS disk_upgraded_at timestamptz;
ALTER TABLE hermes_instances ADD COLUMN IF NOT EXISTS storage_addon_session_id text;
-- ── hermes_hosts: ensure hetzner_server_id is nullable ───────────────────────
-- Already nullable in original migration, but ensure it's consistent
ALTER TABLE hermes_hosts ALTER COLUMN hetzner_server_id DROP NOT NULL;
