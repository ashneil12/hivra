import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import Stripe from "stripe";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { BACKUP_ADDON } from "@/lib/subscription";
import { hasPlanAccessStatus } from "@/lib/billing/subscription-status";
import { getStripe } from "@/lib/stripe";
import { enableServerBackup } from "@/lib/hetzner/client";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

const Schema = z.object({
  instanceId: z.string().uuid("Invalid instance ID"),
});

/**
 * POST /api/billing/backup-addon
 *
 * Adds a $10/month backup addon to the user's Stripe subscription and
 * immediately enables Hetzner's native daily backup system on the server.
 *
 * Hetzner backups: automated daily snapshots, retained for 7 days (~20%
 * of server cost on Hetzner's end). We charge $10/mo — roughly $7+ margin.
 *
 * Idempotent: returns an error if backups are already enabled on this instance.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError("Invalid JSON body", 400, { failureType: "backup_addon_invalid_json" });
    }
    const parsed = Schema.safeParse(body);
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400);

    const { instanceId } = parsed.data;

    // ── 1. Verify instance ownership ─────────────────────────────────────────
    const { data: instance, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, name, status, hetzner_server_id, backups_enabled")
      .eq("id", instanceId)
      .eq("user_id", clerkUserId)
      .maybeSingle();

    if (error) {
      return apiError("Failed to load instance", 500, {
        failureType: "backup_addon_instance_lookup_failed",
      });
    }
    if (!instance) {
      return apiError(`Instance ID ${instanceId} not found or belongs to another user.`, 404);
    }

    if (instance.status === "deleted") {
      return apiError("Cannot enable backups on a deleted instance", 400);
    }

    if (instance.backups_enabled) {
      return apiError("Backups are already enabled on this instance", 400);
    }

    if (!instance.hetzner_server_id) {
      return apiError("Instance has no associated server ID", 400);
    }

    // ── 2. Verify active subscription ─────────────────────────────────────────
    const { data: sub } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("stripe_customer_id, stripe_subscription_id, status")
      .eq("user_id", clerkUserId)
      .maybeSingle();

    if (!sub || !hasPlanAccessStatus(sub.status) || !sub.stripe_subscription_id) {
      return apiError("Active subscription required to purchase addons", 403);
    }

    if (!BACKUP_ADDON.priceId) {
      return apiError("Backup addon price is not configured on the server.", 500);
    }

    // A retry after an earlier attempt billed the item but failed to save the
    // flag must not bill a second one: look for the item that is already there.
    const stripe = getStripe();
    const existingItems = await stripe.subscriptionItems.list({
      subscription: sub.stripe_subscription_id,
      limit: 100,
    });
    const existingItem = existingItems.data.find(
      (item) => item.metadata?.type === "backup_addon" && item.metadata?.instance_id === instanceId,
    );

    // ── 3. Enable Hetzner native backups FIRST (before charging) ──────────────
    // MONEY/INFRA invariant: never bill a customer $10/mo for backups that are
    // not actually running. We must confirm Hetzner enablement succeeds before
    // adding the recurring Stripe line item. If Hetzner fails we fail closed —
    // no charge, no backups_enabled flag — so the user can safely retry.
    try {
      await enableServerBackup(instance.hetzner_server_id);
    } catch (hetznerErr) {
      if (existingItem) {
        // Retry of an attempt that already enabled backups and billed the item:
        // a repeat enable can be refused, but the customer is already charged,
        // so finish the flag write instead of claiming nothing was charged.
        log.warn("hetzner enable_backup failed on a retry with an existing add-on item", {
          source: "billing-backup-addon",
          route: "/api/billing/backup-addon",
          method: "POST",
          instanceId,
          hetznerServerId: instance.hetzner_server_id,
          stripeSubscriptionItemId: existingItem.id,
          failureType: "hetzner_enable_backup_retry_failed",
        });
      } else {
        log.error("hetzner enable_backup failed", hetznerErr, {
          source: "billing-backup-addon",
          route: "/api/billing/backup-addon",
          method: "POST",
          instanceId,
          hetznerServerId: instance.hetzner_server_id,
          failureType: "hetzner_enable_backup_failed",
        });
        await reportOpsEvent({
          source: "billing-backup-addon",
          title: "Hetzner backup enable failed before billing",
          message:
            "enableServerBackup failed; aborted before charging the customer so the backup add-on can be retried.",
          severity: "warn",
          route: "/api/billing/backup-addon",
          userId: clerkUserId,
          instanceId,
          metadata: {
            hetznerServerId: instance.hetzner_server_id,
            failureType: "hetzner_enable_backup_failed",
          },
          sampleStack: hetznerErr instanceof Error ? hetznerErr.stack ?? null : null,
        });
        return apiError(
          "Could not enable server backups right now. You have not been charged — please try again shortly.",
          502,
          { failureType: "hetzner_enable_backup_failed" },
        );
      }
    }

    // ── 4. Add recurring item to Stripe subscription (at most one per instance) ─

    let subscriptionItemId: string | null = existingItem?.id ?? null;
    if (!existingItem) {
      // The idempotency key stops two concurrent requests creating two items.
      // It is scoped to a one-minute window: a key reused after the add-on was
      // removed would replay the deleted item instead of billing a new one.
      const idempotencyWindow = Math.floor(Date.now() / 60_000);
      const created = await stripe.subscriptionItems.create(
        {
          subscription: sub.stripe_subscription_id,
          price: BACKUP_ADDON.priceId,
          quantity: 1,
          proration_behavior: "create_prorations",
          metadata: {
            type: "backup_addon",
            instance_id: instanceId,
            instance_name: instance.name,
          },
        },
        { idempotencyKey: `backup-addon:${instanceId}:${idempotencyWindow}` },
      );
      subscriptionItemId = created.id;
    }

    // ── 5. Mark instance & peers as backup-enabled ───────────────────────────
    // The customer may already be billed, so a failed flag write must not look
    // like success. The retry above reuses the item, so it cannot bill twice.
    const { error: flagError } = await supabaseAdmin
      .from("hermes_instances")
      .update({ backups_enabled: true })
      .eq("hetzner_server_id", instance.hetzner_server_id);
    if (flagError) {
      log.error("backup add-on billed but backups_enabled write failed", flagError, {
        source: "billing-backup-addon",
        route: "/api/billing/backup-addon",
        method: "POST",
        instanceId,
        hetznerServerId: instance.hetzner_server_id,
        stripeSubscriptionItemId: subscriptionItemId,
        failureType: "backup_addon_flag_write_failed",
      });
      await reportOpsEvent({
        source: "billing-backup-addon",
        title: "Backup add-on billed but backups flag not saved",
        message:
          "The Stripe subscription item exists but hermes_instances.backups_enabled could not be set. A retry reuses the item.",
        severity: "error",
        route: "/api/billing/backup-addon",
        userId: clerkUserId,
        instanceId,
        metadata: {
          hetznerServerId: instance.hetzner_server_id,
          stripeSubscriptionItemId: subscriptionItemId,
          failureType: "backup_addon_flag_write_failed",
        },
      });
      return apiError(
        "Backups were billed but could not be switched on. Please try again; you will not be charged twice.",
        500,
        { failureType: "backup_addon_flag_write_failed" },
      );
    }

    return apiSuccess({
      success: true,
      message: "Daily backups enabled. Your server will be backed up every 24 hours.",
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      return apiError("Unable to update Stripe billing for backups. Please try again.", 400, {
        failureType: "backup_addon_stripe_failed",
        stripeErrorType: err.type,
      });
    }
    return apiError(
      "Failed to enable backups. Please try again.",
      500,
      {
        failureType: "backup_addon_unexpected_error",
        errorName: err instanceof Error ? err.name : typeof err,
      }
    );
  }
}
