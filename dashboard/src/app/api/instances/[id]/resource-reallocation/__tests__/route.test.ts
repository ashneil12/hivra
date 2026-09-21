import { POST } from "../route";

const mockAuth = jest.fn();
const mockFrom = jest.fn();
const mockResizeProxmoxVm = jest.fn();
const mockGetInfrastructure = jest.fn();
const mockGetHostRouting = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  getProxmoxInfrastructure: (...args: unknown[]) => mockGetInfrastructure(...args),
  getProxmoxHostRoutingConfigFromInfrastructure: (...args: unknown[]) => mockGetHostRouting(...args),
  resizeProxmoxVm: (...args: unknown[]) => mockResizeProxmoxVm(...args),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function request(body: Record<string, unknown>) {
  return new Request("https://hermesos.cloud/api/instances/pike/resource-reallocation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/instances/[id]/resource-reallocation", () => {
  const instance = {
    id: "pike",
    user_id: "user-1",
    cpu_limit: 4,
    ram_limit: 8192,
    resource_tier: "fleet",
    config: { infrastructure: { provider: "proxmox" } },
    host_id: "host-fixturenode13",
    status: "running",
  };
  const infrastructure = {
    provider: "proxmox",
    node: "fixturenode13",
    vmid: 1302,
    privateIpv4: "10.250.20.52",
    gatewayHost: "gateway.hermesos.cloud",
    hostEnvPrefix: "PROXMOX_FIXTURENODE13_",
  };
  const hostConfig = { hostId: "host-fixturenode13", hostSlug: "fixturenode13", envPrefix: "PROXMOX_FIXTURENODE13_", failClosed: true };
  let updateMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockGetInfrastructure.mockReturnValue(infrastructure);
    mockGetHostRouting.mockReturnValue(hostConfig);
    mockResizeProxmoxVm.mockResolvedValue({ ok: true, stdout: "resized", stderr: "" });

    const selectChain: Record<string, jest.Mock> = {};
    selectChain.select = jest.fn(() => selectChain);
    selectChain.eq = jest.fn(() => selectChain);
    selectChain.neq = jest.fn(() => selectChain);
    selectChain.single = jest.fn(async () => ({ data: instance, error: null }));

    const updateChain: Record<string, unknown> = {};
    updateChain.eq = jest.fn(() => updateChain);
    updateChain.then = (resolve: (value: { error: null }) => void) => resolve({ error: null });
    updateMock = jest.fn(() => updateChain);
    mockFrom.mockReturnValue({ select: selectChain.select, update: updateMock });
  });

  it("shrinks the owner VM on its recorded host before saving freed capacity", async () => {
    const res = await POST(request({ cpuLimit: 2, ramLimit: 4096 }) as never, { params: Promise.resolve({ id: "pike" }) });

    expect(res.status).toBe(200);
    expect(mockResizeProxmoxVm).toHaveBeenCalledWith(
      expect.objectContaining({ vmid: 1302, node: "fixturenode13", cpuLimit: 2, memoryMb: 4096 }),
      { hostConfig },
    );
    expect(mockGetHostRouting).toHaveBeenCalledWith(infrastructure, { host_id: "host-fixturenode13" });
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ cpu_limit: 2, ram_limit: 4096 }));
  });

  it("rejects growth because pool-aware growth belongs to the normal controls", async () => {
    const res = await POST(request({ cpuLimit: 5, ramLimit: 8192 }) as never, { params: Promise.resolve({ id: "pike" }) });

    expect(res.status).toBe(400);
    expect(mockResizeProxmoxVm).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not save freed capacity when the host resize fails", async () => {
    mockResizeProxmoxVm.mockResolvedValue({ ok: false, error: "host unavailable", stdout: "", stderr: "" });
    const res = await POST(request({ cpuLimit: 2, ramLimit: 4096 }) as never, { params: Promise.resolve({ id: "pike" }) });

    expect(res.status).toBe(502);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("requires the authenticated owner", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const res = await POST(request({ cpuLimit: 2, ramLimit: 4096 }) as never, { params: Promise.resolve({ id: "pike" }) });

    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockResizeProxmoxVm).not.toHaveBeenCalled();
  });
});
