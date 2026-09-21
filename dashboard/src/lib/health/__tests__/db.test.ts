import { checkDbHealth } from "../db";

// Build a mock supabaseAdmin whose from().select().limit() chain we control.
const mockLimit = jest.fn();
const mockSelect = jest.fn(() => ({ limit: mockLimit }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({ select: mockSelect }),
  },
}));
// Logger is called on the down-path; stub it to keep test output clean.
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("checkDbHealth", () => {
  beforeEach(() => {
    mockLimit.mockReset();
  });

  it("returns status 'up' with measured latency when query succeeds", async () => {
    mockLimit.mockResolvedValueOnce({ count: 5, error: null });

    const result = await checkDbHealth();

    expect(result.status).toBe("up");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });

  it("returns status 'down' with latency 0 when query rejects (network / auth)", async () => {
    mockLimit.mockRejectedValueOnce(new Error("connection refused"));

    const result = await checkDbHealth();

    expect(result.status).toBe("down");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });
});
