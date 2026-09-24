/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TextEncoder } from "node:util";

import { HivraRemoteDesktop } from "../HivraRemoteDesktop";
import { WorkspaceModalLayerProvider } from "@/components/workspace/WorkspaceModalLayerContext";
import { clientLog } from "@/lib/client/logger";
import { streamModeStorageKey } from "@/lib/remote-computers/streaming-mode-preference";
import { refreshDesktopCapability, resetDesktopSessionLaneForTests } from "@/lib/remote-computers/desktop-session-lane";

// The real client logger forwards warnings through fetch, which these tests
// count; keep its calls observable instead.
jest.mock("@/lib/client/logger", () => ({
  clientLog: { info: jest.fn(), warn: jest.fn() },
}));

const COMPUTER_ID = "00000000-0000-4000-8000-000000001041";
const ORIGIN = "https://agent.example.test";

function response(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

function session(id: string, exchangeCode = "e".repeat(43)) {
  return {
    id,
    exchangeCode,
    handoff: "message",
    transport: "selkies-websocket",
    inputRole: "controller",
    streamingMode: "hq",
    brokerOrigin: ORIGIN,
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
  };
}

function dispatchBrokerMessage(
  frame: HTMLIFrameElement,
  data: Record<string, unknown>,
  origin = ORIGIN,
  source: MessageEventSource | null = frame.contentWindow,
) {
  if (data.type !== "hivra.remote-desktop.ready.v1") {
    data = { sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8377", ...data };
  }
  act(() => window.dispatchEvent(new MessageEvent("message", { origin, source, data })));
}

describe("HivraRemoteDesktop", () => {
  const originalCrypto = globalThis.crypto;
  const originalVideoDecoder = (window as unknown as { VideoDecoder?: unknown }).VideoDecoder;
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    // Proofs and session requests are coordinated per tab; each test is a new tab.
    resetDesktopSessionLaneForTests();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    window.localStorage.clear();
    Object.defineProperty(window, "crypto", { configurable: true, value: {
      getRandomValues: (value: Uint8Array) => { value.fill(7); return value; },
      subtle: { digest: async () => new Uint8Array(32).fill(9).buffer },
    } });
    Object.defineProperty(window, "VideoDecoder", { configurable: true, value: function VideoDecoder() {} });
    Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  });

  it.each([null, "computer_stopping", "capability_unverified"])("recovers a hidden ended session once without preparation (proof %s)", async (denial) => {
    let issued = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        issued++;
        return response(201, { success: true, data: session(issued === 1 ? "018f6d3c-1d91-7c65-9d86-37fc915b8377" : "028f6d3c-1d91-7c65-9d86-37fc915b8378") });
      }
      if (init?.body && JSON.parse(String(init.body)).action === "refresh" && denial) {
        return response(409, { success: false, code: denial, error: "Current proof denied." });
      }
      return response(200, { success: true, data: { prepared: true } });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    fireEvent(document, new Event("visibilitychange"));
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.disconnected.v1", reason: "transport-closed" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).action === "refresh")).toHaveLength(1));
    if (denial) await screen.findAllByText("Current proof denied.");
    else await waitFor(() => expect(issued).toBe(2));
    fireEvent(document, new Event("visibilitychange"));
    const shown = new Event("pageshow"); Object.defineProperty(shown, "persisted", { value: true });
    fireEvent(window, shown);
    expect(issued).toBe(denial ? 1 : 2);
    const issueBodies = fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/remote-desktop/sessions"
      && init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
    expect(issueBodies[0].ownerHandoff).toBe(false);
    if (!denial) expect(issueBodies[1].ownerHandoff).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare")).toBe(false);
  });

  it.each(["persisted", "navigation", "unmount", "inactive"])("bounds foreground recovery for %s lifecycle", async (mode) => {
    let issued = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        issued++;
        return response(201, { success: true, data: session(issued === 1 ? "018f6d3c-1d91-7c65-9d86-37fc915b8377" : "028f6d3c-1d91-7c65-9d86-37fc915b8378") });
      }
      return response(200, { success: true, data: { prepared: true } });
    });
    const view = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    if (mode === "inactive") {
      view.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active={false} />);
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.disconnected.v1", reason: "transport-closed" });
      view.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active />);
    } else {
      const hidden = new Event("pagehide"); Object.defineProperty(hidden, "persisted", { value: mode === "persisted" });
      fireEvent(window, hidden);
      if (mode === "unmount") view.unmount();
      const shown = new Event("pageshow"); Object.defineProperty(shown, "persisted", { value: true });
      fireEvent(window, shown);
    }
    if (mode === "persisted" || mode === "inactive") await waitFor(() => expect(issued).toBe(2));
    else expect(issued).toBe(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare")).toBe(false);
  });

  it("refreshes only an aged connected return without issuing or preparing again", async () => {
    const clock = jest.spyOn(Date, "now");
    let now = 1000000; clock.mockImplementation(() => now);
    try {
      fetchMock.mockImplementation((input, init) => String(input) === "/api/remote-desktop/sessions" && init?.method === "POST"
        ? response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") })
        : response(200, { success: true, data: { prepared: true } }));
      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
      for (const duration of [5000, 120000]) {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        fireEvent(document, new Event("visibilitychange")); now += duration;
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        fireEvent(document, new Event("visibilitychange"));
      }
      fireEvent(document, new Event("visibilitychange"));
      expect(fetchMock.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).action === "refresh")).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/remote-desktop/sessions")).toHaveLength(1);
      expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare")).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it("recovers once when the ended iframe message arrives after foreground visibility", async () => {
    let issued = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        issued++;
        return response(201, { success: true, data: session(issued === 1 ? "018f6d3c-1d91-7c65-9d86-37fc915b8377" : "028f6d3c-1d91-7c65-9d86-37fc915b8378") });
      }
      return response(200, { success: true, data: { prepared: true } });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    fireEvent(document, new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    fireEvent(document, new Event("visibilitychange"));
    expect(issued).toBe(1);
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.disconnected.v1", reason: "transport-closed" });
    await waitFor(() => expect(issued).toBe(2));
    fireEvent(document, new Event("visibilitychange"));
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.disconnected.v1", reason: "transport-closed" });
    expect(issued).toBe(2);
    expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare")).toBe(false);
  });

  afterAll(() => {
    Object.defineProperty(window, "crypto", { configurable: true, value: originalCrypto });
    Object.defineProperty(window, "VideoDecoder", { configurable: true, value: originalVideoDecoder });
    if (originalFetch) Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("keeps healthy opening read-only and updates only after explicit runtime maintenance", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true, data: { prepared: true } });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    await screen.findByText("Connected");
    const prepareCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare");
    expect(prepareCalls()).toHaveLength(0);
    const details = screen.getByLabelText("Desktop settings").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText(/optional maintenance.*interrupts this stream/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update runtime…" }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(prepareCalls()).toHaveLength(1));
    expect(prepareCalls()[0]).toEqual([
      `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`,
      expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ action: "prepare" }) }),
    ]);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/remote-desktop/sessions" && init?.method === "POST")).toHaveLength(2));
    expect(prepareCalls()).toHaveLength(1);
  });

  it("uses a clean iframe URL and exact-origin message handoff without exposing credentials", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") return response(201, { success: true, data: {
        id: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
        exchangeCode: "e".repeat(43),
        handoff: "message",
        transport: "selkies-websocket",
        inputRole: "controller",
        streamingMode: "hq",
        brokerOrigin: ORIGIN,
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      } });
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    const requestFullscreen = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    const surface = frame.closest("section")!;
    Object.defineProperty(surface, "requestFullscreen", { configurable: true, value: requestFullscreen });
    const focus = jest.spyOn(frame, "focus").mockImplementation(() => {});
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/desktop/handoff`);
    expect(frame.getAttribute("src")).not.toMatch(/token|code|verifier|secret/i);
    expect(document.body.textContent).not.toContain("e".repeat(43));

    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: "https://attacker.example",
      source: frame.contentWindow,
      data: { type: "hivra.remote-desktop.ready.v1" },
    })));
    expect(postMessage).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: ORIGIN,
      source: frame.contentWindow,
      data: { type: "hivra.remote-desktop.ready.v1" },
    })));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "hivra.remote-desktop.handoff.v2",
      exchangeCode: "e".repeat(43),
      verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      streamingMode: "hq",
    }), ORIGIN);
    act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: ORIGIN,
      source: frame.contentWindow,
      data: { type: "hivra.remote-desktop.connected.v1", sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8377" },
    })));
    expect(await screen.findByText("Connected")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Desktop settings"));
    expect(screen.getByLabelText("Session performance evidence")).toBeTruthy();
    expect(screen.getByText("WebSocket + WebCodecs")).toBeTruthy();
    expect(screen.getByText("Waiting for input… · n=0 · stalls=0")).toBeTruthy();
    expect(screen.getByText("Waiting for input… · n=0 · stalls=0").closest("p")?.getAttribute("title")).toMatch(/not physical input-to-photon/i);

    const sendTiming = (data: Record<string, unknown>, origin = ORIGIN, source: MessageEventSource | null = frame.contentWindow) => {
      act(() => window.dispatchEvent(new MessageEvent("message", {
        origin,
        source,
        data: { sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8377", type: "hivra.remote-desktop.telemetry.v1", metric: "browser-input-to-changed-frame", outcome: "changed", ...data },
      })));
    };
    sendTiming({ sequence: 1, durationMs: 999, decodedFrames: 1 }, "https://attacker.example");
    sendTiming({ sequence: 1, durationMs: 999, decodedFrames: 1 }, ORIGIN, window);
    sendTiming({ sequence: 1, durationMs: 2_001, decodedFrames: 1 });
    expect(screen.getByText("Waiting for input… · n=0 · stalls=0")).toBeTruthy();

    sendTiming({ sequence: 1, durationMs: 12, decodedFrames: 1 });
    expect(await screen.findByText("12 ms · n=1 · stalls=0")).toBeTruthy();
    sendTiming({ sequence: 1, durationMs: 999, decodedFrames: 1 });
    sendTiming({ sequence: 2, durationMs: 18, decodedFrames: 2 });
    sendTiming({ sequence: 3, durationMs: 20, decodedFrames: 2 });
    sendTiming({ sequence: 4, durationMs: 40, decodedFrames: 3 });
    sendTiming({ outcome: "timeout", sequence: 5, durationMs: 2_000, decodedFrames: 0 });
    expect(await screen.findByText("p50 20 ms · p95 ≥2.0 s · n=5 · stalls=1")).toBeTruthy();
    for (let sequence = 6; sequence <= 205; sequence += 1) {
      sendTiming({ sequence, durationMs: 5, decodedFrames: 1 });
    }
    expect(await screen.findByText("p50 5 ms · p95 5 ms · window=200 · total=205 · stalls=1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /full screen/i }));
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));
    expect(focus).toHaveBeenCalledTimes(1);
    const exitFullscreen = jest.fn().mockRejectedValueOnce(new Error("browser refused")).mockResolvedValue(undefined);
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: surface });
    fireEvent(document, new Event("fullscreenchange"));
    const exit = screen.getByRole("button", { name: "Exit full screen" });
    expect(surface.contains(exit)).toBe(true);
    fireEvent.click(exit);
    await waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Fullscreen could not close/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBe(exit);
    fireEvent.click(exit);
    await waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(2));
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    fireEvent(document, new Event("fullscreenchange"));
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
    expect(screen.getByTitle("Codex remote desktop")).toBe(frame);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "same-origin" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      computerKind: "hivra-agent",
      computerId: COMPUTER_ID,
      requestedTransport: "selkies-websocket",
      ttlSeconds: 240,
    });
  });

  it("rejects and revokes a session whose authorized mode differs from the requested mode", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: {
          ...session("018f6d3c-1d91-7c65-9d86-37fc915b8377"),
          streamingMode: "performance",
        } });
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    expect((await screen.findAllByText("The secure desktop session could not be opened.")).length).toBeGreaterThan(0);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/remote-desktop/sessions/018f6d3c-1d91-7c65-9d86-37fc915b8377",
      expect.objectContaining({ method: "DELETE" }),
    ));
    expect(screen.queryByTitle("Codex remote desktop")).toBeNull();
  });

  it("ignores wrong-origin, wrong-source, malformed, and out-of-order handoff results", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});

    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.failed.v1", reason: "handoff-rejected" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" }, "https://attacker.example");
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" }, ORIGIN, window);
    expect(postMessage).not.toHaveBeenCalled();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);

    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    expect(postMessage).toHaveBeenCalledTimes(1);
    dispatchBrokerMessage(
      frame,
      { type: "hivra.remote-desktop.failed.v1", reason: "control-unreachable" },
      "https://attacker.example",
    );
    dispatchBrokerMessage(
      frame,
      { type: "hivra.remote-desktop.failed.v1", reason: "control-unreachable" },
      ORIGIN,
      window,
    );
    dispatchBrokerMessage(frame, {
      type: "hivra.remote-desktop.failed.v1",
      reason: "control-unreachable",
      detail: "must not be accepted",
    });
    expect(screen.getByTitle("Codex remote desktop")).toBe(frame);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);

    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("revokes a rejected handoff once and ignores a late connected message", async () => {
    const sessionId = "018f6d3c-1d91-7c65-9d86-37fc915b8377";
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session(sessionId) });
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    const source = frame.contentWindow;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.failed.v1", reason: "handoff-rejected" });

    expect(await screen.findAllByText("The secure desktop handoff was rejected.")).toHaveLength(2);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/remote-desktop/sessions/${sessionId}`,
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
    expect(screen.queryByTitle("Codex remote desktop")).toBeNull();

    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" }, ORIGIN, source);
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("ends only the exact current media session and keeps Reconnect one click away", async () => {
    const a = "018f6d3c-1d91-7c65-9d86-37fc915b8377";
    const b = "018f6d3c-1d91-7c65-9d86-37fc915b8378";
    let issued = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        issued += 1;
        return response(201, { success: true, data: session(issued === 1 ? a : b) });
      }
      return response(200, { success: true });
    });
    const view = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    expect(screen.queryByText("Connected")).toBeNull();
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    const terminal = { type: "hivra.remote-desktop.disconnected.v1", sessionId: a, reason: "transport-closed" };
    dispatchBrokerMessage(frame, terminal, "https://attacker.example");
    dispatchBrokerMessage(frame, terminal, ORIGIN, window);
    dispatchBrokerMessage(frame, { ...terminal, sessionId: b });
    dispatchBrokerMessage(frame, { ...terminal, extra: true });
    expect(screen.getByText("Connected")).toBeTruthy();
    dispatchBrokerMessage(frame, terminal);
    // The automatic reconnect waits out its backoff; the old frame is gone.
    expect(await screen.findByText("Reconnecting")).toBeTruthy();
    expect(screen.queryByTitle("Codex remote desktop")).toBeNull();
    expect(screen.queryByText(/Human input is isolated/)).toBeNull();
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    const persisted = new Event("pageshow");
    Object.defineProperty(persisted, "persisted", { value: true });
    act(() => window.dispatchEvent(persisted));
    view.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare active={false} />);
    view.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare active />);
    expect(issued).toBe(1);
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('"prepare"'))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    const next = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(next, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(next, { type: "hivra.remote-desktop.connected.v1", sessionId: b });
    dispatchBrokerMessage(next, terminal);
    dispatchBrokerMessage(next, { ...terminal, sessionId: b }, ORIGIN, frame.contentWindow);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(issued).toBe(2);
  });

  it("shows a session protocol update requirement without reissuing or auto-installing", async () => {
    fetchMock.mockImplementation(() => response(409, { success: false, code: "desktop_upgrade_required", error: "Update this desktop before opening a new secure session." }));
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    expect(await screen.findByText("Update needed")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /update desktop/i })).toBeTruthy();
  });

  it("updates an admitted old desktop once and reconnects through the current handoff", async () => {
    let issueAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        issueAttempts += 1;
        return issueAttempts === 1
          ? response(409, { success: false, code: "desktop_upgrade_required", error: "Update this desktop before opening a new secure session." })
          : response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true, data: { prepared: true } });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    const update = await screen.findByRole("button", { name: /update desktop/i });
    const prepared = () => fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare");
    expect(prepared()).toBe(false);

    // The installer can close the desktop's apps and restart the agent's chat
    // service, so the click only asks; Cancel hands focus back.
    fireEvent.click(update);
    const confirm = screen.getByRole("group", { name: "Confirm update" });
    expect(confirm.textContent).toContain("restart the desktop and the agent’s chat service");
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" }));
    await act(async () => { await Promise.resolve(); });
    expect(prepared()).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm update" })).toBeNull();
    expect(document.activeElement).toBe(update);
    expect(prepared()).toBe(false);

    fireEvent.click(update);
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm update" })).getByRole("button", { name: "Update" }));

    expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
    expect(issueAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "prepare" }) }),
    );
  });

  it("auto-prepares once after a control failure and revokes each failed session once", async () => {
    const sessionIds = [
      "018f6d3c-1d91-7c65-9d86-37fc915b8377",
      "028f6d3c-1d91-7c65-9d86-37fc915b8378",
    ];
    let sessionAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        const issued = sessionIds[sessionAttempts];
        sessionAttempts += 1;
        return response(201, { success: true, data: session(issued) });
      }
      if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
        return response(200, { success: true, data: { prepared: true } });
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    const firstFrame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(firstFrame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(firstFrame, { type: "hivra.remote-desktop.failed.v1", reason: "control-unreachable" });

    await waitFor(() => expect(sessionAttempts).toBe(2));
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`
      && init?.method === "POST"
      && JSON.parse(String(init.body)).action === "prepare"
    )).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === `/api/remote-desktop/sessions/${sessionIds[0]}` && init?.method === "DELETE"
    )).toHaveLength(1);

    const secondFrame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(secondFrame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(secondFrame, { type: "hivra.remote-desktop.failed.v1", sessionId: sessionIds[1], reason: "control-unreachable" });
    expect(await screen.findAllByText(/desktop broker could not reach this Hivra control plane/i)).toHaveLength(2);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === `/api/remote-desktop/sessions/${sessionIds[1]}` && init?.method === "DELETE"
    )).toHaveLength(1));
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`
      && init?.method === "POST"
      && JSON.parse(String(init.body)).action === "prepare"
    )).toHaveLength(1);
  });

  it("expands in place with the shell chrome hidden when element fullscreen is unavailable", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") return response(201, { success: true, data: {
        id: "018f6d3c-1d91-7c65-9d86-37fc915b8377", exchangeCode: "e".repeat(43), handoff: "message",
        transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq", brokerOrigin: ORIGIN,
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      } });
      return response(200, { success: true });
    });
    // iPhone Safari: no element Fullscreen API at all.
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
    const layerChanges: boolean[] = [];
    render(
      <WorkspaceModalLayerProvider onActiveChange={(active) => layerChanges.push(active)}>
        <nav><button type="button">Manage</button></nav>
        <div data-testid="retained-pane" inert />
        <HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />
      </WorkspaceModalLayerProvider>,
    );
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    const contentWindow = frame.contentWindow;
    const manage = screen.getByText("Manage");
    const retained = screen.getByTestId("retained-pane");
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: ORIGIN, source: frame.contentWindow, data: { type: "hivra.remote-desktop.connected.v1", sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8377" } })));
    const surface = frame.closest("section")!;
    expect(surface.getAttribute("data-immersive")).toBeNull();

    expect(manage.closest("[inert]")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Full screen" }));
    expect(surface.getAttribute("data-immersive")).toBe("true");
    expect(layerChanges.at(-1)).toBe(true);
    // Controls hidden under the layer leave the tab order; the layer does not.
    expect(manage.closest("[inert]")).not.toBeNull();
    expect(frame.closest("[inert]")).toBeNull();
    expect(screen.queryByText(/Fullscreen is not available/)).toBeNull();
    // The same authenticated frame and browsing context stay mounted.
    expect(screen.getByTitle("Codex remote desktop")).toBe(frame);
    expect(frame.contentWindow).toBe(contentWindow);

    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(surface.getAttribute("data-immersive")).toBeNull();
    expect(layerChanges.at(-1)).toBe(false);
    expect(manage.closest("[inert]")).toBeNull();
    // A pane that was already inert stays that way.
    expect(retained.hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(surface.getAttribute("data-immersive")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(surface.getAttribute("data-immersive")).toBeNull();
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/desktop/handoff`);
  });

  it("closes the settings panel on an outside tap or when the desktop frame takes focus", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    await screen.findByText("Connected");
    const details = screen.getByLabelText("Desktop settings").closest("details")!;
    const open = () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    };

    open();
    expect(details.open).toBe(true);
    fireEvent.pointerDown(screen.getByRole("region", { name: "Desktop options" }));
    expect(details.open).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(details.open).toBe(false);

    open();
    expect(details.open).toBe(true);
    act(() => window.dispatchEvent(new Event("blur")));
    expect(details.open).toBe(false);
  });

  it("bounds the settings panel by the room left above the bottom bar", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true });
    });
    const bar = document.createElement("nav");
    bar.setAttribute("data-testid", "pwa-bottom-navigation");
    document.body.appendChild(bar);
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 667, width: 667, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    jest.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect(311, 64));
    try {
      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
      await screen.findByText("Connected");
      const panel = screen.getByRole("region", { name: "Desktop options" });
      // Phone landscape: the panel starts under the strip at y=172.
      jest.spyOn(panel, "getBoundingClientRect").mockReturnValue(rect(172, 249));
      const details = panel.closest("details")!;
      details.open = true;
      fireEvent(details, new Event("toggle"));
      expect(panel.style.maxHeight).toBe(`${311 - 172 - 8}px`);
      fireEvent.pointerDown(document.body);
      expect(panel.style.maxHeight).toBe("");
    } finally {
      bar.remove();
    }
  });

  it("signals the broker when the connected browser viewport changes", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    await screen.findByText("Connected");

    expect((screen.getByRole("combobox", { name: "Desktop quality" }) as HTMLSelectElement).value).toBe("hq");
    expect(screen.getByText("HQ · 25 Mbps · 60 fps")).toBeTruthy();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      { type: "hivra.remote-desktop.streaming-mode.v1", mode: "hq" },
      ORIGIN,
    ));
    fireEvent.change(screen.getByRole("combobox", { name: "Desktop quality" }), {
      target: { value: "performance" },
    });
    expect((screen.getByRole("combobox", { name: "Desktop quality" }) as HTMLSelectElement).value).toBe("performance");
    expect(screen.getByText("Performance · 12 Mbps · 60 fps")).toBeTruthy();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      { type: "hivra.remote-desktop.streaming-mode.v1", mode: "performance" },
      ORIGIN,
    ));
    expect(window.localStorage.getItem(streamModeStorageKey(COMPUTER_ID))).toBe("performance");

    const contentWindow = frame.contentWindow;
    const sessionRequests = () => fetchMock.mock.calls.filter(([input, init]) => input === "/api/remote-desktop/sessions" && init?.method === "POST");
    expect(sessionRequests()).toHaveLength(1);
    expect(JSON.parse(String(sessionRequests()[0]?.[1]?.body))).toMatchObject({ streamingMode: "hq" });
    fireEvent.click(screen.getByLabelText("Desktop settings"));
    const fit = screen.getByRole("checkbox", { name: /Fit desktop to window/ });
    expect((fit as HTMLInputElement).checked).toBe(true);
    fireEvent.click(fit);
    expect((screen.getByRole("checkbox", { name: /Fit desktop to window/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(fit);
    expect(screen.getByTitle("Codex remote desktop")).toBe(frame);
    expect(frame.contentWindow).toBe(contentWindow);
    expect(sessionRequests()).toHaveLength(1);

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      { type: "hivra.remote-desktop.viewport.v1" },
      ORIGIN,
    ));
    postMessage.mockClear();
    act(() => window.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenCalledWith(
      { type: "hivra.remote-desktop.viewport.v1" },
      ORIGIN,
    );
  });

  it("installs the handoff message listener before mounting the broker iframe", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true });
    });
    const listenerSpy = jest.spyOn(window, "addEventListener");
    const appendSpy = jest.spyOn(Node.prototype, "appendChild");
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    await screen.findByTitle("Codex remote desktop");

    const listenerCall = listenerSpy.mock.calls.findIndex(([type]) => type === "message");
    const iframeCall = appendSpy.mock.calls.findIndex(([node]) =>
      node instanceof HTMLIFrameElement && node.title === "Codex remote desktop");
    expect(listenerCall).toBeGreaterThanOrEqual(0);
    expect(iframeCall).toBeGreaterThanOrEqual(0);
    expect(listenerSpy.mock.invocationCallOrder[listenerCall])
      .toBeLessThan(appendSpy.mock.invocationCallOrder[iframeCall]);

    rendered.unmount();
    listenerSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it("keeps the owner-bound capability proof fresh while the desktop remains connected", async () => {
    const intervalSpy = jest.spyOn(window, "setInterval");
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") return response(201, { success: true, data: {
        id: "018f6d3c-1d91-7c65-9d86-37fc915b8377", exchangeCode: "e".repeat(43), handoff: "message",
        transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq", brokerOrigin: ORIGIN,
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      } });
      return response(200, { success: true, data: { prepared: true } });
    });
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: ORIGIN,
      source: frame.contentWindow,
      data: { type: "hivra.remote-desktop.connected.v1", sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8377" },
    })));
    await screen.findByText("Connected");
    const refreshTimer = intervalSpy.mock.calls.find(([, delay]) => delay === 120_000)?.[0] as (() => void) | undefined;
    expect(refreshTimer).toBeDefined();
    act(() => { refreshTimer?.(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`,
      expect.objectContaining({ body: JSON.stringify({ action: "refresh" }) }),
    ));
    rendered.unmount();
    intervalSpy.mockRestore();
  });

  it("auto-repairs when capability is unavailable and refresh cannot verify the runtime", async () => {
    let sessionAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          return response(409, {
            success: false,
            code: "capability_unavailable",
            error: "The computer has no current remote-desktop capability.",
          });
        }
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
        const action = JSON.parse(String(init.body)).action;
        if (action === "refresh") {
          return response(409, { success: false, code: "capability_refresh_failed", error: "Not installed." });
        }
        if (action === "prepare") {
          return response(200, { success: true, data: { prepared: true } });
        }
      }
      return response(500, { success: false });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
    expect(sessionAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`,
      expect.objectContaining({ body: JSON.stringify({ action: "refresh" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`,
      expect.objectContaining({ body: JSON.stringify({ action: "prepare" }) }),
    );
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
    expect(screen.queryByText(/prepare desktop/i)).toBeNull();
  });

  it("surfaces a hard failure with Retry and never teaches Prepare after auto-repair fails", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(409, {
          success: false,
          code: "capability_unavailable",
          error: "The computer has no current remote-desktop capability.",
        });
      }
      if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
        const action = JSON.parse(String(init.body)).action;
        if (action === "refresh") {
          return response(409, { success: false, code: "capability_refresh_failed", error: "Not installed." });
        }
        return response(500, { success: false, error: "Runtime repair failed." });
      }
      return response(500, { success: false });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    expect(await screen.findAllByText(/Desktop couldn’t open/i)).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
    expect(screen.queryByText(/prepare desktop/i)).toBeNull();
  });

  it.each(["provider_desktop_refresh_required", "provider_desktop_unverified"])(
    "stops on %s from refresh without entering the repair loop",
    async (code) => {
      let prepareAttempts = 0;
      fetchMock.mockImplementation((input, init) => {
        if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
          return response(409, {
            success: false,
            code: "capability_unavailable",
            error: "Capability expired.",
          });
        }
        if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
          const action = JSON.parse(String(init.body)).action;
          if (action === "refresh") {
            return response(409, { success: false, code, error: "Provider refresh owns this desktop." });
          }
          if (action === "prepare") {
            prepareAttempts += 1;
            return response(409, { success: false, code });
          }
        }
        return response(500, { success: false });
      });

      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      expect(await screen.findAllByText("Provider refresh owns this desktop.")).not.toHaveLength(0);
      expect(prepareAttempts).toBe(0);
      expect(screen.queryByText(/Desktop couldn’t open/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
      expect(screen.queryByText(/prepare desktop/i)).toBeNull();
    },
  );

  it.each(["provider_desktop_refresh_required", "provider_desktop_unverified"])(
    "keeps the box surfaces usable when the repair pass also reports %s",
    async (code) => {
      let prepareAttempts = 0;
      fetchMock.mockImplementation((input, init) => {
        if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
          return response(409, {
            success: false,
            code: "capability_unavailable",
            error: "Capability expired.",
          });
        }
        if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
          const action = JSON.parse(String(init.body)).action;
          if (action === "refresh") {
            return response(409, { success: false, code: "capability_refresh_failed", error: "Not installed." });
          }
          if (action === "prepare") {
            prepareAttempts += 1;
            return response(409, { success: false, code, error: "Provider refresh owns this desktop." });
          }
        }
        return response(500, { success: false });
      });

      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      await waitFor(() => expect(prepareAttempts).toBe(1));
      expect(await screen.findAllByText("Provider refresh owns this desktop.")).not.toHaveLength(0);
      expect(screen.queryByText(/Desktop couldn’t open/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
      expect(prepareAttempts).toBe(1);
    },
  );

  it("refreshes stale capability proof once and opens a fresh session without reinstalling", async () => {
    let sessionAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        if (sessionAttempts === 1) return response(409, {
          success: false,
          code: "capability_unavailable",
          error: "Capability expired.",
        });
        return response(201, { success: true, data: {
          id: "018f6d3c-1d91-7c65-9d86-37fc915b8377", exchangeCode: "e".repeat(43), handoff: "message",
          transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq", brokerOrigin: ORIGIN,
          expiresAt: new Date(Date.now() + 240_000).toISOString(),
        } });
      }
      if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ action: "refresh" });
        return response(200, { success: true, data: { prepared: true } });
      }
      return response(500, { success: false });
    });

    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
    expect(sessionAttempts).toBe(2);
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
  });

  it("backs off on rate_limited refresh then retries connect without teaching Prepare", async () => {
    jest.useFakeTimers();
    let sessionAttempts = 0;
    let refreshAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          return response(409, {
            success: false,
            code: "capability_unavailable",
            error: "Capability expired.",
          });
        }
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
        const action = JSON.parse(String(init.body)).action;
        if (action === "refresh") {
          refreshAttempts += 1;
          return response(429, {
            success: false,
            code: "rate_limited",
            error: "Wait before checking this desktop again.",
          });
        }
      }
      return response(500, { success: false });
    });

    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    await waitFor(() => expect(refreshAttempts).toBe(1));
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(2_500);
    });
    expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
    expect(sessionAttempts).toBe(2);
    expect(refreshAttempts).toBe(1);
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
    expect(screen.queryByText(/prepare desktop/i)).toBeNull();
    jest.useRealTimers();
  });

  it("backs off on rate_limited prepare then opens without sticky Prepare language", async () => {
    jest.useFakeTimers();
    let sessionAttempts = 0;
    let refreshAttempts = 0;
    let prepareAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          return response(409, {
            success: false,
            code: "capability_unavailable",
            error: "Capability expired.",
          });
        }
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
        const action = JSON.parse(String(init.body)).action;
        if (action === "refresh") {
          refreshAttempts += 1;
          if (refreshAttempts === 1) {
            return response(409, {
              success: false,
              code: "capability_refresh_failed",
              error: "Not installed.",
            });
          }
          // After prepare rate_limit backoff, refresh proves runtime without another prepare.
          return response(200, { success: true, data: { prepared: true } });
        }
        if (action === "prepare") {
          prepareAttempts += 1;
          return response(429, {
            success: false,
            code: "rate_limited",
            error: "Wait before preparing this desktop again.",
          });
        }
      }
      return response(500, { success: false });
    });

    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    await waitFor(() => expect(prepareAttempts).toBe(1));
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
    expect(screen.queryByText(/preparing/i)).toBeNull();
    expect(screen.getAllByText(/Wait before opening this desktop again/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
    expect(sessionAttempts).toBe(2);
    expect(prepareAttempts).toBe(1);
    expect(refreshAttempts).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/prepar/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
    jest.useRealTimers();
  });

  it("caps rate_limited prepare retries and fails clear with Retry instead of infinite Retrying", async () => {
    jest.useFakeTimers();
    let prepareAttempts = 0;
    let refreshAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(409, { success: false, code: "capability_unavailable", error: "Capability expired." });
      }
      if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
        const action = JSON.parse(String(init.body)).action;
        if (action === "refresh") {
          refreshAttempts += 1;
          return response(409, { success: false, code: "capability_refresh_failed", error: "Not installed." });
        }
        if (action === "prepare") {
          prepareAttempts += 1;
          return response(429, {
            success: false,
            code: "rate_limited",
            error: "Wait before opening this desktop again.",
          });
        }
      }
      return response(500, { success: false });
    });

    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    await waitFor(() => expect(prepareAttempts).toBe(1));
    expect(screen.getAllByText(/Wait before opening this desktop again/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await waitFor(() => expect(prepareAttempts).toBe(2));
    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeTruthy();
    expect(screen.queryByText(/Retrying/i)).toBeNull();
    expect(screen.getAllByText(/Wait before opening this desktop again/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/prepar/i)).toBeNull();
    expect(prepareAttempts).toBe(2);
    expect(refreshAttempts).toBeGreaterThanOrEqual(2);
    jest.useRealTimers();
  });

  it("waits through the broker grace window before retrying an unclassified controller", async () => {
    jest.useFakeTimers();
    let sessionAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        if (sessionAttempts <= 2) return response(409, {
          success: false,
          code: "controller_conflict",
          error: "Another human controller still owns this computer input lease.",
        });
        return response(201, { success: true, data: {
          id: "018f6d3c-1d91-7c65-9d86-37fc915b8377", exchangeCode: "e".repeat(43), handoff: "message",
          transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq", brokerOrigin: ORIGIN,
          expiresAt: new Date(Date.now() + 240_000).toISOString(),
        } });
      }
      return response(200, { success: true });
    });
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(sessionAttempts).toBe(1);
      expect(screen.getAllByText("Waiting briefly for the existing controller. An active desktop elsewhere will not be interrupted.")).toHaveLength(2);

      await act(async () => {
        jest.advanceTimersByTime(9_999);
        await Promise.resolve();
      });
      expect(sessionAttempts).toBe(1);

      await act(async () => {
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(sessionAttempts).toBe(2);
      await act(async () => {
        jest.advanceTimersByTime(1_999);
        await Promise.resolve();
      });
      expect(sessionAttempts).toBe(2);
      await act(async () => {
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(sessionAttempts).toBe(3);
      expect(screen.getByTitle("Codex remote desktop")).toBeTruthy();
    } finally {
      rendered.unmount();
      jest.useRealTimers();
    }
  });

  it("keeps reconnecting a proven release-pending controller beyond the old fifteen-second window", async () => {
    jest.useFakeTimers();
    let sessionAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        if (sessionAttempts <= 9) return response(409, {
          success: false,
          code: "controller_releasing",
          error: "The previous desktop is still releasing this computer input lease.",
        });
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true });
    });
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(sessionAttempts).toBe(1);
      expect(screen.getAllByText("The previous desktop is releasing control. Reconnecting automatically…")).toHaveLength(2);

      for (let retry = 0; retry < 8; retry += 1) {
        await act(async () => {
          jest.advanceTimersByTime(2_000);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      expect(sessionAttempts).toBe(9);
      expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(2_000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(sessionAttempts).toBe(10);
      const issueBodies = fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/remote-desktop/sessions"
        && init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
      expect(issueBodies[0].ownerHandoff).toBe(false);
      expect(issueBodies.slice(1).every(body => body.ownerHandoff === false)).toBe(true);
      expect(screen.getByTitle("Codex remote desktop")).toBeTruthy();
    } finally {
      rendered.unmount();
      jest.useRealTimers();
    }
  });

  it("stops retrying a genuinely active controller without revoking or displacing it", async () => {
    jest.useFakeTimers();
    let sessionAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        return response(409, {
          success: false,
          code: "controller_conflict",
          error: "Another human controller still owns this computer input lease.",
        });
      }
      return response(200, { success: true, data: { prepared: true } });
    });
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      for (let retry = 0; retry < 5; retry += 1) {
        await act(async () => {
          jest.advanceTimersByTime(2_000);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      expect(sessionAttempts).toBe(7);
      expect(screen.getAllByText("Another human controller still owns this computer input lease.")).toHaveLength(2);
      expect(screen.getByRole("button", { name: /take over here/i })).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);

      await act(async () => {
        jest.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(sessionAttempts).toBe(7);
      expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/remote-desktop/sessions"
        && init?.method === "POST").every(([, init]) => JSON.parse(String(init?.body)).ownerHandoff === false)).toBe(true);
      let takeoverAttempts = 0;
      fetchMock.mockImplementation((input, init) => {
        if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
          takeoverAttempts++;
          return takeoverAttempts === 1
            ? response(409, { success: false, code: "controller_releasing", error: "The previous desktop is releasing control." })
            : response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
        }
        return response(200, { success: true, data: { prepared: true } });
      });
      fireEvent.click(screen.getByRole("button", { name: /take over here/i }));
      await act(async () => {
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });
      expect(takeoverAttempts).toBe(1);
      expect(screen.queryByTitle("Codex remote desktop")).toBeNull();
      expect(screen.getAllByText("The previous desktop is releasing control. Reconnecting automatically…")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: /take over here/i })).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(2_000);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });
      expect(screen.getByTitle("Codex remote desktop")).toBeTruthy();
      const bodies = fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/remote-desktop/sessions"
        && init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
      expect(bodies.slice(7).map(body => body.ownerHandoff)).toEqual([true, false]);
      expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare")).toBe(false);
    } finally {
      rendered.unmount();
      jest.useRealTimers();
    }
  });

  it("auto-prepares an eligible computer after refresh failure and reconnects through a fresh handoff", async () => {
    let sessionAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          return response(409, {
            success: false,
            code: "capability_unavailable",
            error: "Capability missing.",
          });
        }
        return response(201, { success: true, data: {
          id: "018f6d3c-1d91-7c65-9d86-37fc915b8377", exchangeCode: "e".repeat(43), handoff: "message",
          transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq", brokerOrigin: ORIGIN,
          expiresAt: new Date(Date.now() + 240_000).toISOString(),
        } });
      }
      if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
        if (JSON.parse(String(init.body)).action === "refresh") {
          return response(409, { success: false, code: "capability_refresh_failed", error: "Not installed." });
        }
        return response(200, { success: true, data: { prepared: true } });
      }
      return response(500, { success: false });
    });

    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    expect(await screen.findByText("Opening your computer…")).toBeTruthy();
    const frame = await screen.findByTitle("Codex remote desktop");
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/desktop/handoff`);
    expect(sessionAttempts).toBe(2);
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ action: "prepare" }),
      }),
    );
  });

  it("explains why a legacy computer cannot be prepared in place", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(409, { success: false, code: "capability_unavailable", error: "Unavailable" });
      }
      return response(409, {
        success: false,
        code: "legacy_identity_unbound",
        error: "This older computer predates Hivra's ownership-bound desktop runtime. Launch a current computer to use Desktop; its existing chat, terminal, and files are unchanged.",
      });
    });

    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    expect(await screen.findByText("This computer needs a current launch")).toBeTruthy();
    expect(screen.getAllByText(/predates Hivra's ownership-bound desktop runtime/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
  });

  it.each(["computer_lifecycle_blocked", "computer_operation_blocked"])("does not auto-prepare or offer futile Retry after %s", async code => {
    const explanation = "Check this computer's lifecycle in Manage.";
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions") {
        return response(409, { success: false, code: "capability_unavailable" });
      }
      expect(JSON.parse(String(init?.body)).action).toBe("refresh");
      return response(409, { success: false, code, error: explanation });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    await screen.findAllByText(explanation);
    expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare")).toBe(false);
    expect(screen.queryByRole("button", { name: /retry|try again|prepare/i })).toBeNull();
  });

  it("never auto-prepares a desktop whose shared-folder identity requires controlled upgrade", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(409, { success: false, code: "capability_unavailable" });
      }
      expect(JSON.parse(String(init?.body)).action).toBe("refresh");
      return response(409, { success: false, code: "desktop_upgrade_required",
        error: "This desktop needs an update to establish its shared-folder identity. This check did not install or change anything." });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    expect(await screen.findByText("This desktop needs an update")).toBeTruthy();
    expect(screen.getByRole("button", { name: /update desktop/i })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare")).toBe(false);
    expect(screen.queryByText(/current launch/)).toBeNull();
  });

  it.each([
    ["canary_desktop_prepare_paused", "Desktop couldn’t open right now", false],
    ["desktop_prepare_pending", "Desktop is still opening", true],
  ])("does not encourage Prepare teaching for %s", async (code, heading, canRetry) => {
    let prepares = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions") {
        return response(409, { success: false, code: "capability_unavailable" });
      }
      if (JSON.parse(String(init?.body)).action === "refresh") {
        return response(409, { success: false, code: "capability_refresh_failed", error: "Not verified." });
      }
      prepares += 1;
      return response(409, { success: false, code, error: "Desktop could not be repaired for another attempt yet." });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
    expect(await screen.findByText(heading)).toBeTruthy();
    expect(prepares).toBe(1);
    expect(screen.queryByRole("button", { name: /try install again/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /prepare desktop/i })).toBeNull();
    expect(screen.queryByText(/prepare desktop/i)).toBeNull();
    if (canRetry) {
      fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
      await waitFor(() => expect(prepares).toBe(2));
    } else {
      expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
    }
  });

  it("eagerly revokes the owner session when the surface closes", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") return response(201, { success: true, data: {
        id: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
        exchangeCode: "e".repeat(43), handoff: "message", transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq",
        brokerOrigin: ORIGIN, expiresAt: new Date(Date.now() + 240_000).toISOString(),
      } });
      return response(200, { success: true });
    });
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    await screen.findByTitle("Codex remote desktop");
    rendered.unmount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/remote-desktop/sessions/018f6d3c-1d91-7c65-9d86-37fc915b8377",
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    ));
  });

  it("eagerly revokes the owner session during pagehide before React teardown", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") return response(201, { success: true, data: {
        id: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
        exchangeCode: "e".repeat(43), handoff: "message", transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq",
        brokerOrigin: ORIGIN, expiresAt: new Date(Date.now() + 240_000).toISOString(),
      } });
      return response(200, { success: true });
    });
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    await screen.findByTitle("Codex remote desktop");

    act(() => window.dispatchEvent(new Event("pagehide")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/remote-desktop/sessions/018f6d3c-1d91-7c65-9d86-37fc915b8377",
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    ));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);

    rendered.unmount();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("requires manual reconnection after a revoked page returns from the back-forward cache", async () => {
    let sessionAttempts = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        sessionAttempts += 1;
        return response(201, { success: true, data: {
          id: sessionAttempts === 1
            ? "018f6d3c-1d91-7c65-9d86-37fc915b8377"
            : "028f6d3c-1d91-7c65-9d86-37fc915b8378",
          exchangeCode: "e".repeat(43), handoff: "message", transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq",
          brokerOrigin: ORIGIN, expiresAt: new Date(Date.now() + 240_000).toISOString(),
        } });
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    await screen.findByTitle("Codex remote desktop");

    act(() => window.dispatchEvent(new Event("pagehide")));
    const pageshow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageshow, "persisted", { value: true });
    act(() => window.dispatchEvent(pageshow));

    expect(sessionAttempts).toBe(1);
    expect(screen.getByText("Disconnected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(sessionAttempts).toBe(2));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
  });

  it("does not open a hidden newly mounted desktop until first activation", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true });
    });
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active={false} />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Codex remote desktop")).toBeNull();
    jest.useFakeTimers();
    try {
      act(() => jest.advanceTimersByTime(60_000));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByText(/desktop stream did not finish opening/i)).toBeNull();
    } finally {
      jest.useRealTimers();
    }

    rendered.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    rendered.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active={false} />);
    rendered.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active />);
    expect(screen.getByTitle("Codex remote desktop")).toBe(frame);
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === "/api/remote-desktop/sessions" && init?.method === "POST")).toHaveLength(1);
    rendered.unmount();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("cleans up an inactive never-opened desktop without issuing or revoking a session", async () => {
    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active={false} />);
    await act(async () => { await Promise.resolve(); });
    rendered.unmount();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the authenticated desktop session alive while its local tab is hidden", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") return response(201, { success: true, data: {
        id: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
        exchangeCode: "e".repeat(43), handoff: "message", transport: "selkies-websocket", inputRole: "controller", streamingMode: "hq",
        brokerOrigin: ORIGIN, expiresAt: new Date(Date.now() + 240_000).toISOString(),
      } });
      return response(200, { success: true });
    });

    const rendered = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active />);
    const frame = await screen.findByTitle("Codex remote desktop");
    const region = screen.getByRole("region", { name: "Codex remote desktop" });

    rendered.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active={false} />);
    expect(region.getAttribute("aria-hidden")).toBe("true");
    expect(region.style.display).toBe("none");
    expect(screen.getByTitle("Codex remote desktop")).toBe(frame);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/remote-desktop/sessions/018f6d3c-1d91-7c65-9d86-37fc915b8377",
      expect.objectContaining({ method: "DELETE" }),
    );

    rendered.rerender(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" active />);
    expect(screen.getByTitle("Codex remote desktop")).toBe(frame);
    expect(region.getAttribute("aria-hidden")).toBe("false");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not block session issue on previous-session revoke", async () => {
    let releaseRevoke!: () => void;
    const revokeGate = new Promise<void>(resolve => { releaseRevoke = resolve; });
    let issueCalls = 0;
    const firstId = "018f6d3c-1d91-7c65-9d86-37fc915b8377";
    const secondId = "028f6d3c-1d91-7c65-9d86-37fc915b8378";
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/remote-desktop/sessions" && init?.method === "POST") {
        issueCalls += 1;
        return response(201, { success: true, data: session(issueCalls === 1 ? firstId : secondId) });
      }
      if (url === `/api/remote-desktop/sessions/${firstId}` && init?.method === "DELETE") {
        return revokeGate.then(() => response(200, { success: true }));
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    expect(await screen.findByText("Connected")).toBeTruthy();
    dispatchBrokerMessage(frame, {
      type: "hivra.remote-desktop.disconnected.v1",
      sessionId: firstId,
      reason: "transport-closed",
    });
    // Revoke from disconnect is in-flight and gated; reconnect must still issue.
    fireEvent.click(await screen.findByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(issueCalls).toBe(2));
    expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
    releaseRevoke();
  });

  it("speculatively warms handoff without mounting the iframe before the message listener", async () => {
    const warmOrigin = "https://warm.example.test";
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" handoffWarmOrigin={warmOrigin} />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === `${warmOrigin}/desktop/handoff`)).toBe(true));
    const warmCall = fetchMock.mock.calls.find(([url]) => String(url) === `${warmOrigin}/desktop/handoff`);
    expect(warmCall?.[1]).toEqual(expect.objectContaining({
      method: "GET",
      mode: "no-cors",
      credentials: "omit",
    }));
    // iframe still only appears after session + listener path (same as today)
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/desktop/handoff`);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `${ORIGIN}/desktop/handoff`)).toBe(true);
  });

  it("asks before Update runtime, since it can restart the desktop and close its apps", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
        return response(201, { success: true, data: session("018f6d3c-1d91-7c65-9d86-37fc915b8377") });
      }
      return response(200, { success: true, data: { prepared: true } });
    });
    render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
    const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
    dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1" });
    await screen.findByText("Connected");
    const prepareCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare");
    const revokes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    const details = screen.getByLabelText("Desktop settings").closest("details")!;
    const openMenu = () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    };

    openMenu();
    fireEvent.click(screen.getByRole("button", { name: /update runtime/i }));
    // Asking changes nothing: no preparation and the stream stays open.
    expect(prepareCalls()).toHaveLength(0);
    expect(revokes()).toHaveLength(0);
    expect(screen.getByText("Connected")).toBeTruthy();
    const confirm = screen.getByRole("group", { name: "Confirm update" });
    expect(confirm.textContent).toContain("Updating ends this stream and can restart the desktop and the agent’s chat service.");
    expect(confirm.textContent).toContain("closes the desktop’s open apps and can interrupt a chat reply the agent is writing.");
    expect(confirm.textContent).toContain("Files in ~/Hivra are kept.");
    // Keyboard focus moves into the question instead of falling to the page.
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" }));

    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm update" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Update runtime…" }));
    // Closing the panel also withdraws the question.
    fireEvent.click(screen.getByRole("button", { name: /update runtime/i }));
    fireEvent.pointerDown(document.body);
    openMenu();
    expect(screen.queryByRole("group", { name: "Confirm update" })).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(prepareCalls()).toHaveLength(0);
    expect(revokes()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /update runtime/i }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm update" })).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(prepareCalls()).toHaveLength(1));
    expect(revokes()).toHaveLength(1);
  });

  describe("after the stream drops", () => {
    const SESSION_IDS = [1, 2, 3, 4, 5].map(n => `00000000-0000-4000-8000-00000000000${n}`);
    const advance = (milliseconds: number) => act(async () => { jest.advanceTimersByTime(milliseconds); });

    function mockDesktop(overrides: {
      issue?: (attempt: number) => Promise<Response> | undefined;
      refresh?: (attempt: number) => Promise<Response> | undefined;
      revoke?: (sessionId: string) => Promise<Response> | undefined;
    } = {}) {
      const counts = { issued: 0, refresh: 0, prepare: 0, revoked: [] as string[] };
      fetchMock.mockImplementation((input, init) => {
        if (init?.method === "DELETE") {
          const sessionId = decodeURIComponent(String(input).split("/").at(-1) ?? "");
          counts.revoked.push(sessionId);
          return overrides.revoke?.(sessionId) ?? response(200, { success: true, data: { inputState: "release-pending" } });
        }
        if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
          counts.issued += 1;
          return overrides.issue?.(counts.issued)
            ?? response(201, { success: true, data: session(SESSION_IDS[counts.issued - 1]) });
        }
        if (String(input) === `/api/hivra/agents/${COMPUTER_ID}/remote-desktop` && init?.method === "POST") {
          const action = JSON.parse(String(init.body)).action;
          if (action === "refresh") {
            counts.refresh += 1;
            const refreshed = overrides.refresh?.(counts.refresh);
            if (refreshed) return refreshed;
          }
          if (action === "prepare") counts.prepare += 1;
        }
        return response(200, { success: true, data: { prepared: true } });
      });
      return counts;
    }

    async function openStream(sessionId: string) {
      const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1", sessionId });
      expect(screen.getByText("Connected")).toBeTruthy();
      return frame;
    }

    function dropStream(frame: HTMLIFrameElement, sessionId: string, reason = "transport-closed") {
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.disconnected.v1", sessionId, reason });
    }

    /** Real SHA-256 PKCE with fresh randomness, so every request has its own challenge. */
    function useDistinctPkce() {
      const nodeCrypto = jest.requireActual<typeof import("node:crypto")>("node:crypto");
      Object.defineProperty(window, "crypto", { configurable: true, value: {
        getRandomValues: (value: Uint8Array) => nodeCrypto.randomFillSync(value),
        subtle: { digest: async (_algorithm: string, data: Uint8Array) => nodeCrypto.createHash("sha256").update(data).digest() },
      } });
    }

    /**
     * The session broker's one-controller fence, as the database applies it:
     * a live, never-revoked controller lease on this computer refuses the next
     * issue. A lease that was never exchanged and whose challenge the request
     * names as unanswered is retired first (the broker's
     * retireUnansweredHandoffs). `loseAnswerTo` / `neverAnswer` list issue
     * numbers whose lease is recorded but whose answer never reaches the page.
     */
    function fencedSessionServer(options: { loseAnswerTo?: number[]; neverAnswer?: number[]; foreignLease?: boolean } = {}) {
      type Lease = { id: string; challenge: string; live: boolean; exchanged: boolean };
      const leases: Lease[] = options.foreignLease
        ? [{ id: "00000000-0000-4000-8000-0000000000ff", challenge: "f".repeat(43), live: true, exchanged: true }]
        : [];
      const log: string[] = [];
      const bodies: Array<{ pkceChallenge: string; ownerHandoff?: boolean; unansweredPkceChallenges?: string[] }> = [];
      let granted = 0;
      fetchMock.mockImplementation((input, init) => {
        const url = String(input);
        if (init?.method === "DELETE") {
          const id = decodeURIComponent(url.split("/").at(-1) ?? "");
          const lease = leases.find(candidate => candidate.id === id);
          if (lease) lease.live = false;
          log.push(`revoke ${id}`);
          return response(200, { success: true, data: { inputState: "released" } });
        }
        if (url === "/api/remote-desktop/sessions" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          bodies.push(body);
          const named: string[] = body.unansweredPkceChallenges ?? [];
          for (const lease of leases) {
            if (lease.live && !lease.exchanged && named.includes(lease.challenge)) {
              lease.live = false;
              log.push(`retire ${lease.id}`);
            }
          }
          if (leases.some(lease => lease.live)) {
            log.push("issue refused: controller_conflict");
            return response(409, { success: false, code: "controller_conflict", error: "Another human controller still owns this computer input lease." });
          }
          granted += 1;
          const id = SESSION_IDS[granted - 1];
          leases.push({ id, challenge: body.pkceChallenge, live: true, exchanged: false });
          if (options.neverAnswer?.includes(granted)) {
            log.push(`issue ${id} granted, answer lost`);
            return new Promise<Response>(() => {});
          }
          if (options.loseAnswerTo?.includes(granted)) {
            log.push(`issue ${id} granted, answer lost`);
            return Promise.reject(new TypeError("Failed to fetch"));
          }
          log.push(`issue ${id} granted`);
          return response(201, { success: true, data: session(id) });
        }
        return response(200, { success: true, data: { prepared: true } });
      });
      return {
        log,
        bodies,
        /** The handoff document exchanged this session's code. */
        exchange(id: string) {
          const lease = leases.find(candidate => candidate.id === id);
          if (lease) lease.exchanged = true;
        },
      };
    }

    it("reconnects on its own after a short backoff and says the desktop is still running", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop();
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);

        expect(screen.getByText("Reconnecting")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Stream disconnected" })).toBeTruthy();
        expect(screen.getByTitle("Stream disconnected. Your desktop and its apps are still running. Reconnecting…")).toBeTruthy();
        expect(screen.queryByText(/session has ended/i)).toBeNull();
        expect(screen.getByRole("button", { name: /reconnect/i })).toBeTruthy();

        await advance(1_500);
        expect(counts.issued).toBe(1);
        await advance(500);
        await waitFor(() => expect(counts.issued).toBe(2));
        // A read-only proof precedes the new authority; nothing is installed
        // and another controller is never displaced.
        const steps = fetchMock.mock.calls
          .filter(([input, init]) => init?.method === "POST" && (String(input) === "/api/remote-desktop/sessions" || JSON.parse(String(init.body)).action))
          .map(([input, init]) => String(input) === "/api/remote-desktop/sessions" ? "issue" : JSON.parse(String(init?.body)).action);
        expect(steps).toEqual(["issue", "refresh", "issue"]);
        expect(counts.prepare).toBe(0);
        const reissued = fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/remote-desktop/sessions" && init?.method === "POST").at(-1);
        expect(JSON.parse(String(reissued?.[1]?.body)).ownerHandoff).toBe(false);

        await openStream(SESSION_IDS[1]);
        expect(screen.queryByText(/Stream disconnected/)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it("stops after a bounded number of automatic attempts and leaves the next step to the user", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop({
          issue: attempt => attempt === 1 ? undefined : response(503, { success: false, error: "Desktop opening is unavailable." }),
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0], "transport-error");

        for (const [delay, issued] of [[2_000, 2], [5_000, 3], [15_000, 4]]) {
          expect(screen.getByText("Reconnecting")).toBeTruthy();
          await advance(delay - 500);
          expect(counts.issued).toBe(issued - 1);
          await advance(500);
          await waitFor(() => expect(counts.issued).toBe(issued));
        }
        expect(await screen.findByRole("button", { name: /try again/i })).toBeTruthy();
        await advance(120_000);
        expect(counts.issued).toBe(4);
        expect(counts.refresh).toBe(3);
        expect(counts.prepare).toBe(0);
        expect(screen.queryByText("Reconnecting")).toBeNull();
        expect(clientLog.warn).toHaveBeenCalledWith(
          "remote desktop stream did not reconnect automatically",
          expect.objectContaining({
            failureType: "hivra_remote_desktop_reconnect_exhausted",
            attempts: 3,
            finalState: "failed",
            httpStatus: 503,
            dropReason: "transport-error",
          }),
        );

        fireEvent.click(screen.getByRole("button", { name: /try again/i }));
        await waitFor(() => expect(counts.issued).toBe(5));
      } finally {
        jest.useRealTimers();
      }
    });

    it("carries the budget across a reconnect that drops again soon and refills it after a stable minute", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop();
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        let frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);
        await advance(2_000);
        await waitFor(() => expect(counts.issued).toBe(2));

        // Dropped again straight away: the second attempt waits longer.
        frame = await openStream(SESSION_IDS[1]);
        dropStream(frame, SESSION_IDS[1]);
        await advance(4_000);
        expect(counts.issued).toBe(2);
        await advance(1_000);
        await waitFor(() => expect(counts.issued).toBe(3));

        // Up for a minute: the next drop starts from the shortest wait again.
        frame = await openStream(SESSION_IDS[2]);
        await advance(60_000);
        dropStream(frame, SESSION_IDS[2]);
        await advance(2_000);
        await waitFor(() => expect(counts.issued).toBe(4));
      } finally {
        jest.useRealTimers();
      }
    });

    it("still reconnects once on return when the stream drops while hidden after a spent budget", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop();
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        let frame = await openStream(SESSION_IDS[0]);
        for (const [index, delay] of [[0, 2_000], [1, 5_000], [2, 15_000]]) {
          dropStream(frame, SESSION_IDS[index]);
          await advance(delay);
          await waitFor(() => expect(counts.issued).toBe(index + 2));
          frame = await openStream(SESSION_IDS[index + 1]);
        }
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        dropStream(frame, SESSION_IDS[3]);
        await advance(60_000);
        expect(counts.issued).toBe(4);
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        await advance(0);
        await waitFor(() => expect(counts.issued).toBe(5));
      } finally {
        jest.useRealTimers();
      }
    });

    it("waits until the page is visible and online before reconnecting", async () => {
      jest.useFakeTimers();
      let online = true;
      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
      try {
        const counts = mockDesktop();
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        online = false;
        act(() => { window.dispatchEvent(new Event("offline")); });
        dropStream(frame, SESSION_IDS[0]);
        expect(screen.getByText("Disconnected")).toBeTruthy();
        expect(screen.getByTitle("Stream disconnected. Your desktop and its apps are still running. Reconnecting when this device is back online.")).toBeTruthy();
        await advance(60_000);
        expect(counts.issued).toBe(1);

        online = true;
        act(() => { window.dispatchEvent(new Event("online")); });
        expect(screen.getByText("Reconnecting")).toBeTruthy();
        // Hidden before the backoff ends: nothing opens for a page nobody sees.
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        await advance(60_000);
        expect(counts.issued).toBe(1);

        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(screen.getByText("Reconnecting")).toBeTruthy();
        await advance(2_000);
        await waitFor(() => expect(counts.issued).toBe(2));
        expect(counts.prepare).toBe(0);
      } finally {
        delete (window.navigator as { onLine?: boolean }).onLine;
        jest.useRealTimers();
      }
    });

    it("lets Reconnect replace a pending automatic attempt without opening a second session", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop();
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);
        fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
        await waitFor(() => expect(counts.issued).toBe(2));
        expect(counts.refresh).toBe(0);
        // Even when that stream never opens (the 30 s handoff timeout), the
        // cancelled automatic attempt does not come back.
        await advance(31_000);
        expect(await screen.findByRole("button", { name: /try again/i })).toBeTruthy();
        await advance(30_000);
        expect(counts.issued).toBe(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it("sends an offline drop's revoke again before reconnecting, so its own old lease cannot block the desktop", async () => {
      jest.useFakeTimers();
      let online = true;
      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
      try {
        let revokeArrived = false;
        let releasingAnswered = false;
        const counts = mockDesktop({
          // Offline, the revoke never reaches the server.
          revoke: () => {
            if (!online) return Promise.reject(new TypeError("Failed to fetch"));
            revokeArrived = true;
            return undefined;
          },
          // Until its revoke arrives, the server counts the dropped stream as
          // an active controller (the guest keeps renewing its lease), then
          // as releasing until the guest lets go of input.
          issue: attempt => {
            if (attempt === 1) return undefined;
            if (!revokeArrived) return response(409, { success: false, code: "controller_conflict", error: "Another desktop controls this computer." });
            if (!releasingAnswered) {
              releasingAnswered = true;
              return response(409, { success: false, code: "controller_releasing", error: "The previous desktop is still releasing this computer input lease." });
            }
            return undefined;
          },
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        online = false;
        act(() => { window.dispatchEvent(new Event("offline")); });
        dropStream(frame, SESSION_IDS[0]);
        await advance(0);
        expect(counts.revoked).toEqual([SESSION_IDS[0]]);

        online = true;
        act(() => { window.dispatchEvent(new Event("online")); });
        await advance(2_000);
        await waitFor(() => expect(counts.issued).toBe(2));
        // The revoke went again, and before the new session was asked for.
        expect(counts.revoked).toEqual([SESSION_IDS[0], SESSION_IDS[0]]);
        const order = fetchMock.mock.calls
          .filter(([, init]) => init?.method === "DELETE" || init?.method === "POST")
          .map(([input, init]) => init?.method === "DELETE" ? "revoke"
            : String(input) === "/api/remote-desktop/sessions" ? "issue" : JSON.parse(String(init?.body)).action);
        expect(order.slice(-3)).toEqual(["refresh", "revoke", "issue"]);

        await advance(2_000);
        await waitFor(() => expect(counts.issued).toBe(3));
        await openStream(SESSION_IDS[2]);
        expect(screen.queryByRole("button", { name: /take over/i })).toBeNull();
        expect(counts.prepare).toBe(0);
        const reissued = fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/remote-desktop/sessions" && init?.method === "POST");
        expect(reissued.every(([, init]) => JSON.parse(String(init?.body)).ownerHandoff === false)).toBe(true);
      } finally {
        delete (window.navigator as { onLine?: boolean }).onLine;
        jest.useRealTimers();
      }
    });

    it.each([
      [409, "capability_refresh_failed"],
      [503, "service_unavailable"],
    ])("tries again when the runtime proof fails while the desktop restarts (%s %s)", async (status, code) => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop({
          refresh: attempt => attempt === 1
            ? response(status, { success: false, code, error: "This computer's current desktop runtime could not be verified." })
            : undefined,
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);
        await advance(2_000);
        await waitFor(() => expect(counts.refresh).toBe(1));
        expect(await screen.findByText("Reconnecting")).toBeTruthy();
        expect(screen.queryByText("Unavailable")).toBeNull();
        expect(counts.issued).toBe(1);

        await advance(5_000);
        await waitFor(() => expect(counts.issued).toBe(2));
        expect(counts.refresh).toBe(2);
        expect(counts.prepare).toBe(0);
        await openStream(SESSION_IDS[1]);
        expect(clientLog.warn).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it.each([
      [429, "rate_limited", "Unavailable", "unavailable"],
      [409, "computer_lifecycle_blocked", "Blocked", "blocked"],
    ])("stops at once on a proof it must not retry and reports why (%s %s)", async (status, code, label, finalState) => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop({
          refresh: () => response(status, { success: false, code, error: "Not right now." }),
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);
        await advance(2_000);
        await waitFor(() => expect(counts.refresh).toBe(1));
        expect(await screen.findByText(label)).toBeTruthy();
        await advance(60_000);
        expect(counts.refresh).toBe(1);
        expect(counts.issued).toBe(1);
        expect(counts.prepare).toBe(0);
        expect(clientLog.warn).toHaveBeenCalledTimes(1);
        expect(clientLog.warn).toHaveBeenCalledWith("remote desktop automatic reconnect stopped", expect.objectContaining({
          failureType: "hivra_remote_desktop_reconnect_stopped",
          computerId: COMPUTER_ID,
          attempts: 1,
          finalState,
          code,
          httpStatus: status,
          dropReason: "transport-closed",
        }));
      } finally {
        jest.useRealTimers();
      }
    });

    it("reports a controller conflict that ends the automatic reconnect", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop({
          issue: attempt => attempt === 1 ? undefined
            : response(409, { success: false, code: "controller_conflict", error: "Another desktop controls this computer." }),
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0], "transport-error");
        await advance(2_000);
        await waitFor(() => expect(counts.issued).toBe(2));
        await advance(25_000);
        expect(await screen.findByRole("button", { name: /take over here/i })).toBeTruthy();
        const issuedAtConflict = counts.issued;
        await advance(60_000);
        expect(counts.issued).toBe(issuedAtConflict);
        expect(clientLog.warn).toHaveBeenCalledWith("remote desktop automatic reconnect stopped", expect.objectContaining({
          finalState: "failed",
          code: "controller_conflict",
          httpStatus: 409,
          dropReason: "transport-error",
        }));
      } finally {
        jest.useRealTimers();
      }
    });

    it("after a runtime that keeps failing its proof, keeps Reconnect and asks before Repair", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop({
          refresh: () => response(409, { success: false, code: "capability_refresh_failed", error: "This computer's current desktop runtime could not be verified." }),
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);
        for (const [delay, refreshes] of [[2_000, 1], [5_000, 2], [15_000, 3]]) {
          await advance(delay);
          await waitFor(() => expect(counts.refresh).toBe(refreshes));
        }
        expect(await screen.findByText("Unavailable")).toBeTruthy();
        await advance(60_000);
        expect(counts.refresh).toBe(3);
        expect(counts.issued).toBe(1);
        expect(counts.prepare).toBe(0);
        expect(clientLog.warn).toHaveBeenCalledWith("remote desktop stream did not reconnect automatically", expect.objectContaining({
          failureType: "hivra_remote_desktop_reconnect_exhausted",
          attempts: 3,
          finalState: "unavailable",
          code: "capability_refresh_failed",
        }));
        expect(screen.getByRole("button", { name: /^reconnect/i })).toBeTruthy();

        const repair = screen.getByRole("button", { name: /repair desktop/i });
        fireEvent.click(repair);
        const confirm = screen.getByRole("group", { name: "Confirm repair" });
        expect(confirm.textContent).toContain("Repairing can reinstall the desktop and restart the agent’s chat service.");
        expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" }));
        await advance(0);
        expect(counts.prepare).toBe(0);
        fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
        expect(document.activeElement).toBe(screen.getByRole("button", { name: /repair desktop/i }));
        expect(counts.prepare).toBe(0);

        fireEvent.click(screen.getByRole("button", { name: /repair desktop/i }));
        fireEvent.click(within(screen.getByRole("group", { name: "Confirm repair" })).getByRole("button", { name: "Repair" }));
        await waitFor(() => expect(counts.prepare).toBe(1));
        await waitFor(() => expect(counts.issued).toBe(2));
      } finally {
        jest.useRealTimers();
      }
    });

    it("never runs the installer from Reconnect after a drop, even when the runtime needs repair", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop({
          issue: attempt => attempt === 1 ? undefined
            : response(409, { success: false, code: "capability_unavailable", error: "The computer has no current remote-desktop capability." }),
          refresh: () => response(409, { success: false, code: "capability_refresh_failed", error: "This computer's current desktop runtime could not be verified." }),
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" autoPrepare />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);
        // The page has just said the desktop and its apps are still running.
        fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
        await waitFor(() => expect(counts.issued).toBe(2));
        await waitFor(() => expect(counts.refresh).toBe(1));
        expect(await screen.findByText("Unavailable")).toBeTruthy();
        await advance(60_000);
        expect(counts.prepare).toBe(0);
        expect(screen.getByRole("button", { name: /repair desktop/i })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: /^reconnect/i }));
        await waitFor(() => expect(counts.issued).toBe(3));
        await advance(60_000);
        expect(counts.prepare).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it("keeps its backoff when the device reports it is online again mid-wait", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop();
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);
        await advance(1_500);
        act(() => { window.dispatchEvent(new Event("online")); });
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        await advance(499);
        expect(counts.refresh).toBe(0);
        await advance(1);
        // The proof that opens the attempt goes out on time.
        expect(counts.refresh).toBe(1);
        await waitFor(() => expect(counts.issued).toBe(2));
      } finally {
        jest.useRealTimers();
      }
    });

    it("refills the budget on a back-forward cache return after a stable minute", async () => {
      jest.useFakeTimers();
      try {
        const counts = mockDesktop({
          issue: attempt => attempt <= 3 ? undefined : response(503, { success: false, error: "Desktop opening is unavailable." }),
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        let frame = await openStream(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0]);
        await advance(2_000);
        await waitFor(() => expect(counts.issued).toBe(2));
        frame = await openStream(SESSION_IDS[1]);
        dropStream(frame, SESSION_IDS[1]);
        await advance(5_000);
        await waitFor(() => expect(counts.issued).toBe(3));
        await openStream(SESSION_IDS[2]);

        // Up for over a minute, then the page goes into the back-forward cache.
        await advance(61_000);
        const hidden = new Event("pagehide"); Object.defineProperty(hidden, "persisted", { value: true });
        act(() => { window.dispatchEvent(hidden); });
        const shown = new Event("pageshow"); Object.defineProperty(shown, "persisted", { value: true });
        act(() => { window.dispatchEvent(shown); });
        await advance(0);
        await waitFor(() => expect(counts.issued).toBe(4));
        // The full budget: two more spaced attempts after the immediate one.
        await advance(5_000);
        await waitFor(() => expect(counts.issued).toBe(5));
        await advance(15_000);
        await waitFor(() => expect(counts.issued).toBe(6));
        await advance(60_000);
        expect(counts.issued).toBe(6);
        expect(counts.prepare).toBe(0);
        expect(clientLog.warn).toHaveBeenCalledWith("remote desktop stream did not reconnect automatically", expect.objectContaining({
          attempts: 3,
          dropReason: "page-hidden",
        }));
      } finally {
        jest.useRealTimers();
      }
    });

    it.each(["stream-unavailable", "transport-closed"])(
      "neither claims a running desktop nor retries on its own when a first open never streamed (%s)",
      async reason => {
        jest.useFakeTimers();
        try {
          const counts = mockDesktop();
          render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
          const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
          dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
          dropStream(frame, SESSION_IDS[0], reason);
          expect(screen.getByText("Disconnected")).toBeTruthy();
          expect(screen.getByTitle("The desktop stream stopped before it finished opening. Reconnect when you are ready.")).toBeTruthy();
          expect(screen.queryByText(/still running/)).toBeNull();
          await advance(60_000);
          expect(counts.issued).toBe(1);
          expect(screen.getByRole("button", { name: /reconnect/i })).toBeTruthy();
        } finally {
          jest.useRealTimers();
        }
      },
    );

    // This pins only that online/offline nudges while the reconnect's request
    // is out neither start a second attempt nor revoke the session it brings
    // back. A request that the flap actually fails is the next test.
    it("online and offline nudges while the reconnect's request is out neither start a second attempt nor revoke its session", async () => {
      jest.useFakeTimers();
      let online = true;
      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
      try {
        let answerReconnect!: () => void;
        const reconnectAnswered = new Promise<void>(resolve => { answerReconnect = resolve; });
        const counts = mockDesktop({
          revoke: sessionId => sessionId === SESSION_IDS[0] && !online ? Promise.reject(new TypeError("Failed to fetch")) : undefined,
          issue: attempt => attempt === 2
            ? reconnectAnswered.then(() => response(201, { success: true, data: session(SESSION_IDS[1]) }))
            : undefined,
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        online = false;
        act(() => { window.dispatchEvent(new Event("offline")); });
        dropStream(frame, SESSION_IDS[0]);
        online = true;
        act(() => { window.dispatchEvent(new Event("online")); });
        await advance(2_000);
        await waitFor(() => expect(counts.issued).toBe(2));
        // The link flaps while the reconnect's request is out.
        online = false;
        act(() => { window.dispatchEvent(new Event("offline")); });
        online = true;
        act(() => { window.dispatchEvent(new Event("online")); });
        fireEvent(document, new Event("visibilitychange"));
        await act(async () => { answerReconnect(); });
        const reconnected = await openStream(SESSION_IDS[1]);
        expect(reconnected).toBeTruthy();
        await advance(60_000);
        expect(counts.issued).toBe(2);
        expect(counts.revoked).not.toContain(SESSION_IDS[1]);
        expect(counts.revoked.every(sessionId => sessionId === SESSION_IDS[0])).toBe(true);
        expect(screen.getByText("Connected")).toBeTruthy();
      } finally {
        delete (window.navigator as { onLine?: boolean }).onLine;
        jest.useRealTimers();
      }
    });

    it("reconnects past its own lease when the network drops the reconnect's session answer, without Take over here", async () => {
      jest.useFakeTimers();
      useDistinctPkce();
      try {
        const server = fencedSessionServer({ loseAnswerTo: [2] });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await openStream(SESSION_IDS[0]);
        server.exchange(SESSION_IDS[0]);
        dropStream(frame, SESSION_IDS[0], "transport-error");
        await advance(0);
        // The first reconnect's request reaches the server and is granted, but
        // the answer is lost on the way back: fetch rejects.
        await advance(2_000);
        await waitFor(() => expect(server.log).toContain(`issue ${SESSION_IDS[1]} granted, answer lost`));
        // The next attempt names that request, so the lease only its lost
        // answer could use no longer counts as another controller.
        await advance(5_000);
        await waitFor(() => expect(server.log).toContain(`issue ${SESSION_IDS[2]} granted`));
        await openStream(SESSION_IDS[2]);
        expect(server.log).toEqual([
          `issue ${SESSION_IDS[0]} granted`,
          `revoke ${SESSION_IDS[0]}`,
          `issue ${SESSION_IDS[1]} granted, answer lost`,
          `retire ${SESSION_IDS[1]}`,
          `issue ${SESSION_IDS[2]} granted`,
        ]);
        expect(server.bodies[2].unansweredPkceChallenges).toEqual([server.bodies[1].pkceChallenge]);
        expect(server.bodies.every(body => body.ownerHandoff === false)).toBe(true);
        expect(screen.queryByRole("button", { name: /take over/i })).toBeNull();
        expect(screen.queryByText(/Another human controller/)).toBeNull();
        expect(screen.queryByText(/Waiting briefly for the existing controller/)).toBeNull();
        // A request whose answer was read is never named; the lost one stays
        // named until no lease of it can still exist.
        dropStream(screen.getByTitle("Codex remote desktop") as HTMLIFrameElement, SESSION_IDS[2]);
        // (That stream was up for less than a minute, so this is the third attempt.)
        await advance(15_000);
        await waitFor(() => expect(server.bodies).toHaveLength(4));
        expect(server.bodies[3].unansweredPkceChallenges).toEqual([server.bodies[1].pkceChallenge]);
      } finally {
        jest.useRealTimers();
      }
    });

    it("a reload while its session request was out does not leave the reloaded page waiting on that request's lease", async () => {
      useDistinctPkce();
      const server = fencedSessionServer({ neverAnswer: [1] });
      const before = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      await waitFor(() => expect(server.log).toEqual([`issue ${SESSION_IDS[0]} granted, answer lost`]));
      // The page reloads: its module state is gone, this tab's sessionStorage is not.
      before.unmount();
      resetDesktopSessionLaneForTests({ keepStorage: true });
      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
      expect(server.log).toEqual([
        `issue ${SESSION_IDS[0]} granted, answer lost`,
        `retire ${SESSION_IDS[0]}`,
        `issue ${SESSION_IDS[1]} granted`,
      ]);
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1", sessionId: SESSION_IDS[1] });
      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /take over/i })).toBeNull();
    });

    it("still waits for, and never retires, a lease this tab did not lose the answer to", async () => {
      jest.useFakeTimers();
      useDistinctPkce();
      try {
        // Another tab holds the desktop; this tab's own requests were all answered.
        const server = fencedSessionServer({ foreignLease: true });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        // Step through the 10 s grace and the 2 s retries up to 20 s.
        for (let elapsed = 0; elapsed < 25_000; elapsed += 1_000) await advance(1_000);
        expect(await screen.findByRole("button", { name: /take over here/i })).toBeTruthy();
        expect(server.log.filter(line => line === "issue refused: controller_conflict").length).toBeGreaterThan(1);
        expect(server.log.filter(line => line.startsWith("retire"))).toEqual([]);
        expect(server.bodies.every(body => body.unansweredPkceChallenges === undefined)).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it("rechecks a proof that ran out while the stream was down when Reconnect is clicked, instead of stopping at unavailable", async () => {
      // The first open needed a fresh proof; the drop then outlasted the next
      // one. Each open may recheck once, and a Reconnect never installs.
      const counts = mockDesktop({
        issue: attempt => attempt === 1 || attempt === 3
          ? response(409, { success: false, code: "capability_unavailable", error: "The computer has no current remote-desktop capability." })
          : undefined,
      });
      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      const frame = await openStream(SESSION_IDS[1]);
      expect(counts.refresh).toBe(1);
      dropStream(frame, SESSION_IDS[1]);
      fireEvent.click(await screen.findByRole("button", { name: /reconnect/i }));
      await waitFor(() => expect(counts.issued).toBe(4));
      await openStream(SESSION_IDS[3]);
      expect(counts.refresh).toBe(2);
      expect(counts.prepare).toBe(0);
      expect(screen.queryByText("Unavailable")).toBeNull();
    });
  });

  describe("on a first open", () => {
    const SESSION_A = "00000000-0000-4000-8000-00000000000a";
    const SESSION_B = "00000000-0000-4000-8000-00000000000b";
    const proofUrl = `/api/hivra/agents/${COMPUTER_ID}/remote-desktop`;
    const advance = (milliseconds: number) => act(async () => { jest.advanceTimersByTime(milliseconds); });

    function track() {
      const calls = { refresh: 0, prepare: 0, issue: 0, revoked: [] as string[], order: [] as string[] };
      return calls;
    }

    it("joins the page's proof when its first request finds the proof expired: one inspection, one session, no repair", async () => {
      const calls = track();
      let landPageProof!: () => void;
      const pageProof = new Promise<void>(resolve => { landPageProof = resolve; });
      fetchMock.mockImplementation((input, init) => {
        const url = String(input);
        if (init?.method === "DELETE") {
          calls.revoked.push(url.split("/").at(-1) ?? "");
          return response(200, { success: true });
        }
        if (url === "/api/remote-desktop/sessions") {
          calls.issue += 1;
          return calls.issue === 1
            ? response(409, { success: false, code: "capability_unavailable", error: "The computer has no current remote-desktop capability." })
            : response(201, { success: true, data: session(SESSION_A) });
        }
        if (url === proofUrl) {
          const action = JSON.parse(String(init?.body)).action;
          if (action === "prepare") {
            calls.prepare += 1;
            return response(200, { success: true, data: { prepared: true } });
          }
          calls.refresh += 1;
          // A second inspection of the same guest running beside the first
          // loses the ledger's ordering on Proxmox and is refused as stale.
          return calls.refresh === 1
            ? pageProof.then(() => response(200, { success: true, data: { prepared: true } }))
            : response(409, { success: false, code: "capability_refresh_failed", error: "This computer's current desktop runtime could not be verified." });
        }
        return response(200, { success: true });
      });

      // The agent page starts this proof as soon as it knows the computer.
      const prefetch = refreshDesktopCapability(COMPUTER_ID);
      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      await waitFor(() => expect(calls.issue).toBe(1));
      await screen.findByTitle("Rechecking this computer’s installed desktop runtime…");
      expect(calls.refresh).toBe(1);

      await act(async () => { landPageProof(); await prefetch; });
      expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
      expect(calls.refresh).toBe(1);
      expect(calls.issue).toBe(2);
      expect(calls.prepare).toBe(0);
      expect(calls.revoked).toEqual([]);
    });

    it("uses a proof that landed while its first request was on the way instead of inspecting again", async () => {
      const calls = track();
      let landPageProof!: () => void;
      const pageProof = new Promise<void>(resolve => { landPageProof = resolve; });
      fetchMock.mockImplementation((input) => {
        const url = String(input);
        if (url === "/api/remote-desktop/sessions") {
          calls.issue += 1;
          if (calls.issue > 1) return response(201, { success: true, data: session(SESSION_A) });
          // The server read the expired proof, then the page's proof landed
          // before this answer reached the page.
          landPageProof();
          return pageProof.then(() => new Promise(resolve => setTimeout(resolve, 0)))
            .then(() => response(409, { success: false, code: "capability_unavailable", error: "The computer has no current remote-desktop capability." }));
        }
        if (url === proofUrl) {
          calls.refresh += 1;
          return calls.refresh === 1
            ? pageProof.then(() => response(200, { success: true, data: { prepared: true } }))
            : response(200, { success: true, data: { prepared: true } });
        }
        return response(200, { success: true });
      });

      void refreshDesktopCapability(COMPUTER_ID);
      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
      expect(calls.issue).toBe(2);
      expect(calls.refresh).toBe(1);
    });

    it("an open that replaces an earlier one in this tab waits for it and gives back its session before asking", async () => {
      const calls = track();
      let answerFirst!: () => void;
      const firstAnswered = new Promise<void>(resolve => { answerFirst = resolve; });
      fetchMock.mockImplementation((input, init) => {
        const url = String(input);
        if (init?.method === "DELETE") {
          const id = url.split("/").at(-1) ?? "";
          calls.revoked.push(id);
          calls.order.push(`revoke ${id}`);
          return response(200, { success: true });
        }
        if (url === "/api/remote-desktop/sessions") {
          calls.issue += 1;
          calls.order.push(`issue ${calls.issue}`);
          if (calls.issue === 1) return firstAnswered.then(() => response(201, { success: true, data: session(SESSION_A) }));
          // The server's one-controller fence: a lease this tab still holds
          // blocks the next one until it is revoked.
          return calls.revoked.includes(SESSION_A)
            ? response(201, { success: true, data: session(SESSION_B) })
            : response(409, { success: false, code: "controller_conflict", error: "Another human controller still owns this computer input lease." });
        }
        return response(200, { success: true, data: { prepared: true } });
      });

      const first = render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      await waitFor(() => expect(calls.issue).toBe(1));
      // The surface remounts (a route change, a retained surface rebuilt)
      // while its request is still out.
      first.unmount();
      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
      expect(calls.issue).toBe(1);

      await act(async () => { answerFirst(); });
      const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
      expect(calls.order).toEqual(["issue 1", `revoke ${SESSION_A}`, "issue 2"]);
      expect(calls.revoked).toEqual([SESSION_A]);
      expect(screen.queryByText(/Waiting briefly for the existing controller/)).toBeNull();
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
      dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1", sessionId: SESSION_B });
      expect(screen.getByText("Connected")).toBeTruthy();
    });

    it.each([
      [503, { success: false, code: "session_issue_failed", error: "Desktop sessions are unavailable." }, true],
      [409, { success: false, code: "capability_changed", error: "The desktop capability changed during session creation." }, true],
      [502, null, true],
      [429, { success: false, error: "Too many requests" }, false],
    ])("names a request the server answered %s on the next try only when that answer may follow a lease it made", async (status, body, named) => {
      const nodeCrypto = jest.requireActual<typeof import("node:crypto")>("node:crypto");
      Object.defineProperty(window, "crypto", { configurable: true, value: {
        getRandomValues: (value: Uint8Array) => nodeCrypto.randomFillSync(value),
        subtle: { digest: async (_algorithm: string, data: Uint8Array) => nodeCrypto.createHash("sha256").update(data).digest() },
      } });
      const bodies: Array<{ pkceChallenge: string; unansweredPkceChallenges?: string[] }> = [];
      fetchMock.mockImplementation((input, init) => {
        if (String(input) === "/api/remote-desktop/sessions" && init?.method === "POST") {
          bodies.push(JSON.parse(String(init.body)));
          if (bodies.length > 1) return response(201, { success: true, data: session(SESSION_A) });
          return body === null
            ? Promise.resolve({ ok: false, status, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response)
            : response(status, body);
        }
        return response(200, { success: true, data: { prepared: true } });
      });
      render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
      fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
      expect(await screen.findByTitle("Codex remote desktop")).toBeTruthy();
      expect(bodies[1].unansweredPkceChallenges).toEqual(named ? [bodies[0].pkceChallenge] : undefined);
    });

    it("keeps a session the handoff document just exchanged when that document was slow to load", async () => {
      jest.useFakeTimers();
      try {
        const calls = track();
        fetchMock.mockImplementation((input, init) => {
          const url = String(input);
          if (init?.method === "DELETE") {
            calls.revoked.push(url.split("/").at(-1) ?? "");
            return response(200, { success: true });
          }
          if (url === "/api/remote-desktop/sessions") {
            calls.issue += 1;
            return response(201, { success: true, data: session(SESSION_A) });
          }
          return response(200, { success: true, data: { prepared: true } });
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
        const posted = jest.spyOn(frame.contentWindow!, "postMessage");

        // The document says it is ready just inside its 30 s and exchanges.
        await advance(29_900);
        dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
        expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: "hivra.remote-desktop.handoff.v2", sessionId: SESSION_A }), ORIGIN);
        await advance(200);
        expect(calls.revoked).toEqual([]);
        expect(screen.queryByText(/did not finish opening/)).toBeNull();

        await advance(15_000);
        dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.connected.v1", sessionId: SESSION_A });
        expect(screen.getByText("Connected")).toBeTruthy();
        expect(calls.revoked).toEqual([]);
        expect(calls.issue).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("still ends, once, a handoff whose document goes silent after it was sent", async () => {
      jest.useFakeTimers();
      try {
        const calls = track();
        fetchMock.mockImplementation((input, init) => {
          const url = String(input);
          if (init?.method === "DELETE") {
            calls.revoked.push(url.split("/").at(-1) ?? "");
            return response(200, { success: true });
          }
          if (url === "/api/remote-desktop/sessions") {
            calls.issue += 1;
            return response(201, { success: true, data: session(SESSION_A) });
          }
          return response(200, { success: true, data: { prepared: true } });
        });
        render(<HivraRemoteDesktop computerId={COMPUTER_ID} name="Codex" />);
        const frame = await screen.findByTitle("Codex remote desktop") as HTMLIFrameElement;
        await advance(1_000);
        dispatchBrokerMessage(frame, { type: "hivra.remote-desktop.ready.v1" });
        await advance(59_000);
        expect(calls.revoked).toEqual([]);
        await advance(1_000);
        expect(await screen.findByRole("button", { name: /try again/i })).toBeTruthy();
        expect(screen.getByTitle("The computer answered, but its desktop stream did not finish opening.")).toBeTruthy();
        await advance(0);
        expect(calls.revoked).toEqual([SESSION_A]);
        expect(calls.issue).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
