import { NextRequest } from "next/server";

import { DELETE, GET, PATCH, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/services/instance-orchestrator";
import { sshExec } from "@/lib/hetzner/ssh";
import { makeJsonRequest } from "@/test-utils";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/instance-orchestrator", () => ({
  resolveInstanceIpv4: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

describe("instance tailscale private access route", () => {
  let updateInstanceMock: jest.Mock;
  let updateInstanceResult: { data: unknown; error: unknown };
  let instanceRow: Record<string, unknown>;
  const authMock = auth as unknown as jest.Mock;
  const supabaseAdminMock = supabaseAdmin as NonNullable<typeof supabaseAdmin>;

  beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockResolvedValue({ userId: "user_123" });
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("203.0.113.10");
    updateInstanceResult = {
      data: {
        id: "inst-123",
        gateway_url: "https://atlas.example.com",
      },
      error: null,
    };
    instanceRow = {
      id: "inst-123",
      user_id: "user_123",
      status: "running",
      provider: "anthropic",
      gateway_url: "https://atlas.example.com",
      api_key_encrypted: "encrypted-provider-key",
      host_id: "host-123",
      hetzner_server_id: 42,
      config: {
        privateAccess: {
          tailscale: {
            enabled: true,
            hostScoped: true,
            state: "connected",
            machineName: "atlas-agent",
          },
        },
      },
    };
    updateInstanceMock = jest.fn().mockImplementation(() => ({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({
          data: updateInstanceResult.data,
          error: updateInstanceResult.error,
        }),
      }),
    }));

    (supabaseAdminMock.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== "hermes_instances") {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              neq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: instanceRow,
                  error: null,
                }),
              }),
            }),
          }),
        }),
        update: updateInstanceMock,
      };
    });
  });

  it("returns the current public-safe tailscale metadata", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: {
        tailscale: {
          enabled: true,
          hostScoped: true,
          state: "connected",
          machineName: "atlas-agent",
        },
      },
    });
  });

  it("requires authentication for setup", async () => {
    authMock.mockResolvedValue({ userId: null });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123/private-access/tailscale", { authKey: "tskey-auth-123" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("Unauthorized");
  });

  it("installs tailscale, enrolls the host, and persists sanitized metadata", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          Self: {
            HostName: "atlas-agent",
            DNSName: "atlas-agent.customer.ts.net.",
            TailscaleIPs: ["100.64.0.4", "fd7a:115c:a1e0::4"],
            SSHEnabled: true,
          },
          CurrentTailnet: {
            Name: "customer.ts.net",
          },
        }),
        stderr: "",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale", {
        method: "POST",
        body: JSON.stringify({
          authKey: "tskey-auth-123",
          machineName: "atlas-agent",
          tags: ["tag:prod"],
          enableSsh: true,
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(resolveInstanceIpv4).toHaveBeenCalled();
    expect(sshExec).toHaveBeenCalledTimes(2);
    expect(String((sshExec as jest.Mock).mock.calls[0][1])).toContain("TAILSCALE_AUTH_KEY");
    expect(String((sshExec as jest.Mock).mock.calls[0][1])).toContain("tailscale up");
    expect((sshExec as jest.Mock).mock.calls[0][2]).toBeUndefined();
    expect(json.data.tailscale).toEqual({
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: "atlas-agent",
      magicDnsName: "atlas-agent.customer.ts.net",
      tailnetName: "customer.ts.net",
      ipv4: "100.64.0.4",
      ipv6: "fd7a:115c:a1e0::4",
      sshEnabled: true,
      tags: ["tag:prod"],
      connectedAt: expect.any(String),
      lastError: null,
    });
    expect(json.data.tailscale).not.toHaveProperty("authKey");
  });

  it("routes proxmox-backed tailscale setup through the instance owning host", async () => {
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("10.250.30.80");
    instanceRow.host_id = "host-fixturelegacy";
    instanceRow.config = {
      infrastructure: {
        provider: "proxmox",
        node: "pve-fixturelegacy",
        vmid: 3080,
        privateIpv4: "10.250.30.80",
        gatewayHost: "atlas-fixturelegacy.agents.example.com",
        hostId: "host-fixturelegacy",
        hostSlug: "fixturelegacy",
        hostEnvPrefix: "PROXMOX_HOST_FIXTURELEGACY_",
      },
      privateAccess: {
        tailscale: {
          enabled: false,
          hostScoped: true,
          state: "disconnected",
        },
      },
    };
    (sshExec as jest.Mock)
      // preflight probe — checks the SSH bridge before pasting the auth key
      .mockResolvedValueOnce({
        ok: true,
        stdout: "hermes-tailscale-preflight-ok\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          Self: {
            HostName: "atlas-agent",
            TailscaleIPs: ["100.64.0.4"],
          },
        }),
        stderr: "",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale", {
        method: "POST",
        body: JSON.stringify({
          authKey: "tskey-auth-123",
          machineName: "atlas-agent",
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(sshExec).toHaveBeenNthCalledWith(
      1,
      "10.250.30.80",
      expect.stringContaining("hermes-tailscale-preflight-ok"),
      expect.objectContaining({
        proxmoxHostConfig: {
          hostId: "host-fixturelegacy",
          hostSlug: "fixturelegacy",
          envPrefix: "PROXMOX_HOST_FIXTURELEGACY_",
          failClosed: true,
        },
        timeoutMs: expect.any(Number),
      })
    );
    expect(sshExec).toHaveBeenNthCalledWith(
      2,
      "10.250.30.80",
      expect.stringContaining("tailscale up"),
      expect.objectContaining({
        proxmoxHostConfig: {
          hostId: "host-fixturelegacy",
          hostSlug: "fixturelegacy",
          envPrefix: "PROXMOX_HOST_FIXTURELEGACY_",
          failClosed: true,
        },
      })
    );
    expect(sshExec).toHaveBeenNthCalledWith(
      3,
      "10.250.30.80",
      "tailscale status --json",
      expect.objectContaining({
        proxmoxHostConfig: {
          hostId: "host-fixturelegacy",
          hostSlug: "fixturelegacy",
          envPrefix: "PROXMOX_HOST_FIXTURELEGACY_",
          failClosed: true,
        },
      })
    );
  });

  it("refuses tailscale setup when the agent is not running, without touching SSH", async () => {
    instanceRow.status = "stopped";

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123/private-access/tailscale", { authKey: "tskey-auth-123" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toContain("agent to be running");
    expect(json.error).toContain("stopped");
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("fast-fails a proxmox setup attempt when the preflight ssh bridge probe fails", async () => {
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("10.250.30.80");
    instanceRow.host_id = "host-fixturelegacy";
    instanceRow.config = {
      infrastructure: {
        provider: "proxmox",
        node: "pve-fixturelegacy",
        vmid: 3080,
        privateIpv4: "10.250.30.80",
        gatewayHost: "atlas-fixturelegacy.agents.example.com",
        hostId: "host-fixturelegacy",
        hostSlug: "fixturelegacy",
        hostEnvPrefix: "PROXMOX_HOST_FIXTURELEGACY_",
      },
      privateAccess: {
        tailscale: {
          enabled: false,
          hostScoped: true,
          state: "disconnected",
        },
      },
    };
    (sshExec as jest.Mock).mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "",
      error: "Remote bash exited with code 255",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123/private-access/tailscale", { authKey: "tskey-auth-123" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).not.toBe("Remote bash exited with code 255");
    expect(json.error).toContain("SSH bridge");
    // Crucially: the install script never runs once the preflight has failed.
    // The user's auth key is never piped into a remote bash that we already
    // know is broken.
    expect(sshExec).toHaveBeenCalledTimes(1);
  });

  it("surfaces redacted tailscale setup stderr instead of a generic remote exit", async () => {
    (sshExec as jest.Mock).mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr:
        "ssh: connect to host 10.250.30.80 port 22: No route to host for tskey-auth-123",
      error: "Remote bash exited with code 255",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123/private-access/tailscale", { authKey: "tskey-auth-123" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toContain("No route to host");
    expect(json.error).not.toContain("tskey-auth-123");
    expect(json.error).not.toBe("Remote bash exited with code 255");
  });

  it("does not rewrite the existing gateway url during tailscale setup", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          Self: {
            HostName: "atlas-agent",
            TailscaleIPs: ["100.64.0.4"],
          },
        }),
        stderr: "",
      });

    await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123/private-access/tailscale", { authKey: "tskey-auth-123" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(supabaseAdminMock.from).toHaveBeenCalledWith("hermes_instances");
    expect(updateInstanceMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        gateway_url: expect.anything(),
      })
    );
  });

  it("returns 500 when tailscale setup cannot be persisted after host enrollment", async () => {
    updateInstanceResult = {
      data: null,
      error: { message: "write failed" },
    };
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          Self: {
            HostName: "atlas-agent",
            TailscaleIPs: ["100.64.0.4"],
          },
        }),
        stderr: "",
      });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123/private-access/tailscale", { authKey: "tskey-auth-123" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
  });

  it("clears stored metadata and disables tailscale on delete", async () => {
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    const response = await DELETE(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(sshExec).toHaveBeenCalledTimes(1);
    expect(String((sshExec as jest.Mock).mock.calls[0][1])).toContain("tailscale logout");
    expect(json).toEqual({
      success: true,
      data: {
        tailscale: undefined,
        hostTeardownConfirmed: true,
      },
    });
  });

  it("returns 500 with canForce when the host-side disable fails", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "ssh: connect to host failed",
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.canForce).toBe(true);
  });

  it("force=1 clears the DB config even when the host-side disable fails", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "ssh: connect to host failed",
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale?force=1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.hostTeardownConfirmed).toBe(false);
  });

  it("returns 500 when tailscale removal cannot be persisted", async () => {
    updateInstanceResult = {
      data: null,
      error: { message: "write failed" },
    };
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    const response = await DELETE(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
  });

  it("updates connected tailscale settings without requiring a new auth key", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          Self: {
            HostName: "atlas-agent-updated",
            DNSName: "atlas-agent-updated.customer.ts.net.",
            TailscaleIPs: ["100.64.0.4", "fd7a:115c:a1e0::4"],
            SSHEnabled: false,
          },
          CurrentTailnet: {
            Name: "customer.ts.net",
          },
        }),
        stderr: "",
      });

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale", {
        method: "PATCH",
        body: JSON.stringify({
          machineName: "atlas-agent-updated",
          enableSsh: false,
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(sshExec).toHaveBeenCalledTimes(2);
    expect(String((sshExec as jest.Mock).mock.calls[0][1])).toContain("tailscale set");
    expect(String((sshExec as jest.Mock).mock.calls[0][1])).toContain(
      "--hostname='atlas-agent-updated'"
    );
    expect(String((sshExec as jest.Mock).mock.calls[0][1])).toContain("--ssh=false");
    expect(json.data.tailscale).toEqual({
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: "atlas-agent-updated",
      magicDnsName: "atlas-agent-updated.customer.ts.net",
      tailnetName: "customer.ts.net",
      ipv4: "100.64.0.4",
      ipv6: "fd7a:115c:a1e0::4",
      sshEnabled: false,
      connectedAt: expect.any(String),
      lastError: null,
    });
  });

  it("returns 500 when tailscale updates cannot be persisted", async () => {
    updateInstanceResult = {
      data: null,
      error: { message: "write failed" },
    };
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          Self: {
            HostName: "atlas-agent-updated",
            TailscaleIPs: ["100.64.0.4"],
          },
        }),
        stderr: "",
      });

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123/private-access/tailscale", {
        method: "PATCH",
        body: JSON.stringify({
          machineName: "atlas-agent-updated",
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
  });

  it("refuses tailscale updates when the agent is not running, without touching SSH", async () => {
    instanceRow.status = "stopped";

    const response = await PATCH(
      makeJsonRequest("http://localhost/api/instances/inst-123/private-access/tailscale", { machineName: "atlas-agent-updated" }, { method: "PATCH" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toContain("running");
    expect(json.error).toContain("stopped");
    expect(sshExec).not.toHaveBeenCalled();
  });

});
