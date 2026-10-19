/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET, PATCH } from "../route";
import { AGENT_CLI_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockReadBox = jest.fn();
const mockLogEvent = jest.fn();
let mockAgentRow: Record<string, unknown> | null;
let mockRecord: Record<string, unknown> | null;
const writes: Array<{ op: string; payload: unknown }> = [];

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock("@/lib/hivra/agent-cli-meta", () => ({ readAgentSoftwareFromBox: (...args: unknown[]) => mockReadBox(...args) }));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: (...args: unknown[]) => mockLogEvent(...args) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => { filters[column] = value; return chain; },
        neq: () => chain,
        maybeSingle: async () => {
          if (table === "hivra_agents") {
            return { data: mockAgentRow && mockAgentRow.id === filters.id && mockAgentRow.user_id === filters.user_id ? mockAgentRow : null, error: null };
          }
          return { data: mockRecord, error: null };
        },
        insert: (payload: Record<string, unknown>) => { writes.push({ op: "insert", payload }); mockRecord = { ...payload, updated_at: "2026-09-25T12:00:00Z" }; return { select: async () => ({ data: [{}], error: null }) }; },
        update: (payload: Record<string, unknown>) => {
          writes.push({ op: "update", payload });
          mockRecord = { ...mockRecord, ...payload };
          const update = { eq: () => update, select: async () => ({ data: [{}], error: null }) };
          return update;
        },
        upsert: async (payload: Record<string, unknown>) => { writes.push({ op: "upsert", payload }); mockRecord = { ...mockRecord, ...payload }; return { error: null }; },
      };
      return chain;
    },
  },
}));

const ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "c".repeat(64);
const TESTED = AGENT_CLI_VERSIONS.codex;
const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const get = (query = "") => GET(new NextRequest(`https://hivra.cloud/api/hivra/agents/${ID}/agent-software${query}`, { headers: { Host: "hivra.cloud" } }), params());
function patch(body: unknown, headers: Record<string, string> = { Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin" }) {
  return PATCH(new NextRequest(`https://hivra.cloud/api/hivra/agents/${ID}/agent-software`, {
    method: "PATCH", headers: { Host: "hivra.cloud", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }), params());
}
const fresh = () => new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  writes.length = 0;
  delete process.env.HIVRA_AGENT_CLI_AUTO_UPDATE;
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockRateLimit.mockReturnValue(null);
  mockAgentRow = {
    id: ID, user_id: "owner", type: "codex", status: "running", deployment_mode: "hivra-managed",
    computer_profile: null, computer_substrate: "proxmox-kvm",
    chat_url: "https://box-7f3a.hivra.example", cf_hostname: "box-7f3a.hivra.example", api_token: TOKEN,
  };
  mockRecord = null;
  mockReadBox.mockResolvedValue({ observation: "reported", report: { name: "codex", version: "0.140.0", update: null } });
});

describe("GET", () => {
  it("reads the computer when nothing is stored and answers with public fields only", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.data).toMatchObject({
      supported: true, cli: "codex", tested: TESTED,
      view: { kind: "behind", installed: "0.140.0" },
      autoUpdate: { mode: "off", enabled: true, source: "default", pausedFor: null },
    });
    expect(mockReadBox).toHaveBeenCalledWith(expect.objectContaining({ chatUrl: "https://box-7f3a.hivra.example", apiToken: TOKEN, subject: expect.objectContaining({ cli: "codex" }) }));
    const text = JSON.stringify(body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("box-7f3a");
    expect(writes[0]).toMatchObject({ op: "insert", payload: expect.objectContaining({ installed_version: "0.140.0", observation: "reported" }) });
  });

  it("answers from a fresh stored reading without reading the computer, and reads it again when asked", async () => {
    mockRecord = { agent_id: ID, user_id: "owner", observation: "reported", installed_version: TESTED, observed_at: fresh(), updated_at: fresh() };
    const stored = await (await get()).json();
    expect(stored.data.view).toEqual({ kind: "current", installed: TESTED });
    expect(mockReadBox).not.toHaveBeenCalled();
    await get("?live=1");
    expect(mockReadBox).toHaveBeenCalledTimes(1);
  });

  it("reads a stale stored reading again", async () => {
    mockRecord = { agent_id: ID, user_id: "owner", observation: "reported", installed_version: TESTED, observed_at: new Date(Date.now() - 11 * 60_000).toISOString() };
    await get();
    expect(mockReadBox).toHaveBeenCalledTimes(1);
  });

  it("never reads a stopped agent's computer", async () => {
    mockAgentRow = { ...mockAgentRow, status: "stopped" };
    const body = await (await get("?live=1")).json();
    expect(body.data.view).toEqual({ kind: "not_running" });
    expect(mockReadBox).not.toHaveBeenCalled();
  });

  it("says nothing for an agent Hivra doesn't check here, without reading it", async () => {
    mockAgentRow = { ...mockAgentRow, type: "deepseek-harness" };
    expect((await (await get("?live=1")).json()).data).toEqual({ supported: false });
    mockAgentRow = { ...mockAgentRow, type: "linux-desktop", computer_profile: "ubuntu-desktop" };
    expect((await (await get()).json()).data).toEqual({ supported: false });
    expect(mockReadBox).not.toHaveBeenCalled();
  });

  it("reports the rollout switch and the owner's choice", async () => {
    process.env.HIVRA_AGENT_CLI_AUTO_UPDATE = "on";
    mockAgentRow = { ...mockAgentRow, deployment_mode: "self-managed" };
    mockRecord = { agent_id: ID, user_id: "owner", observation: "reported", installed_version: TESTED, observed_at: fresh(), auto_paused_target: TESTED, auto_paused_reason: "rolled_back" };
    const body = await (await get()).json();
    expect(body.data.autoUpdate).toEqual({ mode: "on", enabled: false, source: "default", pausedFor: { target: TESTED, reason: "rolled_back" } });
  });

  it.each([
    ["another owner's agent", { userId: "someone-else" }, ID],
    ["a malformed id", { userId: "owner" }, "not-a-uuid"],
  ])("answers 404 for %s", async (_case, session, id) => {
    mockAuth.mockResolvedValue(session);
    const response = await GET(new NextRequest(`https://hivra.cloud/api/hivra/agents/${id}/agent-software`, { headers: { Host: "hivra.cloud" } }), params(id));
    expect(response.status).toBe(404);
    expect(mockReadBox).not.toHaveBeenCalled();
  });

  it("requires sign-in and is rate limited", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await get()).status).toBe(401);
    mockRateLimit.mockReturnValueOnce(new Response("Slow down", { status: 429 }));
    expect((await get()).status).toBe(429);
    expect(mockReadBox).not.toHaveBeenCalled();
  });
});

describe("PATCH", () => {
  it("saves the owner's choice and records it", async () => {
    process.env.HIVRA_AGENT_CLI_AUTO_UPDATE = "on";
    const response = await patch({ autoUpdate: false });
    expect(response.status).toBe(200);
    expect(writes[0]).toMatchObject({ op: "upsert", payload: expect.objectContaining({ agent_id: ID, user_id: "owner", auto_update: false }) });
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_cli_auto_update_changed", agentId: ID, detail: { enabled: false } }));
    expect((await response.json()).data.autoUpdate).toMatchObject({ mode: "on", enabled: false, source: "owner" });
    expect(mockReadBox).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([{ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, {}])("refuses a request from another site %j", async (headers) => {
    expect((await patch({ autoUpdate: true }, headers)).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it.each([[{ autoUpdate: "yes" }], [{}], [{ autoUpdate: true, extra: 1 }]])("refuses a malformed body %j", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("refuses an agent without a CLI Hivra updates, and another owner's agent", async () => {
    mockAgentRow = { ...mockAgentRow, type: "aeon" };
    expect((await patch({ autoUpdate: true })).status).toBe(400);
    mockAuth.mockResolvedValue({ userId: "someone-else" });
    expect((await patch({ autoUpdate: true })).status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it("is rate limited", async () => {
    mockRateLimit.mockReturnValueOnce(new Response("Slow down", { status: 429 }));
    expect((await patch({ autoUpdate: true })).status).toBe(429);
    expect(writes).toHaveLength(0);
  });
});
