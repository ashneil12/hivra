import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";
import {
  LEGACY_STRIPE_PRICE_IDS,
  PLANS,
  TRIAL_GRACE_HOURS,
  type PlanKey,
} from "@/lib/subscription";
import { getStripe } from "@/lib/stripe";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import {
  grantStripeTopUpCredits,
  grantSubscriptionCycleCredits,
  isTopUpPackageCredits,
} from "@/lib/billing/credits";
import { grantManagedVeniceCardTopUpCredit } from "@/lib/billing/managed-venice-wallets";
import { tryReactivateManagedVeniceKeysAfterTopUp } from "@/lib/billing/managed-venice-auto-recover";
import { maybeSendPaymentFailedRecoveryEmail } from "@/lib/billing/dunning";
import { upsertPool } from "@/lib/pools/pool-service";
import {
  resolveEffectiveSubscription,
  type EffectiveSubscription,
} from "@/lib/billing/instance-entitlement";

const LOG_SOURCE = "stripe-webhook-service";

// Reversibility switch for the suspend-not-delete billing change. When a
// payment fails or a subscription is canceled we now SUSPEND instances (route
// them into the stale-suspended ladder: warning emails + plan-aware grace,
// paying customers excluded) instead of arming a 48h deletion fuse directly —
// the path that destroyed paying customers' data on a transient card decline
// (2026-05-22 incident). Set HERMES_BILLING_LEGACY_HARD_DELETE=true to revert
// to the old immediate-schedule behavior if ever needed. Read at call time so
// the kill-switch can be flipped (and tested) without a module reload.
function isBillingLegacyHardDelete(): boolean {
  return (
    process.env.HERMES_BILLING_LEGACY_HARD_DELETE?.trim().toLowerCase() === "true"
  );
}

type ManagedHostStatus = "running" | "stopped";
type CheckoutConversionSource = "stripe_webhook" | "confirm_checkout";

async function runLifecycleStatusWriteWithRetry(
  execute: () => PromiseLike<{ error: { message?: string } | null }>
) {
  // Lifecycle status writes are idempotent, so one bounded retry is safe.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await execute();
    if (!error) return;

    if (attempt === 1) {
      throw new Error(error.message || "Failed to persist lifecycle status");
    }
  }
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parentSub = invoice.parent?.subscription_details?.subscription;
  if (typeof parentSub === "string") return parentSub;
  if (parentSub && typeof parentSub === "object" && "id" in parentSub) {
    return parentSub.id;
  }
  const legacy = (invoice as unknown as { subscription?: unknown }).subscription;
  if (typeof legacy === "string") return legacy;
  if (legacy && typeof legacy === "object" && "id" in legacy) {
    return (legacy as { id: string }).id;
  }
  return null;
}

function getSubscriptionPeriod(subscription: Stripe.Subscription) {
  const firstItem = subscription.items?.data?.[0];
  const periodStart =
    firstItem?.current_period_start ??
    (subscription as unknown as { current_period_start?: number })
      .current_period_start ??
    subscription.start_date;
  const periodEnd =
    firstItem?.current_period_end ??
    (subscription as unknown as { current_period_end?: number })
      .current_period_end;

  return { periodStart, periodEnd };
}

function getConfiguredStripePriceIds(planKey: PlanKey): string[] {
  const plan = PLANS[planKey];
  const priceIds = [plan.stripePriceId];

  if ("stripeYearlyPriceId" in plan) {
    priceIds.push(plan.stripeYearlyPriceId);
  }

  const configured = priceIds.filter((priceId): priceId is string => Boolean(priceId));

  // Keep the "validation skipped when unconfigured" behavior keyed on the env
  // prices alone; only a configured plan also accepts its pre-rotation legacy
  // prices (subscriptions never migrate off the price they were created on).
  if (configured.length === 0) return configured;
  return [...configured, ...(LEGACY_STRIPE_PRICE_IDS[planKey] ?? [])];
}

function getCheckoutPaymentIntentId(session: Stripe.Checkout.Session): string | null {
  const paymentIntent = session.payment_intent;
  if (typeof paymentIntent === "string") return paymentIntent;
  if (paymentIntent && typeof paymentIntent === "object" && "id" in paymentIntent) {
    return paymentIntent.id;
  }
  return null;
}

export class StripeWebhookService {
  static async captureCheckoutPaymentCompleted({
    session,
    subscription,
    source,
  }: {
    session: Stripe.Checkout.Session;
    subscription?: Stripe.Subscription | null;
    source: CheckoutConversionSource;
  }) {
    const userId = session.metadata?.user_id || subscription?.metadata?.user_id || null;
    const plan = session.metadata?.plan || subscription?.metadata?.plan || null;
    const cadence = session.metadata?.cadence || subscription?.metadata?.cadence || null;
    const subscriptionId =
      subscription?.id ||
      (typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id) ||
      null;

    try {
      posthogClient.capture({
        distinctId: userId || "unknown",
        event: "checkout_payment_completed",
        properties: {
          plan,
          cadence,
          source,
          session_id: session.id,
          subscription_id: subscriptionId,
          payment_status: session.payment_status,
          amount: session.amount_total ? session.amount_total / 100 : undefined,
          $insert_id: `checkout_payment_completed_${session.id}`,
        },
      });
      await posthogClient.flush();
    } catch (error) {
      log.error("failed to capture checkout conversion", error, {
        source: LOG_SOURCE,
        failureType: "checkout_conversion_capture_failed",
        conversionSource: source,
        sessionId: session.id,
        subscriptionId,
        hasUserId: Boolean(userId),
        paymentStatus: session.payment_status,
      });
    }
  }

  private static async updateInstancesConcurrently({
    instances,
    update,
    hostUpdate,
    transitionServer,
    serverActionLabel,
    instanceActionLabel,
  }: {
    instances: Array<{
      id: string;
      host_id?: string | null;
      hetzner_server_id: string | null;
      status?: string | null;
      scheduled_deletion_at?: string | null;
    }>;
    update: {
      status: string;
      scheduled_deletion_at: string | null;
      updated_at: string;
    };
    hostUpdate?: {
      status: ManagedHostStatus;
      updated_at: string;
    };
    transitionServer: (serverId: string) => Promise<unknown>;
    serverActionLabel: string;
    instanceActionLabel: string;
  }) {
    const admin = supabaseAdmin;
    if (!admin || instances.length === 0) return;

    const serverTransitionResults = new Map<string, Promise<boolean>>();
    const hostSyncResults = new Map<string, Promise<boolean>>();

    const getServerTransitionResult = (serverId: string) => {
      const existing = serverTransitionResults.get(serverId);
      if (existing) return existing;

      const pending = (async () => {
        try {
          await transitionServer(serverId);
          return true;
        } catch (error) {
          log.error(`failed to ${serverActionLabel} hetzner server`, error, {
            source: LOG_SOURCE,
            failureType: "instance_server_transition_failed",
            action: serverActionLabel,
            hetznerServerId: serverId,
          });
          return false;
        }
      })();

      serverTransitionResults.set(serverId, pending);
      return pending;
    };

    const getHostSyncResult = (hostId: string) => {
      const existing = hostSyncResults.get(hostId);
      if (existing) return existing;

      const pending = (async () => {
        try {
          await runLifecycleStatusWriteWithRetry(() =>
            admin
              .from("hermes_hosts")
              .update(hostUpdate!)
              .eq("id", hostId)
          );
          return true;
        } catch (error) {
          log.error("failed to sync host lifecycle state", error, {
            source: LOG_SOURCE,
            failureType: "host_state_update_failed",
            action: instanceActionLabel,
            hostId,
          });
          return false;
        }
      })();

      hostSyncResults.set(hostId, pending);
      return pending;
    };

    await Promise.allSettled(
      instances.map(async (instance) => {
        // Hetzner shutdown / power-on is best-effort. The lifecycle DB
        // write MUST still happen even if the Hetzner action throws —
        // for shutdown, purge-expired cron tolerates already-off / 404
        // and converges from DB state; for restore, skipping the write
        // would leave the row scheduled_for_deletion and the purge cron
        // would delete a user's reactivated instance. Earlier behavior
        // gated the DB write on transition success, which silently left
        // rows stuck mid-state when Hetzner returned a transient error
        // — including the 2026-04-29 cohort where cancelled trials kept
        // their VMs alive at Hetzner because the DB never moved to
        // scheduled_for_deletion.
        if (instance.hetzner_server_id) {
          await getServerTransitionResult(instance.hetzner_server_id);
        }

        if (instance.host_id && hostUpdate) {
          await getHostSyncResult(instance.host_id);
        }

        try {
          await runLifecycleStatusWriteWithRetry(() =>
            admin
              .from("hermes_instances")
              .update(update)
              .eq("id", instance.id)
          );
        } catch (error) {
          log.error(`failed to ${instanceActionLabel} instance lifecycle row`, error, {
            source: LOG_SOURCE,
            failureType: "instance_state_update_failed",
            action: instanceActionLabel,
            instanceId: instance.id,
          });
        }
      })
    );
  }

  /**
   * Routes checkout.session.completed based on session metadata type:
   *  - "storage_addon": triggers disk expansion on the target instance
   *  - regular subscription: immediately activates the subscription in DB
   *    (fires before customer.subscription.created, enabling instant activation)
   */
  static async handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    const type = session.metadata?.type;

    if (type === "credit_topup") {
      await this.handleCreditTopUpPurchased(session);
      return;
    }

    if (type === "managed_venice_card_topup") {
      await this.handleManagedVeniceCardTopUpPurchased(session);
      return;
    }

    if (!supabaseAdmin) return;

    if (type === "storage_addon") {
      await this.handleStorageAddonPurchased(session);
      return;
    }

    // For regular subscription checkouts: activate immediately rather than
    // waiting for customer.subscription.created which may arrive later
    const checkoutCompleted =
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required";

    if (session.mode === "subscription" && session.subscription && checkoutCompleted) {
      const stripe = getStripe();
      const subscriptionId = typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription as Stripe.Subscription).id;

      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await this.handleSubscriptionChange(subscription);
        log.info("activated subscription from checkout.session.completed", {
          source: LOG_SOURCE,
          subscriptionId,
          stripeEventType: "checkout.session.completed",
        });

        const userId = session.metadata?.user_id || subscription.metadata?.user_id || null;
        const checkoutIp =
          session.metadata?.checkout_ip || subscription.metadata?.checkout_ip || null;

        if (userId) {
          // Awaited so the insert actually runs to completion before
          // the serverless function returns. The previous fire-and-
          // forget pattern could lose the row if the response was sent
          // before the insert resolved — undermining the trial-abuse
          // gate. 23505 (unique violation) is treated as an idempotent
          // success: a redelivered webhook may fire this twice.
          const { error: trialInsertErr } = await supabaseAdmin
            .from("hermes_trial_usage")
            .insert({
              user_id: userId,
              ip_address: checkoutIp && checkoutIp !== 'unknown' ? checkoutIp : null,
            });
          if (trialInsertErr && trialInsertErr.code !== '23505') {
            log.error("failed to record trial usage", trialInsertErr, {
              source: LOG_SOURCE,
              failureType: "trial_usage_insert_failed",
              errorCode: trialInsertErr.code,
              userId,
            });
          }
        }
        
        await this.captureCheckoutPaymentCompleted({
          session,
          subscription,
          source: "stripe_webhook",
        });
      } catch (err) {
        log.error("failed to activate subscription from checkout", err, {
          source: LOG_SOURCE,
          failureType: "checkout_activation_failed",
          subscriptionId,
          stripeErrorType: err instanceof Stripe.errors.StripeError ? err.type : undefined,
        });
        // Re-throw so the webhook returns non-2xx and Stripe retries via
        // its built-in redelivery (exponential backoff over ~3 days). The
        // previous swallow ack'd the event as processed even when the
        // paying user's subscription was never activated.
        throw err;
      }
    }
  }

  static async handleCreditTopUpPurchased(session: Stripe.Checkout.Session) {
    if (!supabaseAdmin) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured - cannot record credit top-up");
    }

    if (session.payment_status !== "paid") {
      log.warn("credit_topup checkout completed before payment settled", {
        source: LOG_SOURCE,
        failureType: "credit_topup_unpaid_session",
        sessionId: session.id,
        paymentStatus: session.payment_status,
      });
      return;
    }

    const userId = session.metadata?.user_id;
    const packageCredits = Number(session.metadata?.package_credits);
    if (!userId || !Number.isInteger(packageCredits) || !isTopUpPackageCredits(packageCredits)) {
      throw new Error("Invalid credit top-up metadata");
    }

    if (session.amount_total !== null && session.amount_total !== packageCredits) {
      throw new Error("Credit top-up amount does not match package");
    }

    const amountTotalCents = session.amount_total ?? packageCredits;
    const paymentIntentId = getCheckoutPaymentIntentId(session);
    await grantStripeTopUpCredits({
      userId,
      sessionId: session.id,
      packageCredits,
      amountTotalCents,
      metadata: {
        paymentIntentId,
      },
    });

    posthogClient.capture({
      distinctId: userId,
      event: "credit_topup_completed",
      properties: {
        source: "stripe_webhook",
        session_id: session.id,
        package_credits: packageCredits,
        amount: amountTotalCents / 100,
      },
    });
    await posthogClient.flush();
  }

  static async handleManagedVeniceCardTopUpPurchased(session: Stripe.Checkout.Session) {
    if (!supabaseAdmin) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured - cannot record managed Venice card top-up");
    }

    if (session.payment_status !== "paid") {
      log.warn("managed_venice_card_topup checkout completed before payment settled", {
        source: LOG_SOURCE,
        failureType: "managed_venice_card_topup_unpaid_session",
        sessionId: session.id,
        paymentStatus: session.payment_status,
      });
      return;
    }

    const userId = session.metadata?.user_id;
    const paidMicroUsd = Number(session.metadata?.paid_micro_usd);
    const creditMicroUsd = Number(session.metadata?.credit_micro_usd);
    if (
      !userId ||
      !Number.isInteger(paidMicroUsd) ||
      paidMicroUsd <= 0 ||
      !Number.isInteger(creditMicroUsd) ||
      creditMicroUsd <= 0
    ) {
      throw new Error("Invalid managed Venice card top-up metadata");
    }

    const expectedAmountCents = Math.round(paidMicroUsd / 10_000);
    if (session.amount_total !== null && session.amount_total !== expectedAmountCents) {
      throw new Error("Managed Venice card top-up amount does not match checkout total");
    }

    const amountTotalCents = session.amount_total ?? expectedAmountCents;
    const paymentIntentId = getCheckoutPaymentIntentId(session);
    await grantManagedVeniceCardTopUpCredit({
      userId,
      sessionId: session.id,
      amountMicroUsd: creditMicroUsd,
      amountTotalCents,
      metadata: {
        paidMicroUsd,
        paymentIntentId,
      },
    });

    // Now that the wallet is funded, auto-reactivate any proxy key that was
    // paused for an uncovered overage (flag-gated, off by default; no-op when
    // disabled). Best-effort — a recovery miss must not fail the top-up that
    // already credited the wallet.
    try {
      await tryReactivateManagedVeniceKeysAfterTopUp(userId);
    } catch (recoverError) {
      log.warn("managed Venice auto-recover after card top-up failed", {
        source: LOG_SOURCE,
        failureType: "managed_venice_auto_recover_failed",
        userId,
        errorMessage: recoverError instanceof Error ? recoverError.message : String(recoverError),
      });
    }

    posthogClient.capture({
      distinctId: userId,
      event: "managed_venice_card_topup_completed",
      properties: {
        source: "stripe_webhook",
        session_id: session.id,
        paid_micro_usd: paidMicroUsd,
        credit_micro_usd: creditMicroUsd,
        amount: amountTotalCents / 100,
      },
    });
    await posthogClient.flush();
  }

  static async handleStorageAddonPurchased(session: Stripe.Checkout.Session) {
    if (!supabaseAdmin) return;

    const instanceId = session.metadata?.instance_id;
    const userId = session.metadata?.user_id;
    const diskGbStr = session.metadata?.disk_gb_added;

    if (!instanceId || !userId) {
      log.error(
        "storage_addon missing instance_id or user_id in metadata",
        new Error("storage_addon missing metadata"),
        {
          source: LOG_SOURCE,
          failureType: "storage_addon_missing_metadata",
          hasInstanceId: Boolean(instanceId),
          hasUserId: Boolean(userId),
          hasDiskGbAdded: Boolean(diskGbStr),
          sessionId: session.id,
        }
      );
      return;
    }

    const { data: instance } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, name, hetzner_server_id, disk_size_gb, disk_upgraded, status")
      .eq("id", instanceId)
      .eq("user_id", userId)
      .single();

    if (!instance) {
      log.error(
        "instance not found for storage addon",
        new Error("instance not found"),
        {
          source: LOG_SOURCE,
          failureType: "storage_addon_instance_not_found",
          instanceId,
          userId,
        },
      );
      return;
    }
    if (instance.disk_upgraded) {
      log.warn("instance already disk_upgraded — skipping Hetzner call", {
        source: LOG_SOURCE,
        failureType: "storage_addon_already_upgraded",
        instanceId,
        userId,
      });
      return;
    }

    const diskGbAdded = parseInt(diskGbStr || "20", 10);
    const newDiskSize = (instance.disk_size_gb || 40) + diskGbAdded;

    // ORDER MATTERS: resize Hetzner FIRST, then mark `disk_upgraded=true`.
    // The previous order (DB flag → fire-and-forget Hetzner resize) had
    // a BLOCKER bug: a Hetzner failure would leave the user with the DB
    // showing "upgraded" but no actual disk, AND the early-return guard
    // at the top of this method would prevent re-attempts on retry.
    // The user paid for storage they don't have.
    if (!instance.hetzner_server_id) {
      log.warn("instance has no hetzner_server_id — recording storage addon without Hetzner resize", {
        source: LOG_SOURCE,
        failureType: "storage_addon_no_hetzner_server",
        instanceId,
        userId,
      });
      // No Hetzner server to resize (manual / pre-Hetzner instance).
      // Record the addon at the DB level so the user's paid intent is
      // captured for a manual operator follow-up.
      const { error: updateErrNoHetzner } = await supabaseAdmin
        .from("hermes_instances")
        .update({
          disk_upgraded: true,
          disk_upgraded_at: new Date().toISOString(),
          disk_size_gb: newDiskSize,
          storage_addon_session_id: session.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", instanceId);
      if (updateErrNoHetzner) {
        log.error("failed to update instance disk after storage addon", updateErrNoHetzner, {
          source: LOG_SOURCE,
          failureType: "storage_addon_instance_update_failed",
          instanceId,
          userId,
          errorCode: updateErrNoHetzner.code,
        });
        // Don't return — fall through to posthog capture so we don't
        // double-throw. Stripe will not redeliver on a failed write
        // since we caught the error; an operator alert via ops_events
        // is the recovery path.
      }
    } else {
      // Await the Hetzner resize so a failure here means we DO NOT mark
      // the user as upgraded. Stripe will redeliver the webhook (we
      // throw below on error) and the addon will be retried. The
      // `disk_upgraded` early-return guard above only fires after a
      // successful resize.
      try {
        await this.triggerHetznerDiskExpansion(
          instanceId,
          instance.hetzner_server_id
        );
      } catch (err) {
        log.error("hetzner disk expansion failed; aborting storage addon webhook so Stripe redelivers", err, {
          source: LOG_SOURCE,
          failureType: "storage_addon_disk_expansion_failed",
          instanceId,
          userId,
          hetznerServerId: instance.hetzner_server_id,
        });
        throw err;
      }

      const { error: updateErr } = await supabaseAdmin
        .from("hermes_instances")
        .update({
          disk_upgraded: true,
          disk_upgraded_at: new Date().toISOString(),
          disk_size_gb: newDiskSize,
          storage_addon_session_id: session.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", instanceId);

      if (updateErr) {
        // The disk is already physically resized. If we throw here
        // Stripe will redeliver and we'll re-attempt the resize, which
        // will increment disk size AGAIN. Don't throw — log loudly and
        // emit an ops_events row so the operator can fix the DB by
        // hand. The user has the storage they paid for; the DB row is
        // just out of sync.
        log.error(
          "hetzner disk resized but DB flag update failed — manual reconciliation needed",
          updateErr,
          {
            source: LOG_SOURCE,
            failureType: "storage_addon_db_update_after_resize_failed",
            instanceId,
            userId,
            errorCode: updateErr.code,
            newDiskSizeGb: newDiskSize,
          }
        );
      }
    }

    // Track the add-on purchase
    posthogClient.capture({
      distinctId: userId,
      event: 'storage_addon_purchased',
      properties: {
        instance_id: instanceId,
        disk_gb_added: diskGbAdded,
        amount: session.amount_total ? session.amount_total / 100 : undefined
      }
    });
    await posthogClient.flush();
  }

  /**
   * Triggers a Hetzner server type change with upgrade_disk=true, expanding the disk.
   */
  static async triggerHetznerDiskExpansion(
    instanceId: string,
    hetznerServerId: number
  ) {
    try {
      const { getServer, changeServerType, waitForAction, shutdownServer, powerOnServer } =
        await import("@/lib/hetzner/client");

      const { server } = await getServer(hetznerServerId);
      const currentServerType =
        (server as unknown as { server_type?: { name?: string } }).server_type?.name || "cx23";

      const shutdownAction = await shutdownServer(hetznerServerId);
      await waitForAction(shutdownAction.action.id, 60_000);

      const resizeAction = await changeServerType(
        hetznerServerId,
        currentServerType,
        true // upgrade_disk: PERMANENT
      );
      await waitForAction(resizeAction.action.id, 120_000);

      const powerAction = await powerOnServer(hetznerServerId);
      await waitForAction(powerAction.action.id, 60_000);
    } catch (err) {
      log.error("hetzner disk expansion failed", err, {
        source: LOG_SOURCE,
        failureType: "hetzner_disk_expansion_failed",
        instanceId,
        hetznerServerId,
      });
      throw err;
    }
  }

  /**
   * Refund the charge on a duplicate (newer) subscription. Idempotent: the
   * Stripe idempotency key is derived from the subscription id, so a webhook
   * redelivery — or a recovery run after a crash between cancel() and refund —
   * either no-ops (the refund already happened) or issues the missed refund.
   * Never throws; a refund failure is logged loudly for ops to action.
   */
  private static async refundDuplicateSubscriptionCharge(
    subscription: Stripe.Subscription,
    userId: string
  ): Promise<void> {
    const stripe = getStripe();
    const invoiceId =
      typeof subscription.latest_invoice === "string"
        ? subscription.latest_invoice
        : subscription.latest_invoice?.id;
    if (!invoiceId) return;

    const invoice = await stripe.invoices.retrieve(invoiceId);
    const pi = (
      invoice as unknown as { payment_intent?: string | Stripe.PaymentIntent | null }
    ).payment_intent;
    const paymentIntentId =
      typeof pi === "string" ? pi : (pi as Stripe.PaymentIntent | null)?.id;

    if (!paymentIntentId) {
      // No payment_intent on the invoice. Often benign (unpaid / $0 /
      // credit-balance invoice ⇒ nothing was charged), but it can also be a
      // paid invoice whose PI we couldn't read — flag for manual review so a
      // genuine double-charge isn't missed.
      log.warn("could not find payment intent to refund for duplicate subscription; manual review required", {
        source: LOG_SOURCE,
        failureType: "duplicate_subscription_no_payment_intent",
        subscriptionId: subscription.id,
        invoiceId,
        userId,
      });
      return;
    }

    try {
      await stripe.refunds.create(
        { payment_intent: paymentIntentId, reason: "duplicate" },
        // Idempotency key keyed on the canceled (newer) subscription so a
        // webhook redelivery of this same duplicate can't issue a second refund
        // for the same charge.
        { idempotencyKey: `duplicate_refund_${subscription.id}` }
      );
      log.info("refunded duplicate payment intent", {
        source: LOG_SOURCE,
        subscriptionId: subscription.id,
        paymentIntentId,
        userId,
      });
    } catch (refundErr) {
      // The duplicate subscription was canceled but its charge could not be
      // refunded — the customer is double-charged until a human intervenes.
      // Surface this loudly (error-level, distinct failureType) so it reaches
      // ops alerting for manual refund.
      log.error(
        "FAILED to refund duplicate subscription charge — manual refund required",
        refundErr,
        {
          source: LOG_SOURCE,
          failureType: "duplicate_subscription_refund_failed",
          subscriptionId: subscription.id,
          paymentIntentId,
          userId,
        }
      );
    }
  }

  static async handleSubscriptionChange(
    subscription: Stripe.Subscription,
    options: { source?: CheckoutConversionSource } = {}
  ) {
    const source = options.source ?? "stripe_webhook";
    if (!supabaseAdmin) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured - cannot update subscription");
    }

    if (!subscription.metadata) {
      log.error("subscription missing metadata", new Error("subscription metadata absent"), {
        source: LOG_SOURCE,
        failureType: "subscription_missing_metadata",
        subscriptionId: subscription.id,
      });
      return;
    }

    const userId = subscription.metadata.user_id;
    const planKey = subscription.metadata.plan as PlanKey;

    if (!userId || !planKey || !PLANS[planKey]) {
      log.error("subscription has missing or invalid metadata", new Error("invalid subscription metadata"), {
        source: LOG_SOURCE,
        failureType: "subscription_invalid_metadata",
        subscriptionId: subscription.id,
        hasUserId: Boolean(userId),
        hasPlanKey: Boolean(planKey),
        hasValidPlan: Boolean(planKey && PLANS[planKey]),
      });
      return;
    }

    const plan = PLANS[planKey];

    // Cross-check `metadata.plan` against the actual price the customer is
    // paying for. Stripe's metadata is authoritative for the platform but
    // an admin slip in the dashboard (or a Stripe Workflow that updates one
    // side without the other) can drift the two: e.g. metadata says
    // "command" while the price item is the "operator" recurring price.
    // Without this check, the user would get command-tier resources for an
    // operator price (or vice versa). Monthly and yearly prices are both
    // valid for the same plan; when a mismatch is detected, log loudly and
    // skip the upsert so resource grants stay accurate.
    const subscriptionPriceId = subscription.items?.data?.[0]?.price?.id;
    const configuredPriceIds = getConfiguredStripePriceIds(planKey);
    if (subscriptionPriceId && configuredPriceIds.length === 0) {
      log.warn(
        "subscription price validation skipped because no plan price IDs are configured",
        {
          source: LOG_SOURCE,
          failureType: "subscription_price_validation_unconfigured",
          subscriptionId: subscription.id,
          userId,
          metadataPlan: planKey,
          actualPriceId: subscriptionPriceId,
        },
      );
    }

    if (subscriptionPriceId && configuredPriceIds.length > 0 && !configuredPriceIds.includes(subscriptionPriceId)) {
      log.error(
        "subscription plan/price mismatch — refusing to apply",
        new Error("plan/price mismatch"),
        {
          source: LOG_SOURCE,
          failureType: "subscription_plan_price_mismatch",
          subscriptionId: subscription.id,
          userId,
          metadataPlan: planKey,
          metadataPlanPriceIds: configuredPriceIds,
          actualPriceId: subscriptionPriceId,
        },
      );
      return;
    }

    // Defense-in-depth: cross-check `subscription.metadata.user_id` against
    // the customer's `metadata.clerk_user_id`. The customer's
    // clerk_user_id is set ONCE at signup (subscribe route or
    // recreateCustomer) and shouldn't drift; the subscription's user_id
    // could be tampered via Stripe Dashboard / API. If a Stripe-side
    // attacker creates a subscription with a substituted user_id, this
    // catches it before we credit the wrong account. Skip when the
    // customer somehow lacks clerk_user_id (legacy customers from before
    // the metadata convention) — log a warning so we know to backfill.
    try {
      const stripe = getStripe();
      const customer = await stripe.customers.retrieve(subscription.customer as string);
      if (customer.deleted) {
        log.error(
          "customer is deleted — skipping subscription apply",
          new Error("customer deleted"),
          {
            source: LOG_SOURCE,
            failureType: "subscription_customer_deleted",
            subscriptionId: subscription.id,
            customerId: subscription.customer,
          },
        );
        return;
      }
      const customerClerkUserId = customer.metadata?.clerk_user_id;
      if (!customerClerkUserId) {
        log.warn(
          "customer has no clerk_user_id metadata (legacy?) — proceeding without cross-check",
          {
            source: LOG_SOURCE,
            failureType: "subscription_customer_missing_clerk_metadata",
            subscriptionId: subscription.id,
            customerId: customer.id,
          },
        );
      } else if (customerClerkUserId !== userId) {
        log.error(
          "subscription/customer user mismatch — refusing to apply",
          new Error("user mismatch between subscription metadata and customer"),
          {
            source: LOG_SOURCE,
            failureType: "subscription_user_mismatch",
            subscriptionId: subscription.id,
            customerId: customer.id,
            metadataUserId: userId,
            customerClerkUserId,
          },
        );
        return;
      }
    } catch (err) {
      // Stripe customer retrieve failed — log and proceed. We don't want a
      // transient Stripe API error to lock out a legitimate webhook;
      // Stripe will retry the webhook on a 5xx so the next delivery has
      // another chance to confirm.
      log.warn("customer cross-check failed, proceeding without it", {
        source: LOG_SOURCE,
        failureType: "subscription_customer_lookup_failed",
        subscriptionId: subscription.id,
      }, err);
    }

    const { periodStart, periodEnd } = getSubscriptionPeriod(subscription);

    if (subscription.status === "active") {
      // Check for duplicate active subscriptions due to concurrent checkouts
      // We rely on Stripe as the source of truth rather than DB state, because multiple
      // concurrent webhooks might read a stale DB state before upserting.
      const stripe = getStripe();
      const activeSubs = await stripe.subscriptions.list({
        customer: subscription.customer as string,
        status: 'active',
      });
      
      // Filter subs that belong to this user (in case the customer is shared, which shouldn't happen, but just to be safe)
      const hermesSubs = activeSubs.data.filter(s => s.metadata?.user_id === userId);
      
      if (hermesSubs.length > 1) {
        // Sort oldest first
        hermesSubs.sort((a, b) => a.created - b.created);

        // If the current subscription being processed is NOT the oldest one, it's a duplicate created by a race condition.
        if (hermesSubs[0].id !== subscription.id) {
          // Defer cancel/refund until the survivor (older) sub has a
          // corresponding hermes_subscriptions row. Otherwise — if
          // webhooks arrive out of order with the newer one first — we'd
          // cancel the duplicate while the user briefly has paid for an
          // active subscription with no DB row, dashboard polls show
          // "No active subscription", and the user may buy a third time.
          //
          // Throwing here makes Stripe redeliver this webhook on its
          // retry schedule. By the next delivery, the older sub's
          // webhook has typically processed and the survivor row
          // exists; we can then safely cancel + refund the duplicate.
          const { data: survivorRow } = await supabaseAdmin
            .from("hermes_subscriptions")
            .select("id, stripe_subscription_id")
            .eq("user_id", userId)
            .eq("stripe_subscription_id", hermesSubs[0].id)
            .maybeSingle();

          if (!survivorRow) {
            log.warn(
              "duplicate subscription detected but survivor row not yet present — deferring via webhook redelivery",
              {
                source: LOG_SOURCE,
                failureType: "subscription_duplicate_survivor_pending",
                subscriptionId: subscription.id,
                userId,
                survivorSubscriptionId: hermesSubs[0].id,
              }
            );
            throw new Error(
              "survivor subscription row not yet present; deferring duplicate handling via Stripe webhook redelivery"
            );
          }

          log.warn("duplicate subscription detected; canceling newer", {
            source: LOG_SOURCE,
            failureType: "subscription_duplicate_detected",
            subscriptionId: subscription.id,
            userId,
            duplicateOfSubscriptionId: hermesSubs[0].id,
          });
          try {
            await stripe.subscriptions.cancel(subscription.id);
            await this.refundDuplicateSubscriptionCharge(subscription, userId);
          } catch (err) {
            log.error("error handling duplicate subscription", err, {
              source: LOG_SOURCE,
              failureType: "duplicate_subscription_recovery_failed",
              subscriptionId: subscription.id,
              userId,
            });
          }
          return; // Ignore this incoming duplicate
        }
      }

      // Redelivery self-heal. The frozen webhook payload still says 'active',
      // but if this subscription is no longer in Stripe's live active list it
      // was canceled in a PRIOR, partially-completed duplicate-handling run
      // that died after cancel() but before the refund and before the event was
      // marked processed. On this redelivery the hermesSubs>1 branch above is
      // skipped (only the survivor is active now), so without this we would
      // (a) never issue the refund and (b) upsert a CANCELED subscription id as
      // the active row. Confirm the cancellation with a live retrieve, re-issue
      // the refund (idempotent via the same key — a prior success is a no-op),
      // and refuse to write it as active.
      const stillActiveAtStripe = activeSubs.data.some((s) => s.id === subscription.id);
      if (!stillActiveAtStripe) {
        let liveStatus: Stripe.Subscription["status"] | null = null;
        try {
          liveStatus = (await stripe.subscriptions.retrieve(subscription.id)).status;
        } catch (retrieveErr) {
          // Couldn't confirm — fall through to normal handling rather than
          // skip a legitimately-active subscription on a transient error.
          log.warn("could not confirm live subscription status on redelivery; proceeding normally", {
            source: LOG_SOURCE,
            failureType: "subscription_live_status_unconfirmed",
            subscriptionId: subscription.id,
            userId,
            errorName: retrieveErr instanceof Error ? retrieveErr.name : typeof retrieveErr,
          });
        }
        if (liveStatus === "canceled" || liveStatus === "incomplete_expired") {
          log.warn("incoming subscription is a canceled duplicate (redelivery); ensuring refund + skipping active upsert", {
            source: LOG_SOURCE,
            failureType: "subscription_canceled_duplicate_redelivery",
            subscriptionId: subscription.id,
            userId,
            liveStatus,
          });
          try {
            await this.refundDuplicateSubscriptionCharge(subscription, userId);
          } catch (refundErr) {
            log.error("error ensuring duplicate refund on redelivery", refundErr, {
              source: LOG_SOURCE,
              failureType: "duplicate_subscription_recovery_failed",
              subscriptionId: subscription.id,
              userId,
            });
          }
          return; // Do NOT upsert a canceled subscription as the active row.
        }
      }

      await this.restoreScheduledDeletions(userId);
      await this.resumeBillingSuspendedInstances(userId);
    }

    // Suspend instances when subscription transitions to past_due / canceled /
    // unpaid via subscription.updated (e.g. trial ended with no payment method,
    // or manual cancellation from Stripe dashboard). We SUSPEND (laddered,
    // archivable, recoverable) rather than arm an immediate deletion fuse.
    if (
      (subscription.status === "past_due" ||
        subscription.status === "canceled" ||
        subscription.status === "unpaid") &&
      !(await this.findOtherLaneEntitlement(userId, `subscription_${subscription.status}`))
    ) {
      log.info("subscription moved to non-active state — suspending instances", {
        source: LOG_SOURCE,
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        userId,
        legacyHardDelete: isBillingLegacyHardDelete(),
      });
      if (isBillingLegacyHardDelete()) {
        await this.scheduleInstancesForDeletion(userId);
      } else {
        await this.suspendInstancesForBilling(
          userId,
          subscription.status === "canceled"
            ? "subscription_canceled"
            : "subscription_past_due"
        );
      }
    }

    const nextStatus =
      subscription.status === "active" || subscription.status === "trialing"
        ? "active"
        : subscription.status === "past_due"
          ? "past_due"
          : subscription.status === "incomplete"
            ? "pending"
            : "inactive";

    // Conversion stamp (write-once): record the FIRST free->paid transition.
    // Read the prior row before the blind upsert; stamp only when the prior
    // plan was free/pending/absent AND the new state is paid+active. The keys
    // are OMITTED from the upsert otherwise, so Stripe webhook redeliveries
    // (and routine paid->paid updates) can never move the timestamp. If the
    // prior-row read fails, skip stamping (fail closed) rather than risk
    // re-stamping an already-converted user.
    const { data: priorSubRow, error: priorSubReadError } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("plan, status, upgraded_at")
      .eq("user_id", userId)
      .maybeSingle();

    const isPaidActivation = planKey !== "free" && nextStatus === "active";
    const priorWasUnpaid =
      !priorSubRow ||
      priorSubRow.plan === "free" ||
      priorSubRow.plan == null ||
      priorSubRow.status === "pending";
    const shouldStampUpgrade =
      isPaidActivation &&
      !priorSubReadError &&
      priorWasUnpaid &&
      !priorSubRow?.upgraded_at;

    const { error: upsertError } = await supabaseAdmin
      .from("hermes_subscriptions")
      .upsert(
        {
          user_id: userId,
          stripe_subscription_id: subscription.id,
          stripe_customer_id: subscription.customer as string,
          plan: planKey,
          status: nextStatus,
          ...(shouldStampUpgrade
            ? {
                upgraded_at: new Date().toISOString(),
                upgrade_source: source,
              }
            : {}),
          instance_limit: plan.maxAgents,
          total_cpu_budget: plan.totalCpu,
          total_ram_budget: plan.totalRam,
          excess_resources: false,
          current_period_start: periodStart
            ? new Date(periodStart * 1000).toISOString()
            : null,
          current_period_end: periodEnd
            ? new Date(periodEnd * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (upsertError) {
      log.error("failed to upsert subscription", upsertError, {
        source: LOG_SOURCE,
        failureType: "subscription_upsert_failed",
        errorCode: upsertError.code,
        subscriptionId: subscription.id,
        userId,
      });
      return;
    }

    // Phase 1: mirror the subscription budget into the explicit pool entity.
    // Best-effort; the subscription row remains the source of truth until the read-flip.
    await upsertPool({
      userId,
      productSurface: "hermesos",
      cpuBudget: plan.totalCpu,
      ramBudgetMb: plan.totalRam,
      agentSlots: plan.maxAgents,
      priority: plan.priority,
      status:
        subscription.status === "active" || subscription.status === "trialing"
          ? "active"
          : subscription.status === "past_due"
            ? "past_due"
            : subscription.status === "incomplete"
              ? "pending"
              : "inactive",
    });

    if (subscription.status === "active" || subscription.status === "trialing") {
      await grantSubscriptionCycleCredits({
        userId,
        planKey,
        subscriptionId: subscription.id,
        periodStart,
        periodEnd,
      });

      // Bump every running instance to the new tier (DB tier_key + live VM
      // resize for Proxmox VMs). Webhook continues even if any individual
      // resize fails — the DB write is the source of truth, and warden's
      // 60s TTL refresh picks up the new tier policy regardless. Hetzner
      // instances pick up new caps on next container recreate (no live path).
      try {
        const { applyTierChange } = await import("@/lib/services/tier-change-service");
        const { tierFromPlanKey } = await import("@/lib/services/tier-specs");
        const outcome = await applyTierChange({
          userId,
          newTier: tierFromPlanKey(planKey),
          source: "stripe",
          reason: `subscription ${subscription.status} (${planKey})`,
        });
        if (outcome.resizesFailed.length > 0) {
          log.warn("tier-change had resize failures", {
            source: LOG_SOURCE,
            failureType: "tier_change_partial_failure",
            userId,
            subscriptionId: subscription.id,
            failedResizeCount: outcome.resizesFailed.length,
          });
        }
      } catch (err) {
        // Don't let a tier-change error roll back the subscription upsert —
        // the DB write to hermes_subscriptions has already landed.
        log.error("applyTierChange failed", err, {
          source: LOG_SOURCE,
          failureType: "tier_change_failed",
          userId,
          subscriptionId: subscription.id,
        });
      }
    }
  }

  /**
   * Cancellation intentionally keeps `plan` and `stripe_subscription_id` on
   * the row: entitlement everywhere gates on `status` (only
   * active/trialing/past_due grant access — see hasPlanAccessStatus), while
   * the retained plan/sub id preserve billing history and the win-back path.
   * status='canceled' also takes the row out of the subscription-state
   * reconciler's scan set. Do NOT "clean up" by resetting plan to free here —
   * writing a free/active row with a nulled sub id is what minted the 2026-07
   * ghost-payer rows.
   */
  static async handleSubscriptionDeleted(subscription: Stripe.Subscription) {
    if (!supabaseAdmin) return;
    if (!subscription.metadata?.user_id) return;

    const userId = subscription.metadata.user_id;

    const { data: currentSub } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (currentSub && currentSub.stripe_subscription_id !== subscription.id) {
      log.warn("ignoring outdated subscription.deleted event", {
        source: LOG_SOURCE,
        failureType: "subscription_deleted_outdated",
        subscriptionId: subscription.id,
        currentSubscriptionId: currentSub.stripe_subscription_id,
        userId,
      });
      return;
    }

    await supabaseAdmin.from("hermes_subscriptions").update({
      status: "canceled",
      instance_limit: 0,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);

    // Still paid through another lane: move the instances onto that lane's
    // tier and leave them running. Nothing is suspended or scheduled.
    const otherLane = await this.findOtherLaneEntitlement(userId, "subscription_deleted");
    if (otherLane) {
      try {
        const { applyTierChange } = await import("@/lib/services/tier-change-service");
        const { tierFromPlanKey } = await import("@/lib/services/tier-specs");
        await applyTierChange({
          userId,
          newTier: tierFromPlanKey(otherLane.plan),
          source: "stripe",
          reason: `subscription deleted (${subscription.id}); ${otherLane.source} ${otherLane.plan} entitlement remains`,
        });
      } catch (err) {
        log.error("tier change to remaining entitlement on subscription deletion failed", err, {
          source: LOG_SOURCE,
          failureType: "subscription_deletion_remaining_tier_failed",
          userId,
          subscriptionId: subscription.id,
          remainingSource: otherLane.source,
        });
      }
      return;
    }

    // Downgrade to free/sandbox tier so warden's daily cap kicks in for any
    // remaining running instances during the deletion grace window. The
    // resize itself is a no-op-on-failure: schedule_for_deletion already
    // queues the instances for shutdown, so the cap matters mostly for the
    // grace window before final deletion.
    try {
      const { applyTierChange } = await import("@/lib/services/tier-change-service");
      await applyTierChange({
        userId,
        newTier: "credit_base",
        source: "stripe",
        reason: `subscription deleted (${subscription.id})`,
      });
    } catch (err) {
      log.error("tier downgrade on subscription deletion failed", err, {
        source: LOG_SOURCE,
        failureType: "subscription_deletion_tier_downgrade_failed",
        userId,
        subscriptionId: subscription.id,
      });
    }

    // Cancellation preserves data: suspend (laddered + archivable + win-back
    // recoverable) instead of arming a 48h hard-delete fuse. A user who paid
    // through period end and might re-subscribe keeps their chats + workspace.
    if (isBillingLegacyHardDelete()) {
      await this.scheduleInstancesForDeletion(userId);
    } else {
      await this.suspendInstancesForBilling(userId, "subscription_canceled");
    }
  }

  /**
   * Cross-lane guard for every Stripe lapse path (invoice.payment_failed,
   * subscription.updated → past_due / canceled / unpaid, and
   * subscription.deleted); the Stripe twin of the Apple webhook's
   * suspendUnlessOtherEntitlement. A lapsing card subscription says nothing
   * about the user's other paid lanes: an Apple IAP subscription, a yearly
   * $HermesOS subscription or a Pro/Power token qualification. Without this a
   * yearly subscriber whose old card subscription ended had their instances
   * stopped and forced to credit_base while their paid year was still running.
   *
   * The Stripe row is left out because at call time it can still read active
   * or past_due. Returns the other lane's entitlement when it grants seats,
   * else null. If the check itself fails it throws: the webhook route then
   * marks the event failed and answers 500, so Stripe redelivers it rather
   * than this handler suspending someone it could not check.
   */
  private static async findOtherLaneEntitlement(
    userId: string,
    trigger: string
  ): Promise<EffectiveSubscription | null> {
    let other: EffectiveSubscription | null;
    try {
      other = await resolveEffectiveSubscription(userId, { excludeStripe: true });
    } catch (err) {
      log.error("stripe lapse entitlement cross-check failed; leaving instances for redelivery", err, {
        source: LOG_SOURCE,
        failureType: "stripe_lapse_crosscheck_failed",
        userId,
        trigger,
      });
      throw err;
    }
    if (!other || other.instance_limit <= 0) return null;

    log.info("stripe lapse: user keeps another paid entitlement — skipping suspension", {
      source: LOG_SOURCE,
      userId,
      trigger,
      remainingSource: other.source,
      remainingPlan: other.plan,
    });
    return other;
  }

  static async scheduleInstancesForDeletion(userId: string) {
    if (!supabaseAdmin) return;
    const { shutdownServer } = await import("@/lib/hetzner/client");

    const scheduledDeletionAt = new Date(
      Date.now() + TRIAL_GRACE_HOURS * 60 * 60 * 1000
    ).toISOString();
    const updatedAt = new Date().toISOString();

    const { data: instances } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, host_id, hetzner_server_id, status, scheduled_deletion_at")
      .eq("user_id", userId)
      .not("status", "in", '("deleted","scheduled_for_deletion")');

    if (!instances || instances.length === 0) return;

    await this.updateInstancesConcurrently({
      instances,
      update: {
        status: "scheduled_for_deletion",
        scheduled_deletion_at: scheduledDeletionAt,
        updated_at: updatedAt,
      },
      hostUpdate: {
        status: "stopped",
        updated_at: updatedAt,
      },
      transitionServer: (serverId) => shutdownServer(serverId as unknown as number),
      serverActionLabel: "shutdown",
      instanceActionLabel: "soft-delete instance",
    });
  }

  static async restoreScheduledDeletions(userId: string) {
    if (!supabaseAdmin) return;
    const { powerOnServer } = await import("@/lib/hetzner/client");
    const updatedAt = new Date().toISOString();

    const { data: pendingInstances } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, name, host_id, hetzner_server_id, status, scheduled_deletion_at")
      .eq("user_id", userId)
      .eq("status", "scheduled_for_deletion");

    if (!pendingInstances || pendingInstances.length === 0) return;

    await this.updateInstancesConcurrently({
      instances: pendingInstances,
      update: {
        status: "running",
        scheduled_deletion_at: null,
        updated_at: updatedAt,
      },
      hostUpdate: {
        status: "running",
        updated_at: updatedAt,
      },
      transitionServer: (serverId) => powerOnServer(serverId as unknown as number),
      serverActionLabel: "power on",
      instanceActionLabel: "restore",
    });
  }

  /**
   * Suspend a user's instances when billing lapses (payment failed or
   * subscription canceled) WITHOUT arming a deletion fuse. This routes the
   * rows into the existing stale-suspended-sweep ladder (warning emails +
   * plan-aware grace, paying customers excluded) instead of the old behavior
   * that flipped them straight to scheduled_for_deletion with a 48h fuse — the
   * path that destroyed paying customers' data on a transient decline
   * (2026-05-22 incident). Mirrors the credit-based suspend shape written by
   * compute-billing.ts so a row is consistent across both billing systems.
   * Data is preserved: disk + chats + workspace volumes stay intact; any
   * eventual purge happens only via the laddered sweep with its warning emails.
   * Already-suspended rows are skipped so Stripe webhook redeliveries can't
   * reset the suspension clock and push the deletion deadline out forever.
   */
  static async suspendInstancesForBilling(
    userId: string,
    reason: "subscription_past_due" | "subscription_canceled"
  ) {
    if (!supabaseAdmin) return;
    const now = new Date().toISOString();

    // `status` must stay within the hermes_instances_status_check constraint
    // (provisioning/running/stopped/failed/error/deleted/redeploying/
    // scheduled_for_deletion) — "suspended" is a lifecycle_state, NOT a status.
    // Writing status:"suspended" violated the check constraint, the whole
    // UPDATE rolled back, and past-due/canceled users' instances silently kept
    // running (billing_suspend_failed, 5 users, 2026-06/07). "stopped" mirrors
    // the credit-based suspend shape (compute-billing.ts uses
    // buildInstanceLifecyclePatch("stopped") + lifecycle_state:"suspended").
    const { data: suspended, error } = await supabaseAdmin
      .from("hermes_instances")
      .update({
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_state: "suspended",
        entitlement_reason: reason,
        entitlement_suspended_at: now,
        last_lifecycle_transition_at: now,
        updated_at: now,
      })
      .eq("user_id", userId)
      .neq("lifecycle_state", "suspended")
      .not("lifecycle_state", "in", '("deleted","deleting")')
      .not("status", "in", '("deleted","scheduled_for_deletion")')
      .is("deleted_at", null)
      .select("id");

    if (error) {
      log.error("failed to suspend instances for billing", error, {
        source: LOG_SOURCE,
        failureType: "billing_suspend_failed",
        userId,
        reason,
      });
      return;
    }

    log.info("suspended instances for billing (no deletion fuse armed)", {
      source: LOG_SOURCE,
      userId,
      reason,
      count: suspended?.length ?? 0,
    });
  }

  /**
   * Resume instances that were suspended for a billing lapse, when payment
   * recovers (invoice.paid / subscription back to active). Complements
   * restoreScheduledDeletions, which only un-schedules rows already flipped to
   * scheduled_for_deletion. Scoped to billing-originated suspensions so we
   * never resurrect an instance the user themselves stopped.
   */
  static async resumeBillingSuspendedInstances(userId: string) {
    if (!supabaseAdmin) return;
    const now = new Date().toISOString();

    // Billing-suspend reasons we un-suspend on recovery. Includes
    // `subscription_grace_expired` — the state the dunning grace enforcer
    // leaves after it physically `qm shutdown`s a lapsed box — so a later
    // invoice.paid both un-suspends the row AND powers the VM back on.
    const BILLING_SUSPEND_REASONS = [
      "subscription_past_due",
      "subscription_canceled",
      "subscription_grace_expired",
    ];

    // Snapshot the rows (with infra) BEFORE the update flips their reason, so we
    // can power the VMs the enforcer stopped back on.
    const { data: toPowerOn } = await supabaseAdmin
      .from("hermes_instances")
      .select(
        "id, config, proxmox_node, proxmox_vmid, host_id, infrastructure_provider"
      )
      .eq("user_id", userId)
      .eq("lifecycle_state", "suspended")
      .in("entitlement_reason", BILLING_SUSPEND_REASONS)
      .is("deleted_at", null);

    const { data: resumed, error } = await supabaseAdmin
      .from("hermes_instances")
      .update({
        status: "running",
        lifecycle_state: "active",
        entitlement_state: "ok",
        entitlement_reason: "subscription_reactivated",
        entitlement_suspended_at: null,
        scheduled_deletion_at: null,
        paused_reason: null,
        last_lifecycle_transition_at: now,
        updated_at: now,
      })
      .eq("user_id", userId)
      .eq("lifecycle_state", "suspended")
      .in("entitlement_reason", BILLING_SUSPEND_REASONS)
      .is("deleted_at", null)
      .select("id");

    if (error) {
      log.error("failed to resume billing-suspended instances", error, {
        source: LOG_SOURCE,
        failureType: "billing_resume_failed",
        userId,
      });
      return;
    }

    if ((resumed?.length ?? 0) > 0) {
      log.info("resumed billing-suspended instances after payment recovered", {
        source: LOG_SOURCE,
        userId,
        count: resumed?.length ?? 0,
      });
      // Best-effort power-on. The DB already reflects restored entitlement; a
      // start failure must NOT fail the webhook (Stripe would redeliver and the
      // wake-on-access / resume-mispaused sweeps retry the physical start).
      await this.powerOnResumedInstances(userId, toPowerOn ?? []);
    }
  }

  /**
   * Physically start the Proxmox VMs the dunning grace enforcer shut down, once
   * payment recovers. Best-effort and isolated: a start that fails is logged but
   * never thrown, and non-Proxmox rows are skipped. Dynamic-imports the proxmox
   * service so the webhook path stays light when there's nothing to resume.
   */
  private static async powerOnResumedInstances(
    userId: string,
    rows: Array<{
      id: string;
      config: Record<string, unknown> | null;
      proxmox_node: string | null;
      proxmox_vmid: number | null;
      host_id: string | null;
      infrastructure_provider: string | null;
    }>
  ) {
    if (rows.length === 0) return;
    let mod: typeof import("@/lib/services/proxmox-instance-service");
    try {
      mod = await import("@/lib/services/proxmox-instance-service");
    } catch (err) {
      log.error("failed to load proxmox service for billing power-on", err, {
        source: LOG_SOURCE,
        failureType: "billing_power_on_import_failed",
        userId,
      });
      return;
    }

    for (const row of rows) {
      const infra =
        mod.getProxmoxInfrastructure(row.config) ??
        (row.proxmox_vmid && row.proxmox_node
          ? {
              provider: "proxmox" as const,
              node: row.proxmox_node,
              vmid: row.proxmox_vmid,
              privateIpv4: "",
              gatewayHost: "",
            }
          : null);
      if (!infra) continue; // Non-Proxmox (legacy Hetzner) — nothing to power on.

      try {
        const result = await mod.startProxmoxInstance(infra, {
          expectedInstanceId: row.id,
          hostConfig: mod.getProxmoxHostRoutingConfigFromInfrastructure(infra, {
            host_id: row.host_id,
          }),
          // onboot:1 — a resumed paying agent should survive host reboots.
          setOnboot: 1,
        });
        if (!result.ok && !mod.isProxmoxVmMissingResult(result)) {
          throw new Error(
            result.error || result.stderr || "qm start returned non-zero"
          );
        }
      } catch (err) {
        log.error("failed to power on resumed instance (best-effort)", err, {
          source: LOG_SOURCE,
          failureType: "billing_power_on_failed",
          userId,
          instanceId: row.id,
        });
      }
    }
  }

  static async handleInvoicePaid(invoice: Stripe.Invoice) {
    if (!supabaseAdmin) return;

    const subscriptionId = getInvoiceSubscriptionId(invoice);
    if (!subscriptionId) return;

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const userId = subscription.metadata?.user_id;
    const planKey = subscription.metadata?.plan as PlanKey | undefined;

    if (!userId) return;

    // A dunning email can collect an open invoice AFTER Stripe already
    // canceled the subscription. Blanket-writing status='active' here would
    // resurrect a canceled (or reconciler-reset free) row without a plan or
    // subscription id attached — the user paid but got nothing. Surface it for
    // manual reconciliation instead of half-activating.
    if (
      subscription.status === "canceled" ||
      subscription.status === "incomplete_expired"
    ) {
      log.error(
        "invoice.paid for a canceled subscription — manual reconciliation required",
        new Error("invoice paid after subscription cancellation"),
        {
          source: LOG_SOURCE,
          failureType: "invoice_paid_after_cancellation",
          subscriptionId,
          userId,
          invoiceId: invoice.id,
        }
      );
      return;
    }

    // A renewal's invoice.paid confirms the new cycle was paid. Advance the
    // stored period here too, so the dashboard doesn't keep rendering a stale
    // "renews on <past date>" when the matching customer.subscription.updated
    // event (the other place these fields are written) is delayed or dropped.
    // Conditional-set: never clobber the period with null on the rare invoice
    // whose subscription doesn't carry a period.
    const { periodStart, periodEnd } = getSubscriptionPeriod(subscription);

    await supabaseAdmin.from("hermes_subscriptions").update({
      status: "active",
      grace_period_ends_at: null,
      ...(periodStart
        ? { current_period_start: new Date(periodStart * 1000).toISOString() }
        : {}),
      ...(periodEnd
        ? { current_period_end: new Date(periodEnd * 1000).toISOString() }
        : {}),
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);

    await this.restoreScheduledDeletions(userId);
    await this.resumeBillingSuspendedInstances(userId);

    if (planKey && PLANS[planKey]) {
      await grantSubscriptionCycleCredits({
        userId,
        planKey,
        subscriptionId,
        periodStart,
        periodEnd,
      });
    }
  }

  static async handlePaymentFailed(invoice: Stripe.Invoice) {
    if (!supabaseAdmin) return;

    const subscriptionId = getInvoiceSubscriptionId(invoice);
    if (!subscriptionId) return;

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const userId = subscription.metadata?.user_id;

    if (!userId) return;

    // Final-retry cancellations emit invoice.payment_failed and
    // customer.subscription.deleted in the same second. When this handler runs
    // after the deleted one, the unconditional past_due write below used to
    // resurrect the just-canceled row into the subscription-state reconciler's
    // scan set, which then reset the payer to a free/active row with a nulled
    // subscription id (the 2026-06→07 ghost-payer cohort). The live retrieve
    // above already tells us the subscription is terminal — route through the
    // canonical cancel path instead of writing past_due.
    if (
      subscription.status === "canceled" ||
      subscription.status === "incomplete_expired"
    ) {
      await this.handleSubscriptionDeleted(subscription);
      return;
    }

    // Anchor the grace window to the FIRST failure, not every retry. Stripe
    // emits invoice.payment_failed on each smart-retry attempt (up to ~4 over
    // ~2 weeks); re-stamping grace_period_ends_at on every one would keep
    // pushing the 48h keep-alive out to the end of the retry window and defeat
    // the dunning cutoff the entitlement resolver enforces. Only set the anchor
    // when the row isn't already carrying a live grace timestamp; otherwise
    // preserve the existing one so the 48h clock runs from the first decline.
    const { data: existingSub } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("status, grace_period_ends_at")
      .eq("user_id", userId)
      .maybeSingle<{ status: string | null; grace_period_ends_at: string | null }>();

    const alreadyAnchored =
      existingSub?.status === "past_due" &&
      typeof existingSub.grace_period_ends_at === "string";

    const gracePeriodEnd = alreadyAnchored
      ? existingSub!.grace_period_ends_at!
      : new Date(Date.now() + TRIAL_GRACE_HOURS * 60 * 60 * 1000).toISOString();

    await supabaseAdmin.from("hermes_subscriptions").update({
      status: "past_due",
      grace_period_ends_at: gracePeriodEnd,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);

    // A failed invoice is often a transient decline; Stripe smart-retries over
    // the next several days. NEVER arm VM destruction here — suspend instead so
    // the data survives until either the retry succeeds (resume) or the
    // subscription truly terminates and the laddered sweep takes over. A user
    // still paid through another lane is not suspended at all.
    if (!(await this.findOtherLaneEntitlement(userId, "invoice_payment_failed"))) {
      if (isBillingLegacyHardDelete()) {
        await this.scheduleInstancesForDeletion(userId);
      } else {
        await this.suspendInstancesForBilling(userId, "subscription_past_due");
      }
    }

    // Dunning recovery email (flag-gated, at most once per invoice — see
    // lib/billing/dunning.ts). Isolated so an email-path throw can never fail
    // the webhook: a non-2xx here would make Stripe redeliver the event and
    // re-run the whole past-due path just because a nudge email hiccuped.
    try {
      await maybeSendPaymentFailedRecoveryEmail({ invoice, userId });
    } catch (err) {
      log.warn("payment-failed recovery email errored", {
        source: LOG_SOURCE,
        userId,
        invoiceId: invoice.id ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
