/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TerminalPanel } from "../TerminalPanel";

let mockResolvedTheme: "dark" | "light" = "dark";

const mockFitAddon = {
  fit: jest.fn(),
};

const mockTerminal = {
  cols: 132,
  rows: 40,
  loadAddon: jest.fn(),
  open: jest.fn(),
  onResize: jest.fn(),
  onData: jest.fn(),
  writeln: jest.fn(),
  write: jest.fn(),
  clear: jest.fn(),
  reset: jest.fn(),
  focus: jest.fn(),
  dispose: jest.fn(),
  refresh: jest.fn(),
  buffer: {
    active: {
      length: 2,
      getLine: jest.fn((index: number) => ({
        translateToString: () => (index === 0 ? "alpha" : "beta"),
      })),
    },
  },
  options: {} as Record<string, unknown>,
};

const mockTerminalConstructor = jest.fn((options: Record<string, unknown> = {}) => {
  mockTerminal.options = { ...options };
  return mockTerminal;
});
const mockFitAddonConstructor = jest.fn(() => mockFitAddon);

jest.mock("@xterm/xterm", () => ({
  Terminal: mockTerminalConstructor,
}));

jest.mock("@xterm/addon-fit", () => ({
  FitAddon: mockFitAddonConstructor,
}));

jest.mock("@xterm/xterm/css/xterm.css", () => ({}));

jest.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: mockResolvedTheme,
  }),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close = jest.fn();

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = MockWebSocket.OPEN;
  send = jest.fn();
  close = jest.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observe = jest.fn();
  disconnect = jest.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
}

function terminalRequestCalls(action?: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(([url, options]) => {
    if (url !== "/api/instances/inst_1/terminal/interactive") return false;
    if (typeof options?.body !== "string") return false;
    if (!action) return true;
    return options.body.includes(`"action":"${action}"`);
  });
}

function requestBody(call: unknown[]) {
  const [, options] = call as [string, { body?: string }];
  return JSON.parse(options.body ?? "{}");
}

function mockStartWithoutWebSocketUrl() {
  (global.fetch as jest.Mock).mockImplementationOnce(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      sessionKey: "term:user_123:inst_1:shell",
      sessionToken: "11111111-1111-4111-8111-111111111111",
    }),
  }));
}

async function flushInitialMount() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advanceConnectTimer() {
  act(() => {
    jest.advanceTimersByTime(60);
  });
  await waitFor(() => {
    expect(terminalRequestCalls("start")).toHaveLength(1);
  });
}

describe("TerminalPanel", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    MockEventSource.instances = [];
    MockWebSocket.instances = [];
    MockResizeObserver.instances = [];
    window.sessionStorage.clear();

    mockTerminal.cols = 132;
    mockTerminal.rows = 40;
    mockTerminal.options = {};
    mockTerminal.buffer.active.getLine.mockClear();
    mockTerminal.onResize.mockImplementation(() => ({ dispose: jest.fn() }));
    mockTerminal.onData.mockImplementation(() => ({ dispose: jest.fn() }));
    mockResolvedTheme = "dark";
    delete process.env.NEXT_PUBLIC_TERMINAL_DEBUG_RTT;

    Object.defineProperty(global, "EventSource", {
      configurable: true,
      writable: true,
      value: MockEventSource,
    });

    Object.defineProperty(global, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });

    Object.defineProperty(global, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: MockResizeObserver,
    });

    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    });

    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: (handle: number) => clearTimeout(handle),
    });

    Object.defineProperty(global, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: window.requestAnimationFrame,
    });

    Object.defineProperty(global, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: window.cancelAnimationFrame,
    });

    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });

    global.fetch = jest.fn(async (_url: string, options?: RequestInit) => {
      const body = typeof options?.body === "string" ? JSON.parse(options.body) : {};
      if (body.action === "start") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            sessionKey: `term:user_123:inst_1:${body.mode ?? "shell"}`,
            sessionToken: "11111111-1111-4111-8111-111111111111",
            gatewayWebSocketUrl: "wss://agent.example.com/_sidecar/api/terminal/ws?token=ignored",
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ ok: true }),
      } as Response;
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("leaves terminal newlines untouched for Hermes TUI sessions", async () => {
    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="tui" />);

    await flushInitialMount();

    expect(mockTerminalConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        convertEol: false,
      }),
    );
  });

  it("keeps shell output newline conversion enabled", async () => {
    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();

    expect(mockTerminalConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        convertEol: true,
      }),
    );
  });

  it("connects with the gateway websocket when start returns a websocket url", async () => {
    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    expect(MockEventSource.instances).toHaveLength(0);
    expect(requestBody(terminalRequestCalls("start")[0])).toEqual({
      action: "start",
      cols: 132,
      rows: 40,
      mode: "shell",
    });
    expect(MockWebSocket.instances[0].url).toContain("wss://agent.example.com/_sidecar/api/terminal/ws");
    expect(MockWebSocket.instances[0].url).toContain("includeScrollback=1");
  });

  it("falls back to the SSE bridge when start does not return a websocket url", async () => {
    mockStartWithoutWebSocketUrl();

    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("sends every terminal input event immediately without batching", async () => {
    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const onData = mockTerminal.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;
    expect(typeof onData).toBe("function");

    act(() => {
      onData?.("l");
      onData?.("s");
    });

    expect(terminalRequestCalls("input")).toHaveLength(0);
    expect(MockWebSocket.instances[0].send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: "input", data: "l" }),
    );
    expect(MockWebSocket.instances[0].send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: "input", data: "s" }),
    );
  });

  it("splits large paste payloads into route-safe immediate input chunks", async () => {
    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const onData = mockTerminal.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;
    const pasted = "x".repeat(4097);

    act(() => {
      onData?.(pasted);
    });

    expect(MockWebSocket.instances[0].send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: "input", data: "x".repeat(4096) }),
    );
    expect(MockWebSocket.instances[0].send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: "input", data: "x" }),
    );
  });

  it("debounces geometry updates to one resize POST after the viewport settles", async () => {
    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="tui" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    mockTerminal.cols = 144;
    mockTerminal.rows = 48;

    act(() => {
      MockResizeObserver.instances[0]?.callback([], MockResizeObserver.instances[0] as unknown as ResizeObserver);
      MockResizeObserver.instances[0]?.callback([], MockResizeObserver.instances[0] as unknown as ResizeObserver);
      jest.advanceTimersByTime(119);
    });

    expect(terminalRequestCalls("resize")).toHaveLength(0);

    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(terminalRequestCalls("resize")).toHaveLength(0);
    expect(MockWebSocket.instances[0].send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "resize", cols: 144, rows: 48 }),
    );
  });

  it("retries an SSE attach once after 500ms and then asks the user to reconnect", async () => {
    mockStartWithoutWebSocketUrl();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getByText } = render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    act(() => {
      MockEventSource.instances[0].onopen?.();
      MockEventSource.instances[0].onerror?.();
    });

    await act(async () => {
      jest.advanceTimersByTime(60);
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(terminalRequestCalls("start")).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(440);
    });

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(2);
    });
    expect(MockEventSource.instances[1].url).toContain("includeScrollback=0");

    act(() => {
      MockEventSource.instances[1].onerror?.();
    });

    expect(getByText("Needs attention")).toBeInTheDocument();
    expect(getByText("Reconnect")).toBeInTheDocument();
    expect(terminalRequestCalls("start")).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[terminal-panel] Terminal SSE stream failed after one retry",
      expect.objectContaining({ failureType: "terminal_sse_retry_exhausted" }),
    );
  });

  it("writes output and closes when the sidecar sends default SSE messages", async () => {
    mockStartWithoutWebSocketUrl();
    const { getByText } = render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    act(() => {
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({ type: "output", data: "hello\r\n" }),
      } as MessageEvent<string>);
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "closed",
          message: "Session exited with code 0.",
        }),
      } as MessageEvent<string>);
    });

    expect(mockTerminal.write).toHaveBeenCalledWith("hello\r\n");
    expect(getByText("Closed")).toBeInTheDocument();
    expect(mockTerminal.writeln).toHaveBeenCalledWith(
      "\r\n\x1b[31m  [!] Session exited with code 0.\x1b[0m\r\n",
    );
  });

  it("persists sessions only for tui-prefixed surface keys", async () => {
    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="tui" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    expect(window.sessionStorage.length).toBe(0);
  });

  it("reattaches a tui-prefixed surface session without starting a new one", async () => {
    const firstRender = render(
      <TerminalPanel instanceId="inst_1" isActive sessionMode="tui" surfaceKey="tui-fullpage" />,
    );

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    expect(
      window.sessionStorage.getItem(
        "/api/instances/inst_1/terminal/interactive:tui:persisted-session:tui-fullpage",
      ),
    ).toBe(
      JSON.stringify({
        sessionKey: "term:user_123:inst_1:tui",
        sessionToken: "11111111-1111-4111-8111-111111111111",
        gatewayWebSocketUrl: "wss://agent.example.com/_sidecar/api/terminal/ws?token=ignored",
      }),
    );

    firstRender.unmount();

    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="tui" surfaceKey="tui-fullpage" />);

    await flushInitialMount();
    act(() => {
      jest.advanceTimersByTime(60);
    });

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    expect(MockWebSocket.instances[1].url).toContain("includeScrollback=0");
    expect(terminalRequestCalls("start")).toHaveLength(1);
  });

  it("stops non-persistent sessions when they unmount", async () => {
    const rendered = render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    rendered.unmount();

    await waitFor(() => {
      expect(terminalRequestCalls("stop")).toHaveLength(1);
    });
    expect(requestBody(terminalRequestCalls("stop")[0])).toMatchObject({
      action: "stop",
      mode: "shell",
      sessionKey: "term:user_123:inst_1:shell",
    });
  });

  it("offers webui-style clear, copy, and restart terminal actions", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    fireEvent.click(screen.getByLabelText("Clear"));
    expect(mockTerminal.clear).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Copy output"));
    expect(writeText).toHaveBeenCalledWith("alpha\nbeta");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Restart"));
      await Promise.resolve();
    });

    expect(mockTerminal.reset).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(terminalRequestCalls("stop")).toHaveLength(1));

    act(() => {
      jest.advanceTimersByTime(60);
    });

    await waitFor(() => expect(terminalRequestCalls("start")).toHaveLength(2));
    expect(requestBody(terminalRequestCalls("stop")[0])).toMatchObject({
      action: "stop",
      sessionKey: "term:user_123:inst_1:shell",
      sessionToken: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("keeps RTT telemetry env-gated and emits samples from SSE echoes", async () => {
    mockStartWithoutWebSocketUrl();
    process.env.NEXT_PUBLIC_TERMINAL_DEBUG_RTT = "1";
    let now = 100;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => undefined);
    const rttListener = jest.fn();
    window.addEventListener("terminal-rtt-sample", rttListener);

    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" surfaceKey="shell-tab-1" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    const onData = mockTerminal.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;

    act(() => {
      onData?.("p");
    });

    now = 137.25;

    act(() => {
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({ type: "output", data: "p" }),
      } as MessageEvent<string>);
    });

    expect(debugSpy).toHaveBeenCalledWith("[terminal-rtt] char=p ms=37.3");
    expect(rttListener).toHaveBeenCalledTimes(1);
    expect((rttListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(
      expect.objectContaining({
        char: "p",
        ms: 37.25,
        sessionMode: "shell",
        surfaceKey: "shell-tab-1",
        transport: "sse",
      }),
    );

    window.removeEventListener("terminal-rtt-sample", rttListener);
  });

  it("keeps terminal RTT telemetry silent unless the debug env flag is enabled", async () => {
    mockStartWithoutWebSocketUrl();
    const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => undefined);
    const rttListener = jest.fn();
    window.addEventListener("terminal-rtt-sample", rttListener);

    render(<TerminalPanel instanceId="inst_1" isActive sessionMode="shell" />);

    await flushInitialMount();
    await advanceConnectTimer();
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    const onData = mockTerminal.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;

    act(() => {
      onData?.("p");
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({ type: "output", data: "p" }),
      } as MessageEvent<string>);
    });

    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining("[terminal-rtt]"));
    expect(rttListener).not.toHaveBeenCalled();

    window.removeEventListener("terminal-rtt-sample", rttListener);
  });

  it("re-focuses the terminal when the user presses into the terminal surface", async () => {
    const { container } = render(<TerminalPanel instanceId="inst_1" isActive surfaceKey="shell-tab-2" />);

    await flushInitialMount();

    const terminalSurface = container.querySelector("#terminal-inst_1-shell-tab-2");
    expect(terminalSurface).not.toBeNull();

    const initialFocusCalls = mockTerminal.focus.mock.calls.length;
    fireEvent.pointerDown(terminalSurface!);

    expect(mockTerminal.focus).toHaveBeenCalledTimes(initialFocusCalls + 1);
  });

  it("updates the existing xterm palette when the color mode changes", async () => {
    const { rerender } = render(
      <TerminalPanel instanceId="inst_1" isActive sessionMode="tui" colorMode="dark" />,
    );

    await flushInitialMount();

    expect(mockTerminal.options.theme).toEqual(
      expect.objectContaining({
        background: "#080810",
        foreground: "#d0ceff",
      }),
    );

    rerender(<TerminalPanel instanceId="inst_1" isActive sessionMode="tui" colorMode="light" />);

    await waitFor(() => {
      expect(mockTerminal.options.theme).toEqual(
        expect.objectContaining({
          background: "#f2e8da",
          foreground: "#2c2116",
        }),
      );
    });

    expect(mockTerminalConstructor).toHaveBeenCalledTimes(1);
  });
});
