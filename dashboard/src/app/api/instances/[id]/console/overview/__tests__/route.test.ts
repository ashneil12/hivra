import { NextRequest } from "next/server";

import { GET } from "../route";
import { apiError } from "@/lib/api-response";
import { sshExec } from "@/lib/hetzner/ssh";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { log } from "@/lib/logger";

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

jest.mock("@/lib/services/console-helpers", () => ({
  validateConsoleAccess: jest.fn(),
}));

jest.mock("@/lib/api-response", () => {
  const actual = jest.requireActual("@/lib/api-response");
  return {
    ...actual,
    apiError: jest.fn(actual.apiError),
  };
});

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("GET /api/instances/[id]/console/overview", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      instance: { status: "running" },
      hostIp: "127.0.0.1",
      proxmoxHostConfig: null,
      errorResponse: null,
    });
  });

  it("targets the main agent container by exact name (not a regex that matches sibling containers)", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "agent-inst-123###0.01%|||10MiB / 1GiB|||1kB / 2kB###Up 2 minutes",
      stderr: "",
    });

    await GET(
      new NextRequest("http://localhost/api/instances/inst-123/console/overview"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    const script = (sshExec as jest.Mock).mock.calls[0][1] as string;
    expect(script).toContain('C="agent-inst-123"');
    expect(script).toContain('docker stats "$C"');
    // Sibling containers (e.g. agent-${id}-official-dashboard) all share the
    // `agent-${id}` prefix; head -n 1 against a permissive regex would let
    // their hardcoded sub-service memory limits leak into the Memory
    // Allocation card. Lock that out.
    expect(script).not.toMatch(/head\s+-n\s+1/);
    expect(script).not.toMatch(/grep\s+-E/);
  });

  it("reports the live docker-ps status, not a stale DB 'running', when the container is dead", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      // DB says running, but the container actually Exited.
      instance: { status: "running" },
      hostIp: "127.0.0.1",
      proxmoxHostConfig: null,
      errorResponse: null,
    });
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "agent-inst-123###0.00%|||0B / 0B|||0B / 0B###Exited (137) 3 minutes ago",
      stderr: "",
    });

    const res = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/console/overview"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.data.status).toBe("stopped");
  });

  it("does not degrade to 'unreachable' when stats are valid but benign stderr chatter is present", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "agent-inst-123###0.01%|||10MiB / 1GiB|||1kB / 2kB###Up 2 minutes",
      // benign SSH wrapper chatter on stderr must NOT trip the degraded branch
      stderr: "Warning: Permanently added host to known hosts.",
    });

    const res = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/console/overview"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.data.status).toBe("running");
    expect(data.data.cpu).toBe("0.01%");
    expect(data.data.error).toBeUndefined();
  });

  it("passes stored Proxmox host routing to SSH stats calls", async () => {
    const proxmoxHostConfig = { hostId: null, hostSlug: "fixturenode2", envPrefix: null, failClosed: true };
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      instance: { status: "running" },
      hostIp: "10.250.21.59",
      proxmoxHostConfig,
      errorResponse: null,
    });
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "agent-inst-123###0.01%|||10MiB / 1GiB|||1kB / 2kB###Up 2 minutes",
      stderr: "",
    });

    const res = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/console/overview"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(res.status).toBe(200);
    expect(sshExec).toHaveBeenCalledWith(
      "10.250.21.59",
      expect.any(String),
      { proxmoxHostConfig },
    );
  });

  it("returns a graceful degraded overview when SSH fails, never leaking remote stderr", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "refresh_token=super-secret",
      error: "",
    });

    const res = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/console/overview"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const data = await res.json();
    const allLogCalls = [
      ...(log.error as jest.Mock).mock.calls,
      ...(log.warn as jest.Mock).mock.calls,
    ]
      .map((args: unknown[]) =>
        args
          .map((arg: unknown) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" "),
      )
      .join(" ");

    // Decorative panel — return 200 with degraded values rather than 500.
    // 500-spam from this poll was masking the actual instance health
    // signal in production.
    expect(res.status).toBe(200);
    expect(data.data).toEqual(
      expect.objectContaining({
        uptime: "Unknown",
        status: "unreachable",
        error: "Stats temporarily unavailable.",
      })
    );
    // Whatever we logged, must not contain the remote stderr secrets.
    expect(allLogCalls).not.toContain("super-secret");
    // apiError should not have been used at all on the SSH-failed path.
    expect(apiError).not.toHaveBeenCalled();
  });

  it("returns the same graceful overview for SSH timeouts (no 500-spam)", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection error: Keepalive timeout",
    });

    const res = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/console/overview"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const data = await res.json();
    const allLogCalls = [
      ...(log.error as jest.Mock).mock.calls,
      ...(log.warn as jest.Mock).mock.calls,
    ]
      .map((args: unknown[]) =>
        args
          .map((arg: unknown) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" "),
      )
      .join(" ");

    expect(res.status).toBe(200);
    expect(data.data.status).toBe("unreachable");
    expect(allLogCalls).not.toContain("Keepalive timeout");
    expect(apiError).not.toHaveBeenCalled();
  });

  it("returns the same graceful overview for SSH transport failures (no 500-spam)", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection error: write ECONNRESET",
    });

    const res = await GET(
      new NextRequest("http://localhost/api/instances/inst-123/console/overview"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const data = await res.json();
    const allLogCalls = [
      ...(log.error as jest.Mock).mock.calls,
      ...(log.warn as jest.Mock).mock.calls,
    ]
      .map((args: unknown[]) =>
        args
          .map((arg: unknown) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" "),
      )
      .join(" ");

    expect(res.status).toBe(200);
    expect(data.data.status).toBe("unreachable");
    expect(allLogCalls).not.toContain("ECONNRESET");
    expect(apiError).not.toHaveBeenCalled();
  });
});
