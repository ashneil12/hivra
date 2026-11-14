/** @jest-environment jsdom */
import { openWebuiWorkspaceInNewTab } from "@/lib/webui-open-new-tab";

describe("openWebuiWorkspaceInNewTab", () => {
  const originalFetch = global.fetch;
  const originalOpen = window.open;

  let openedWindow: {
    location: { href: string };
    opener: unknown;
    close: jest.Mock;
  };

  function mockLoginUrlResponse(body: unknown) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response);
  }

  beforeEach(() => {
    openedWindow = { location: { href: "" }, opener: {}, close: jest.fn() };
    global.fetch = jest.fn();
    Object.defineProperty(window, "open", {
      configurable: true,
      value: jest.fn(() => openedWindow),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(window, "open", {
      configurable: true,
      value: originalOpen,
    });
  });

  it.each([
    "https://agent.example.com/_sidecar/webui-login?exp=1&sig=def",
    "http://localhost:3000/webui?token=abc",
    "http://127.0.0.1:8080/webui",
  ])("navigates the fresh tab to the minted http(s) URL %s", async (url) => {
    mockLoginUrlResponse({ url, expiresAt: Date.now() + 30_000 });

    const result = await openWebuiWorkspaceInNewTab("inst_ok");

    expect(result).toEqual({ status: "opened" });
    expect(openedWindow.location.href).toBe(url);
    expect(openedWindow.close).not.toHaveBeenCalled();
    expect(openedWindow.opener).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "javascript:alert(document.cookie)",
    "data:text/html,<h1>pwned</h1>",
    "data:text/html;base64,PGgxPnB3bmVkPC9oMT4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative/path",
    "agent.example.com/path",
  ])(
    "closes the tab and errors instead of navigating to %s",
    async (url) => {
      mockLoginUrlResponse({ url, expiresAt: Date.now() + 30_000 });

      const result = await openWebuiWorkspaceInNewTab("inst_evil");

      expect(result).toEqual({
        status: "error",
        reason: "Workspace login URL was invalid.",
      });
      expect(openedWindow.location.href).toBe("");
      expect(openedWindow.close).toHaveBeenCalled();
    },
  );

  it("closes the tab and reports a malformed response when url is missing", async () => {
    mockLoginUrlResponse({ expiresAt: Date.now() + 30_000 });

    const result = await openWebuiWorkspaceInNewTab("inst_malformed");

    expect(result).toEqual({
      status: "error",
      reason: "Workspace login response was malformed.",
    });
    expect(openedWindow.close).toHaveBeenCalled();
    expect(openedWindow.location.href).toBe("");
  });

  it("reports pending when the workspace is still starting", async () => {
    mockLoginUrlResponse({ kind: "pending", message: "Still booting." });

    const result = await openWebuiWorkspaceInNewTab("inst_pending");

    expect(result).toEqual({ status: "pending", message: "Still booting." });
    expect(openedWindow.close).toHaveBeenCalled();
    expect(openedWindow.location.href).toBe("");
  });

  it("reports blocked when the popup is suppressed", async () => {
    Object.defineProperty(window, "open", {
      configurable: true,
      value: jest.fn(() => null),
    });

    const result = await openWebuiWorkspaceInNewTab("inst_blocked");

    expect(result).toEqual({ status: "blocked" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("closes the tab and reports the HTTP failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "gateway exploded",
    } as unknown as Response);

    const result = await openWebuiWorkspaceInNewTab("inst_http_err");

    expect(result).toEqual({
      status: "error",
      reason: "HTTP 500: gateway exploded",
    });
    expect(openedWindow.close).toHaveBeenCalled();
    expect(openedWindow.location.href).toBe("");
  });
});
