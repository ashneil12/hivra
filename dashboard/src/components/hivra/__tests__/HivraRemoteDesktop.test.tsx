/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TextEncoder } from "node:util";

import { HivraRemoteDesktop } from "../HivraRemoteDesktop";
import { WorkspaceModalLayerProvider } from "@/components/workspace/WorkspaceModalLayerContext";
import { streamModeStorageKey } from "@/lib/remote-computers/streaming-mode-preference";

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
    fireEvent.click(screen.getByLabelText("Desktop settings"));
    expect(screen.getByText(/optional maintenance.*interrupts this stream/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update runtime" }));
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

  it("ends only the exact current media session and never automatically opens a replacement", async () => {
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
    expect(await screen.findByText("Disconnected")).toBeTruthy();
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
    expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).action === "prepare")).toBe(false);

    fireEvent.click(update);

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
    expect(await screen.findByText("Disconnected")).toBeTruthy();
    // Revoke from disconnect is in-flight and gated; reconnect must still issue.
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
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

});
