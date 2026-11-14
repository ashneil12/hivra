import { NextRequest } from "next/server";

import { createSupabaseMemoryDb } from "@/test-utils/supabase-memory-db";

import { POST } from "../route";
import { reportOpsEvent } from "@/lib/ops-events";

const mockDb: { current: unknown } = { current: null };
const mockUser = { current: "user_me" as string | null };

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(async () => ({ userId: mockUser.current })),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: jest.fn(() => null),
  RATE_LIMIT_PRESETS: { settingsWrite: { limit: 60, windowMs: 60_000 } },
}));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn().mockResolvedValue({ fingerprint: "fp" }) }));
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb.current;
  },
}));

const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";
const MY_AGENT = "33333333-3333-4333-8333-333333333333";

function report(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/support/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.current = "user_me";
  mockDb.current = createSupabaseMemoryDb({
    tables: ["hermes_instances", "hivra_agents"],
    seed: {
      hermes_instances: [
        { id: MINE, user_id: "user_me" },
        { id: THEIRS, user_id: "user_someone_else" },
      ],
      hivra_agents: [{ id: MY_AGENT, user_id: "user_me" }],
    },
  }).db;
});

describe("POST /api/support/report", () => {
  it("attaches the report to an instance the caller owns", async () => {
    const res = await report({ surface: "deploy", summary: "Stuck", instanceId: MINE });

    expect(res.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: MINE, userId: "user_me", metadata: { surface: "deploy", summary: "Stuck" } })
    );
  });

  it("attaches the report to a Hivra agent the caller owns", async () => {
    await report({ surface: "deploy", summary: "Stuck", instanceId: MY_AGENT });

    expect(reportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({ instanceId: MY_AGENT }));
  });

  it("drops an instance id the caller does not own instead of writing into that feed", async () => {
    const res = await report({ surface: "deploy", summary: "Stuck", instanceId: THEIRS });

    expect(res.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: null,
        metadata: { surface: "deploy", summary: "Stuck", instanceIdDropped: true },
      })
    );
  });

  it("keeps control characters and line breaks out of the ops event title", async () => {
    await report({ surface: "deploy", summary: "Line one\r\nBcc: someone‮evil", errorContext: "boom\u0007" });

    const call = (reportOpsEvent as jest.Mock).mock.calls[0][0];
    expect(call.title).toBe("Support report: Line one Bcc: someoneevil");
    expect(call.message).toBe('User reported a problem from "deploy". Error: boom');
  });
});
