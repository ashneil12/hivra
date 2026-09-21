/**
 * Route tests for POST /api/admin/warm-pool-campaign. Locks in:
 *   - auth fails closed: no bearer + no session → 401; a Clerk session that
 *     isn't the OPS_ADMIN_EMAILS admin → 403; Bearer CRON_SECRET → in; the
 *     ops-admin Clerk session → in
 *   - dryRun DEFAULTS TRUE: an empty body, {}, and even {"dryRun": "false"}
 *     (string) all run dry — only the literal boolean false plans a send
 *   - the env-gate block message passes through when a real send is blocked
 *   - limit is validated and forwarded
 *   - sweep errors → 500
 */

import { NextRequest } from "next/server";

const mockSupabaseAdmin = { value: {} as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

const runCampaignMock = jest.fn();
jest.mock("@/lib/recovery/warm-pool-campaign-sweep", () => ({
  runWarmPoolCampaign: (...args: unknown[]) => runCampaignMock(...args),
}));

const authMock = jest.fn();
const currentUserMock = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  currentUser: (...args: unknown[]) => currentUserMock(...args),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { POST } from "../route";

const DRY_SUMMARY = {
  dryRun: true,
  enabled: false,
  blockedBy: null,
  cohortSize: 258,
  excludedAlreadyEmailed: 8,
  eligible: 250,
  plannedSends: 250,
  capHit: false,
  sampleUserIds: ["user_a"],
  subject: "what your agent could be doing",
  sent: 0,
  failed: 0,
  skippedNoEmail: 0,
};

function makeRequest(opts: { authorization?: string; body?: unknown } = {}) {
  return new Request("http://localhost/api/admin/warm-pool-campaign", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
    },
    body: opts.body === undefined ? "" : JSON.stringify(opts.body),
  }) as unknown as NextRequest;
}

describe("POST /api/admin/warm-pool-campaign", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CRON_SECRET: "cron-secret",
      OPS_ADMIN_EMAILS: "ash@example.com",
    };
    delete process.env.OPS_ADMIN_USER_IDS;
    mockSupabaseAdmin.value = {};
    authMock.mockResolvedValue({ userId: null });
    currentUserMock.mockResolvedValue(null);
    runCampaignMock.mockResolvedValue(DRY_SUMMARY);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("401s with no bearer and no session", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(runCampaignMock).not.toHaveBeenCalled();
  });

  it("401s a wrong bearer with no session", async () => {
    const res = await POST(makeRequest({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(runCampaignMock).not.toHaveBeenCalled();
  });

  it("does not accept the bearer path when CRON_SECRET is unconfigured", async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(makeRequest({ authorization: "Bearer cron-secret" }));
    expect(res.status).toBe(401);
    expect(runCampaignMock).not.toHaveBeenCalled();
  });

  it("403s an authenticated non-admin session", async () => {
    authMock.mockResolvedValue({ userId: "user_other" });
    currentUserMock.mockResolvedValue({
      id: "user_other",
      primaryEmailAddress: { emailAddress: "someone@else.com" },
      emailAddresses: [{ emailAddress: "someone@else.com" }],
    });
    const res = await POST(makeRequest({ body: {} }));
    expect(res.status).toBe(403);
    expect(runCampaignMock).not.toHaveBeenCalled();
  });

  it("admits the ops-admin Clerk session (OPS_ADMIN_EMAILS)", async () => {
    authMock.mockResolvedValue({ userId: "user_ash" });
    currentUserMock.mockResolvedValue({
      id: "user_ash",
      primaryEmailAddress: { emailAddress: "ash@example.com" },
      emailAddresses: [{ emailAddress: "ash@example.com" }],
    });
    const res = await POST(makeRequest({ body: {} }));
    expect(res.status).toBe(200);
    expect(runCampaignMock).toHaveBeenCalledWith({ dryRun: true, limit: undefined });
  });

  it("admits Bearer CRON_SECRET and defaults to dryRun:true on an empty body", async () => {
    const res = await POST(makeRequest({ authorization: "Bearer cron-secret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ ok: true, dryRun: true, cohortSize: 258 });
    expect(runCampaignMock).toHaveBeenCalledWith({ dryRun: true, limit: undefined });
  });

  it("treats anything but the literal boolean false as a dry run", async () => {
    for (const dryRun of [true, "false", null, 0]) {
      runCampaignMock.mockClear();
      const res = await POST(
        makeRequest({ authorization: "Bearer cron-secret", body: { dryRun } })
      );
      expect(res.status).toBe(200);
      expect(runCampaignMock).toHaveBeenCalledWith({ dryRun: true, limit: undefined });
    }
  });

  it("passes dryRun:false through only when explicitly false, with the limit", async () => {
    runCampaignMock.mockResolvedValue({ ...DRY_SUMMARY, dryRun: false, blockedBy: null });
    const res = await POST(
      makeRequest({ authorization: "Bearer cron-secret", body: { dryRun: false, limit: 50 } })
    );
    expect(res.status).toBe(200);
    expect(runCampaignMock).toHaveBeenCalledWith({ dryRun: false, limit: 50 });
  });

  it("rejects a non-numeric or non-positive limit", async () => {
    for (const limit of ["50", -1, 0, Number.NaN]) {
      const res = await POST(
        makeRequest({ authorization: "Bearer cron-secret", body: { limit } })
      );
      expect(res.status).toBe(400);
    }
    expect(runCampaignMock).not.toHaveBeenCalled();
  });

  it("surfaces the env-gate block with a clear message", async () => {
    runCampaignMock.mockResolvedValue({
      ...DRY_SUMMARY,
      dryRun: false,
      blockedBy: "WARM_POOL_CAMPAIGN_ENABLED",
    });
    const res = await POST(
      makeRequest({ authorization: "Bearer cron-secret", body: { dryRun: false } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.blockedBy).toBe("WARM_POOL_CAMPAIGN_ENABLED");
    expect(body.data.message).toContain("WARM_POOL_CAMPAIGN_ENABLED");
    expect(body.data.message).toContain("No email was sent");
  });

  it("400s invalid JSON", async () => {
    const req = new Request("http://localhost/api/admin/warm-pool-campaign", {
      method: "POST",
      headers: { authorization: "Bearer cron-secret" },
      body: "{not json",
    }) as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(runCampaignMock).not.toHaveBeenCalled();
  });

  it("500s when the database is not configured", async () => {
    mockSupabaseAdmin.value = null;
    const res = await POST(makeRequest({ authorization: "Bearer cron-secret" }));
    expect(res.status).toBe(500);
    expect(runCampaignMock).not.toHaveBeenCalled();
  });

  it("500s when the sweep throws", async () => {
    runCampaignMock.mockRejectedValue(new Error("boom"));
    const res = await POST(makeRequest({ authorization: "Bearer cron-secret" }));
    expect(res.status).toBe(500);
  });
});
