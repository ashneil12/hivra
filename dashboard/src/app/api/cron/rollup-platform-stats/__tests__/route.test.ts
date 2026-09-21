import { NextRequest } from "next/server";

import { GET } from "../route";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: jest.fn() },
}));

const ORIGINAL_ENV = process.env;

const makeRequest = (
  authorization?: string,
  url = "http://localhost/api/cron/rollup-platform-stats"
) =>
  new Request(url, {
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;

describe("GET /api/cron/rollup-platform-stats", () => {
  const rpc = supabaseAdmin!.rpc as jest.Mock;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "cron-secret" };
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "" };
    const res = await GET(makeRequest("Bearer cron-secret"));
    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 401 when the authorization header is wrong", async () => {
    const res = await GET(makeRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 401 when no authorization header is present", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("computes today + yesterday by default and reports success", async () => {
    const res = await GET(makeRequest("Bearer cron-secret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ computed: 2, errors: 0, days: 2 });
    expect(
      rpc.mock.calls.filter((c) => c[0] === "compute_platform_stats_snapshot")
    ).toHaveLength(2);
    expect(rpc).toHaveBeenCalledWith("compute_platform_stats_snapshot", {
      p_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(rpc).toHaveBeenCalledWith("roll_token_anchor");
  });

  it("backfills the requested number of days, capped at 90", async () => {
    const res = await GET(
      makeRequest("Bearer cron-secret", "http://localhost/api/cron/rollup-platform-stats?days=200")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.days).toBe(90);
    expect(
      rpc.mock.calls.filter((c) => c[0] === "compute_platform_stats_snapshot")
    ).toHaveLength(90);
  });

  it("continues past a failed day and counts it as an error", async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } })
      .mockResolvedValue({ data: {}, error: null });

    const res = await GET(
      makeRequest("Bearer cron-secret", "http://localhost/api/cron/rollup-platform-stats?days=3")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ computed: 2, errors: 1, days: 3 });
  });

  it("returns 500 when every day fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const res = await GET(makeRequest("Bearer cron-secret"));
    expect(res.status).toBe(500);
  });
});
