/**
 * Apple IAP webhook service — App Store Server Notifications V2 state machine.
 *
 * Mirrors the discipline of stripe-webhook-service.ts on a fully PARALLEL
 * lane (blueprint: workspace-cloud-billing-service): its own table
 * (apple_iap_subscriptions), its own idempotency ledger
 * (apple_webhook_events), and the same suspend-not-delete billing posture —
 * lapses route through StripeWebhookService.suspendInstancesForBilling /
 * resumeBillingSuspendedInstances (the shared instance-lifecycle helpers, NOT
 * the Stripe subscription machinery), never a deletion fuse.
 *
 * State machine (notification type → row transition → side effects):
 *
 *   SUBSCRIBED (INITIAL_BUY | RESUBSCRIBE)
 *       → status active|trialing, new period
 *       → grant cycle credits (idempotent per period) + applyTierChange
 *         + restore/resume suspended instances
 *   DID_RENEW (incl. BILLING_RECOVERY)
 *       → advance period, status active
 *       → same activation side effects
 *   DID_CHANGE_RENEWAL_PREF (UPGRADE)
 *       → immediate plan change (Apple applies upgrades instantly)
 *       → same activation side effects (credit grant dedupes per period)
 *   DID_CHANGE_RENEWAL_STATUS (AUTO_RENEW_DISABLED / AUTO_RENEW_ENABLED)
 *       → cancel_at_period_end true/false — access untouched, nothing revoked
 *   DID_FAIL_TO_RENEW (GRACE_PERIOD)
 *       → status grace_period, period end pushed to gracePeriodExpiresDate —
 *         ACCESS KEPT (resolver honors grace_period)
 *   DID_FAIL_TO_RENEW (no subtype — billing retry without grace)
 *       → status past_due — access DENIED by the resolver, but instances are
 *         NOT suspended (EXPIRED is the suspension trigger)
 *   EXPIRED / GRACE_PERIOD_EXPIRED
 *       → status expired
 *       → suspendInstancesForBilling + tier downgrade to credit_base — unless
 *         another paid entitlement (Stripe/token) still covers the user
 *   REFUND / REVOKE
 *       → status revoked, immediately
 *       → same suspension path (with the same cross-lane guard)
 *   REFUND_REVERSED
 *       → re-activate when the transaction still has time left; otherwise
 *         converge to expired
 *   TEST
 *       → log + ack
 *   anything else
 *       → log + ack (no-op; the reconciler converges real state)
 */

import type {
  JWSRenewalInfoDecodedPayload,
  JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload,
  SignedDataVerifier,
} from "@apple/app-store-server-library";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { grantSubscriptionCycleCredits } from "@/lib/billing/credits";
import {
  appleSandboxFallbackEnabled,
  getAppleEnvironment,
  planFromAppleProductId,
  type AppleEnvironment,
  type AppleSubscriptionStatus,
} from "@/lib/billing/apple-products";
import { getAppleSignedDataVerifier } from "@/lib/billing/apple-verifier";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";

const LOG_SOURCE = "apple-webhook-service";

/** Decoded + verified notification context the state machine consumes. */
export interface AppleNotificationContext {
  notificationType: string;
  subtype: string | null;
  notificationUUID: string | null;
  environment: AppleEnvironment;
  transaction: JWSTransactionDecodedPayload | null;
  renewalInfo: JWSRenewalInfoDecodedPayload | null;
}

export interface AppleNotificationOutcome {
  action:
    | "activated"
    | "renewal_status_updated"
    | "grace_period"
    | "billing_retry"
    | "expired"
    | "revoked"
    | "reinstated"
    | "test_acknowledged"
    | "ignored"
    | "skipped_stale";
  userId?: string;
}

interface AppleSubscriptionRow {
  user_id: string;
  apple_original_transaction_id: string;
  product_id: string;
  plan: string;
  status: AppleSubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

function msToIso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

function requireDb() {
  if (!supabaseAdmin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY not configured - cannot process Apple notification"
    );
  }
  return supabaseAdmin;
}

export class AppleWebhookService {
  /**
   * Verify the outer signedPayload with the primary (env-selected) verifier.
   * When the primary environment rejects it and the sandbox fallback is
   * enabled, retry with the Sandbox verifier — Apple posts sandbox-signed
   * notifications (TestFlight, App Review purchases) to the same endpoint.
   */
  static async verifyNotification(signedPayload: string): Promise<{
    payload: ResponseBodyV2DecodedPayload;
    environment: AppleEnvironment;
    verifier: SignedDataVerifier;
  }> {
    const primaryEnvironment = getAppleEnvironment();
    const primaryVerifier = getAppleSignedDataVerifier(primaryEnvironment);
    try {
      const payload = await primaryVerifier.verifyAndDecodeNotification(signedPayload);
      return { payload, environment: primaryEnvironment, verifier: primaryVerifier };
    } catch (primaryError) {
      if (primaryEnvironment === "Production" && appleSandboxFallbackEnabled()) {
        const sandboxVerifier = getAppleSignedDataVerifier("Sandbox");
        try {
          const payload = await sandboxVerifier.verifyAndDecodeNotification(signedPayload);
          log.info("apple notification verified via sandbox fallback", {
            source: LOG_SOURCE,
            notificationType: payload.notificationType ?? null,
          });
          return { payload, environment: "Sandbox", verifier: sandboxVerifier };
        } catch {
          // fall through to the primary error — it names the real environment.
        }
      }
      throw primaryError;
    }
  }

  /**
   * Verify a bare signed transaction JWS (StoreKit 2 jwsRepresentation) —
   * the /api/mobile/iap/attach input. Same primary-then-sandbox-fallback
   * environment selection as verifyNotification.
   */
  static async verifyTransaction(signedTransaction: string): Promise<{
    transaction: JWSTransactionDecodedPayload;
    environment: AppleEnvironment;
  }> {
    const primaryEnvironment = getAppleEnvironment();
    const primaryVerifier = getAppleSignedDataVerifier(primaryEnvironment);
    try {
      const transaction =
        await primaryVerifier.verifyAndDecodeTransaction(signedTransaction);
      return { transaction, environment: primaryEnvironment };
    } catch (primaryError) {
      if (primaryEnvironment === "Production" && appleSandboxFallbackEnabled()) {
        const sandboxVerifier = getAppleSignedDataVerifier("Sandbox");
        try {
          const transaction =
            await sandboxVerifier.verifyAndDecodeTransaction(signedTransaction);
          return { transaction, environment: "Sandbox" };
        } catch {
          // fall through to the primary error.
        }
      }
      throw primaryError;
    }
  }

  /** Decode the inner signed transaction / renewal info JWS payloads. */
  static async decodeNotificationData(
    payload: ResponseBodyV2DecodedPayload,
    environment: AppleEnvironment,
    verifier: SignedDataVerifier
  ): Promise<AppleNotificationContext> {
    const data = payload.data;
    const transaction = data?.signedTransactionInfo
      ? await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo)
      : null;
    const renewalInfo = data?.signedRenewalInfo
      ? await verifier.verifyAndDecodeRenewalInfo(data.signedRenewalInfo)
      : null;

    return {
      notificationType: String(payload.notificationType ?? ""),
      subtype: payload.subtype ? String(payload.subtype) : null,
      notificationUUID: payload.notificationUUID ?? null,
      environment,
      transaction,
      renewalInfo,
    };
  }

  /**
   * appAccountToken → user (primary), original transaction id → existing row
   * (fallback for pre-attach purchases / family sharing). Null when unmapped —
   * the caller throws so Apple redelivers, giving /api/mobile/iap/attach time
   * to bind the transaction.
   */
  static async resolveUserForTransaction(
    transaction: JWSTransactionDecodedPayload
  ): Promise<string | null> {
    const db = requireDb();

    if (transaction.appAccountToken) {
      const { data: tokenRow } = await db
        .from("apple_iap_account_tokens")
        .select("user_id")
        .eq("token", transaction.appAccountToken)
        .maybeSingle<{ user_id: string }>();
      if (tokenRow?.user_id) return tokenRow.user_id;
    }

    if (transaction.originalTransactionId) {
      const { data: subRow } = await db
        .from("apple_iap_subscriptions")
        .select("user_id")
        .eq("apple_original_transaction_id", transaction.originalTransactionId)
        .maybeSingle<{ user_id: string }>();
      if (subRow?.user_id) return subRow.user_id;
    }

    return null;
  }

  /** Mint (or return) the server-side appAccountToken for a user. */
  static async ensureAppleAccountToken(userId: string): Promise<string> {
    const db = requireDb();

    const { data: existing } = await db
      .from("apple_iap_account_tokens")
      .select("token")
      .eq("user_id", userId)
      .maybeSingle<{ token: string }>();
    if (existing?.token) return existing.token;

    const token =
      globalThis.crypto?.randomUUID?.() ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require("crypto") as typeof import("crypto")).randomUUID();

    const { error } = await db
      .from("apple_iap_account_tokens")
      .insert({ user_id: userId, token });

    if (error) {
      // 23505 = a concurrent mint won; read it back.
      if (error.code === "23505") {
        const { data: raced } = await db
          .from("apple_iap_account_tokens")
          .select("token")
          .eq("user_id", userId)
          .maybeSingle<{ token: string }>();
        if (raced?.token) return raced.token;
      }
      throw new Error(error.message || "Failed to mint Apple account token");
    }

    return token;
  }

  private static async getRowForUser(
    userId: string
  ): Promise<AppleSubscriptionRow | null> {
    const db = requireDb();
    const { data } = await db
      .from("apple_iap_subscriptions")
      .select(
        "user_id, apple_original_transaction_id, product_id, plan, status, current_period_start, current_period_end, cancel_at_period_end"
      )
      .eq("user_id", userId)
      .maybeSingle<AppleSubscriptionRow>();
    return data ?? null;
  }

  private static async writeRow(
    userId: string,
    fields: Record<string, unknown>,
    notificationType: string
  ): Promise<void> {
    const db = requireDb();
    const now = new Date().toISOString();
    const { error } = await db.from("apple_iap_subscriptions").upsert(
      {
        user_id: userId,
        ...fields,
        last_notification_type: notificationType,
        last_notification_at: now,
        updated_at: now,
      },
      { onConflict: "user_id" }
    );
    if (error) {
      // Includes the apple_original_transaction_id unique violation — a
      // transaction already bound to ANOTHER user. Loud failure: Apple
      // retries, ops sees the failed event row. Never silently rebind.
      throw new Error(error.message || "Failed to upsert apple_iap_subscriptions row");
    }
  }

  private static async updateExistingRow(
    userId: string,
    fields: Record<string, unknown>,
    notificationType: string
  ): Promise<boolean> {
    const db = requireDb();
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("apple_iap_subscriptions")
      .update({
        ...fields,
        last_notification_type: notificationType,
        last_notification_at: now,
        updated_at: now,
      })
      .eq("user_id", userId)
      .select("user_id");
    if (error) {
      throw new Error(error.message || "Failed to update apple_iap_subscriptions row");
    }
    return (data?.length ?? 0) > 0;
  }

  /**
   * True when the incoming transaction is an out-of-order replay of an older
   * cycle: same Apple subscription, but the stored period already ends after
   * the incoming one. Prevents a delayed SUBSCRIBED/DID_RENEW redelivery from
   * rolling the row backwards.
   */
  private static isStaleTransaction(
    existing: AppleSubscriptionRow | null,
    transaction: JWSTransactionDecodedPayload
  ): boolean {
    if (!existing || !existing.current_period_end) return false;
    if (
      existing.apple_original_transaction_id !==
      transaction.originalTransactionId
    ) {
      return false;
    }
    const incomingEnd = transaction.expiresDate;
    if (typeof incomingEnd !== "number") return false;
    return new Date(existing.current_period_end).getTime() > incomingEnd;
  }

  /**
   * Activation path shared by SUBSCRIBED, DID_RENEW, upgrade, refund-reversal
   * and the reconciler's ACTIVE convergence: write the row, grant the cycle's
   * credits (idempotent), apply the tier, and lift any billing suspension.
   */
  static async activateFromTransaction(params: {
    userId: string;
    transaction: JWSTransactionDecodedPayload;
    renewalInfo: JWSRenewalInfoDecodedPayload | null;
    environment: AppleEnvironment;
    notificationType: string;
  }): Promise<AppleNotificationOutcome> {
    const { userId, transaction, renewalInfo, environment, notificationType } = params;

    const originalTransactionId = transaction.originalTransactionId;
    if (!originalTransactionId) {
      throw new Error("Apple transaction is missing originalTransactionId");
    }

    const planKey = planFromAppleProductId(transaction.productId);
    if (!planKey) {
      // Never guess a plan. Throwing makes Apple redeliver and lands the
      // event in the failed ledger where ops can see the unknown product.
      throw new Error(
        `Unknown Apple product id "${transaction.productId ?? "<missing>"}" — no plan mapping configured`
      );
    }

    const existing = await this.getRowForUser(userId);
    if (this.isStaleTransaction(existing, transaction)) {
      log.warn("skipping stale apple transaction (older period than stored row)", {
        source: LOG_SOURCE,
        failureType: "apple_stale_transaction_skipped",
        userId,
        notificationType,
        originalTransactionId,
      });
      return { action: "skipped_stale", userId };
    }

    const isTrial = transaction.offerDiscountType === "FREE_TRIAL";
    const status: AppleSubscriptionStatus = isTrial ? "trialing" : "active";
    const periodStartIso = msToIso(transaction.purchaseDate);
    const periodEndIso = msToIso(transaction.expiresDate);
    const cancelAtPeriodEnd = renewalInfo ? renewalInfo.autoRenewStatus === 0 : false;

    await this.writeRow(
      userId,
      {
        apple_original_transaction_id: originalTransactionId,
        product_id: transaction.productId,
        plan: planKey,
        status,
        current_period_start: periodStartIso,
        current_period_end: periodEndIso,
        cancel_at_period_end: cancelAtPeriodEnd,
        app_account_token: transaction.appAccountToken ?? null,
        environment,
      },
      notificationType
    );

    // Cycle credit grant — idempotent on
    // apple_subscription:<originalTransactionId>:<periodStart>:<periodEnd>,
    // so redeliveries and reconciler convergence can never double-grant.
    await grantSubscriptionCycleCredits({
      userId,
      planKey,
      subscriptionId: originalTransactionId,
      periodStart: transaction.purchaseDate,
      periodEnd: transaction.expiresDate,
      source: "apple",
      actor: "apple_webhook",
      referencePrefix: "apple_subscription",
    });

    // Same tier machinery as the Stripe activation path. Failures never roll
    // back the subscription write (mirrors stripe-webhook-service).
    try {
      const { applyTierChange } = await import("@/lib/services/tier-change-service");
      const { tierFromPlanKey } = await import("@/lib/services/tier-specs");
      await applyTierChange({
        userId,
        newTier: tierFromPlanKey(planKey),
        source: "apple_iap",
        reason: `apple ${notificationType} (${planKey})`,
      });
    } catch (err) {
      log.error("applyTierChange failed for apple activation", err, {
        source: LOG_SOURCE,
        failureType: "apple_tier_change_failed",
        userId,
        originalTransactionId,
      });
    }

    // Recover anything a previous lapse parked — the exact helpers the Stripe
    // active path uses (suspend-not-delete's other half).
    await StripeWebhookService.restoreScheduledDeletions(userId);
    await StripeWebhookService.resumeBillingSuspendedInstances(userId);

    return { action: "activated", userId };
  }

  /**
   * Cross-lane guard for lapse handling: only suspend/downgrade when the user
   * has no OTHER live paid entitlement (Stripe, yearly token, token holding).
   * The apple row is already terminal at call time, so the resolver returning
   * a seat-granting entitlement means another lane still covers the user —
   * touching their instances would enforce Apple's lapse against someone who
   * is still paying elsewhere (the standing "verify before destructive
   * billing action" rule).
   */
  private static async suspendUnlessOtherEntitlement(
    userId: string,
    notificationType: string
  ): Promise<void> {
    try {
      const { resolveEffectiveSubscription } = await import(
        "@/lib/billing/instance-entitlement"
      );
      const remaining = await resolveEffectiveSubscription(userId);
      if (
        remaining &&
        remaining.source !== "free" &&
        remaining.instance_limit > 0
      ) {
        log.info("apple lapse: user retains another paid entitlement — skipping suspension", {
          source: LOG_SOURCE,
          userId,
          notificationType,
          remainingSource: remaining.source,
        });
        return;
      }
    } catch (err) {
      // Resolver hiccup: fail toward NOT destroying access. The reconciler
      // and the next notification get another chance.
      log.error("apple lapse entitlement cross-check failed — skipping suspension", err, {
        source: LOG_SOURCE,
        failureType: "apple_lapse_crosscheck_failed",
        userId,
        notificationType,
      });
      return;
    }

    await StripeWebhookService.suspendInstancesForBilling(
      userId,
      "subscription_canceled"
    );

    try {
      const { applyTierChange } = await import("@/lib/services/tier-change-service");
      await applyTierChange({
        userId,
        newTier: "credit_base",
        source: "apple_iap",
        reason: `apple ${notificationType}`,
      });
    } catch (err) {
      log.error("tier downgrade on apple lapse failed", err, {
        source: LOG_SOURCE,
        failureType: "apple_lapse_tier_downgrade_failed",
        userId,
        notificationType,
      });
    }
  }

  static async expireSubscription(
    userId: string,
    notificationType: string
  ): Promise<AppleNotificationOutcome> {
    await this.updateExistingRow(userId, { status: "expired" }, notificationType);
    await this.suspendUnlessOtherEntitlement(userId, notificationType);
    return { action: "expired", userId };
  }

  static async revokeSubscription(
    userId: string,
    notificationType: string
  ): Promise<AppleNotificationOutcome> {
    await this.updateExistingRow(userId, { status: "revoked" }, notificationType);
    await this.suspendUnlessOtherEntitlement(userId, notificationType);
    return { action: "revoked", userId };
  }

  static async markGracePeriod(params: {
    userId: string;
    renewalInfo: JWSRenewalInfoDecodedPayload | null;
    notificationType: string;
  }): Promise<AppleNotificationOutcome> {
    const gracePeriodEndsIso = msToIso(params.renewalInfo?.gracePeriodExpiresDate);
    await this.updateExistingRow(
      params.userId,
      {
        status: "grace_period",
        // Access runs through the grace window; keep currentPeriodEnd honest
        // so "Renews on …" shows when access actually lapses.
        ...(gracePeriodEndsIso ? { current_period_end: gracePeriodEndsIso } : {}),
      },
      params.notificationType
    );
    return { action: "grace_period", userId: params.userId };
  }

  static async markBillingRetry(
    userId: string,
    notificationType: string
  ): Promise<AppleNotificationOutcome> {
    await this.updateExistingRow(userId, { status: "past_due" }, notificationType);
    return { action: "billing_retry", userId };
  }

  /** The notification state machine. */
  static async handleNotification(
    ctx: AppleNotificationContext
  ): Promise<AppleNotificationOutcome> {
    const { notificationType, subtype, transaction, renewalInfo, environment } = ctx;

    if (notificationType === "TEST") {
      log.info("apple TEST notification received", {
        source: LOG_SOURCE,
        environment,
      });
      return { action: "test_acknowledged" };
    }

    if (!transaction) {
      // Notification families without transaction data that we don't act on.
      log.info("apple notification without transaction data — ignoring", {
        source: LOG_SOURCE,
        notificationType,
        subtype,
      });
      return { action: "ignored" };
    }

    const userId = await this.resolveUserForTransaction(transaction);
    if (!userId) {
      // Unmapped purchase: no appAccountToken match, no attached row yet.
      // Throw so Apple redelivers — the app POSTs /api/mobile/iap/attach right
      // after purchase, so by the next delivery the binding usually exists.
      throw new Error(
        `No user mapping for apple transaction ${transaction.originalTransactionId ?? "<unknown>"} (${notificationType})`
      );
    }

    switch (notificationType) {
      case "SUBSCRIBED":
        // Subtypes INITIAL_BUY / RESUBSCRIBE both activate.
        return this.activateFromTransaction({
          userId,
          transaction,
          renewalInfo,
          environment,
          notificationType,
        });

      case "DID_RENEW":
        // Subtype BILLING_RECOVERY included — recovery IS a renewal.
        return this.activateFromTransaction({
          userId,
          transaction,
          renewalInfo,
          environment,
          notificationType,
        });

      case "DID_CHANGE_RENEWAL_PREF": {
        if (subtype === "UPGRADE") {
          // Upgrades apply immediately (Apple starts the new product now).
          return this.activateFromTransaction({
            userId,
            transaction,
            renewalInfo,
            environment,
            notificationType,
          });
        }
        // DOWNGRADE (takes effect at next renewal — DID_RENEW carries the new
        // product then) and pref reverts: nothing to do now.
        log.info("apple renewal-pref change deferred to next renewal", {
          source: LOG_SOURCE,
          userId,
          subtype,
        });
        return { action: "ignored", userId };
      }

      case "DID_CHANGE_RENEWAL_STATUS": {
        const disabled = subtype === "AUTO_RENEW_DISABLED";
        const enabled = subtype === "AUTO_RENEW_ENABLED";
        if (!disabled && !enabled) {
          return { action: "ignored", userId };
        }
        // Cancellation is cancel-at-period-end, NEVER an access revoke —
        // the user stays entitled until EXPIRED arrives.
        await this.updateExistingRow(
          userId,
          { cancel_at_period_end: disabled },
          notificationType
        );
        return { action: "renewal_status_updated", userId };
      }

      case "DID_FAIL_TO_RENEW":
        if (subtype === "GRACE_PERIOD") {
          return this.markGracePeriod({ userId, renewalInfo, notificationType });
        }
        return this.markBillingRetry(userId, notificationType);

      case "EXPIRED":
      case "GRACE_PERIOD_EXPIRED":
        return this.expireSubscription(userId, notificationType);

      case "REFUND":
      case "REVOKE":
        return this.revokeSubscription(userId, notificationType);

      case "REFUND_REVERSED": {
        const expiresMs = transaction.expiresDate;
        if (typeof expiresMs === "number" && expiresMs > Date.now()) {
          const outcome = await this.activateFromTransaction({
            userId,
            transaction,
            renewalInfo,
            environment,
            notificationType,
          });
          return outcome.action === "activated"
            ? { action: "reinstated", userId }
            : outcome;
        }
        // Refund reversed on an already-lapsed period: converge to expired
        // without re-suspending (the refund already suspended).
        await this.updateExistingRow(userId, { status: "expired" }, notificationType);
        return { action: "expired", userId };
      }

      default:
        log.info("apple notification type not handled — acknowledging", {
          source: LOG_SOURCE,
          notificationType,
          subtype,
          userId,
        });
        return { action: "ignored", userId };
    }
  }
}
