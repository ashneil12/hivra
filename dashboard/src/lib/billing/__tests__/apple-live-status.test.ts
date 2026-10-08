import {
  APPLE_LIVE_STATUS_ACTIVE,
  APPLE_LIVE_STATUS_REVOKED,
  AppleLiveStatusConfigError,
  getAppleLiveSubscriptionStatus,
} from "../apple-live-status";

type StatusItem = { originalTransactionId?: string; status?: number };

function clientReturning(data: Array<{ lastTransactions?: StatusItem[] }>) {
  const getAllSubscriptionStatuses = jest.fn().mockResolvedValue({ data });
  return {
    getAllSubscriptionStatuses,
    getClient: jest.fn(() => ({ getAllSubscriptionStatuses }) as never),
  };
}

describe("getAppleLiveSubscriptionStatus", () => {
  it("returns the live status of the matching transaction", async () => {
    const { getClient, getAllSubscriptionStatuses } = clientReturning([
      {
        lastTransactions: [
          { originalTransactionId: "other", status: APPLE_LIVE_STATUS_ACTIVE },
          { originalTransactionId: "2000000123456789", status: APPLE_LIVE_STATUS_REVOKED },
        ],
      },
    ]);

    const status = await getAppleLiveSubscriptionStatus("2000000123456789", "Sandbox", { getClient });

    expect(status).toBe(APPLE_LIVE_STATUS_REVOKED);
    expect(getClient).toHaveBeenCalledWith("Sandbox");
    expect(getAllSubscriptionStatuses).toHaveBeenCalledWith("2000000123456789");
  });

  it("returns missing when Apple lists no entry for the transaction", async () => {
    const { getClient } = clientReturning([{ lastTransactions: [{ originalTransactionId: "other", status: 1 }] }]);
    expect(await getAppleLiveSubscriptionStatus("2000000123456789", "Production", { getClient })).toBe("missing");
  });

  it("returns missing when Apple answers 404", async () => {
    const getClient = jest.fn(
      () =>
        ({
          getAllSubscriptionStatuses: jest.fn().mockRejectedValue(Object.assign(new Error("not found"), { httpStatusCode: 404 })),
        }) as never,
    );
    expect(await getAppleLiveSubscriptionStatus("2000000123456789", "Production", { getClient })).toBe("missing");
  });

  it("rethrows other Apple failures, so the caller can refuse", async () => {
    const getClient = jest.fn(
      () =>
        ({
          getAllSubscriptionStatuses: jest.fn().mockRejectedValue(Object.assign(new Error("server error"), { httpStatusCode: 500 })),
        }) as never,
    );
    await expect(getAppleLiveSubscriptionStatus("2000000123456789", "Production", { getClient })).rejects.toThrow("server error");
  });

  it("reports missing API credentials as a configuration error", async () => {
    const getClient = jest.fn(() => {
      throw new Error("APPLE_ISSUER_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY must be configured");
    });
    await expect(getAppleLiveSubscriptionStatus("2000000123456789", "Production", { getClient })).rejects.toBeInstanceOf(
      AppleLiveStatusConfigError,
    );
  });
});
