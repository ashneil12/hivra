import { reconcileAppleSubscriptions } from "@/lib/billing/apple-subscription-reconciler";
import { supabaseAdmin } from "@/lib/supabase";
import { AppleWebhookService } from "@/lib/services/apple-webhook-service";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

// The reconciler converges through the SAME state-machine primitives the
// webhook uses — spy on them rather than re-testing their internals.
jest.mock("@/lib/services/apple-webhook-service", () => ({
  AppleWebhookService: {
    activateFromTransaction: jest
      .fn()
      .mockResolvedValue({ action: "activated", userId: "user_1" }),
    markGracePeriod: jest
      .fn()
      .mockResolvedValue({ action: "grace_period", userId: "user_1" }),
    markBillingRetry: jest
      .fn()
      .mockResolvedValue({ action: "billing_retry", userId: "user_1" }),
    expireSubscription: jest
      .fn()
      .mockResolvedValue({ action: "expired", userId: "user_1" }),
    revokeSubscription: jest
      .fn()
      .mockResolvedValue({ action: "revoked", userId: "user_1" }),
  },
}));

const activateMock = AppleWebhookService.activateFromTransaction as jest.Mock;
const graceMock = AppleWebhookService.markGracePeriod as jest.Mock;
const retryMock = AppleWebhookService.markBillingRetry as jest.Mock;
const expireMock = AppleWebhookService.expireSubscription as jest.Mock;
const revokeMock = AppleWebhookService.revokeSubscription as jest.Mock;

interface StrandedRow {
  user_id: string;
  apple_original_transaction_id: string;
  status: string;
  environment: string;
  current_period_end: string | null;
}

function strandedRow(overrides: Partial<StrandedRow> = {}): StrandedRow {
  return {
    user_id: "user_1",
    apple_original_transaction_id: "otx_1",
    status: "active",
    environment: "Production",
    current_period_end: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Mock the scan chain: .select(...).in(...).not(...).lt(...) */
function mockScan(rows: StrandedRow[], error: unknown = null) {
  const query = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    lt: jest.fn().mockResolvedValue({ data: rows, error }),
  };
  (supabaseAdmin!.from as jest.Mock).mockReturnValue(query);
  return query;
}

function deps(appleStatus: number | null, opts: { apiThrows?: unknown } = {}) {
  const decodedTransaction = {
    originalTransactionId: "otx_1",
    productId: "cloud.hivra.pro.monthly",
    purchaseDate: 1_752_600_000_000,
    expiresDate: 1_755_278_400_000,
  };
  const client = {
    getAllSubscriptionStatuses: jest.fn(async () => {
      if (opts.apiThrows) throw opts.apiThrows;
      return {
        data:
          appleStatus === null
            ? []
            : [
                {
                  subscriptionGroupIdentifier: "group_1",
                  lastTransactions: [
                    {
                      originalTransactionId: "otx_1",
                      status: appleStatus,
                      signedTransactionInfo: "signed-txn",
                      signedRenewalInfo: "signed-renewal",
                    },
                  ],
                },
              ],
      };
    }),
  };
  const verifier = {
    verifyAndDecodeTransaction: jest.fn().mockResolvedValue(decodedTransaction),
    verifyAndDecodeRenewalInfo: jest.fn().mockResolvedValue({ autoRenewStatus: 1 }),
  };
  return {
    getClient: jest.fn(() => client as never),
    getVerifier: jest.fn(() => verifier as never),
    client,
    verifier,
    decodedTransaction,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("reconcileAppleSubscriptions", () => {
  it("returns zeros when nothing is stranded", async () => {
    mockScan([]);
    const d = deps(1);

    const result = await reconcileAppleSubscriptions("2026-07-16T00:00:00Z", d);

    expect(result.scanned).toBe(0);
    expect(result.converged).toBe(0);
    expect(d.getClient).not.toHaveBeenCalled();
  });

  it("scans only non-terminal statuses past their period end", async () => {
    const query = mockScan([]);
    await reconcileAppleSubscriptions("2026-07-16T00:00:00Z", deps(1));

    expect((supabaseAdmin!.from as jest.Mock)).toHaveBeenCalledWith(
      "apple_iap_subscriptions"
    );
    expect(query.in).toHaveBeenCalledWith("status", [
      "active",
      "trialing",
      "grace_period",
      "past_due",
    ]);
    expect(query.lt).toHaveBeenCalledWith(
      "current_period_end",
      "2026-07-16T00:00:00Z"
    );
  });

  it("converges a live ACTIVE subscription through the activation primitive (missed DID_RENEW)", async () => {
    mockScan([strandedRow()]);
    const d = deps(1);

    const result = await reconcileAppleSubscriptions("2026-07-16T00:00:00Z", d);

    expect(result.converged).toBe(1);
    expect(result.entries[0].action).toBe("converged_active");
    expect(activateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        transaction: d.decodedTransaction,
        notificationType: "RECONCILE_ACTIVE",
      })
    );
  });

  it("converges EXPIRED through the expire primitive (missed EXPIRED notification)", async () => {
    mockScan([strandedRow()]);

    const result = await reconcileAppleSubscriptions(
      "2026-07-16T00:00:00Z",
      deps(2)
    );

    expect(result.converged).toBe(1);
    expect(result.entries[0].action).toBe("converged_expired");
    expect(expireMock).toHaveBeenCalledWith("user_1", "RECONCILE_EXPIRED");
  });

  it("converges BILLING_RETRY to past_due", async () => {
    mockScan([strandedRow()]);

    const result = await reconcileAppleSubscriptions(
      "2026-07-16T00:00:00Z",
      deps(3)
    );

    expect(result.entries[0].action).toBe("converged_billing_retry");
    expect(retryMock).toHaveBeenCalledWith("user_1", "RECONCILE_BILLING_RETRY");
  });

  it("converges BILLING_GRACE_PERIOD through the grace primitive", async () => {
    mockScan([strandedRow()]);

    const result = await reconcileAppleSubscriptions(
      "2026-07-16T00:00:00Z",
      deps(4)
    );

    expect(result.entries[0].action).toBe("converged_grace");
    expect(graceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        notificationType: "RECONCILE_GRACE_PERIOD",
      })
    );
  });

  it("converges REVOKED through the revoke primitive", async () => {
    mockScan([strandedRow()]);

    const result = await reconcileAppleSubscriptions(
      "2026-07-16T00:00:00Z",
      deps(5)
    );

    expect(result.entries[0].action).toBe("converged_revoked");
    expect(revokeMock).toHaveBeenCalledWith("user_1", "RECONCILE_REVOKED");
  });

  it("flags manual review when the App Store has no record (never destroys on missing data)", async () => {
    mockScan([strandedRow()]);
    const notFound = Object.assign(new Error("not found"), {
      httpStatusCode: 404,
    });

    const result = await reconcileAppleSubscriptions(
      "2026-07-16T00:00:00Z",
      deps(null, { apiThrows: notFound })
    );

    expect(result.manualReview).toBe(1);
    expect(result.converged).toBe(0);
    expect(expireMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it("flags manual review when no lastTransactions entry matches", async () => {
    mockScan([strandedRow()]);

    const result = await reconcileAppleSubscriptions(
      "2026-07-16T00:00:00Z",
      deps(null)
    );

    expect(result.manualReview).toBe(1);
    expect(result.entries[0].liveAppleStatus).toBe("missing");
  });

  it("records a stale-skip when the activation primitive reports one", async () => {
    mockScan([strandedRow()]);
    activateMock.mockResolvedValueOnce({ action: "skipped_stale", userId: "user_1" });

    const result = await reconcileAppleSubscriptions(
      "2026-07-16T00:00:00Z",
      deps(1)
    );

    expect(result.skipped).toBe(1);
    expect(result.converged).toBe(0);
  });

  it("counts per-row errors without aborting the pass", async () => {
    mockScan([
      strandedRow(),
      strandedRow({ user_id: "user_2", apple_original_transaction_id: "otx_2" }),
    ]);
    const d = deps(2);
    expireMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ action: "expired", userId: "user_2" });

    const result = await reconcileAppleSubscriptions("2026-07-16T00:00:00Z", d);

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
  });

  it("selects the client/verifier for each row's stored environment", async () => {
    mockScan([strandedRow({ environment: "Sandbox" })]);
    const d = deps(1);

    await reconcileAppleSubscriptions("2026-07-16T00:00:00Z", d);

    expect(d.getClient).toHaveBeenCalledWith("Sandbox");
    expect(d.getVerifier).toHaveBeenCalledWith("Sandbox");
  });
});
