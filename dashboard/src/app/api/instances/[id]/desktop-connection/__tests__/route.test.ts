import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { getSecureUserInstance } from "@/lib/services/instance-security";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
}));

const call = (id = "inst-123") =>
  GET(new Request(`http://localhost/api/instances/${id}/desktop-connection`), {
    params: Promise.resolve({ id }),
  });

describe("/api/instances/[id]/desktop-connection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user-123" });
    (getSecureUserInstance as jest.Mock).mockResolvedValue({
      instance: {
        id: "inst-123",
        name: "my-agent",
        status: "running",
        backend: "webui",
        gateway_url: "https://agent.example.com",
      },
      apiServerKey: "secret-bearer-xyz",
      instanceIpv4: "203.0.113.4",
      error: null,
    });
  });

  it("returns the /desktop gateway URL and the instance bearer for the owner", async () => {
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.gatewayUrl).toBe("https://agent.example.com/desktop");
    expect(body.data.token).toBe("secret-bearer-xyz");
    expect(body.data.instanceName).toBe("my-agent");
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    expect(res.headers.get("Pragma")).toBe("no-cache");
  });

  it("401s when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("404s when the instance is not found / not owned", async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValue({
      instance: null,
      apiServerKey: "",
      instanceIpv4: "",
      error: "Instance not found or unauthorized",
    });
    const res = await call();
    expect(res.status).toBe(404);
    expect(getSecureUserInstance).toHaveBeenCalledWith({
      id: "inst-123",
      userId: "user-123",
      requireRunning: true,
    });
    expect(JSON.stringify(await res.json())).not.toContain("secret-bearer-xyz");
  });

  it("treats a gateway backend like webfree — returns the /desktop URL (gateway≡webfree collapse)", async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValue({
      instance: {
        id: "inst-123",
        name: "my-agent",
        status: "running",
        backend: "gateway",
        gateway_url: "https://agent.example.com",
      },
      apiServerKey: "secret-bearer-xyz",
      instanceIpv4: "203.0.113.4",
      error: null,
    });
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.gatewayUrl).toBe("https://agent.example.com/desktop");
    expect(body.data.token).toBe("secret-bearer-xyz");
    expect(body.data.instanceName).toBe("my-agent");
  });

  it("upgrades sslip.io http gateways to https before appending /desktop", async () => {
    (getSecureUserInstance as jest.Mock).mockResolvedValue({
      instance: {
        id: "inst-123",
        status: "running",
        backend: "webui",
        gateway_url: "http://203-0-113-11.sslip.io",
      },
      apiServerKey: "secret-bearer-xyz",
      instanceIpv4: "203.0.113.11",
      error: null,
    });
    const res = await call();
    const body = await res.json();
    expect(body.data.gatewayUrl).toBe("https://203-0-113-11.sslip.io/desktop");
  });
});
