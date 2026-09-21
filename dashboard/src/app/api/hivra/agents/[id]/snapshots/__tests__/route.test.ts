import { NextRequest } from "next/server";
import { GET } from "../route";

const mockAuth = jest.fn();
const mockFrom = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));

function request() {
  return new NextRequest("https://hivra.cloud/api/hivra/agents/agent-1/snapshots", {
    headers: { Host: "hivra.cloud" },
  });
}

function query<T>(terminal: () => Promise<T>) {
  const chain: Record<string, jest.Mock> = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.neq = jest.fn(() => chain);
  chain.order = jest.fn(terminal);
  chain.maybeSingle = jest.fn(terminal);
  return chain;
}

describe("GET /api/hivra/agents/[id]/snapshots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "owner-1" });
    mockFrom.mockImplementation((table: string) => {
      if (table === "hivra_agents") {
        return query(async () => ({ data: { id: "agent-1", computer_substrate: "proxmox-kvm" }, error: null }));
      }
      return query(async () => ({
        data: [{
          id: "snapshot-1",
          status: "ready",
          retention_policy: "until_agent_delete",
          created_at: "2026-08-30T12:00:00.000Z",
          ready_at: "2026-08-30T12:00:01.000Z",
          last_restored_at: null,
          restore_count: 0,
          last_error: null,
          provider_snapshot_id: "must-not-leak",
          snapshot_config_sha256: "must-not-leak",
        }],
        error: null,
      }));
    });
  });

  it("returns owner-scoped display metadata without provider identities", async () => {
    const response = await GET(request(), { params: Promise.resolve({ id: "agent-1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      data: {
        supported: true,
        maximum: 5,
        snapshots: [{
          id: "snapshot-1",
          status: "ready",
          retentionPolicy: "until_agent_delete",
          createdAt: "2026-08-30T12:00:00.000Z",
          readyAt: "2026-08-30T12:00:01.000Z",
          lastRestoredAt: null,
          restoreCount: 0,
          error: null,
        }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("does not query restore points for a provider-native computer", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table !== "hivra_agents") throw new Error("unexpected snapshot query");
      return query(async () => ({ data: { id: "agent-1", computer_substrate: "provider-vm" }, error: null }));
    });
    const response = await GET(request(), { params: Promise.resolve({ id: "agent-1" }) });
    expect(await response.json()).toEqual({ success: true, data: { snapshots: [], supported: false } });
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("requires authentication before reading an owner row", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    expect((await GET(request(), { params: Promise.resolve({ id: "agent-1" }) })).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("fails closed for another tenant's agent without querying its restore points", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table !== "hivra_agents") throw new Error("foreign restore points must not be queried");
      return query(async () => ({ data: null, error: null }));
    });

    const response = await GET(request(), { params: Promise.resolve({ id: "foreign-agent" }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: "Agent not found" });
    expect(mockFrom).toHaveBeenCalledTimes(1);
    const agentQuery = mockFrom.mock.results[0]?.value;
    expect(agentQuery.eq).toHaveBeenCalledWith("id", "foreign-agent");
    expect(agentQuery.eq).toHaveBeenCalledWith("user_id", "owner-1");
  });
});
