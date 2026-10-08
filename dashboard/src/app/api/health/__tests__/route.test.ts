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

type HealthBody = { status: string; timestamp: string; cached?: boolean };
type HealthResponse = { body: HealthBody; status: number };

// A fresh route module per test: the result cache lives in module scope, and
// each test must start from a cold cache.
let GET: () => Promise<unknown>;
let NextResponse: { json: jest.Mock };
let now: number;
let dateNowSpy: jest.SpyInstance;

async function get(): Promise<HealthResponse> {
  return (await GET()) as HealthResponse;
}

function makeUp() {
  return { status: "up" as const, latency_ms: 42 };
}
function makeDown() {
  return { status: "down" as const, latency_ms: 0 };
}

beforeEach(() => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  GET = require("../route").GET;
  NextResponse = jest.requireMock("next/server").NextResponse;
  mockDb.mockReset();
  mockClerk.mockReset();
  mockStripe.mockReset();
  now = Date.parse("2026-09-25T12:00:00.000Z");
  dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  dateNowSpy.mockRestore();
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

describe("GET /api/health is cached so anonymous traffic cannot spend Clerk and Stripe quota", () => {
  beforeEach(() => {
    mockDb.mockResolvedValue(makeUp());
    mockClerk.mockResolvedValue(makeUp());
    mockStripe.mockResolvedValue(makeUp());
  });

  it("answers a burst of requests with one Clerk call and one Stripe call", async () => {
    const responses: HealthResponse[] = [];
    for (let i = 0; i < 50; i += 1) {
      responses.push(await get());
      now += 100;
    }

    expect(mockClerk).toHaveBeenCalledTimes(1);
    expect(mockStripe).toHaveBeenCalledTimes(1);
    expect(mockDb).toHaveBeenCalledTimes(1);
    expect(responses.every((response) => response.status === 200 && response.body.status === "healthy")).toBe(true);
    expect(responses[0].body.cached).toBe(false);
    expect(responses[1].body.cached).toBe(true);
    // The timestamp is when the checks ran, so a monitor can see the age.
    expect(responses[49].body.timestamp).toBe(responses[0].body.timestamp);
  });

  it("shares one in-flight check between concurrent cold requests", async () => {
    let release: (value: ReturnType<typeof makeUp>) => void = () => {};
    const slowClerk = new Promise<ReturnType<typeof makeUp>>((resolve) => {
      release = resolve;
    });
    mockClerk.mockImplementation(() => slowClerk);

    const pending = Promise.all([get(), get(), get()]);
    release(makeUp());
    const responses = await pending;

    expect(mockClerk).toHaveBeenCalledTimes(1);
    expect(mockStripe).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.body.status)).toEqual(["healthy", "healthy", "healthy"]);
  });

  it("checks again once the cached result is older than the TTL, so monitors see a real change", async () => {
    await get();
    mockStripe.mockResolvedValue(makeDown());

    now += 29_000;
    expect((await get()).body.status).toBe("healthy");

    now += 2_000;
    const fresh = await get();
    expect(fresh.body.status).toBe("degraded");
    expect(fresh.body.cached).toBe(false);
    expect(mockStripe).toHaveBeenCalledTimes(2);
    expect(mockClerk).toHaveBeenCalledTimes(2);
  });

  it("caches an unhealthy result too, so an outage is not amplified by retries", async () => {
    mockDb.mockResolvedValue(makeDown());
    mockClerk.mockResolvedValue(makeDown());
    mockStripe.mockResolvedValue(makeDown());

    expect((await get()).status).toBe(503);
    now += 1_000;
    expect((await get()).status).toBe(503);
    expect(mockStripe).toHaveBeenCalledTimes(1);
  });
});
