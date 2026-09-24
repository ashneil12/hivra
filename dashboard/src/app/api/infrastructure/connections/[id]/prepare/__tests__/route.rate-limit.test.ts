/** @jest-environment node */

// The real in-memory limiter behind host preparation, end to end through the
// route: a failed run never locks the owner out, a successful one does for the
// rest of the window, and the refusal says how long to wait.

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockPrepare = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/infrastructure/connection-preparation", () => ({
  prepareSimpleProxmoxConnection: (...args: unknown[]) => mockPrepare(...args),
}));

import { POST } from "../route";

const CONNECTION_ID = "00000000-0000-4000-8000-000000001036";
const context = () => ({ params: Promise.resolve({ id: CONNECTION_ID }) });
const request = () => new NextRequest(
  `http://localhost/api/infrastructure/connections/${CONNECTION_ID}/prepare`,
  { method: "POST", headers: { "x-forwarded-for": "198.51.100.44" } },
);

const failed = {
  ok: false,
  connectionId: CONNECTION_ID,
  error: { code: "PREPARATION_FAILED", message: "The Proxmox host could not be prepared." },
};
const succeeded = {
  ok: true,
  connectionId: CONNECTION_ID,
  provisionerVersion: "2026.08.26.3",
  preflight: {
    ok: false,
    connectionId: CONNECTION_ID,
    checkedAt: "2026-08-26T12:00:00.000Z",
    error: { code: "CAPACITY_UNAVAILABLE", message: "Target capacity could not be measured safely." },
    unmetRequirements: [{ code: "CAPACITY_UNAVAILABLE", message: "Target capacity could not be measured safely." }],
  },
};

describe("host preparation rate limit", () => {
  let now = 1_800_000_000_000;
  let dateNow: jest.SpyInstance;

  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: "user_rate_limit" });
    dateNow = jest.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => dateNow.mockRestore());

  it("lets a failed run be retried at once, then holds a success for the window", async () => {
    mockPrepare.mockResolvedValueOnce(failed).mockResolvedValueOnce(failed).mockResolvedValueOnce(succeeded);

    expect((await POST(request(), context())).status).toBe(502);
    now += 1_000;
    expect((await POST(request(), context())).status).toBe(502);
    now += 1_000;
    expect((await POST(request(), context())).status).toBe(200);
    expect(mockPrepare).toHaveBeenCalledTimes(3);

    now += 3 * 60_000;
    const limited = await POST(request(), context());
    expect(limited.status).toBe(429);
    // 15 minutes from the window's first run, less the 3m02s since.
    expect(limited.headers.get("retry-after")).toBe(String(15 * 60 - 3 * 60 - 2));
    expect((await limited.json()).error).toBe(
      "This server was set up in the last 15 minutes. You can try again in 12 minutes.",
    );
    expect(mockPrepare).toHaveBeenCalledTimes(3);

    now += 13 * 60_000;
    mockPrepare.mockResolvedValueOnce(succeeded);
    expect((await POST(request(), context())).status).toBe(200);
  });

  it("refuses a second run while the first is still going", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockPrepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const connection = "00000000-0000-4000-8000-000000001037";
    const ctx = () => ({ params: Promise.resolve({ id: connection }) });
    const first = POST(request(), ctx());
    await new Promise((resolve) => setImmediate(resolve));

    const second = await POST(request(), ctx());
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("PREPARATION_IN_PROGRESS");

    finish(failed);
    expect((await first).status).toBe(502);
    mockPrepare.mockResolvedValueOnce(succeeded);
    expect((await POST(request(), ctx())).status).toBe(200);
  });
});
