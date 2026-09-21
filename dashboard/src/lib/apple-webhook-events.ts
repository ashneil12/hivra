import { supabaseAdmin } from "@/lib/supabase";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";

/**
 * Idempotency ledger for App Store Server Notifications V2.
 *
 * A line-for-line mirror of stripe-webhook-events.ts against the
 * apple_webhook_events table, keyed on Apple's notificationUUID instead of
 * Stripe's event id. Kept as a separate module (not a parameterized shared
 * one) deliberately: the Stripe ledger is battle-tested prod money machinery
 * and this lane must never be able to change its behavior.
 */
type AppleWebhookStatus = "processing" | "processed" | "failed";

// Same reclaim window and safety invariant as the Stripe ledger: MUST stay
// comfortably larger than the webhook route's maxDuration so a redelivery can
// never reclaim a STILL-RUNNING handler. The unique credit-ledger reference
// (apple_subscription:<originalTransactionId>:<periodStart>:<periodEnd>) is
// the ultimate backstop against any double-grant.
const PROCESSING_STALE_AFTER_MS = 15 * 60 * 1000;

function isMissingTableError(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42P01";
}

async function getExistingEvent(notificationUuid: string): Promise<{
  notification_uuid: string;
  status: AppleWebhookStatus;
  updated_at: string;
} | null> {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("apple_webhook_events")
    .select("notification_uuid, status, updated_at")
    .eq("notification_uuid", notificationUuid)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw new Error(`Failed to read Apple webhook event state: ${error.message}`);
  }

  return data;
}

export async function beginAppleWebhookEvent(
  notificationUuid: string,
  notificationType: string,
  subtype?: string | null
): Promise<"reserved" | "duplicate" | "processing" | "untracked"> {
  if (!supabaseAdmin) return "untracked";

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("apple_webhook_events")
    .insert({
      notification_uuid: notificationUuid,
      notification_type: notificationType,
      subtype: subtype ?? null,
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
    throw new Error(`Failed to reserve Apple webhook event: ${error.message}`);
  }

  const existing = await getExistingEvent(notificationUuid);
  if (!existing) {
    throw new Error("Apple webhook event reservation conflicted but no row was found");
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
    .from("apple_webhook_events")
    .update({
      notification_type: notificationType,
      subtype: subtype ?? null,
      status: "processing",
      updated_at: now,
      processed_at: null,
      last_error: null,
    })
    .eq("notification_uuid", notificationUuid)
    .in("status", ["failed", "processing"]);

  if (retryError) {
    throw new Error(`Failed to retry Apple webhook event: ${retryError.message}`);
  }

  return "reserved";
}

export async function markAppleWebhookEventProcessed(
  notificationUuid: string
): Promise<void> {
  if (!supabaseAdmin) return;

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("apple_webhook_events")
    .update({
      status: "processed",
      processed_at: now,
      updated_at: now,
      last_error: null,
    })
    .eq("notification_uuid", notificationUuid);

  if (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw new Error(`Failed to mark Apple webhook event processed: ${error.message}`);
  }
}

export async function markAppleWebhookEventFailed(
  notificationUuid: string,
  errorInput: unknown
): Promise<void> {
  if (!supabaseAdmin) return;

  const now = new Date().toISOString();
  const message =
    errorInput instanceof Error ? errorInput.message : String(errorInput);
  const sanitizedMessage = redactSensitiveCommandOutput(message, 1000).slice(0, 1000);

  const { error } = await supabaseAdmin
    .from("apple_webhook_events")
    .update({
      status: "failed",
      updated_at: now,
      last_error: sanitizedMessage,
    })
    .eq("notification_uuid", notificationUuid);

  if (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw new Error(`Failed to mark Apple webhook event failed: ${error.message}`);
  }
}
