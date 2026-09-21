import { checkClerkHealth } from "../clerk";

// Build a mock Clerk client whose users.getUserList we control per-test.
const mockGetUserList = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: () => ({
    users: { getUserList: mockGetUserList },
  }),
}));
// Logger is called on the down-path; stub it to keep test output clean.
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("checkClerkHealth", () => {
  beforeEach(() => {
    mockGetUserList.mockReset();
    process.env.CLERK_SECRET_KEY = "sk_test_dummy_key";
    delete process.env.HIVRA_AUTH_MODE;
  });

  afterAll(() => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.HIVRA_AUTH_MODE;
  });

  it("treats hosted Clerk as intentionally absent in local-auth mode", async () => {
    process.env.HIVRA_AUTH_MODE = "local";
    delete process.env.CLERK_SECRET_KEY;

    await expect(checkClerkHealth()).resolves.toEqual({ status: "up", latency_ms: 0 });
    expect(mockGetUserList).not.toHaveBeenCalled();
  });

  it("returns status 'up' with measured latency when getUserList succeeds", async () => {
    mockGetUserList.mockResolvedValueOnce({ data: [], totalCount: 0 });

    const result = await checkClerkHealth();

    expect(result.status).toBe("up");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(mockGetUserList).toHaveBeenCalledTimes(1);
  });

  it("returns status 'down' with latency 0 when getUserList rejects (401 / network)", async () => {
    mockGetUserList.mockRejectedValueOnce(new Error("Unauthorized"));

    const result = await checkClerkHealth();

    expect(result.status).toBe("down");
    expect(result.latency_ms).toBe(0);
  });

  it("returns status 'down' when CLERK_SECRET_KEY is not configured", async () => {
    delete process.env.CLERK_SECRET_KEY;

    const result = await checkClerkHealth();

    expect(result.status).toBe("down");
    expect(result.latency_ms).toBe(0);
    expect(mockGetUserList).not.toHaveBeenCalled();
  });
});
