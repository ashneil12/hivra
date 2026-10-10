import { NextRequest } from "next/server";
import { POST } from "../route";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { sshExec } from "@/lib/hetzner/ssh";
import { apiError } from "@/lib/api-response";

jest.mock("@/lib/services/console-helpers");
jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));
jest.mock("@/lib/ssh-warmup", () => ({
  SSH_WARMUP_MESSAGE: "Instance is still provisioning SSH access. Try again in a moment.",
  isSshWarmupError: jest.fn((message: string | null | undefined) => {
    const normalized = message?.toLowerCase() ?? "";
    return (
      normalized.includes("timed out capturing ssh host fingerprint") ||
      normalized.includes("ssh fingerprint capture failed:") ||
      normalized.includes("ssh connection error: connect econnrefused")
    );
  }),
}));
jest.mock("@/lib/api-response", () => {
  const actual = jest.requireActual("@/lib/api-response");
  return {
    ...actual,
    apiError: jest.fn(actual.apiError),
  };
});

describe("POST /api/instances/[id]/oauth/codex/start", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        config: {},
      },
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("starts the Hermes-managed device flow and returns the URL + code", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"url":"https://auth.openai.com/codex/device","code":"ABCD-EFGH"}',
        stderr: "",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.url).toBe("https://auth.openai.com/codex/device");
    expect(json.data.code).toBe("ABCD-EFGH");

    expect(sshExec).toHaveBeenCalledTimes(2);

    const readyCommand = (sshExec as jest.Mock).mock.calls[0][1];
    const readyOptions = (sshExec as jest.Mock).mock.calls[0][2];
    expect(readyCommand).toBe("true");
    expect(readyOptions).toEqual({ timeoutMs: 8_000, proxmoxHostConfig: null });

    const command = (sshExec as jest.Mock).mock.calls[1][1];
    const options = (sshExec as jest.Mock).mock.calls[1][2];
    expect(command).toContain('docker exec -u "hermes" -i "$AGENT_CONTAINER"');
    expect(command).toContain("for candidate_container in agent-inst-123 agent-inst-123-gateway; do");
    expect(command).toContain('export HERMES_HOME="/opt/data"');
    expect(command).toContain('os.environ.get("HERMES_HOME")');
    expect(command).toContain(".codex_device_flow.json");
    expect(command).toContain("deviceauth/usercode");
    expect(command).not.toContain("codex login --device-auth");
    expect(options).toEqual({ timeoutMs: 30_000, proxmoxHostConfig: null });
  });

  it("targets the selected profile home when a Codex profile is chosen", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        config: { hermes_home_dir: "/opt/data" },
      },
    });
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"url":"https://auth.openai.com/codex/device","code":"ABCD-EFGH"}',
        stderr: "",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start?profile=strategy", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect((sshExec as jest.Mock).mock.calls[1][1]).toContain(
      'export HERMES_HOME="/opt/data/profiles/strategy"'
    );
  });

  it("starts Codex OAuth inside the WebUI runtime home for WebUI-backed instances", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        backend: "webui",
        config: {},
      },
    });
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"url":"https://auth.openai.com/codex/device","code":"ABCD-EFGH"}',
        stderr: "",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    const command = (sshExec as jest.Mock).mock.calls[1][1];
    expect(command).toContain('docker exec -u "1024:1024" -i "$AGENT_CONTAINER"');
    expect(command).toContain("for candidate_container in agent-inst-123 agent-inst-123-gateway; do");
    expect(command).toContain('export HERMES_HOME="/home/hermes/.hermes"');
  });

  it("short-circuits with 409 instance_off before any SSH when the row is stopped", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        status: "stopped",
        config: {},
      },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("instance_off");
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("short-circuits with 409 instance_off when the row is cold-archived (lifecycle)", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        status: "running",
        lifecycle_state: "cold_archived",
        config: {},
      },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("instance_off");
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("proceeds to SSH for a running/active row", async () => {
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "127.0.0.1",
      userId: "user_123",
      instance: {
        status: "running",
        lifecycle_state: "active",
        config: {},
      },
    });
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: '{"url":"https://auth.openai.com/codex/device","code":"ABCD-EFGH"}',
        stderr: "",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(sshExec).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid profile names before attempting SSH", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start?profile=../../etc/passwd", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Invalid profile name format");
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("treats retryable ssh connection failures as warmup responses", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "SSH connection error: connect ECONNREFUSED 203.0.113.58:22",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("Instance is still provisioning SSH access. Try again in a moment.");
    expect(apiError).toHaveBeenCalledWith(
      "Instance is still provisioning SSH access. Try again in a moment.",
      409
    );
  });

  it("returns a retryable provisioning response when SSH fingerprint capture is still warming up", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "Timed out capturing SSH host fingerprint from 203.0.113.80 after 5355ms",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("Instance is still provisioning SSH access. Try again in a moment.");
    expect(sshExec).toHaveBeenCalledTimes(1);
    expect(apiError).toHaveBeenCalledWith(
      "Instance is still provisioning SSH access. Try again in a moment.",
      409
    );
  });

  /**
   * Regression: with the guest agent down, `qm guest exec` prints "QEMU guest
   * agent is not running" before the host refuses to SSH, and the "is not
   * running" match told the user their runtime was stopped.
   */
  it("reports a refused guest identity check as that, not as a stopped runtime", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr:
          "QEMU guest agent is not running\n" +
          "VMID-bound SSH refused: the SSH host key could not be read through QEMU Guest Agent; nothing was sent to the guest\n",
        error: "Command exited with code 1",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toMatch(/couldn't confirm which VM is your agent's, so nothing was sent/);
    expect(json.error).not.toMatch(/not running/);
    expect(apiError).toHaveBeenCalledWith(
      expect.any(String),
      503,
      expect.objectContaining({ failureCategory: "guest_identity_refused" }),
      undefined,
      expect.anything()
    );
  });

  it("returns 503 when Docker reports the agent container missing via the SSH error field", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "",
        error: "Command exited with code 1: Error response from daemon: No such container: agent-inst-123",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("Agent container is not running. Please start your instance first.");
    expect(apiError).toHaveBeenCalledWith(
      "Agent container is not running. Please start your instance first.",
      503,
      expect.objectContaining({
        failureType: "codex_start_command_failed",
        failureCategory: "container_unavailable",
        errorPresent: true,
      }),
      undefined,
      expect.objectContaining({
        source: "codex-oauth-start",
        route: "/api/instances/[id]/oauth/codex/start",
      })
    );
  });

  it("classifies missing Hermes Codex auth support during device flow start", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "ModuleNotFoundError: No module named 'hermes_cli'",
        error: "Command exited with code 1: ModuleNotFoundError: No module named 'hermes_cli'",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("Codex auth support is unavailable in this Hermes runtime. Update or restart the instance, then try again.");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("hermes_cli");
    expect(apiError).toHaveBeenCalledWith(
      "Codex auth support is unavailable in this Hermes runtime. Update or restart the instance, then try again.",
      503,
      expect.objectContaining({
        failureType: "codex_start_command_failed",
        failureCategory: "codex_auth_module_missing",
        stderrPresent: true,
        errorPresent: true,
      }),
      undefined,
      expect.objectContaining({
        source: "codex-oauth-start",
        route: "/api/instances/[id]/oauth/codex/start",
      })
    );
  });

  it("does not leak raw command output when the device flow payload is malformed", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'refresh_token=super-secret',
        stderr: "",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Codex start command returned an unreadable device flow payload.");
    expect(JSON.stringify(json)).not.toContain("refresh_token");
    expect(consoleErrorSpy).toHaveBeenCalled();
    const logged = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("refresh_token=[REDACTED]");
    expect(logged).not.toContain("super-secret");
  });

  it("does not leak raw SSH errors when the device flow start fails", async () => {
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "refresh_token=super-secret",
      });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/codex/start", { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to start the Hermes Codex device flow.");
    expect(JSON.stringify(json)).not.toContain("super-secret");
    expect(apiError).toHaveBeenCalledWith(
      "Failed to start the Hermes Codex device flow.",
      500,
      expect.objectContaining({
        failureType: "codex_start_command_failed",
        failureCategory: "unknown",
        stderrPresent: true,
        redactedError: "refresh_token=[REDACTED]",
      }),
      undefined,
      expect.objectContaining({
        source: "codex-oauth-start",
        route: "/api/instances/[id]/oauth/codex/start",
      })
    );
  });
});
