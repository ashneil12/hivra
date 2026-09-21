import { NextRequest, after } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyClerkWebhookSignature } from "@/lib/email/clerk-webhook-signature";
import {
  type ClerkAnnouncementUser,
  syncClerkUserToAnnouncementAudience,
} from "@/lib/email/resend-announcement-sync";
import { sendWelcomeEmail } from "@/lib/email/welcome";
import { log } from "@/lib/logger";
import { isReferralEnabled, recordReferralAttribution } from "@/lib/referral";

// Invite & Earn — pull a referral code out of the Clerk user payload, if any.
// At signup the marketing site captures `?ref=<code>` and stashes it on the
// Clerk user (unsafe_metadata is the only bucket the client SDK can write). We
// read it defensively here: any shape we don't recognise yields null and the
// attribution is simply skipped. No-op unless the feature flag is on.
//
// TODO(paioclaw-riplist): plumb the signup-time `?ref` capture. The dashboard
// landing currently has no code that writes the cookie/Clerk metadata, so until
// the marketing/sign-up flow stamps `unsafe_metadata.referral_code` (or sets a
// `hivra_ref` cookie forwarded into Clerk), this reads as null and no attribution
// is recorded. The code/link surface below is exposed regardless.
function extractReferralCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const buckets = [record.unsafe_metadata, record.public_metadata, record.private_metadata];
  for (const bucket of buckets) {
    if (bucket && typeof bucket === "object") {
      const meta = bucket as Record<string, unknown>;
      const candidate = meta.referral_code ?? meta.referralCode ?? meta.ref;
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return null;
}

// SCRIPTURE_ANCHOR: clerk-gate | Nehemiah 7:3 | Verse: Don't let the gates of Jerusalem be opened until the sun is hot.
function pickWelcomeRecipient(user: ClerkAnnouncementUser): {
  email: string;
  firstName: string | null;
} | null {
  const addresses = user.email_addresses ?? [];
  const primary = addresses.find((address) => address.id === user.primary_email_address_id);
  const verified = addresses.find((address) => address.verification?.status === "verified");
  const email = primary?.email_address || verified?.email_address || addresses[0]?.email_address;
  if (!email) return null;
  return {
    email: email.trim().toLowerCase(),
    firstName: user.first_name?.trim() || null,
  };
}

type ClerkWebhookEvent = {
  type: string;
  data: ClerkAnnouncementUser;
};

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    log.error("CLERK_WEBHOOK_SECRET is not configured; refusing to run", new Error("missing CLERK_WEBHOOK_SECRET"), {
      source: "clerk-webhook",
      route: "/api/webhooks/clerk",
      method: "POST",
      failureType: "clerk_webhook_secret_missing",
    });
    return apiError("Webhook not configured", 500);
  }

  const payload = await req.text();
  const isValid = verifyClerkWebhookSignature({
    payload,
    secret: webhookSecret,
    svixId: req.headers.get("svix-id"),
    svixTimestamp: req.headers.get("svix-timestamp"),
    svixSignature: req.headers.get("svix-signature"),
  });

  if (!isValid) {
    return apiError("Invalid signature", 400, {
      failureType: "clerk_webhook_invalid_signature",
    });
  }

  let event: ClerkWebhookEvent;
  try {
    event = JSON.parse(payload) as ClerkWebhookEvent;
  } catch {
    return apiError("Invalid JSON body", 400, {
      failureType: "clerk_webhook_invalid_json",
    });
  }

  if (event.type !== "user.created" && event.type !== "user.updated") {
    return apiSuccess({ received: true, skipped: true, reason: "unsupported_event" });
  }

  try {
    // Announcement audience sync — deferred to *after* the 200 so a slow or
    // failing Resend call (it makes several API calls with rate-limit
    // retries/sleeps) can't delay the webhook ack or, on failure, return a 500
    // that makes Clerk retry and re-run the whole sync. Mirrors the welcome
    // email below. Fail-soft: log, never throw. If `after` isn't available
    // (e.g. unit-test scope), fall back to an inline best-effort sync that
    // still never throws, so the ack is preserved.
    try {
      after(async () => {
        try {
          await syncClerkUserToAnnouncementAudience(event.data);
        } catch (err) {
          log.warn("announcement audience sync failed", {
            source: "clerk-webhook",
            failureType: "announcement_audience_sync_failed",
            eventType: event.type,
            errorName: err instanceof Error ? err.name : typeof err,
          });
        }
      });
    } catch {
      // `after` unavailable — run inline but swallow failures so the ack holds.
      try {
        await syncClerkUserToAnnouncementAudience(event.data);
      } catch (err) {
        log.warn("announcement audience sync failed (inline fallback)", {
          source: "clerk-webhook",
          failureType: "announcement_audience_sync_failed",
          eventType: event.type,
          errorName: err instanceof Error ? err.name : typeof err,
        });
      }
    }

    // Welcome email — only on user.created. We do this *after* the
    // response so Clerk gets its 200 quickly and never retries on a
    // slow Resend call (a retry would double-send the welcome). If
    // `after` isn't available (e.g. unit-test scope), we skip rather
    // than break the webhook ack.
    if (event.type === "user.created") {
      // Invite & Earn attribution. No-op unless the flag is on; never throws
      // (the lib swallows missing-table / unknown-code / already-attributed),
      // so the signup critical path is never affected.
      if (isReferralEnabled()) {
        const refereeUserId =
          typeof (event.data as { id?: unknown }).id === "string"
            ? (event.data as { id: string }).id
            : "";
        const refCode = extractReferralCode(event.data);
        if (refereeUserId && refCode) {
          try {
            await recordReferralAttribution(refereeUserId, refCode);
          } catch (err) {
            log.warn("referral attribution skipped", {
              source: "clerk-webhook",
              failureType: "referral_attribution_failed",
              errorName: err instanceof Error ? err.name : typeof err,
            });
          }
        }
      }

      const recipient = pickWelcomeRecipient(event.data);
      if (recipient) {
        try {
          after(async () => {
            const sendResult = await sendWelcomeEmail(recipient);
            if (!sendResult.sent) {
              log.warn("welcome email send skipped or failed", {
                source: "clerk-webhook",
                failureType: "welcome_email_not_sent",
                reason: sendResult.reason ?? "unknown",
                errorMessage: sendResult.errorMessage,
              });
            }
          });
        } catch (err) {
          log.warn("welcome email scheduling skipped", {
            source: "clerk-webhook",
            failureType: "welcome_email_after_unavailable",
            errorName: err instanceof Error ? err.name : typeof err,
          });
        }
      }
    }

    return apiSuccess({ received: true, deferred: true });
  } catch (error) {
    return apiError("Clerk webhook handler failed", 500, {
      failureType: "clerk_webhook_handler_failed",
      eventType: event.type,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
