/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { consoleEncodingFor, HivraConsoleDesktop } from "../HivraConsoleDesktop";
import { WorkspaceModalLayerProvider } from "@/components/workspace/WorkspaceModalLayerContext";
import {
  activateNativeOmarchyDesktop,
  browserNativeDesktopDependencies,
  focusNativeDesktopProcess,
  inspectNativeDesktopProcess,
  renewNativeOmarchyDesktop,
  stopNativeOmarchyDesktop,
} from "@/lib/remote-computers/native-desktop-handoff";
import { streamModeStorageKey } from "@/lib/remote-computers/streaming-mode-preference";

jest.mock("@/lib/remote-computers/native-desktop-handoff", () => ({
  activateNativeOmarchyDesktop: jest.fn(),
  browserNativeDesktopDependencies: jest.fn(),
  focusNativeDesktopProcess: jest.fn(),
  inspectNativeDesktopProcess: jest.fn(),
  renewNativeOmarchyDesktop: jest.fn(),
  stopNativeOmarchyDesktop: jest.fn(),
}));

const activateNative = activateNativeOmarchyDesktop as jest.MockedFunction<typeof activateNativeOmarchyDesktop>;
const focusNative = focusNativeDesktopProcess as jest.MockedFunction<typeof focusNativeDesktopProcess>;
const nativeDependencies = browserNativeDesktopDependencies as jest.MockedFunction<typeof browserNativeDesktopDependencies>;
const inspectNative = inspectNativeDesktopProcess as jest.MockedFunction<typeof inspectNativeDesktopProcess>;
const renewNative = renewNativeOmarchyDesktop as jest.MockedFunction<typeof renewNativeOmarchyDesktop>;
const stopNative = stopNativeOmarchyDesktop as jest.MockedFunction<typeof stopNativeOmarchyDesktop>;

const mockRfbInstances: Array<Record<string, unknown>> = [];

jest.mock("@novnc/novnc", () => ({
  __esModule: true,
  default: class MockRFB {
    scaleViewport = false;
    resizeSession = false;
    clipViewport = true;
    viewOnly = true;
    focusOnClick = false;
    showDotCursor = false;
    qualityLevel = 0;
    compressionLevel = 0;
    disconnect = jest.fn();
    focus = jest.fn();
    addEventListener = jest.fn();

    constructor(target: HTMLElement, url: string, options: unknown) {
      mockRfbInstances.push(this as unknown as Record<string, unknown>);
      Object.assign(this, { target, url, options });
    }
  },
}));

function response(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

function nativeActivationResult(options: {
  expiresAt?: string;
  streamingMode?: "hq" | "qhd" | "uhd" | "performance";
  sessionId?: string;
  activationId?: string;
  processIdentifier?: number;
} = {}) {
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 240_000).toISOString();
  return {
    ok: true as const,
    handoff: {
      sessionId: options.sessionId ?? "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      clientId: "018f6d3c-1d91-7c65-9d86-37fc915b8380",
      clientCertificatePem: "certificate",
      clientCertificateSha256: "a".repeat(64),
      streamingMode: options.streamingMode ?? "performance",
      exchangeCode: "e".repeat(43), verifier: "v".repeat(43),
      brokerOrigin: "https://desktop.example.test", expiresAt,
    },
    sessionToken: `hrs1_${"t".repeat(43)}`,
    activationId: options.activationId ?? "018f6d3c-1d91-7c65-9d86-37fc915b8381",
    launched: true as const,
    processIdentifier: options.processIdentifier ?? 4242,
    server: {
      id: "00000000-0000-4000-8000-000000002099",
      certificatePem: "server certificate", certificateSha256: "b".repeat(64),
      guestBootId: "018f6d3c-1d91-7c65-9d86-37fc915b8382", connectionIpv4: "198.51.100.11",
    },
  };
}

describe("HivraConsoleDesktop", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    mockRfbInstances.length = 0;
    window.localStorage.clear();
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: jest.fn(() => "018f6d3c-1d91-7c65-9d86-37fc915b8383"),
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    activateNative.mockReset();
    focusNative.mockReset();
    nativeDependencies.mockReset();
    inspectNative.mockReset();
    renewNative.mockReset();
    stopNative.mockReset();
    focusNative.mockResolvedValue({ ok: true, sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379", processIdentifier: 4242 });
    nativeDependencies.mockReturnValue(null);
    inspectNative.mockResolvedValue({ ok: true, sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      processIdentifier: 4242, running: true });
    fetchMock.mockImplementation(() => response(201, {
      success: true,
      data: {
        websocketUrl: "wss://console-canary.hermesos.cloud/console/2099?token=test",
        password: "one-time-password",
        profile: "omarchy",
      },
    }));
  });

  afterAll(() => {
    if (originalFetch) Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("uses HQ by default while rendering pointer movement locally", async () => {
    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099" name="Omarchy" />);

    await waitFor(() => expect(mockRfbInstances).toHaveLength(1));
    expect(mockRfbInstances[0]).toMatchObject({
      showDotCursor: true,
      scaleViewport: true,
      resizeSession: true,
      viewOnly: false,
      focusOnClick: true,
      qualityLevel: 9,
      compressionLevel: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hivra/agents/00000000-0000-4000-8000-000000002099/console",
      expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store" }),
    );
    expect(screen.getByLabelText("Omarchy interactive desktop")).toBeTruthy();
    expect(screen.getByRole("button", { name: "HQ 1080p" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Performance 720p" })).toBeTruthy();
  });

  it("never starts VNC for Windows and offers the RDP gateway", async () => {
    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002098"
      name="Windows" profile="windows" />);

    expect(mockRfbInstances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open fast Windows desktop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect desktop" })).toBeNull();
    expect(screen.getByText("Open Windows desktop here")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Desktop quality" })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.queryByRole("group", { name: "Desktop streaming mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "HQ 1080p" })).toBeNull();
    expect(screen.queryByText("Windows", { exact: true })).toBeNull();
    expect(screen.getByRole("status").closest("header")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open fast Windows desktop" }).textContent).toBe("Open");
  });

  it("persists Windows quality and retains the frame until an explicit reconnect applies it", async () => {
    window.localStorage.setItem(streamModeStorageKey("windows-id"), "qhd");
    fetchMock.mockImplementation(() => response(201, { success: true, data: {
      launchUrl: `https://windows-canary.hermesos.cloud/guacamole/#/client/${fetchMock.mock.calls.length}`,
    } }));
    render(<HivraConsoleDesktop computerId="windows-id" name="Work PC" profile="windows" />);
    const quality = screen.getByRole("combobox", { name: "Desktop quality" }) as HTMLSelectElement;
    expect(quality.value).toBe("qhd");
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    const frame = await screen.findByTitle("Work PC Windows desktop");
    fireEvent.load(frame);
    expect(screen.getByText("Open", { selector: "span" })).toBeTruthy();
    const originalSource = frame.getAttribute("src");
    fireEvent.change(quality, { target: { value: "performance" } });
    expect(window.localStorage.getItem(streamModeStorageKey("windows-id"))).toBe("performance");
    expect(screen.getByRole("status").textContent).toBe("Reconnect to apply the selected quality.");
    expect(frame.getAttribute("src")).toBe(originalSource);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Windows desktop" }));
    await waitFor(() => expect(screen.getByTitle("Work PC Windows desktop")).not.toBe(frame));
    expect(screen.getByTitle("Work PC Windows desktop").getAttribute("src")).not.toBe(originalSource);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/hivra/agents/windows-id/windows-desktop",
      expect.objectContaining({ body: JSON.stringify({ streamingMode: "performance" }) }));
    expect(screen.queryByText("Reconnect to apply the selected quality.")).toBeNull();
  });

  it("reloads a failed Windows iframe on explicit retry even when the handoff URL is unchanged", async () => {
    const launchUrl = "https://windows-canary.hermesos.cloud/guacamole/#/client/same";
    fetchMock.mockImplementation(() => response(201, { success: true, data: { launchUrl } }));
    render(<HivraConsoleDesktop computerId="windows-id" name="Work PC" profile="windows" />);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    const failedFrame = await screen.findByTitle("Work PC Windows desktop");
    fireEvent.error(failedFrame);
    expect(screen.getByRole("status").textContent).toBe("Windows desktop could not load. Reconnect Windows to request a fresh session.");
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(screen.getByTitle("Work PC Windows desktop")).toBe(failedFrame);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTitle("Work PC Windows desktop")).not.toBe(failedFrame));
    const retriedFrame = screen.getByTitle("Work PC Windows desktop");
    expect(retriedFrame.getAttribute("src")).toBe(launchUrl);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.load(retriedFrame);
    expect(screen.getByRole("status").textContent).toBe("Windows desktop gateway loaded · Full screen is optional");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect Windows desktop" })).toBeTruthy();
  });

  it("keeps Windows failure diagnostics in the strip with a contextual retry", async () => {
    fetchMock.mockImplementation(() => response(503, { success: false, error: "Gateway unavailable" }));
    render(<HivraConsoleDesktop computerId="windows-id" name="Work PC" profile="windows" />);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(retry.closest("header")).toBeTruthy();
    expect(screen.getByText("Couldn’t open")).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Gateway unavailable");
    expect(screen.getByRole("status").getAttribute("title")).toBe("Gateway unavailable");
    expect(screen.getByRole("status").closest("header")).toBe(retry.closest("header"));
    fireEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("replaces the idle prompt during handoff and keeps loading until the gateway frame loads", async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    render(<HivraConsoleDesktop computerId="windows-id" name="Windows" profile="windows" />);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    expect(screen.getByText("Opening Windows…")).toBeInTheDocument();
    expect(screen.queryByText("Open Windows desktop here")).not.toBeInTheDocument();
    await act(async () => finish(await response(201, { success: true, data: {
      launchUrl: "https://windows-canary.hermesos.cloud/guacamole/#/client/loading-test",
    } })));
    const frame = await screen.findByTitle("Windows Windows desktop");
    expect(screen.getByText("Opening Windows…")).toBeInTheDocument();
    fireEvent.load(frame);
    expect(screen.queryByText("Opening Windows…")).not.toBeInTheDocument();
    expect(screen.getByTitle("Windows Windows desktop")).toBe(frame);
  });

  it("clears the loading screen on handoff failure and leaves retry available", async () => {
    fetchMock.mockImplementation(() => response(503, { error: "Gateway unavailable" }));
    render(<HivraConsoleDesktop computerId="windows-id" name="Windows" profile="windows" />);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    await screen.findByText("Gateway unavailable");
    expect(screen.queryByText("Opening Windows…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("opens Windows inline without navigation and retains the same frame through fullscreen exit and tab changes", async () => {
    const before = window.location.href;
    const launchUrl = "https://windows-canary.hermesos.cloud/guacamole/#/client/test?token=handoff";
    fetchMock.mockImplementation(() => response(201, { success: true, data: { launchUrl } }));
    const { rerender } = render(<HivraConsoleDesktop computerId="windows-id" name="Windows" profile="windows" />);
    const panel = screen.getByLabelText("Windows interactive desktop");
    Object.defineProperty(panel, "clientWidth", { configurable: true, value: 816 });
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 617 });
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    const frame = await screen.findByTitle("Windows Windows desktop");
    expect(frame.getAttribute("src")).toBe(launchUrl);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(window.location.href).toBe(before);
    expect(mockRfbInstances).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/hivra/agents/windows-id/windows-desktop",
      expect.objectContaining({ body: JSON.stringify({ streamingMode: "hq", viewport: { width: 816, height: 617 } }) }));
    const shell = screen.getByLabelText("Windows interactive desktop").parentElement!;
    const requestFullscreen = jest.fn(async () => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: shell });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(shell, "requestFullscreen", { configurable: true, value: requestFullscreen });
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    await screen.findByRole("button", { name: "Exit full screen" });
    expect(screen.getByTitle("Windows Windows desktop")).toBe(frame);
    // The browser handles Escape by leaving fullscreen and emitting this event.
    act(() => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
    expect(screen.getByTitle("Windows Windows desktop")).toBe(frame);
    rerender(<HivraConsoleDesktop computerId="windows-id" name="Windows" profile="windows" active={false} />);
    rerender(<HivraConsoleDesktop computerId="windows-id" name="Windows" profile="windows" />);
    expect(screen.getByTitle("Windows Windows desktop")).toBe(frame);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("expands Windows in place, hiding the shell chrome, when element fullscreen is unavailable", async () => {
    const launchUrl = "https://windows-canary.hermesos.cloud/guacamole/#/client/test?token=handoff";
    fetchMock.mockImplementation(() => response(201, { success: true, data: { launchUrl } }));
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
    const layerChanges: boolean[] = [];
    try {
      const { rerender } = render(
        <WorkspaceModalLayerProvider onActiveChange={(active) => layerChanges.push(active)}>
          <nav><button type="button">Manage</button></nav>
          <HivraConsoleDesktop computerId="windows-id" name="Windows" profile="windows" />
        </WorkspaceModalLayerProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
      const frame = await screen.findByTitle("Windows Windows desktop");
      const shell = screen.getByLabelText("Windows interactive desktop").parentElement!;
      const manage = screen.getByText("Manage");
      // No element fullscreen, so the copy points at the button rather than
      // Escape, which the frame would swallow.
      expect(screen.getByRole("button", { name: "Full screen" })).toHaveAttribute("title", "Expand desktop; Exit full screen returns here");
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      expect(shell).toHaveAttribute("data-immersive", "true");
      expect(layerChanges.at(-1)).toBe(true);
      expect(manage.closest("[inert]")).not.toBeNull();
      expect(frame.closest("[inert]")).toBeNull();
      expect(screen.queryByText(/Fullscreen is unavailable/)).not.toBeInTheDocument();
      expect(screen.getByTitle("Windows Windows desktop")).toBe(frame);
      fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
      expect(shell).not.toHaveAttribute("data-immersive");
      expect(layerChanges.at(-1)).toBe(false);
      expect(manage.closest("[inert]")).toBeNull();
      // Leaving the Desktop tab never strands the shell with its chrome hidden.
      fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      expect(layerChanges.at(-1)).toBe(true);
      rerender(
        <WorkspaceModalLayerProvider onActiveChange={(active) => layerChanges.push(active)}>
          <nav><button type="button">Manage</button></nav>
          <HivraConsoleDesktop computerId="windows-id" name="Windows" profile="windows" active={false} />
        </WorkspaceModalLayerProvider>,
      );
      expect(layerChanges.at(-1)).toBe(false);
      expect(shell).not.toHaveAttribute("data-immersive");
      expect(manage.closest("[inert]")).toBeNull();
    } finally {
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: undefined });
    }
  });

  it.each([
    "https://attacker.example/guacamole/",
    "https://windows-canary.hermesos.cloud:444/guacamole/",
    "https://user:password@windows-canary.hermesos.cloud/guacamole/",
  ])("rejects an unsafe inline Windows handoff %s", async launchUrl => {
    fetchMock.mockImplementation(() => response(201, { success: true, data: { launchUrl } }));
    render(<HivraConsoleDesktop computerId="windows-id" name="Windows" profile="windows" />);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    expect(await screen.findByText("The Windows desktop handoff was invalid.")).toBeTruthy();
    expect(screen.queryByTitle("Windows Windows desktop")).toBeNull();
  });

  it("does not mount a stale handoff after switching computers", async () => {
    let complete!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
    const { rerender } = render(<HivraConsoleDesktop computerId="old-windows" name="Old Windows" profile="windows" />);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    rerender(<HivraConsoleDesktop computerId="new-windows" name="New Windows" profile="windows" />);
    await act(async () => {
      complete(await response(201, { success: true, data: {
        launchUrl: "https://windows-canary.hermesos.cloud/guacamole/#/client/old?token=old",
      } }));
    });
    expect(screen.queryByTitle("New Windows Windows desktop")).toBeNull();
    expect(screen.getByRole("button", { name: "Open fast Windows desktop" })).toBeTruthy();
  });

  it.each(["prepared", "failed"])("ignores stale %s preparation after switching computers", async result => {
    let complete!: (value: Response) => void;
    fetchMock
      .mockImplementationOnce(() => response(409, { success: false, code: "windows_prepare_required" }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    const { rerender } = render(<HivraConsoleDesktop computerId="old-windows" name="Old Windows" profile="windows" />);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    await screen.findByText("Preparing Windows Remote Desktop and verifying its guest firewall boundary…");
    rerender(<HivraConsoleDesktop computerId="new-windows" name="New Windows" profile="windows" />);
    expect(screen.queryByText("Preparing Windows Remote Desktop and verifying its guest firewall boundary…")).toBeNull();
    await act(async () => {
      complete(await response(result === "prepared" ? 200 : 503, result === "prepared"
        ? { success: true, data: { prepared: true } }
        : { success: false, error: "Old computer preparation failed" }));
    });
    expect(screen.queryByText("Windows Remote Desktop is prepared and verified. Opening the fast desktop…")).toBeNull();
    expect(screen.queryByText("Old computer preparation failed")).toBeNull();
    expect(screen.queryByTitle("New Windows Windows desktop")).toBeNull();
    expect((screen.getByRole("button", { name: "Open fast Windows desktop" }) as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never offers or starts VNC for Omarchy", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);

    expect(screen.getByText("Open Omarchy desktop")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/hivra/agents/00000000-0000-4000-8000-000000002099/console",
      expect.anything(),
    );
    expect(screen.queryByRole("button", { name: "Use recovery console" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect desktop" })).toBeNull();
    expect(mockRfbInstances).toHaveLength(0);
  });

  it("opens the fast Windows path once and removes the one-shot URL flag", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/windows?tab=desktop&open=fast");
    fetchMock.mockImplementation((input: RequestInfo | URL) => String(input).endsWith("/windows-desktop")
      ? response(503, { success: false, error: "Gateway unavailable" })
      : response(201, {
        success: true,
        data: {
          websocketUrl: "wss://console-canary.hermesos.cloud/console/2098?token=test",
          password: "one-time-password",
          profile: "windows",
        },
      }));

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002098"
      name="Windows" profile="windows" autoOpenFast />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/hivra/agents/00000000-0000-4000-8000-000000002098/windows-desktop",
      expect.objectContaining({ body: JSON.stringify({ streamingMode: "hq" }) }),
    ));
    expect(window.location.search).toBe("?tab=desktop");
    expect(await screen.findByText("Gateway unavailable")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["windows_prepare_required", "windows_prepare_resume_required"])("checks Windows preparation once for explicit %s", async code => {
    fetchMock
      .mockImplementationOnce(() => response(409, {
        success: false,
        code,
        error: "Windows RDP needs to be prepared again.",
      }))
      .mockImplementationOnce(() => response(200, {
        success: true,
        data: { prepared: true, accessReady: false },
      }))
      .mockImplementationOnce(() => response(503, {
        success: false,
        error: "The Windows gateway did not respond.",
      }));

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002098"
      name="Windows" profile="windows" />);

    expect(mockRfbInstances).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));

    await waitFor(() => expect(screen.getByText("The Windows gateway did not respond.")).toBeTruthy());
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "/api/hivra/agents/00000000-0000-4000-8000-000000002098/remote-desktop",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ action: "prepare" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      "/api/hivra/agents/00000000-0000-4000-8000-000000002098/windows-desktop",
      expect.objectContaining({ body: JSON.stringify({ streamingMode: "hq" }) }),
    );
  });

  it.each([401, 409, 429, 503])("does not prepare Windows after an unrelated %s handoff failure", async status => {
    fetchMock.mockImplementation(() => response(status, { success: false, error: "Handoff unavailable" }));
    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002098"
      name="Windows" profile="windows" />);
    fireEvent.click(screen.getByRole("button", { name: "Open fast Windows desktop" }));
    expect(await screen.findByText("Handoff unavailable")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hivra/agents/00000000-0000-4000-8000-000000002098/windows-desktop",
      expect.anything(),
    );
  });

  it("applies and persists Performance mode without reconnecting", async () => {
    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099" name="Omarchy" />);

    await waitFor(() => expect(mockRfbInstances).toHaveLength(1));
    const addEventListener = mockRfbInstances[0].addEventListener as jest.Mock;
    const connected = addEventListener.mock.calls.find(([event]) => event === "connect")?.[1] as (() => void) | undefined;
    expect(connected).toBeDefined();
    act(() => connected?.());

    fireEvent.click(screen.getByRole("button", { name: "Performance 720p" }));

    expect(screen.getByRole("button", { name: "Performance 720p" }).getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(streamModeStorageKey("00000000-0000-4000-8000-000000002099"))).toBe("performance");
    expect(mockRfbInstances[0]).toMatchObject({ qualityLevel: 6, compressionLevel: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the established profile-specific Performance presets", () => {
    expect(consoleEncodingFor("windows", "performance")).toEqual({ qualityLevel: 5, compressionLevel: 6 });
    expect(consoleEncodingFor("omarchy", "performance")).toEqual({ qualityLevel: 6, compressionLevel: 4 });
  });

  it("opens Omarchy natively with the explicitly selected streaming mode", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    activateNative.mockResolvedValue(nativeActivationResult());

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);

    fireEvent.click(await screen.findByRole("button", { name: "Performance 720p" }));
    fireEvent.click(screen.getByRole("button", { name: "Open native Omarchy desktop" }));

    await waitFor(() => expect(activateNative).toHaveBeenCalledWith({
      computerId: "00000000-0000-4000-8000-000000002099",
      udp: "direct",
      streamingMode: "performance",
    }));
    expect(await screen.findByText("Native Performance: 720p60 at 12 Mbps. Opened in Moonlight.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Return to Omarchy desktop" }));
    await waitFor(() => expect(focusNative).toHaveBeenCalledWith({
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      processIdentifier: 4242,
    }));
    expect(screen.getByRole("button", { name: "Stop native Omarchy desktop" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "HQ 1080p" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Performance 720p" }).hasAttribute("disabled")).toBe(false);

    stopNative.mockResolvedValue({
      ok: true,
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      localProcessStopped: true,
      controllerReleased: true,
      desktopReady: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop native Omarchy desktop" }));
    await waitFor(() => expect(stopNative).toHaveBeenCalledWith({
      computerId: "00000000-0000-4000-8000-000000002099",
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
    }));
    expect(await screen.findByText("Native desktop stopped and controller released.")).toBeTruthy();
    expect(window.localStorage.getItem(
      "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099",
    )).toBeNull();
  });

  it("waits for an explicit Omarchy launch", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    activateNative.mockResolvedValue(nativeActivationResult({ streamingMode: "hq" }));

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);

    expect(activateNative).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/hivra/agents/00000000-0000-4000-8000-000000002099/console",
      expect.anything(),
    );
    expect(screen.getByText("Open Omarchy desktop")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use recovery console" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open native Omarchy desktop" }));
    await waitFor(() => expect(activateNative).toHaveBeenCalledWith({
      computerId: "00000000-0000-4000-8000-000000002099",
      udp: "direct",
      streamingMode: "hq",
    }));
    expect(await screen.findByText("Native HQ: 1080p60 at 25 Mbps. Opened in Moonlight.")).toBeTruthy();
  });

  it("prepares an unready Omarchy computer once before opening it natively", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    activateNative
      .mockResolvedValueOnce({
        ok: false,
        code: "capability_unavailable",
        profileReleasePending: false,
        sessionReleasePending: false,
      })
      .mockResolvedValueOnce(nativeActivationResult({ streamingMode: "hq" }));
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith("/remote-desktop")) {
        return response(200, { success: true, data: { prepared: true, accessReady: false } });
      }
      return response(201, {
        success: true,
        data: {
          websocketUrl: "wss://console-canary.hermesos.cloud/console/2099?token=test",
          password: "one-time-password",
          profile: "omarchy",
        },
      });
    });

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open native Omarchy desktop" }));

    await waitFor(() => expect(activateNative).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hivra/agents/00000000-0000-4000-8000-000000002099/remote-desktop",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ action: "prepare" }),
      }),
    );
    expect(await screen.findByText("Native HQ: 1080p60 at 25 Mbps. Opened in Moonlight.")).toBeTruthy();
  });

  it("re-prepares an Omarchy computer when its guest capability became stale", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    activateNative
      .mockResolvedValueOnce({
        ok: false,
        code: "computer_not_ready",
        profileReleasePending: false,
        sessionReleasePending: false,
      })
      .mockResolvedValueOnce(nativeActivationResult({ streamingMode: "performance" }));
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith("/remote-desktop")) {
        return response(200, { success: true, data: { prepared: true, accessReady: false } });
      }
      return response(201, {
        success: true,
        data: {
          websocketUrl: "wss://console-canary.hermesos.cloud/console/2099?token=test",
          password: "one-time-password",
          profile: "omarchy",
        },
      });
    });

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);
    fireEvent.click(await screen.findByRole("button", { name: "Performance 720p" }));
    fireEvent.click(screen.getByRole("button", { name: "Open native Omarchy desktop" }));

    await waitFor(() => expect(activateNative).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hivra/agents/00000000-0000-4000-8000-000000002099/remote-desktop",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "prepare" }) }),
    );
    expect(await screen.findByText("Native Performance: 720p60 at 12 Mbps. Opened in Moonlight.")).toBeTruthy();
  });

  it("switches an active native stream only after releasing its exact controller", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    const next = nativeActivationResult({
      streamingMode: "hq",
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8384",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8385",
      processIdentifier: 5252,
    });
    activateNative.mockResolvedValueOnce(nativeActivationResult()).mockResolvedValueOnce(next);
    stopNative.mockResolvedValue({
      ok: true,
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      localProcessStopped: true,
      controllerReleased: true,
      desktopReady: false,
    });

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);
    fireEvent.click(await screen.findByRole("button", { name: "Performance 720p" }));
    fireEvent.click(screen.getByRole("button", { name: "Open native Omarchy desktop" }));
    await screen.findByText("Native Performance: 720p60 at 12 Mbps. Opened in Moonlight.");

    fireEvent.click(screen.getByRole("button", { name: "HQ 1080p" }));

    await waitFor(() => expect(stopNative).toHaveBeenCalledWith({
      computerId: "00000000-0000-4000-8000-000000002099",
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
    }));
    await waitFor(() => expect(activateNative).toHaveBeenLastCalledWith({
      computerId: "00000000-0000-4000-8000-000000002099",
      udp: "direct",
      streamingMode: "hq",
    }));
    expect(stopNative.mock.invocationCallOrder[0]).toBeLessThan(activateNative.mock.invocationCallOrder[1]);
    expect(await screen.findByText("Native HQ: 1080p60 at 25 Mbps. Opened in Moonlight.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "HQ 1080p" }).getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(String(window.localStorage.getItem(
      "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099",
    )))).toMatchObject({
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8384",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8385",
      processIdentifier: 5252,
      streamingMode: "hq",
    });
  });

  it("keeps the active native mode held when a quality switch cannot prove stop", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    activateNative.mockResolvedValue(nativeActivationResult());
    stopNative.mockResolvedValue({
      ok: false,
      code: "native_stop_failed",
      localProcessStopPending: true,
      sessionReleasePending: true,
    });

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);
    fireEvent.click(await screen.findByRole("button", { name: "Performance 720p" }));
    fireEvent.click(screen.getByRole("button", { name: "Open native Omarchy desktop" }));
    await screen.findByText("Native Performance: 720p60 at 12 Mbps. Opened in Moonlight.");

    fireEvent.click(screen.getByRole("button", { name: "HQ 1080p" }));

    expect(await screen.findByText(/Could not prove the current Performance stream stopped/)).toBeTruthy();
    expect(activateNative).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Performance 720p" }).getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(streamModeStorageKey("00000000-0000-4000-8000-000000002099"))).toBe("performance");
  });

  it("re-proves and resumes the exact running Moonlight session after a page reload", async () => {
    jest.useFakeTimers();
    try {
      nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
      const activation = nativeActivationResult().handoff;
      window.localStorage.setItem(
        "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099",
        JSON.stringify({
          sessionId: activation.sessionId,
          activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
          processIdentifier: 4242,
          expiresAt: activation.expiresAt,
          streamingMode: activation.streamingMode,
        }),
      );

      render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
        name="Omarchy" profile="omarchy" />);

      await act(async () => { await Promise.resolve(); });
      expect(inspectNative).toHaveBeenCalledWith({ sessionId: activation.sessionId, processIdentifier: 4242 });
      expect(screen.getByText("Native Performance: 720p60 at 12 Mbps. Reconnected to Moonlight.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Performance 720p" }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: "Stop native Omarchy desktop" })).toBeTruthy();
      expect(activateNative).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("releases a saved controller when its exact Moonlight process is no longer running", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    inspectNative.mockResolvedValue({ ok: true,
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379", processIdentifier: 4242, running: false });
    stopNative.mockResolvedValue({
      ok: true,
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      localProcessStopped: false,
      controllerReleased: true,
      desktopReady: false,
    });
    const key = "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099";
    window.localStorage.setItem(key, JSON.stringify({
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
      streamingMode: "hq",
    }));

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);

    await waitFor(() => expect(window.localStorage.getItem(key)).toBeNull());
    expect(stopNative).toHaveBeenCalledWith({
      computerId: "00000000-0000-4000-8000-000000002099",
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
    });
    expect(screen.getByText("Closed Moonlight session released.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open native Omarchy desktop" })).toBeTruthy();
    expect(activateNative).not.toHaveBeenCalled();
  });

  it("closes a re-proved Moonlight process after its native lease expires", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    inspectNative.mockResolvedValue({ ok: true,
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379", processIdentifier: 4242, running: true });
    stopNative.mockResolvedValue({
      ok: true,
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      localProcessStopped: true,
      controllerReleased: true,
      desktopReady: false,
    });
    const key = "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099";
    window.localStorage.setItem(key, JSON.stringify({
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      streamingMode: "hq",
    }));

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);

    await waitFor(() => expect(window.localStorage.getItem(key)).toBeNull());
    expect(stopNative).toHaveBeenCalledWith({
      computerId: "00000000-0000-4000-8000-000000002099",
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
    });
    expect(screen.getByText("Expired native stream closed and its controller was released.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open native Omarchy desktop" })).toBeTruthy();
    expect(activateNative).not.toHaveBeenCalled();
  });

  it("forgets an expired closed session that the server has already released", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    inspectNative.mockResolvedValue({ ok: true,
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379", processIdentifier: 4242, running: false });
    stopNative.mockResolvedValue({
      ok: false,
      code: "stop_denied",
      localProcessStopPending: true,
      sessionReleasePending: true,
    });
    const key = "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099";
    window.localStorage.setItem(key, JSON.stringify({
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      streamingMode: "hq",
    }));

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);

    await waitFor(() => expect(window.localStorage.getItem(key)).toBeNull());
    expect(screen.getByText("Closed expired Moonlight session was already released.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open native Omarchy desktop" })).toBeTruthy();
  });

  it("retains uncertain recovered ownership and offers an exact stop retry", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    inspectNative.mockResolvedValue({ ok: false, code: "native_status_uncertain" });
    const key = "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099";
    window.localStorage.setItem(key, JSON.stringify({
      sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
      activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
      processIdentifier: 4242,
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
      streamingMode: "hq",
    }));

    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
      name="Omarchy" profile="omarchy" />);

    expect(await screen.findByText(
      "The saved Moonlight process could not be re-proved. Retry stop to release it safely.",
    )).toBeTruthy();
    expect(window.localStorage.getItem(key)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Stop native Omarchy desktop" }).textContent).toContain("Retry stop");
    expect(stopNative).not.toHaveBeenCalled();
    expect(activateNative).not.toHaveBeenCalled();
  });

  it("continues renewal from a re-proved session and persists the new deadline", async () => {
    jest.useFakeTimers();
    try {
      nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
      const key = "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099";
      const expiresAt = new Date(Date.now() + 95_000).toISOString();
      const renewedExpiresAt = new Date(Date.now() + 330_000).toISOString();
      window.localStorage.setItem(key, JSON.stringify({
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        processIdentifier: 4242,
        expiresAt,
        streamingMode: "hq",
      }));
      renewNative.mockResolvedValue({
        ok: true,
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        renewalId: "018f6d3c-1d91-7c65-9d86-37fc915b8383",
        renewalCount: 1,
        expiresAt: renewedExpiresAt,
        continuousExpiresAt: new Date(Date.now() + 43_200_000).toISOString(),
        desktopReady: true,
      });

      render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
        name="Omarchy" profile="omarchy" />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(renewNative).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(window.localStorage.getItem(key)))).toMatchObject({
        expiresAt: renewedExpiresAt,
        streamingMode: "hq",
        processIdentifier: 4242,
      });
      expect(screen.getByText("Native HQ: 1080p60 at 25 Mbps. Active in Moonlight.")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("renews early enough for a backgrounded native handoff", async () => {
    jest.useFakeTimers();
    try {
      nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
      const key = "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099";
      window.localStorage.setItem(key, JSON.stringify({
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        processIdentifier: 4242,
        expiresAt: new Date(Date.now() + 185_000).toISOString(),
        streamingMode: "performance",
      }));
      renewNative.mockResolvedValue({
        ok: true,
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        renewalId: "018f6d3c-1d91-7c65-9d86-37fc915b8383",
        renewalCount: 1,
        expiresAt: new Date(Date.now() + 425_000).toISOString(),
        continuousExpiresAt: new Date(Date.now() + 43_200_000).toISOString(),
        desktopReady: true,
      });

      render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
        name="Omarchy" profile="omarchy" />);
      await act(async () => { await Promise.resolve(); });
      expect(renewNative).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(renewNative).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("rechecks at the safe deadline and closes the stream after renewal fails", async () => {
    jest.useFakeTimers();
    try {
      nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
      const key = "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099";
      const expiresAt = new Date(Date.now() + 95_000).toISOString();
      window.localStorage.setItem(key, JSON.stringify({
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        processIdentifier: 4242,
        expiresAt,
        streamingMode: "hq",
      }));
      renewNative.mockResolvedValue({ ok: false, code: "renewal_uncertain", deadlineUnchanged: true });
      stopNative.mockResolvedValue({
        ok: true,
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        localProcessStopped: true,
        controllerReleased: true,
        desktopReady: false,
      });

      render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
        name="Omarchy" profile="omarchy" />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renewNative).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(91_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(stopNative).toHaveBeenCalledWith({
        computerId: "00000000-0000-4000-8000-000000002099",
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        processIdentifier: 4242,
      });
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(screen.getByText("Expired native stream closed and its controller was released.")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("releases the server controller after the exact Moonlight process exits", async () => {
    jest.useFakeTimers();
    try {
      nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
      activateNative.mockResolvedValue(nativeActivationResult());
      inspectNative.mockResolvedValue({ ok: true,
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379", processIdentifier: 4242, running: false });
      stopNative.mockResolvedValue({
        ok: true, sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381",
        localProcessStopped: false, controllerReleased: true, desktopReady: false,
      });
      render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002099"
        name="Omarchy" profile="omarchy" />);
      fireEvent.click(screen.getByRole("button", { name: "Performance 720p" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open native Omarchy desktop" }));
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(inspectNative).toHaveBeenCalledWith({
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379", processIdentifier: 4242,
      });
      expect(stopNative).toHaveBeenCalledWith({
        computerId: "00000000-0000-4000-8000-000000002099",
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8379",
        activationId: "018f6d3c-1d91-7c65-9d86-37fc915b8381", processIdentifier: 4242,
      });
      expect(renewNative).not.toHaveBeenCalled();
      expect(screen.getByText("Moonlight closed and its controller was released.")).toBeTruthy();
      expect(window.localStorage.getItem(
        "hivra.desktop.native-activation.v1:00000000-0000-4000-8000-000000002099",
      )).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not offer a native launch for Windows", async () => {
    nativeDependencies.mockReturnValue({} as ReturnType<typeof browserNativeDesktopDependencies>);
    render(<HivraConsoleDesktop computerId="00000000-0000-4000-8000-000000002098"
      name="Windows" profile="windows" />);

    expect(mockRfbInstances).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Open native Omarchy desktop" })).toBeNull();
  });
});
