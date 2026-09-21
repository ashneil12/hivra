import {
  AppleWebhookService,
  type AppleNotificationContext,
} from "@/lib/services/apple-webhook-service";
import { supabaseAdmin } from "@/lib/supabase";
import { grantSubscriptionCycleCredits } from "@/lib/billing/credits";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import { applyTierChange } from "@/lib/services/tier-change-service";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { getAppleSignedDataVerifier } from "@/lib/billing/apple-verifier";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/billing/credits", () => ({
  grantSubscriptionCycleCredits: jest
    .fn()
    .mockResolvedValue({ inserted: true, balance: 1099 }),
}));

jest.mock("@/lib/services/stripe-webhook-service", () => ({
  StripeWebhookService: {
    suspendInstancesForBilling: jest.fn().mockResolvedValue(undefined),
    resumeBillingSuspendedInstances: jest.fn().mockResolvedValue(undefined),
    restoreScheduledDeletions: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/lib/services/tier-change-service", () => ({
  applyTierChange: jest.fn().mockResolvedValue({
    userId: "user_1",
    newTier: "operator",
    instancesUpdated: 0,
    resizesAttempted: 0,
    resizesSucceeded: 0,
    resizesFailed: [],
  }),
}));

jest.mock("@/lib/services/tier-specs", () => ({
  tierFromPlanKey: jest.fn((planKey: string) => planKey),
}));

jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/billing/apple-verifier", () => ({
  getAppleSignedDataVerifier: jest.fn(),
  getAppStoreServerAPIClient: jest.fn(),
}));

const fromMock = supabaseAdmin!.from as jest.Mock;
const grantMock = grantSubscriptionCycleCredits as jest.Mock;
const suspendMock = StripeWebhookService.suspendInstancesForBilling as jest.Mock;
const resumeMock = StripeWebhookService.resumeBillingSuspendedInstances as jest.Mock;
const restoreMock = StripeWebhookService.restoreScheduledDeletions as jest.Mock;
const applyTierMock = applyTierChange as jest.Mock;
const resolveMock = resolveEffectiveSubscription as jest.Mock;
const getVerifierMock = getAppleSignedDataVerifier as jest.Mock;

interface DbState {
  tokenUser?: string | null;
  rowByOriginalTxn?: { user_id: string } | null;
  rowForUser?: Record<string, unknown> | null;
}

/**
 * Table-routed supabase mock recording every apple_iap_subscriptions write.
 */
function mockDb(state: DbState = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const tokenInserts: Array<Record<string, unknown>> = [];

  fromMock.mockImplementation((table: string) => {
    if (table === "apple_iap_account_tokens") {
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: state.tokenUser ? { user_id: state.tokenUser, token: "tok" } : null,
          error: null,
        }),
        insert: jest.fn((row: Record<string, unknown>) => {
          tokenInserts.push(row);
          return Promise.resolve({ error: null });
        }),
      };
    }
    if (table === "apple_iap_subscriptions") {
      let eqColumn: string | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: jest.fn(() => builder),
        eq: jest.fn((column: string) => {
          eqColumn = column;
          return builder;
        }),
        maybeSingle: jest.fn(async () => {
          if (eqColumn === "apple_original_transaction_id") {
            return { data: state.rowByOriginalTxn ?? null, error: null };
          }
          return { data: state.rowForUser ?? null, error: null };
        }),
        upsert: jest.fn((row: Record<string, unknown>) => {
          upserts.push(row);
          return Promise.resolve({ error: null });
        }),
        update: jest.fn((patch: Record<string, unknown>) => {
          updates.push(patch);
          return {
            eq: jest.fn().mockReturnValue({
              select: jest
                .fn()
                .mockResolvedValue({ data: [{ user_id: "user_1" }], error: null }),
            }),
          };
        }),
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  return { upserts, updates, tokenInserts };
}

const FUTURE_MS = Date.now() + 30 * 24 * 60 * 60 * 1000;

function txn(overrides: Record<string, unknown> = {}) {
  return {
    originalTransactionId: "2000000123456789",
    transactionId: "2000000123456790",
    productId: "cloud.hivra.pro.monthly",
    purchaseDate: 1_752_600_000_000,
    expiresDate: 1_755_278_400_000,
    appAccountToken: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ...overrides,
  };
}

function ctx(
  notificationType: string,
  subtype: string | null = null,
  transaction: Record<string, unknown> | null = txn(),
  renewalInfo: Record<string, unknown> | null = null
): AppleNotificationContext {
  return {
    notificationType,
    subtype,
    notificationUUID: "uuid-1",
    environment: "Production",
    transaction,
    renewalInfo,
  } as unknown as AppleNotificationContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveMock.mockResolvedValue(null);
  delete process.env.APPLE_ENVIRONMENT;
  delete process.env.APPLE_ACCEPT_SANDBOX_NOTIFICATIONS;
});

describe("AppleWebhookService.handleNotification — state machine", () => {
  it("SUBSCRIBED (INITIAL_BUY): activates, grants credits, applies tier, resumes instances", async () => {
    const { upserts } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("SUBSCRIBED", "INITIAL_BUY")
    );

    expect(outcome).toEqual({ action: "activated", userId: "user_1" });

    expect(upserts).toHaveLength(1);
    const row = upserts[0];
    expect(row.user_id).toBe("user_1");
    expect(row.apple_original_transaction_id).toBe("2000000123456789");
    expect(row.plan).toBe("operator");
    expect(row.status).toBe("active");
    expect(row.cancel_at_period_end).toBe(false);
    expect(row.environment).toBe("Production");
    expect(row.current_period_start).toBe(
      new Date(1_752_600_000_000).toISOString()
    );
    expect(row.current_period_end).toBe(
      new Date(1_755_278_400_000).toISOString()
    );

    expect(grantMock).toHaveBeenCalledWith({
      userId: "user_1",
      planKey: "operator",
      subscriptionId: "2000000123456789",
      periodStart: 1_752_600_000_000,
      periodEnd: 1_755_278_400_000,
      source: "apple",
      actor: "apple_webhook",
      referencePrefix: "apple_subscription",
    });

    expect(applyTierMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        newTier: "operator",
        source: "apple_iap",
      })
    );
    expect(restoreMock).toHaveBeenCalledWith("user_1");
    expect(resumeMock).toHaveBeenCalledWith("user_1");
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it("SUBSCRIBED with a free-trial offer records status trialing", async () => {
    const { upserts } = mockDb({ tokenUser: "user_1" });

    await AppleWebhookService.handleNotification(
      ctx("SUBSCRIBED", "INITIAL_BUY", txn({ offerDiscountType: "FREE_TRIAL" }))
    );

    expect(upserts[0].status).toBe("trialing");
  });

  it("SUBSCRIBED maps power products to the fleet plan", async () => {
    const { upserts } = mockDb({ tokenUser: "user_1" });

    await AppleWebhookService.handleNotification(
      ctx("SUBSCRIBED", "INITIAL_BUY", txn({ productId: "cloud.hivra.power.monthly" }))
    );

    expect(upserts[0].plan).toBe("fleet");
    expect(applyTierMock).toHaveBeenCalledWith(
      expect.objectContaining({ newTier: "fleet" })
    );
  });

  it("DID_RENEW advances the period and re-grants credits (BILLING_RECOVERY included)", async () => {
    const { upserts } = mockDb({
      tokenUser: "user_1",
      rowForUser: {
        user_id: "user_1",
        apple_original_transaction_id: "2000000123456789",
        current_period_end: "2025-08-15T18:40:00.000Z",
      },
    });

    const renewed = txn({
      purchaseDate: 1_755_278_400_000,
      expiresDate: 1_757_956_800_000,
    });
    const outcome = await AppleWebhookService.handleNotification(
      ctx("DID_RENEW", "BILLING_RECOVERY", renewed, { autoRenewStatus: 1 })
    );

    expect(outcome.action).toBe("activated");
    expect(upserts[0].current_period_end).toBe(
      new Date(1_757_956_800_000).toISOString()
    );
    expect(upserts[0].status).toBe("active");
    expect(grantMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledWith("user_1");
  });

  it("skips a stale out-of-order transaction without granting credits", async () => {
    const { upserts } = mockDb({
      tokenUser: "user_1",
      rowForUser: {
        user_id: "user_1",
        apple_original_transaction_id: "2000000123456789",
        // Stored period ends AFTER the incoming transaction's expiry.
        current_period_end: "2025-12-31T00:00:00.000Z",
      },
    });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("DID_RENEW", null)
    );

    expect(outcome).toEqual({ action: "skipped_stale", userId: "user_1" });
    expect(upserts).toHaveLength(0);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it("DID_CHANGE_RENEWAL_STATUS (AUTO_RENEW_DISABLED) sets cancel_at_period_end and revokes nothing", async () => {
    const { updates, upserts } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED")
    );

    expect(outcome.action).toBe("renewal_status_updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].cancel_at_period_end).toBe(true);
    expect(updates[0].status).toBeUndefined();
    expect(upserts).toHaveLength(0);
    expect(suspendMock).not.toHaveBeenCalled();
    expect(grantMock).not.toHaveBeenCalled();
  });

  it("DID_CHANGE_RENEWAL_STATUS (AUTO_RENEW_ENABLED) clears cancel_at_period_end", async () => {
    const { updates } = mockDb({ tokenUser: "user_1" });

    await AppleWebhookService.handleNotification(
      ctx("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_ENABLED")
    );

    expect(updates[0].cancel_at_period_end).toBe(false);
  });

  it("DID_FAIL_TO_RENEW (GRACE_PERIOD) keeps access: status grace_period + extended period end", async () => {
    const { updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("DID_FAIL_TO_RENEW", "GRACE_PERIOD", txn(), {
        gracePeriodExpiresDate: 1_756_000_000_000,
      })
    );

    expect(outcome.action).toBe("grace_period");
    expect(updates[0].status).toBe("grace_period");
    expect(updates[0].current_period_end).toBe(
      new Date(1_756_000_000_000).toISOString()
    );
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it("DID_FAIL_TO_RENEW without grace marks past_due and does NOT suspend (EXPIRED owns that)", async () => {
    const { updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("DID_FAIL_TO_RENEW", null)
    );

    expect(outcome.action).toBe("billing_retry");
    expect(updates[0].status).toBe("past_due");
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it("EXPIRED marks the row expired, suspends instances and downgrades the tier", async () => {
    const { updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("EXPIRED", "VOLUNTARY")
    );

    expect(outcome.action).toBe("expired");
    expect(updates[0].status).toBe("expired");
    expect(suspendMock).toHaveBeenCalledWith("user_1", "subscription_canceled");
    expect(applyTierMock).toHaveBeenCalledWith(
      expect.objectContaining({ newTier: "credit_base", source: "apple_iap" })
    );
  });

  it("GRACE_PERIOD_EXPIRED behaves exactly like EXPIRED", async () => {
    const { updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("GRACE_PERIOD_EXPIRED", null)
    );

    expect(outcome.action).toBe("expired");
    expect(updates[0].status).toBe("expired");
    expect(suspendMock).toHaveBeenCalledWith("user_1", "subscription_canceled");
  });

  it("EXPIRED does NOT suspend when another paid entitlement still covers the user", async () => {
    mockDb({ tokenUser: "user_1" });
    resolveMock.mockResolvedValue({
      plan: "operator",
      status: "active",
      instance_limit: 3,
      total_cpu_budget: 2,
      total_ram_budget: 4096,
      source: "stripe",
      canChangePlanInPlace: true,
    });

    await AppleWebhookService.handleNotification(ctx("EXPIRED", "VOLUNTARY"));

    expect(suspendMock).not.toHaveBeenCalled();
    expect(applyTierMock).not.toHaveBeenCalled();
  });

  it("EXPIRED fails toward NOT suspending when the entitlement cross-check errors", async () => {
    mockDb({ tokenUser: "user_1" });
    resolveMock.mockRejectedValue(new Error("db down"));

    const outcome = await AppleWebhookService.handleNotification(
      ctx("EXPIRED", "BILLING_RETRY")
    );

    expect(outcome.action).toBe("expired");
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it("REFUND revokes immediately and suspends", async () => {
    const { updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(ctx("REFUND", null));

    expect(outcome.action).toBe("revoked");
    expect(updates[0].status).toBe("revoked");
    expect(suspendMock).toHaveBeenCalledWith("user_1", "subscription_canceled");
  });

  it("REVOKE (family sharing) revokes immediately and suspends", async () => {
    const { updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(ctx("REVOKE", null));

    expect(outcome.action).toBe("revoked");
    expect(updates[0].status).toBe("revoked");
    expect(suspendMock).toHaveBeenCalledWith("user_1", "subscription_canceled");
  });

  it("REFUND_REVERSED with remaining time re-activates the subscription", async () => {
    const { upserts } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("REFUND_REVERSED", null, txn({ expiresDate: FUTURE_MS }))
    );

    expect(outcome.action).toBe("reinstated");
    expect(upserts[0].status).toBe("active");
    expect(resumeMock).toHaveBeenCalledWith("user_1");
  });

  it("REFUND_REVERSED on a lapsed period converges to expired without re-suspending", async () => {
    const { updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("REFUND_REVERSED", null, txn({ expiresDate: Date.now() - 1000 }))
    );

    expect(outcome.action).toBe("expired");
    expect(updates[0].status).toBe("expired");
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it("TEST acknowledges without touching the DB", async () => {
    mockDb({});

    const outcome = await AppleWebhookService.handleNotification(
      ctx("TEST", null, null)
    );

    expect(outcome.action).toBe("test_acknowledged");
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("unknown notification types are acknowledged as no-ops", async () => {
    const { upserts, updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("PRICE_INCREASE", "PENDING")
    );

    expect(outcome.action).toBe("ignored");
    expect(upserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("DID_CHANGE_RENEWAL_PREF (UPGRADE) applies the new plan immediately", async () => {
    const { upserts } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("DID_CHANGE_RENEWAL_PREF", "UPGRADE", txn({ productId: "cloud.hivra.power.monthly" }))
    );

    expect(outcome.action).toBe("activated");
    expect(upserts[0].plan).toBe("fleet");
  });

  it("DID_CHANGE_RENEWAL_PREF (DOWNGRADE) defers to the next renewal", async () => {
    const { upserts, updates } = mockDb({ tokenUser: "user_1" });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("DID_CHANGE_RENEWAL_PREF", "DOWNGRADE")
    );

    expect(outcome.action).toBe("ignored");
    expect(upserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("throws (so Apple redelivers) when no user mapping exists yet", async () => {
    mockDb({ tokenUser: null, rowByOriginalTxn: null });

    await expect(
      AppleWebhookService.handleNotification(ctx("SUBSCRIBED", "INITIAL_BUY"))
    ).rejects.toThrow(/No user mapping/);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it("throws on an unknown product id instead of guessing a plan", async () => {
    mockDb({ tokenUser: "user_1" });

    await expect(
      AppleWebhookService.handleNotification(
        ctx("SUBSCRIBED", "INITIAL_BUY", txn({ productId: "com.other.app.sub" }))
      )
    ).rejects.toThrow(/no plan mapping/i);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it("resolves the user through the original transaction id when appAccountToken is absent", async () => {
    const { upserts } = mockDb({
      tokenUser: null,
      rowByOriginalTxn: { user_id: "user_attached" },
    });

    const outcome = await AppleWebhookService.handleNotification(
      ctx("DID_RENEW", null, txn({ appAccountToken: undefined }))
    );

    expect(outcome.userId).toBe("user_attached");
    expect(upserts[0].user_id).toBe("user_attached");
  });
});

describe("AppleWebhookService.verifyNotification — environment selection", () => {
  it("uses the primary environment verifier when it succeeds", async () => {
    process.env.APPLE_ENVIRONMENT = "Production";
    const payload = { notificationType: "TEST", notificationUUID: "uuid-1" };
    const prodVerifier = {
      verifyAndDecodeNotification: jest.fn().mockResolvedValue(payload),
    };
    getVerifierMock.mockImplementation(() => prodVerifier);

    const result = await AppleWebhookService.verifyNotification("jws");
    expect(result.environment).toBe("Production");
    expect(result.payload).toBe(payload);
  });

  it("falls back to the Sandbox verifier when enabled and the primary rejects", async () => {
    process.env.APPLE_ENVIRONMENT = "Production";
    process.env.APPLE_ACCEPT_SANDBOX_NOTIFICATIONS = "true";
    const payload = { notificationType: "TEST", notificationUUID: "uuid-1" };
    const prodVerifier = {
      verifyAndDecodeNotification: jest
        .fn()
        .mockRejectedValue(new Error("INVALID_ENVIRONMENT")),
    };
    const sandboxVerifier = {
      verifyAndDecodeNotification: jest.fn().mockResolvedValue(payload),
    };
    getVerifierMock.mockImplementation((env: string) =>
      env === "Sandbox" ? sandboxVerifier : prodVerifier
    );

    const result = await AppleWebhookService.verifyNotification("jws");
    expect(result.environment).toBe("Sandbox");
  });

  it("propagates the primary error when the sandbox fallback is disabled", async () => {
    process.env.APPLE_ENVIRONMENT = "Production";
    process.env.APPLE_ACCEPT_SANDBOX_NOTIFICATIONS = "false";
    const prodVerifier = {
      verifyAndDecodeNotification: jest
        .fn()
        .mockRejectedValue(new Error("VERIFICATION_FAILURE")),
    };
    getVerifierMock.mockImplementation(() => prodVerifier);

    await expect(AppleWebhookService.verifyNotification("jws")).rejects.toThrow(
      "VERIFICATION_FAILURE"
    );
  });
});

describe("AppleWebhookService.ensureAppleAccountToken", () => {
  it("returns the existing token without minting a new one", async () => {
    const { tokenInserts } = mockDb({ tokenUser: "user_1" });

    const token = await AppleWebhookService.ensureAppleAccountToken("user_1");
    expect(token).toBe("tok");
    expect(tokenInserts).toHaveLength(0);
  });

  it("mints and stores a UUID for a user without one", async () => {
    const { tokenInserts } = mockDb({ tokenUser: null });

    const token = await AppleWebhookService.ensureAppleAccountToken("user_2");
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(tokenInserts).toHaveLength(1);
    expect(tokenInserts[0].user_id).toBe("user_2");
  });
});
