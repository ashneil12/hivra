import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isOpsAdminUser } from "@/lib/ops-access";
import { reportOpsEvent } from "@/lib/ops-events";
import { getProxmoxInfrastructure } from "@/lib/services/proxmox-infrastructure";
import { getProxmoxHostRoutingConfigFromInfrastructure } from "@/lib/services/proxmox-infrastructure";
import { shutdownProxmoxInstance } from "@/lib/services/proxmox-instance-service";
import { shutdownServer } from "@/lib/hetzner/client";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/ops-access", () => ({
  isOpsAdminUser: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
  sanitizeOpsMetadata: jest.fn(
    (metadata: Record<string, unknown> | undefined) => metadata ?? {}
  ),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-infrastructure", () => ({
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(),
}));

jest.mock("@/lib/hetzner/client", () => ({
  shutdownServer: jest.fn(),
}));

interface InstanceRow {
  id: string;
  user_id: string;
  hetzner_server_id?: number | null;
  host_id?: string | null;
  config?: Record<string, unknown>;
  status?: string;
  lifecycle_state?: string;
}

function buildSupabaseStub(instance: InstanceRow | null) {
  const updateEq = jest.fn().mockResolvedValue({ error: null });
  const updateQuery = {
    update: jest.fn().mockReturnThis(),
    eq: updateEq,
  };

  const selectQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: instance,
      error: null,
    }),
  };

  let call = 0;
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== "hermes_instances") {
      throw new Error(`Unexpected table lookup: ${table}`);
    }
    call += 1;
    return call === 1 ? selectQuery : updateQuery;
  });

  return { selectQuery, updateQuery, updateEq };
}

function makeRequest() {
  return new NextRequest(
    "http://localhost/api/ops/instances/inst_abc/force-suspend",
    { method: "POST" }
  );
}

function makeParams(id = "inst_abc") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/ops/instances/[id]/force-suspend", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "admin_user" });
    (currentUser as jest.Mock).mockResolvedValue({
      primaryEmailAddress: { emailAddress: "ops@example.com" },
    });
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
    (getProxmoxHostRoutingConfigFromInfrastructure as jest.Mock).mockReturnValue(null);
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });
    (shutdownServer as jest.Mock).mockResolvedValue({ action: { id: 1 } });
    (reportOpsEvent as jest.Mock).mockResolvedValue({ id: "evt_1" });
  });

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const res = await POST(makeRequest(), makeParams());

    expect(res.status).toBe(401);
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("returns 403 for authenticated non-admins", async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(false);

    const res = await POST(makeRequest(), makeParams());

    expect(res.status).toBe(403);
    expect(isOpsAdminUser).toHaveBeenCalledWith({
      userId: "admin_user",
      email: "ops@example.com",
    });
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("returns 200, suspends a Proxmox-backed instance, and writes an ops_events row", async () => {
    const proxmoxInfra = {
      provider: "proxmox" as const,
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "host.example",
    };
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(proxmoxInfra);

    const { updateQuery, updateEq } = buildSupabaseStub({
      id: "inst_abc",
      user_id: "user_owner",
      hetzner_server_id: null,
      host_id: null,
      config: { infrastructure: proxmoxInfra },
      status: "running",
      lifecycle_state: "active",
    });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        instance_id: "inst_abc",
        action: "force_suspend",
        lifecycle_state: "suspended",
      },
    });

    expect(shutdownProxmoxInstance).toHaveBeenCalledWith(proxmoxInfra, {
      expectedInstanceId: "inst_abc",
      hostConfig: null,
    });
    expect(shutdownServer).not.toHaveBeenCalled();

    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "stopped",
        lifecycle_state: "suspended",
      })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "inst_abc");

    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "admin.force_suspend",
        userId: "user_owner",
        instanceId: "inst_abc",
        metadata: expect.objectContaining({
          actor_user_id: "admin_user",
          actor_email: "ops@example.com",
          instance_id: "inst_abc",
          previous_lifecycle_state: "active",
        }),
      })
    );
  });

  it("falls through to Hetzner shutdown when no Proxmox infra is present", async () => {
    buildSupabaseStub({
      id: "inst_hetz",
      user_id: "user_hetz",
      hetzner_server_id: 12345,
      host_id: null,
      config: {},
      status: "running",
      lifecycle_state: "active",
    });

    const res = await POST(makeRequest(), makeParams("inst_hetz"));
    expect(res.status).toBe(200);
    expect(shutdownServer).toHaveBeenCalledWith(12345);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("is idempotent on an already-suspended row (still updates lifecycle + logs ops_events)", async () => {
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);

    const { updateQuery } = buildSupabaseStub({
      id: "inst_already_paused",
      user_id: "user_owner",
      hetzner_server_id: null,
      host_id: null,
      config: {},
      status: "stopped",
      lifecycle_state: "suspended",
    });

    const res = await POST(makeRequest(), makeParams("inst_already_paused"));

    expect(res.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_state: "suspended" })
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "admin.force_suspend",
        metadata: expect.objectContaining({
          previous_lifecycle_state: "suspended",
        }),
      })
    );
  });

  it("returns 404 when the instance does not exist", async () => {
    buildSupabaseStub(null);

    const res = await POST(makeRequest(), makeParams("inst_missing"));

    expect(res.status).toBe(404);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });
});
