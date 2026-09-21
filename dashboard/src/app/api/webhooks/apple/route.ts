import { NextRequest } from "next/server";

import { apiSuccess, apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { AppleWebhookService } from "@/lib/services/apple-webhook-service";
import {
  beginAppleWebhookEvent,
  markAppleWebhookEventFailed,
  markAppleWebhookEventProcessed,
} from "@/lib/apple-webhook-events";

/**
 * App Store Server Notifications V2 endpoint.
 *
 * Mirrors /api/webhooks/stripe exactly in shape: rate limit → signature
 * verification (JWS via SignedDataVerifier + pinned Apple roots, the
 * equivalent of Stripe's constructEvent) → idempotency begin/mark keyed on
 * notificationUUID (incl. the prod 503-refuse-untracked posture) → the
 * notification state machine → non-2xx on handler failure so Apple's
 * redelivery schedule retries the event.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = getIP(req);
    const { success } = enforceRateLimit(`apple_webhook_${ip}`, {
      limit: 50,
      windowMs: 60 * 1000,
    });

    if (!success) {
      return apiError("Too Many Requests", 429);
    }

    let signedPayload: string | null = null;
    try {
      const body = (await req.json()) as { signedPayload?: unknown };
      signedPayload =
        typeof body?.signedPayload === "string" && body.signedPayload.trim()
          ? body.signedPayload
          : null;
    } catch {
      signedPayload = null;
    }

    if (!signedPayload) {
      return apiError("Missing signedPayload", 400);
    }

    let verified;
    try {
      verified = await AppleWebhookService.verifyNotification(signedPayload);
    } catch (err) {
      // Invalid signature / wrong environment / untrusted chain. 401 (not
      // 5xx): Apple should not redeliver an unverifiable payload forever.
      return apiError("Invalid signature", 401, {
        failureType: "apple_webhook_invalid_signature",
        errorName: err instanceof Error ? err.name : typeof err,
      });
    }

    const { payload, environment, verifier } = verified;
    const notificationUUID = payload.notificationUUID;
    const notificationType = String(payload.notificationType ?? "");
    const subtype = payload.subtype ? String(payload.subtype) : null;

    if (!notificationUUID) {
      return apiError("Missing notificationUUID", 400, {
        failureType: "apple_webhook_missing_uuid",
      });
    }

    const reservation = await beginAppleWebhookEvent(
      notificationUUID,
      notificationType,
      subtype
    );
    if (reservation === "duplicate" || reservation === "processing") {
      return apiSuccess({ received: true, duplicate: true });
    }
    if (reservation === "untracked" && process.env.NODE_ENV === "production") {
      // Same posture as the Stripe route: without the idempotency table,
      // every Apple redelivery would re-grant credits and re-fire tier
      // changes. Refuse in prod so the misconfig surfaces immediately.
      log.error(
        "apple_webhook_events table or service role missing in production; refusing to process without idempotency",
        new Error("apple_webhook_untracked_in_prod"),
        {
          source: "apple-webhook",
          route: "/api/webhooks/apple",
          method: "POST",
          failureType: "apple_webhook_untracked_in_prod",
          notificationType,
        }
      );
      return apiError("Webhook idempotency not configured", 503);
    }

    try {
      const ctx = await AppleWebhookService.decodeNotificationData(
        payload,
        environment,
        verifier
      );
      const outcome = await AppleWebhookService.handleNotification(ctx);
      await markAppleWebhookEventProcessed(notificationUUID);
      log.info("apple notification processed", {
        source: "apple-webhook",
        notificationType,
        subtype,
        action: outcome.action,
        environment,
      });
    } catch (error) {
      await markAppleWebhookEventFailed(notificationUUID, error);
      throw error;
    }

    return apiSuccess({ received: true });
  } catch (error) {
    return apiError("Webhook handler failed", 500, {
      failureType: "apple_webhook_handler_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
