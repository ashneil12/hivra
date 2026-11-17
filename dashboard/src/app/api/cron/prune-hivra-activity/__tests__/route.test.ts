import { NextRequest } from "next/server";

import { GET } from "../route";
import { runInboxPromptRetention } from "@/lib/agent-inbox/retention";
import { runActivityRetention } from "@/lib/ops/activity-retention";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/ops/activity-retention", () => ({
  runActivityRetention: jest.fn(),
}));
jest.mock("@/lib/agent-inbox/retention", () => ({ runInboxPromptRetention: jest.fn() }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: jest.fn() } }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const zero = { expiredEvents: 0, deletedComputerEvents: 0, deletedComputerCollectors: 0 };
const summary = (overrides: Record<string, unknown> = {}) => ({
  dryRun: true,
  enabled: false,
  retentionDays: 90,
  cutoff: "2026-06-25T00:00:00.000Z",
  eligible: { expiredEvents: 4, deletedComputerEvents: 2, deletedComputerCollectors: 1 },
  deleted: zero,
  batches: 0,
  complete: true,
  ...overrides,
});
const inboxSummary = (overrides: Record<string, unknown> = {}) => ({
  dryRun: false,
  retentionDays: 7,
  cutoff: "2026-11-10T00:00:00.000Z",
  deleted: 0,
  ...overrides,
});

describe("GET /api/cron/prune-hivra-activity", () => {
  const originalEnv = process.env;
  const mockedRun = runActivityRetention as jest.MockedFunction<typeof runActivityRetention>;
  const mockedReport = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;
  const mockedInbox = runInboxPromptRetention as jest.MockedFunction<typeof runInboxPromptRetention>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedInbox.mockResolvedValue(inboxSummary());
    process.env = { ...originalEnv, CRON_SECRET: "expected-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (authorization?: string, query = "") =>
    new Request(`http://localhost/api/cron/prune-hivra-activity${query}`, {
      headers: authorization ? { authorization } : {},
    }) as unknown as NextRequest;

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects requests with the wrong bearer", async () => {
    const res = await GET(makeRequest("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("returns dry-run counts without an ops event", async () => {
    mockedRun.mockResolvedValue(summary());
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ...summary(), inboxPrompts: inboxSummary() });
    expect(mockedRun).toHaveBeenCalledWith(expect.anything(), { forceDryRun: false });
    expect(mockedReport).not.toHaveBeenCalled();
  });

  it("clears closed Needs you requests in the same run, whatever the activity switch says", async () => {
    mockedRun.mockResolvedValue(summary());
    mockedInbox.mockResolvedValue(inboxSummary({ deleted: 3 }));
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(200);
    expect(mockedInbox).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
    expect((await res.json()).data.inboxPrompts).toEqual(inboxSummary({ deleted: 3 }));
  });

  it("only counts closed Needs you requests with ?dryRun=1", async () => {
    mockedRun.mockResolvedValue(summary());
    await GET(makeRequest("Bearer expected-secret", "?dryRun=1"));
    expect(mockedInbox).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it("answers 500 when the Needs you step fails, after the activity prune ran", async () => {
    mockedRun.mockResolvedValue(summary());
    mockedInbox.mockRejectedValue(new Error("boom"));
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
    expect(mockedRun).toHaveBeenCalled();
  });

  it("forces a dry run with ?dryRun=1", async () => {
    mockedRun.mockResolvedValue(summary());
    await GET(makeRequest("Bearer expected-secret", "?dryRun=1"));
    expect(mockedRun).toHaveBeenCalledWith(expect.anything(), { forceDryRun: true });
  });

  it("records an ops event when rows were deleted", async () => {
    mockedRun.mockResolvedValue(
      summary({
        dryRun: false,
        enabled: true,
        deleted: { expiredEvents: 4, deletedComputerEvents: 2, deletedComputerCollectors: 1 },
        batches: 1,
      })
    );
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(200);
    expect(mockedReport).toHaveBeenCalledWith(
      expect.objectContaining({ source: "cron.prune_hivra_activity", severity: "info" })
    );
  });

  it("returns 500 when retention throws", async () => {
    mockedRun.mockRejectedValue(new Error("boom"));
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
  });
});
