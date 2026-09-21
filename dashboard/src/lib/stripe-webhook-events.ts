import { supabaseAdmin } from "@/lib/supabase";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";

// SCRIPTURE_ANCHOR: webhook-memory | Deuteronomy 8:2 | Verse: You shall remember all the way which Yahweh your God has led you.
type StripeWebhookStatus = "processing" | "processed" | "failed";

// How long a row may sit in `processing` before a Stripe redelivery is allowed
// to reclaim and re-run it. This recovers events whose handler was killed
// mid-flight (e.g. the Vercel function hit its timeout before marking
// processed/failed).
//
// SAFETY INVARIANT: this MUST stay comfortably larger than the webhook
// function's maxDuration. Today the /api/webhooks/stripe route sets no explicit
// maxDuration, so it gets the Vercel platform default (<=300s) — a handler is
// therefore always dead long before this window elapses, so a redelivery can
// never reclaim a STILL-RUNNING handler and run it concurrently. If anyone
// raises that route's maxDuration toward/above 15 min, a slow handler could be
// reclaimed while still executing — bump this value to keep the margin. The
// (source, reference_id, reason) unique constraints on the credit/financial
// ledgers are the ultimate backstop against any double-apply.
const PROCESSING_STALE_AFTER_MS = 15 * 60 * 1000;

function isMissingTableError(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42P01";
}

async function getExistingEvent(eventId: string): Promise<{
  event_id: string;
  status: StripeWebhookStatus;
  updated_at: string;
} | null> {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .select("event_id, status, updated_at")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw new Error(`Failed to read Stripe webhook event state: ${error.message}`);
  }

  return data;
}

export async function beginStripeWebhookEvent(
  eventId: string,
  eventType: string
): Promise<"reserved" | "duplicate" | "processing" | "untracked"> {
  if (!supabaseAdmin) return "untracked";

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .insert({
      event_id: eventId,
      event_type: eventType,
      status: "processing",
      received_at: now,
      updated_at: now,
      processed_at: null,
      last_error: null,
    });

  if (!error) {
    return "reserved";
  }

  if (isMissingTableError(error)) {
    return "untracked";
  }

  if (error.code !== "23505") {
    throw new Error(`Failed to reserve Stripe webhook event: ${error.message}`);
  }

  const existing = await getExistingEvent(eventId);
  if (!existing) {
    throw new Error("Stripe webhook event reservation conflicted but no row was found");
  }

  if (existing.status === "processed") {
    return "duplicate";
  }

  if (existing.status === "processing") {
    const updatedAtMs = Date.parse(existing.updated_at);
    if (
      Number.isFinite(updatedAtMs) &&
      Date.now() - updatedAtMs < PROCESSING_STALE_AFTER_MS
    ) {
      return "processing";
    }
  }

  const { error: retryError } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({
      event_type: eventType,
      status: "processing",
      updated_at: now,
      processed_at: null,
      last_error: null,
    })
    .eq("event_id", eventId)
    .in("status", ["failed", "processing"]);

  if (retryError) {
    throw new Error(`Failed to retry Stripe webhook event: ${retryError.message}`);
  }

  return "reserved";
}

export async function markStripeWebhookEventProcessed(eventId: string): Promise<void> {
  if (!supabaseAdmin) return;

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({
      status: "processed",
      processed_at: now,
      updated_at: now,
      last_error: null,
    })
    .eq("event_id", eventId);

  if (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw new Error(`Failed to mark Stripe webhook event processed: ${error.message}`);
  }
}

export async function markStripeWebhookEventFailed(
  eventId: string,
  errorInput: unknown
): Promise<void> {
  if (!supabaseAdmin) return;

  const now = new Date().toISOString();
  const message =
    errorInput instanceof Error ? errorInput.message : String(errorInput);
  const sanitizedMessage = redactSensitiveCommandOutput(message, 1000).slice(0, 1000);

  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({
      status: "failed",
      updated_at: now,
      last_error: sanitizedMessage,
    })
    .eq("event_id", eventId);

  if (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw new Error(`Failed to mark Stripe webhook event failed: ${error.message}`);
  }
}
