import { NextRequest } from "next/server";

import { POST } from "../route";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import { sshExec } from "@/lib/hetzner/ssh";

jest.mock("@/lib/services/console-helpers", () => ({
  validateConsoleAccess: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
}));

describe("POST /api/instances/[id]/oauth/gws/setup", () => {
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

  it("does not expose raw command output when setup succeeds", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "Open this URL:\nhttps://idp.example.tld/oauth?code=abc\nclient_secret=super-secret",
      stderr: "",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/gws/setup", {
        method: "POST",
        body: JSON.stringify({
          credentialsJson: '{"installed":{"client_id":"abc","project_id":"proj"}}',
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: {
        url: "https://idp.example.tld/oauth?code=abc",
      },
    });
    expect(JSON.stringify(json)).not.toContain("client_secret");
    expect(JSON.stringify(json)).not.toContain("rawOutput");
  });

  it("redacts secrets from setup command output before logging parse failures", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "workspace setup failed\nclient_secret=super-secret",
      stderr: "",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/gws/setup", {
        method: "POST",
        body: JSON.stringify({
          credentialsJson: '{"installed":{"client_id":"abc","project_id":"proj"}}',
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toMatch(/authorization url could not be parsed/i);
    const logged = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("client_secret=[REDACTED]");
    expect(logged).not.toContain("super-secret");
  });

  it("does not leak unexpected setup failures to the client or logs", async () => {
    (sshExec as jest.Mock).mockRejectedValueOnce(new Error("gws-setup-secret-leak"));

    const response = await POST(
      new NextRequest("http://localhost/api/instances/inst-123/oauth/gws/setup", {
        method: "POST",
        body: JSON.stringify({
          credentialsJson: '{"installed":{"client_id":"abc","project_id":"proj"}}',
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to initialize Google OAuth.");
    expect(json.error).not.toContain("gws-setup-secret-leak");
    expect(getConsoleOutput()).not.toContain("gws-setup-secret-leak");
  });
});
