import { NextRequest } from "next/server";

import { GET } from "../route";
import { validateConsoleAccess, discoverContainerName } from "@/lib/services/console-helpers";
import { sshExec } from "@/lib/hetzner/ssh";

jest.mock("@/lib/services/console-helpers");
jest.mock("@/lib/hetzner/ssh");

describe("GET /api/instances/[id]/console/logs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst_123",
      hostIp: "127.0.0.1",
      errorResponse: null,
    });
    (discoverContainerName as jest.Mock).mockResolvedValue("agent-inst_123");
  });

  it("returns logs when docker logs succeeds", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "__HERMES_LOG_SOURCE__/root/.hermes/logs/agent.log\nruntime log output",
      stderr: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/console/logs"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.logs).toBe("runtime log output");
    expect(json.data.source).toBe("/root/.hermes/logs/agent.log");
    expect(sshExec).toHaveBeenCalledWith(
      "127.0.0.1",
      expect.stringContaining('$HERMES_HOME/logs/agent.log')
    );
  });

  it("returns 504 for SSH timeout failures", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection error: Keepalive timeout",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/console/logs"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(504);
    expect(json.error).toBe("SSH connection error: Keepalive timeout");
  });

  it("returns 503 for non-timeout SSH transport failures", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection error: write ECONNRESET",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/console/logs"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("SSH connection error: write ECONNRESET");
  });

  it("returns host update logs when container logs and docker stdout are empty", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "__HERMES_LOG_SOURCE__host-update-log\n[webui-update] FATAL: containers did not converge to :stable after recreate retries",
      stderr: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/console/logs"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.logs).toBe("[webui-update] FATAL: containers did not converge to :stable after recreate retries");
    expect(json.data.source).toBe("host-update-log");
  });

  it("returns 'No logs available.' when stdout is blank", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "__HERMES_LOG_SOURCE__docker-stdout\n",
      stderr: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst_123/console/logs"),
      { params: Promise.resolve({ id: "inst_123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.logs).toBe("No logs available.");
    expect(json.data.source).toBe("docker-stdout");
  });
});
