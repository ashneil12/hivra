import { NextRequest } from "next/server";
import { GET } from "../route";
import { COMPUTER_HISTORY_LIMIT } from "@/lib/hivra/computer-history";

// A computer's history for Manage › Advanced: owner-scoped, the last 20
// lifecycle events, and never the stored detail (failure details can carry
// host names and raw error text).

const mockAuth = jest.fn();
const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
let mockAgent: Record<string, unknown> | null;
let mockEvents: Array<Record<string, unknown>>;
let mockEventsError: unknown = null;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "in", "order", "limit"]) {
        chain[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          if (table === "hivra_agent_events" && method === "limit") {
            return Promise.resolve({ data: mockEvents.slice(0, Number(args[0])), error: mockEventsError });
          }
          return chain;
        };
      }
      chain.maybeSingle = async () => ({ data: mockAgent, error: null });
      return chain;
    },
  },
}));

const ID = "11111111-2222-4333-8444-555555555555";
const get = (id = ID) => GET(new NextRequest(`https://hivra.cloud/api/hivra/agents/${id}/events`, { headers: { Host: "hivra.cloud" } }),
  { params: Promise.resolve({ id }) });

beforeEach(() => {
  calls.length = 0;
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockAgent = { id: ID };
  mockEventsError = null;
  mockEvents = [
    { event: "failed", created_at: "2026-09-24T12:00:00.000Z", detail: { reason: "provisioner_reported_failure", proxmox_host: "fixturenode11", error: "raw host text" } },
    { event: "runtime_updated", created_at: "2026-09-24T11:00:00.000Z", detail: { inPlace: true } },
    { event: "restarted", created_at: "2026-09-24T10:00:00.000Z", detail: {} },
  ];
});

describe("GET /api/hivra/agents/[id]/events", () => {
  it("returns the events as labels and times only, never the stored detail", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.data.events).toEqual([
      { event: "failed", createdAt: "2026-09-24T12:00:00.000Z", label: "Didn't come online" },
      { event: "runtime_updated", createdAt: "2026-09-24T11:00:00.000Z", label: "Connection service updated" },
      { event: "restarted", createdAt: "2026-09-24T10:00:00.000Z", label: "Restarted" },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("fixturenode11");
    expect(text).not.toContain("raw host text");
    // The query asks for the event and time only.
    expect(calls.find((call) => call.table === "hivra_agent_events" && call.method === "select")?.args[0]).toBe("event, created_at");
  });

  it("scopes both reads to the signed-in owner and reads at most 20 lifecycle events, newest first", async () => {
    await get();
    expect(calls).toEqual(expect.arrayContaining([
      { table: "hivra_agents", method: "eq", args: ["user_id", "owner"] },
      { table: "hivra_agents", method: "neq", args: ["status", "deleted"] },
      { table: "hivra_agent_events", method: "eq", args: ["agent_id", ID] },
      { table: "hivra_agent_events", method: "eq", args: ["user_id", "owner"] },
      { table: "hivra_agent_events", method: "order", args: ["created_at", { ascending: false }] },
      { table: "hivra_agent_events", method: "limit", args: [COMPUTER_HISTORY_LIMIT] },
    ]));
    expect(COMPUTER_HISTORY_LIMIT).toBe(20);
    // Agent-run telemetry shares the table and stays out of the history.
    const events = calls.find((call) => call.table === "hivra_agent_events" && call.method === "in")?.args[1] as string[];
    expect(events).toContain("runtime_updated");
    expect(events).not.toContain("otel_span");
  });

  it("answers 404 for another owner's computer, without reading its events", async () => {
    mockAgent = null;
    const response = await get();
    expect(response.status).toBe(404);
    expect(calls.some((call) => call.table === "hivra_agent_events")).toBe(false);
  });

  it("answers 404 for a malformed id and 401 when signed out", async () => {
    expect((await get("not-a-uuid")).status).toBe(404);
    mockAuth.mockResolvedValue({ userId: null });
    expect((await get()).status).toBe(401);
  });

  it("says the history couldn't load instead of returning a partial list", async () => {
    mockEventsError = { message: "down" };
    expect((await get()).status).toBe(503);
  });
});
