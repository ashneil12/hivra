/** @jest-environment node */

// The real in-memory limiter behind host preparation, end to end through the
// route: a failed run gives its slot back (up to 5 failures per 15 minutes), a
// successful one holds it for 15 minutes from the success, and the refusal
// says how long to wait.

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
    // 15 minutes from the success, less the 3 minutes since.
    expect(limited.headers.get("retry-after")).toBe(String(15 * 60 - 3 * 60));
    expect((await limited.json()).error).toBe(
      "This server was set up in the last 15 minutes. You can try again in 12 minutes.",
    );
    expect(mockPrepare).toHaveBeenCalledTimes(3);

    now += 12 * 60_000 + 1;
    mockPrepare.mockResolvedValueOnce(succeeded);
    expect((await POST(request(), context())).status).toBe(200);
  });

  // Review of slice 5: the window used to start at the first attempt, so a
  // failure at 0:00 and a success at 14:30 let a third run in at 15:01.
  it("holds a success for 15 minutes from the success, even after an earlier failure", async () => {
    const connection = "00000000-0000-4000-8000-000000001038";
    const ctx = () => ({ params: Promise.resolve({ id: connection }) });
    mockPrepare.mockResolvedValueOnce(failed).mockResolvedValueOnce(succeeded);

    expect((await POST(request(), ctx())).status).toBe(502);
    now += 14 * 60_000 + 30_000;
    expect((await POST(request(), ctx())).status).toBe(200);
    now += 31_000;
    const limited = await POST(request(), ctx());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(15 * 60 - 31));
    expect(mockPrepare).toHaveBeenCalledTimes(2);
  });

  it("makes a host wait after 5 failed runs in 15 minutes", async () => {
    const connection = "00000000-0000-4000-8000-000000001039";
    const ctx = () => ({ params: Promise.resolve({ id: connection }) });
    mockPrepare.mockResolvedValue(failed);
    for (let run = 0; run < 5; run += 1) {
      expect((await POST(request(), ctx())).status).toBe(502);
      now += 60_000;
    }
    const limited = await POST(request(), ctx());
    expect(limited.status).toBe(429);
    // 15 minutes from the first failure, less the 5 minutes since.
    expect(limited.headers.get("retry-after")).toBe(String(10 * 60));
    expect(await limited.json()).toMatchObject({
      code: "PREPARATION_FAILURES_LIMITED",
      error: "Setup failed on this server 5 times in the last 15 minutes. You can try again in 10 minutes.",
    });
    expect(mockPrepare).toHaveBeenCalledTimes(5);

    now += 10 * 60_000 + 1;
    expect((await POST(request(), ctx())).status).toBe(502);
    expect(mockPrepare).toHaveBeenCalledTimes(6);
    mockPrepare.mockReset();
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
