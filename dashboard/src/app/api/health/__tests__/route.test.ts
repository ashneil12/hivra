import { GET } from "../route";

const mockDb = jest.fn();
const mockClerk = jest.fn();
const mockStripe = jest.fn();

jest.mock("@/lib/health/db", () => ({
  checkDbHealth: (...args: unknown[]) => mockDb(...args),
}));
jest.mock("@/lib/health/clerk", () => ({
  checkClerkHealth: (...args: unknown[]) => mockClerk(...args),
}));
jest.mock("@/lib/health/stripe", () => ({
  checkStripeHealth: (...args: unknown[]) => mockStripe(...args),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    })),
  },
}));

const { NextResponse } = jest.requireMock("next/server");

function makeUp() {
  return { status: "up" as const, latency_ms: 42 };
}
function makeDown() {
  return { status: "down" as const, latency_ms: 0 };
}

beforeEach(() => {
  mockDb.mockReset();
  mockClerk.mockReset();
  mockStripe.mockReset();
  (NextResponse.json as jest.Mock).mockClear();
});

describe("GET /api/health", () => {
  it("returns healthy / 200 when all three checks are up", async () => {
    mockDb.mockResolvedValueOnce(makeUp());
    mockClerk.mockResolvedValueOnce(makeUp());
    mockStripe.mockResolvedValueOnce(makeUp());

    await GET();

    expect(NextResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "healthy" }),
      { status: 200 },
    );
  });

  it("returns degraded / 200 when one check is down", async () => {
    mockDb.mockResolvedValueOnce(makeDown());
    mockClerk.mockResolvedValueOnce(makeUp());
    mockStripe.mockResolvedValueOnce(makeUp());

    await GET();

    expect(NextResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "degraded" }),
      { status: 200 },
    );
  });

  it("returns unhealthy / 503 when all three checks are down", async () => {
    mockDb.mockResolvedValueOnce(makeDown());
    mockClerk.mockResolvedValueOnce(makeDown());
    mockStripe.mockResolvedValueOnce(makeDown());

    await GET();

    expect(NextResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unhealthy" }),
      { status: 503 },
    );
  });
});
