import { NextRequest } from "next/server";

const mockProvision = jest.fn();
const mockCount = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn().mockResolvedValue({ userId: "user_ws" }),
  currentUser: jest.fn().mockResolvedValue({
    primaryEmailAddress: { emailAddress: "ws@example.com" },
  }),
}));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn().mockReturnValue({ success: true }),
  getIP: jest.fn().mockReturnValue("127.0.0.1"),
}));
jest.mock("@/lib/abuse/gate", () => ({
  checkProvisioningGate: jest.fn().mockResolvedValue({ allow: true }),
}));
jest.mock("@/lib/instance-settings", () => ({
  getPublicInstanceConfig: (config: unknown) => config,
}));
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveWorkspaceCloudEntitlement: jest.fn().mockResolvedValue({ instance_limit: 2 }),
}));
jest.mock("@/lib/services/workspace-cloud-provisioner", () => ({
  provisionWorkspaceCloudAgent: (...args: unknown[]) => mockProvision(...args),
}));
jest.mock("@/lib/supabase", () => {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    // The count query is awaited directly, so the chain itself is thenable.
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(mockCount()).then(resolve, reject),
  };
  return { supabaseAdmin: { from: jest.fn(() => query) } };
});

import { POST } from "../route";

function createRequest() {
  return new NextRequest("http://localhost:3000/api/workspace-cloud/instances", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ops agent" }),
  });
}

describe("POST /api/workspace-cloud/instances instance limit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProvision.mockResolvedValue({ ok: true, instance: { id: "inst_new" } });
  });

  it("fails closed with a 500 when the instance count query returns an error", async () => {
    mockCount.mockResolvedValue({ count: null, error: { code: "08006", message: "connection lost" } });

    const response = await POST(createRequest());

    expect(response.status).toBe(500);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("fails closed with a 500 when the count comes back null without an error", async () => {
    mockCount.mockResolvedValue({ count: null, error: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(500);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("refuses a create at the lane's instance limit", async () => {
    mockCount.mockResolvedValue({ count: 2, error: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(403);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("provisions when the count is readable and below the limit", async () => {
    mockCount.mockResolvedValue({ count: 1, error: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(mockProvision).toHaveBeenCalledWith({ userId: "user_ws", name: "Ops agent" });
  });
});
