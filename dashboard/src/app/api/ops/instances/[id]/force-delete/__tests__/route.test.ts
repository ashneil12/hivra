import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isOpsAdminUser } from "@/lib/ops-access";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getReleasedProxmoxInfrastructure,
  isProxmoxBackedInstanceRow,
  isProxmoxReleaseSafeForDbOnlyDelete,
  resolveProxmoxLifecycleTarget,
} from "@/lib/services/proxmox-infrastructure";
import { deleteProxmoxInstance } from "@/lib/services/proxmox-instance-service";
import { deleteHetznerServer } from "@/lib/services/hetzner-instance-service";

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
  deleteProxmoxInstance: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-infrastructure", () => ({
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(),
  getReleasedProxmoxInfrastructure: jest.fn(),
  isProxmoxReleaseSafeForDbOnlyDelete: jest.fn(),
  isProxmoxBackedInstanceRow: jest.fn(),
  resolveProxmoxLifecycleTarget: jest.fn(),
}));

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  deleteHetznerServer: jest.fn(),
}));

jest.mock("@/lib/services/cloudflare-dns", () => ({
  removeInstanceDns: jest.fn().mockResolvedValue({ ok: true }),
  removeInstanceDnsBestEffort: jest.fn().mockResolvedValue(undefined),
  deriveDnsDomainFromGatewayUrl: jest.fn(() => null),
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

interface OwnerSubsResult {
  data: Array<{ status?: string | null }> | null;
  error: { message: string } | null;
}

/**
 * Wires up `supabaseAdmin.from(...)` for the two tables force-delete touches:
 *   - `hermes_instances` — select (1st call) then update (last call)
 *   - `hermes_subscriptions` — the active-subscription guard's owner lookup
 *
 * `ownerSubs` defaults to an EMPTY list, i.e. the owner has NO subscription
 * rows → the guard's `hasPlanAccessStatus` check finds nothing active and the
 * destroy proceeds. This matches reality: force-delete is used on
 * non-paying/abusive accounts. Tests that exercise the guard pass an explicit
 * `ownerSubs` (active rows, or an error to trip the fail-closed branch).
 */
function buildSupabaseStub(
  instance: InstanceRow | null,
  ownerSubs: OwnerSubsResult = { data: [], error: null }
) {
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

  // The route calls `.from("hermes_subscriptions").select("status").eq(...)`
  // and awaits the resulting query (no .maybeSingle()), so the terminal `.eq`
  // resolves to the rows directly.
  const subsEq = jest.fn().mockResolvedValue({
    data: ownerSubs.data,
    error: ownerSubs.error,
  });
  const subsQuery = {
    select: jest.fn().mockReturnThis(),
    eq: subsEq,
  };

  let instancesCall = 0;
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_subscriptions") {
      return subsQuery;
    }
    if (table !== "hermes_instances") {
      throw new Error(`Unexpected table lookup: ${table}`);
    }
    instancesCall += 1;
    return instancesCall === 1 ? selectQuery : updateQuery;
  });

  return { selectQuery, updateQuery, updateEq, subsQuery, subsEq };
}

function makeRequest() {
  return new NextRequest(
    "http://localhost/api/ops/instances/inst_abc/force-delete",
    { method: "POST" }
  );
}

function makeParams(id = "inst_abc") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/ops/instances/[id]/force-delete", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "admin_user" });
    (currentUser as jest.Mock).mockResolvedValue({
      primaryEmailAddress: { emailAddress: "ops@example.com" },
    });
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);
    (resolveProxmoxLifecycleTarget as jest.Mock).mockReturnValue(null);
    (isProxmoxBackedInstanceRow as jest.Mock).mockReturnValue(false);
    (getReleasedProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
    (isProxmoxReleaseSafeForDbOnlyDelete as jest.Mock).mockReturnValue(false);
    (getProxmoxHostRoutingConfigFromInfrastructure as jest.Mock).mockReturnValue(null);
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });
    (deleteHetznerServer as jest.Mock).mockResolvedValue(undefined);
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

  it("returns 200, destroys a Proxmox-backed instance, and writes an ops_events row", async () => {
    const proxmoxInfra = {
      provider: "proxmox" as const,
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "host.example",
    };
    (resolveProxmoxLifecycleTarget as jest.Mock).mockReturnValue(proxmoxInfra);
    (isProxmoxBackedInstanceRow as jest.Mock).mockReturnValue(true);

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
        action: "force_delete",
        lifecycle_state: "deleted",
      },
    });

    expect(deleteProxmoxInstance).toHaveBeenCalledWith(proxmoxInfra, {
      hostConfig: null,
      expectedInstanceId: "inst_abc",
    });
    expect(deleteHetznerServer).not.toHaveBeenCalled();

    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
      })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "inst_abc");

    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "admin.force_delete",
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

  it("falls through to Hetzner deletion when no Proxmox infra is present", async () => {
    buildSupabaseStub({
      id: "inst_hetz",
      user_id: "user_hetz",
      hetzner_server_id: 99999,
      host_id: null,
      config: {},
      status: "running",
      lifecycle_state: "active",
    });

    const res = await POST(makeRequest(), makeParams("inst_hetz"));

    expect(res.status).toBe(200);
    expect(deleteHetznerServer).toHaveBeenCalledWith(99999);
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
  });

  it("is idempotent on an already-deleted row (still flips lifecycle + logs ops_events)", async () => {
    const { updateQuery } = buildSupabaseStub({
      id: "inst_already_deleted",
      user_id: "user_owner",
      hetzner_server_id: null,
      host_id: null,
      config: {},
      status: "deleted",
      lifecycle_state: "deleted",
    });

    const res = await POST(makeRequest(), makeParams("inst_already_deleted"));

    expect(res.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_state: "deleted" })
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "admin.force_delete",
        metadata: expect.objectContaining({
          previous_lifecycle_state: "deleted",
        }),
      })
    );
  });

  it("does not mark the DB row deleted when Proxmox provider deletion fails", async () => {
    const proxmoxInfra = {
      provider: "proxmox" as const,
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "host.example",
    };
    (resolveProxmoxLifecycleTarget as jest.Mock).mockReturnValue(proxmoxInfra);
    (isProxmoxBackedInstanceRow as jest.Mock).mockReturnValue(true);
    (deleteProxmoxInstance as jest.Mock).mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "provider destroy failed",
    });

    const { updateQuery } = buildSupabaseStub({
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

    expect(res.status).toBe(502);
    expect(body.error).toBe("Provider deletion failed; instance was not marked deleted");
    expect(updateQuery.update).not.toHaveBeenCalled();
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "admin.force_delete_failed",
        severity: "error",
        metadata: expect.objectContaining({
          provider_delete_failed: true,
          previous_lifecycle_state: "active",
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

  it("removes the Cloudflare DNS record when the instance has a subdomain", async () => {
    // Regression guard: previously force-delete skipped the DNS cleanup
    // that the regular DELETE /api/instances/[id] path performs, so admin
    // kills leaked A records pointing at the released Proxmox host IP.
    // The fix routes through removeInstanceDnsBestEffort before the
    // lifecycle row flip.
    const { removeInstanceDnsBestEffort } = jest.requireMock("@/lib/services/cloudflare-dns");
    const { deriveDnsDomainFromGatewayUrl } = jest.requireMock("@/lib/services/cloudflare-dns");
    deriveDnsDomainFromGatewayUrl.mockReturnValueOnce("hermesos.cloud");
    buildSupabaseStub({
      id: "inst_dns",
      user_id: "user_dns",
      hetzner_server_id: null,
      host_id: null,
      config: {},
      status: "running",
      lifecycle_state: "active",
      // The route reads instance.subdomain off the row.
      ...({
        subdomain: "agent-dns",
        gateway_url: "https://agent-dns.hermesos.cloud",
      } as object),
    });

    const res = await POST(makeRequest(), makeParams("inst_dns"));
    expect(res.status).toBe(200);
    expect(removeInstanceDnsBestEffort).toHaveBeenCalledWith(
      "agent-dns",
      expect.objectContaining({
        source: "ops.force_delete",
        route: "/api/ops/instances/[id]/force-delete",
        instanceId: "inst_dns",
        userId: "user_dns",
      }),
      { dnsDomain: "hermesos.cloud" },
    );
  });

  it("forwards a missing subdomain to the helper (helper short-circuits on sslip)", async () => {
    // sslip-only instances have no subdomain. The helper no-ops on
    // null/undefined; the route trusts that contract rather than guarding
    // the call itself.
    const { removeInstanceDnsBestEffort } = jest.requireMock("@/lib/services/cloudflare-dns");
    buildSupabaseStub({
      id: "inst_sslip",
      user_id: "user_sslip",
      hetzner_server_id: null,
      host_id: null,
      config: {},
      status: "running",
      lifecycle_state: "active",
    });

    const res = await POST(makeRequest(), makeParams("inst_sslip"));
    expect(res.status).toBe(200);
    expect(removeInstanceDnsBestEffort).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ source: "ops.force_delete" }),
    );
  });

  it("refuses (409) and does NOT destroy when the owner has an active subscription and no override", async () => {
    // Destructive-billing safety (F198): force-deleting a live paying tenant
    // must be refused unless the caller explicitly opts in.
    const { updateQuery } = buildSupabaseStub(
      {
        id: "inst_paying",
        user_id: "user_paying",
        hetzner_server_id: 99999,
        host_id: null,
        config: {},
        status: "running",
        lifecycle_state: "active",
      },
      { data: [{ status: "active" }], error: null }
    );

    const res = await POST(makeRequest(), makeParams("inst_paying"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe(
      "Owner has an active subscription; pass overrideActiveSubscription:true to force-delete"
    );

    // Nothing was destroyed or flipped.
    expect(deleteHetznerServer).not.toHaveBeenCalled();
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
    expect(updateQuery.update).not.toHaveBeenCalled();

    // The refusal is audited.
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "admin.force_delete_blocked",
        userId: "user_paying",
        instanceId: "inst_paying",
        metadata: expect.objectContaining({
          actor_user_id: "admin_user",
          block_reason: "owner_has_active_subscription",
        }),
      })
    );
  });

  it("proceeds to destroy a paying owner's instance when overrideActiveSubscription:true is passed", async () => {
    const { updateQuery } = buildSupabaseStub(
      {
        id: "inst_paying",
        user_id: "user_paying",
        hetzner_server_id: 99999,
        host_id: null,
        config: {},
        status: "running",
        lifecycle_state: "active",
      },
      { data: [{ status: "active" }], error: null }
    );

    const request = new NextRequest(
      "http://localhost/api/ops/instances/inst_paying/force-delete",
      {
        method: "POST",
        body: JSON.stringify({ overrideActiveSubscription: true }),
        headers: { "content-type": "application/json" },
      }
    );

    const res = await POST(request, makeParams("inst_paying"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        instance_id: "inst_paying",
        action: "force_delete",
        lifecycle_state: "deleted",
      },
    });

    // The override let the destroy through.
    expect(deleteHetznerServer).toHaveBeenCalledWith(99999);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_state: "deleted" })
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "admin.force_delete",
        metadata: expect.objectContaining({
          override_active_subscription: true,
        }),
      })
    );
  });
});
