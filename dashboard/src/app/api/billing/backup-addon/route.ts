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

    const body = await req.json();
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

    // ── 3. Enable Hetzner native backups FIRST (before charging) ──────────────
    // MONEY/INFRA invariant: never bill a customer $10/mo for backups that are
    // not actually running. We must confirm Hetzner enablement succeeds before
    // adding the recurring Stripe line item. If Hetzner fails we fail closed —
    // no charge, no backups_enabled flag — so the user can safely retry.
    try {
      await enableServerBackup(instance.hetzner_server_id);
    } catch (hetznerErr) {
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

    // ── 4. Add recurring item to Stripe subscription ──────────────────────────
    const stripe = getStripe();

    await stripe.subscriptionItems.create({
      subscription: sub.stripe_subscription_id,
      price: BACKUP_ADDON.priceId,
      quantity: 1,
      proration_behavior: "create_prorations",
      metadata: {
        type: "backup_addon",
        instance_id: instanceId,
        instance_name: instance.name,
      },
    });

    // ── 5. Mark instance & peers as backup-enabled ───────────────────────────
    await supabaseAdmin
      .from("hermes_instances")
      .update({ backups_enabled: true })
      .eq("hetzner_server_id", instance.hetzner_server_id);

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
