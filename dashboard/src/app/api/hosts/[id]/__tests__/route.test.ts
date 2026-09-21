import { NextRequest } from "next/server";
import { DELETE } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { deleteHetznerServer } from "@/lib/services/hetzner-instance-service";
import { deleteProxmoxInstance } from "@/lib/services/proxmox-instance-service";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  deleteHetznerServer: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  deleteProxmoxInstance: jest.fn(),
}));

describe("DELETE /api/hosts/[id]", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedDeleteHetznerServer = deleteHetznerServer as jest.MockedFunction<typeof deleteHetznerServer>;
  const mockedDeleteProxmoxInstance = deleteProxmoxInstance as jest.MockedFunction<typeof deleteProxmoxInstance>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedDeleteHetznerServer.mockResolvedValue(undefined);
    mockedDeleteProxmoxInstance.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("hides unexpected host deletion errors from the client", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("host-delete-secret"));

    const response = await DELETE(
      new NextRequest("http://localhost/api/hosts/host-123", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "host-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(json.error).not.toContain("host-delete-secret");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("host-delete-secret");
  });

  it("does not log raw lookup failures when the target host cannot be loaded", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: null,
        error: { message: "host-lookup-secret" },
      }),
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/hosts/host-123", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "host-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error).toBe("Host not found");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("host-lookup-secret");
  });

  it("does not log raw database errors when linked instance cleanup fails", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);

    const hostsQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "host-123", name: "Primary Host", status: "running", hetzner_server_id: null },
        error: null,
      }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnThis(),
      }),
    };

    // One linked instance with no provider resource (already released) so it
    // is "deletable" and the soft-delete update path actually runs.
    const instanceFetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockResolvedValue({
        data: [{ id: "inst-released", host_id: "host-123", hetzner_server_id: null, config: {} }],
        error: null,
      }),
    };

    const instanceUpdateQuery = {
      update: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockResolvedValue({
          error: { message: "cleanup-secret" },
        }),
      }),
    };

    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_hosts") return hostsQuery;
      if (table === "hermes_instances") {
        return mockedFrom.mock.calls.filter(([name]) => name === "hermes_instances").length === 1
          ? instanceFetchQuery
          : instanceUpdateQuery;
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/hosts/host-123", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "host-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to clean up linked instances");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("cleanup-secret");
  });

  it("deletes the user's Hetzner host server before soft-deleting host rows", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);

    const hostFetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "host-123",
          name: "Primary Host",
          status: "running",
          hetzner_server_id: 456,
        },
        error: null,
      }),
    };
    // One Hetzner-backed linked instance whose server is the host's server,
    // so a successful host-server destroy also makes the instance deletable.
    const instanceFetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockResolvedValue({
        data: [{ id: "inst-hetz", host_id: "host-123", hetzner_server_id: 456, config: {} }],
        error: null,
      }),
    };
    const instanceUpdateQuery = {
      update: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockResolvedValue({ error: null }),
      }),
    };
    const hostUpdateQuery = {
      update: jest.fn(() => {
        const chain: Record<string, unknown> = {};
        chain.eq = jest.fn(() => chain);
        chain.then = (resolve: (value: { error: null }) => void) =>
          Promise.resolve({ error: null }).then(resolve);
        return chain;
      }),
    };

    let hostCalls = 0;
    let instanceCalls = 0;
    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        hostCalls += 1;
        return hostCalls === 1 ? hostFetchQuery : hostUpdateQuery;
      }
      if (table === "hermes_instances") {
        instanceCalls += 1;
        return instanceCalls === 1 ? instanceFetchQuery : instanceUpdateQuery;
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/hosts/host-123", { method: "DELETE" }),
      { params: Promise.resolve({ id: "host-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.deletedResources).toEqual({ proxmoxDeleted: 0, hetznerDeleted: 1 });
    expect(mockedDeleteHetznerServer).toHaveBeenCalledWith(456);
    expect(instanceUpdateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
      })
    );
  });

  it("deletes Proxmox VMs for linked instances and targets the stored instance infrastructure", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);

    const proxmoxConfig = {
      infrastructure: {
        provider: "proxmox",
        hostId: "host-123",
        hostSlug: "fixturelegacy",
        vmid: 301,
        privateIpv4: "10.250.30.51",
        gatewayHost: "agent.example",
      },
    };
    const hostFetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "host-123", name: "FixtureLegacy", status: "running", hetzner_server_id: null },
        error: null,
      }),
    };
    const instanceFetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockResolvedValue({
        data: [{ id: "inst-123", host_id: "host-123", hetzner_server_id: null, config: proxmoxConfig }],
        error: null,
      }),
    };
    const instanceUpdateQuery = {
      update: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockResolvedValue({ error: null }),
      }),
    };
    const hostUpdateQuery = {
      update: jest.fn(() => {
        const chain: Record<string, unknown> = {};
        chain.eq = jest.fn(() => chain);
        chain.then = (resolve: (value: { error: null }) => void) =>
          Promise.resolve({ error: null }).then(resolve);
        return chain;
      }),
    };

    let hostCalls = 0;
    let instanceCalls = 0;
    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        hostCalls += 1;
        return hostCalls === 1 ? hostFetchQuery : hostUpdateQuery;
      }
      if (table === "hermes_instances") {
        instanceCalls += 1;
        return instanceCalls === 1 ? instanceFetchQuery : instanceUpdateQuery;
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/hosts/host-123", { method: "DELETE" }),
      { params: Promise.resolve({ id: "host-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.deletedResources).toEqual({ proxmoxDeleted: 1, hetznerDeleted: 0 });
    expect(mockedDeleteProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        vmid: 301,
        privateIpv4: "10.250.30.51",
        gatewayHost: "agent.example",
        hostId: "host-123",
        hostSlug: "fixturelegacy",
      }),
      {
        hostConfig: expect.objectContaining({
          hostId: "host-123",
          hostSlug: "fixturelegacy",
        }),
        expectedInstanceId: "inst-123",
      }
    );
  });

  it("does not soft-delete rows when provider resource deletion fails", async () => {
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedDeleteProxmoxInstance.mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "secret proxmox failure",
      error: "secret proxmox failure",
    });

    const hostFetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "host-123", name: "FixtureLegacy", status: "running", hetzner_server_id: null },
        error: null,
      }),
    };
    const instanceFetchQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockResolvedValue({
        data: [
          {
            id: "inst-123",
            host_id: "host-123",
            hetzner_server_id: null,
            config: {
              infrastructure: {
                provider: "proxmox",
                vmid: 301,
                privateIpv4: "10.250.30.51",
                gatewayHost: "agent.example",
              },
            },
          },
        ],
        error: null,
      }),
    };
    const instanceUpdateQuery = {
      update: jest.fn(),
    };

    let hostCalls = 0;
    let instanceCalls = 0;
    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_hosts") {
        hostCalls += 1;
        return hostCalls === 1
          ? hostFetchQuery
          : { update: jest.fn() };
      }
      if (table === "hermes_instances") {
        instanceCalls += 1;
        return instanceCalls === 1 ? instanceFetchQuery : instanceUpdateQuery;
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/hosts/host-123", { method: "DELETE" }),
      { params: Promise.resolve({ id: "host-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe("Failed to delete linked server resources");
    expect(instanceUpdateQuery.update).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("secret proxmox failure");
  });
});
