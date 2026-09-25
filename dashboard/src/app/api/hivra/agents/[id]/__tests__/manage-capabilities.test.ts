import { NextRequest } from "next/server";
import { GET } from "../route";

// GET /api/hivra/agents/[id] sends the Manage capability map with every
// agent, for every kind of computer, computed from the stored row without any
// extra host call, and without the row's private fields.

const mockAuth = jest.fn();
const mockRunHostScript = jest.fn();
const mockAfterResponse = jest.fn();
const mockMatchPrepared = jest.fn();
let mockRow: Record<string, unknown>;

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(async () => ({ data: mockRow, error: null })),
      maybeSingle: jest.fn(async () => ({ data: mockRow, error: null })),
    }),
    rpc: jest.fn(async () => ({ data: false, error: null })),
  },
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: () => ({ env: {} }),
  runProxmoxHostScript: (...args: unknown[]) => mockRunHostScript(...args),
}));
jest.mock("@/lib/hivra/after-response", () => ({ runAfterResponse: (...args: unknown[]) => mockAfterResponse(...args) }));
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({ matchPreparedCanaryComputer: (...args: unknown[]) => mockMatchPrepared(...args) }));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn(async () => undefined) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const base = {
  id: "11111111-1111-4111-8111-111111111111", user_id: "owner", name: "Fixture", status: "running", desired_state: "running",
  cpu: 2, ram: 4, vmid: 1113, ip: "10.250.20.63", proxmox_host: "fixturenode11", deployment_mode: "hivra-managed",
  infrastructure_binding_token_hash: "c".repeat(64), infrastructure_binding_token_enforced: true,
  operation_id: null, operation_kind: null, operation_payload: null, chat_url: null, api_token: null,
  bootstrapped_at: "2026-09-01T10:10:00.000Z", bankr_skills_seeded_at: "2026-09-01T10:10:00.000Z",
};

async function get(row: Record<string, unknown>) {
  mockRow = row;
  const response = await GET(new NextRequest(`https://hivra.cloud/api/hivra/agents/${row.id}`, { headers: { Host: "hivra.cloud" } }),
    { params: Promise.resolve({ id: String(row.id) }) });
  return { status: response.status, body: await response.json() as { data: { agent: Record<string, unknown> } } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockMatchPrepared.mockReturnValue(null);
});

describe("GET /api/hivra/agents/[id] manage map", () => {
  it.each([
    ["an Ubuntu computer on Proxmox", { ...base, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm" }, "ubuntu-proxmox"],
    ["a My cloud computer", { ...base, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null }, "my-cloud"],
    ["a DigitalOcean session", { ...base, type: "codex", computer_substrate: "do-managed-session", deployment_mode: "self-managed", vmid: null }, "digitalocean"],
    ["a Linux Sandbox", { ...base, type: "linux-desktop", computer_profile: "linux-terminal", computer_substrate: "gvisor", deployment_mode: "self-managed", vmid: null }, "linux-sandbox"],
  ])("adds it for %s without a host call", async (_kind, row, variant) => {
    const { status, body } = await get(row);
    expect(status).toBe(200);
    expect(body.data.agent.manage).toMatchObject({ version: 1, variant });
    expect(mockRunHostScript).not.toHaveBeenCalled();
    // The map is public output: no private field rides along.
    const manage = JSON.stringify(body.data.agent.manage);
    expect(manage).not.toContain("fixturenode11");
    expect(manage).not.toContain("c".repeat(64));
    if (row.deployment_mode === "hivra-managed") expect(manage).not.toContain("10.250.20.63");
    expect(body.data.agent).not.toHaveProperty("infrastructure_binding_token_hash");
    expect(body.data.agent).not.toHaveProperty("operation_payload");
  });

  it("uses the prepared slot match the lifecycle route uses", async () => {
    const row = { ...base, type: "linux-desktop", computer_profile: "windows", computer_substrate: "proxmox-kvm", managed_provisioner_channel: "canary", cpu: 4, ram: 8 };
    mockMatchPrepared.mockReturnValue({ profile: "windows", slot: {} });
    expect((await get(row)).body.data.agent.manage).toMatchObject({ variant: "prepared", power: { stop: { state: "available" } } });
    mockMatchPrepared.mockReturnValue(null);
    expect((await get(row)).body.data.agent.manage).toMatchObject({ variant: "prepared", power: { stop: { state: "unavailable", code: "prepared_mismatch" } } });
  });

  it("tells the page an older unbound computer has no restore points", async () => {
    const row = { ...base, type: "codex", computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: false };
    const manage = (await get(row)).body.data.agent.manage as { restorePoints: { state: string }; sections: string[] };
    expect(manage.restorePoints.state).toBe("unavailable");
    expect(manage.sections).not.toContain("recovery");
  });
});
