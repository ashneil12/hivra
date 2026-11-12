/**
 * Cron route tests for /api/cron/first-win-emails. Locks in:
 *   - fails closed without CRON_SECRET, 401s a bad bearer
 *   - DEFAULT-OFF: without HIVRA_FIRST_WIN_EMAILS_ENABLED=true the route returns
 *     early and never touches the sweep (deploys inert)
 *   - enabled runs pass the sweep summary through; sweep errors → 500
 */

import { NextRequest } from "next/server";

const mockSupabaseAdmin = { value: {} as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

const sweepMock = jest.fn();
jest.mock("@/lib/recovery/first-win-email-sweep", () => ({
  runFirstWinEmailSweep: (...args: unknown[]) => sweepMock(...args),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { GET } from "../route";

const SUMMARY = {
  candidates: 3,
  day1_idle: 1,
  day1_active: 0,
  day3_usecase: 1,
  day7_offer: 0,
  stalled_5d: 1,
  skipped_already_sent: 0,
  skipped_no_email: 0,
  failed: 0,
  capHit: false,
};

describe("GET /api/cron/first-win-emails", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, CRON_SECRET: "expected-secret" };
    delete process.env.HIVRA_FIRST_WIN_EMAILS_ENABLED;
    mockSupabaseAdmin.value = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (authorization?: string) =>
    new Request("http://localhost/api/cron/first-win-emails", {
      headers: authorization ? { authorization } : {},
    }) as unknown as NextRequest;

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("rejects requests with the wrong bearer", async () => {
    const res = await GET(makeRequest("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("returns early when HIVRA_FIRST_WIN_EMAILS_ENABLED is unset (default off)", async () => {
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.enabled).toBe(false);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("returns early when HIVRA_FIRST_WIN_EMAILS_ENABLED is explicitly false", async () => {
    process.env.HIVRA_FIRST_WIN_EMAILS_ENABLED = "false";
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.enabled).toBe(false);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("runs the sweep and passes the summary through when enabled", async () => {
    process.env.HIVRA_FIRST_WIN_EMAILS_ENABLED = "true";
    sweepMock.mockResolvedValue(SUMMARY);
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ ok: true, enabled: true, ...SUMMARY });
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the database is not configured", async () => {
    process.env.HIVRA_FIRST_WIN_EMAILS_ENABLED = "true";
    mockSupabaseAdmin.value = null;
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the sweep throws", async () => {
    process.env.HIVRA_FIRST_WIN_EMAILS_ENABLED = "true";
    sweepMock.mockRejectedValue(new Error("boom"));
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
  });
});
