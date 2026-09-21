import { NextRequest } from "next/server";

import { POST } from "../route";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { sshExec } from "@/lib/hetzner/ssh";
import { makeJsonRequest } from "@/test-utils";

jest.mock("@/lib/services/console-helpers", () => ({
  validateConsoleAccess: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

describe("POST /api/instances/[id]/oauth/gws/exchange", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (validateConsoleAccess as jest.Mock).mockResolvedValue({
      id: "inst-123",
      hostIp: "203.0.113.10",
      errorResponse: null,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function getConsoleOutput() {
    return JSON.stringify(consoleErrorSpy.mock.calls);
  }

  it("does not expose raw command output when exchange succeeds", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "token saved to ~/.hermes/google_token.json\nrefresh_token=super-secret",
      stderr: "",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/gws/exchange", {
        method: "POST",
        body: JSON.stringify({
          code: "oauth-code",
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: {
        success: true,
      },
    });
    expect(JSON.stringify(json)).not.toContain("refresh_token");
    expect(JSON.stringify(json)).not.toContain("rawOutput");
  });

  it("restarts the resolved container (webfree-aware) after a successful exchange", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "token saved",
      stderr: "",
    });

    await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123/oauth/gws/exchange", { code: "oauth-code" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    const sentCommand = (sshExec as jest.Mock).mock.calls[0][1] as string;
    // The restart must target the resolved container, with the webfree
    // (agent-<id>-gateway) fallback — never the bare name unconditionally.
    expect(sentCommand).toContain('docker restart "$c"');
    expect(sentCommand).toContain("agent-inst-123-gateway");
    expect(sentCommand).not.toContain("docker restart agent-inst-123");
    // Restart still only fires on success with no "ERROR:" in the output.
    expect(sentCommand).toContain('if [ $exit_code -eq 0 ] && ! echo "$output" | grep -q "ERROR:"; then');
  });

  it("redacts secrets from exchange command output before logging failures", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ERROR: exchange failed\nrefresh_token=super-secret",
      stderr: "",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/gws/exchange", {
        method: "POST",
        body: JSON.stringify({
          code: "oauth-code",
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Failed to exchange Google OAuth code.");
    const logged = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("refresh_token=[REDACTED]");
    expect(logged).not.toContain("super-secret");
  });

  it("does not leak unexpected exchange failures to the client or logs", async () => {
    (sshExec as jest.Mock).mockRejectedValueOnce(new Error("gws-exchange-secret-leak"));

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/gws/exchange", {
        method: "POST",
        body: JSON.stringify({
          code: "oauth-code",
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to exchange Google OAuth code.");
    expect(json.error).not.toContain("gws-exchange-secret-leak");
    expect(getConsoleOutput()).not.toContain("gws-exchange-secret-leak");
  });
});
