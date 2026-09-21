-- vm_response_seconds_daily — per-VM, per-day cumulative agent wallclock time
-- in seconds, sourced from the host Caddy access log by hermes-warden. UPSERTed
-- by warden on every completed /api/chat/stream POST; read by warden's verdict
-- path before each new chat to enforce the per-tier daily cap, and by the
-- dashboard for UX countdowns.
--
-- Why a separate table (not an extension of compute_usage_events): warden
-- needs a single hot row per (instance, day) to UPSERT into. The existing
-- accounting flow appends one row per usage_period and is computed from
-- compute_usage_events at billing time — different shape, different write
-- pattern. Keeping warden's hot path on its own table avoids contention with
-- the billing pipeline.
--
-- The dashboard sums this into compute_usage_events at end-of-day for
-- per-tier billing reconciliation (separate cron, out of scope here).

CREATE TABLE IF NOT EXISTS vm_response_seconds_daily (
  instance_id          uuid             NOT NULL REFERENCES hermes_instances(id) ON DELETE CASCADE,
  billing_day          date             NOT NULL,
  seconds_used         double precision NOT NULL DEFAULT 0,
  last_request_at      timestamptz,
  cooldown_until_at    timestamptz,
  created_at           timestamptz      NOT NULL DEFAULT now(),
  updated_at           timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, billing_day),
  CHECK (seconds_used >= 0)
);

-- Read-path index: warden's verdict lookup is by (instance_id, billing_day),
-- which is already covered by the PK. Dashboard's "today's tally for instance
-- X" goes through the same key. No additional index needed for warden's hot
-- path; we add one for cross-instance reporting.
CREATE INDEX IF NOT EXISTS idx_vm_response_seconds_daily_day_seconds
  ON vm_response_seconds_daily (billing_day, seconds_used DESC);

-- updated_at maintenance (warden's UPSERT can't hit a default-on-update column)
CREATE OR REPLACE FUNCTION touch_vm_response_seconds_daily_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vm_response_seconds_daily_updated_at ON vm_response_seconds_daily;
CREATE TRIGGER trg_vm_response_seconds_daily_updated_at
  BEFORE UPDATE ON vm_response_seconds_daily
  FOR EACH ROW EXECUTE FUNCTION touch_vm_response_seconds_daily_updated_at();

COMMENT ON TABLE vm_response_seconds_daily IS
  'Per-instance daily cumulative chat-stream wallclock seconds, written by hermes-warden from host Caddy access logs. Source of truth for free/starter tier daily caps.';
COMMENT ON COLUMN vm_response_seconds_daily.cooldown_until_at IS
  'Set by warden when seconds_used crosses the tier cap. Verdict path denies new chats until now() >= cooldown_until_at.';
