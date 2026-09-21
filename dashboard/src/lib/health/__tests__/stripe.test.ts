import { checkStripeHealth } from "../stripe";

// Build a mock Stripe instance whose `balance.retrieve` we control per-test.
const mockRetrieve = jest.fn();
jest.mock("@/lib/stripe", () => ({
  getStripe: () => ({ balance: { retrieve: mockRetrieve } }),
}));
// Logger is called on the down-path; stub it to keep test output clean.
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("checkStripeHealth", () => {
  beforeEach(() => {
    mockRetrieve.mockReset();
    delete process.env.HIVRA_AUTH_MODE;
  });

  afterAll(() => {
    delete process.env.HIVRA_AUTH_MODE;
  });

  it("treats hosted billing as intentionally absent in local-auth mode", async () => {
    process.env.HIVRA_AUTH_MODE = "local";

    await expect(checkStripeHealth()).resolves.toEqual({ status: "up", latency_ms: 0 });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns status 'up' with measured latency when balance.retrieve succeeds", async () => {
    mockRetrieve.mockResolvedValueOnce({ available: [] });

    const result = await checkStripeHealth();

    expect(result.status).toBe("up");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it("returns status 'down' with latency 0 when balance.retrieve rejects (401 / network)", async () => {
    mockRetrieve.mockRejectedValueOnce(new Error("Unauthorized"));

    const result = await checkStripeHealth();

    expect(result.status).toBe("down");
    expect(result.latency_ms).toBe(0);
  });
});
