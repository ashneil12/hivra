/** @jest-environment node */
import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockAgent = jest.fn();
const mockStatus = jest.fn();
const mockAdvance = jest.fn();
const mockAdvanceProvider = jest.fn();
const mockPrepare = jest.fn();
const mockSendSetup = jest.fn();
const mockContext = jest.fn();
const mockRateLimit = jest.fn();
const queries: Array<Array<[string, unknown]>> = [];

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: { settingsWrite: { limit: 10, windowMs: 60_000 } },
  enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const filters: Array<[string, unknown]> = [];
      queries.push(filters);
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        neq: (column: string, value: unknown) => { filters.push([`not ${column}`, value]); return builder; },
        maybeSingle: async () => ({ data: mockAgent(filters), error: null }),
      };
      return builder;
    },
  },
}));
jest.mock("@/lib/hivra/computer-contract-delivery", () => ({
  computerContractStatusFor: (...args: unknown[]) => mockStatus(...args),
  advanceProxmoxComputerContract: (...args: unknown[]) => mockAdvance(...args),
  advanceProviderComputerContract: (...args: unknown[]) => mockAdvanceProvider(...args),
  prepareComputerContractRevision: (...args: unknown[]) => mockPrepare(...args),
}));
jest.mock("@/lib/hivra/do-managed-sessions", () => ({
  ...jest.requireActual("@/lib/hivra/do-managed-sessions"),
  sendManagedSessionSetupNote: (...args: unknown[]) => mockSendSetup(...args),
}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({
  resolveHivraAgentExecutionContext: (...args: unknown[]) => mockContext(...args),
  describeHivraAgentExecutionContextError: () => null,
}));

import { GET, POST } from "../route";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ id: AGENT_ID }) };
const CODEX = { id: AGENT_ID, user_id: "user_1", type: "codex", name: "Codex 1", status: "running", ip: "10.253.0.9",
  computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", cpu: 1.5, ram: 3 };
const DO_CODEX = { ...CODEX, ip: null, computer_substrate: "do-managed-session", deployment_mode: "self-managed", cpu: 2, ram: 4 };
const TRACKED = { kind: "tracked", channel: "proxmox-seed", revision: 1, state: "delivered" };

function get() {
  return new NextRequest(`https://hivra.cloud/api/hivra/agents/${AGENT_ID}/computer-contract`, { headers: { host: "hivra.cloud" } });
}
function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`https://hivra.cloud/api/hivra/agents/${AGENT_ID}/computer-contract`, {
    method: "POST",
    headers: { host: "hivra.cloud", origin: "https://hivra.cloud", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let row: Record<string, unknown> | null;
beforeEach(() => {
  queries.length = 0;
  row = CODEX;
  mockAuth.mockReset().mockResolvedValue({ userId: "user_1" });
  mockAgent.mockReset().mockImplementation(() => row);
  mockStatus.mockReset().mockResolvedValue(TRACKED);
  mockAdvance.mockReset().mockResolvedValue({ ...TRACKED, checkedAt: "2026-09-24T12:00:00.000Z" });
  mockAdvanceProvider.mockReset().mockResolvedValue({ ...TRACKED, channel: "provider-seed" });
  mockPrepare.mockReset().mockResolvedValue({ revision: 1 });
  mockSendSetup.mockReset().mockResolvedValue({ runId: "run_1", revision: 1 });
  mockContext.mockReset().mockResolvedValue({ env: { PROXMOX_NODE: "fixturenode10" } });
  mockRateLimit.mockReset().mockReturnValue(null);
});

describe("GET /api/hivra/agents/[id]/computer-contract", () => {
  it("reports status for the owner's agent only, storing the current revision without contacting the computer", async () => {
    const response = await GET(get(), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: { contract: TRACKED } });
    expect(queries[0]).toEqual(expect.arrayContaining([["id", AGENT_ID], ["user_id", "user_1"], ["not status", "deleted"]]));
    // Manage can show the exact text and revision before delivery.
    expect(mockPrepare).toHaveBeenCalledWith("user_1", CODEX);
    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockContext).not.toHaveBeenCalled();
  });

  it("returns 404 for an agent the caller does not own and 401 when signed out", async () => {
    row = null;
    expect((await GET(get(), params)).status).toBe(404);
    mockAuth.mockResolvedValue({ userId: null });
    expect((await GET(get(), params)).status).toBe(401);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("prepares a DigitalOcean agent's current note so Manage can offer it, sending nothing", async () => {
    row = DO_CODEX;
    await GET(get(), params);
    expect(mockPrepare).toHaveBeenCalledWith("user_1", DO_CODEX);
    expect(mockSendSetup).not.toHaveBeenCalled();
  });
});

describe("POST /api/hivra/agents/[id]/computer-contract", () => {
  it.each(["deliver", "check", "restore"])("runs %s through the owner-scoped execution context", async (action) => {
    const response = await POST(post({ action }), params);
    expect(response.status).toBe(200);
    expect(mockContext).toHaveBeenCalledWith("user_1", CODEX);
    expect(mockAdvance).toHaveBeenCalledWith("user_1", CODEX, { PROXMOX_NODE: "fixturenode10" }, action, { deadline: expect.any(Number) });
  });

  it("gives each step a deadline inside the route's 60 s budget", async () => {
    const before = Date.now();
    await POST(post({ action: "deliver" }), params);
    const { deadline } = mockAdvance.mock.calls[0][4] as { deadline: number };
    expect(deadline).toBeGreaterThanOrEqual(before + 50_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 55_000);
  });

  it.each(["deliver", "check", "restore"])("runs %s for a computer in the owner's own cloud over its enrolled pin, never the Proxmox host", async (action) => {
    row = { ...CODEX, computer_substrate: "provider-vm", deployment_mode: "self-managed" };
    const response = await POST(post({ action }), params);
    expect(response.status).toBe(200);
    expect(mockAdvanceProvider).toHaveBeenCalledWith("user_1", row, action, { deadline: expect.any(Number) });
    expect(mockContext).not.toHaveBeenCalled();
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("sends a DigitalOcean note only as the owner's explicit visible message", async () => {
    row = DO_CODEX;
    expect((await POST(post({ action: "deliver" }), params)).status).toBe(400);
    const response = await POST(post({ action: "send" }), params);
    expect(response.status).toBe(200);
    expect(mockSendSetup).toHaveBeenCalledWith("user_1", AGENT_ID);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("refuses cross-site requests, unknown actions and extra fields before any lookup", async () => {
    expect((await POST(post({ action: "deliver" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }), params)).status).toBe(403);
    expect((await POST(post({ action: "wipe" }), params)).status).toBe(400);
    expect((await POST(post({ action: "deliver", force: true }), params)).status).toBe(400);
    expect(queries).toHaveLength(0);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("says why nothing was sent for a stopped computer or a runtime with its own instructions", async () => {
    row = { ...CODEX, status: "stopped" };
    const stopped = await POST(post({ action: "deliver" }), params);
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toMatchObject({ error: "The computer must be running before Hivra can update it." });
    row = { ...CODEX, type: "openclaw" };
    expect((await POST(post({ action: "deliver" }), params)).status).toBe(409);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("is rate limited per owner", async () => {
    mockRateLimit.mockReturnValueOnce(new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }));
    expect((await POST(post({ action: "check" }), params)).status).toBe(429);
    expect(mockRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ routeKey: "hivra_computer_contract_post", userId: "user_1" }));
    expect(mockAdvance).not.toHaveBeenCalled();
  });
});
