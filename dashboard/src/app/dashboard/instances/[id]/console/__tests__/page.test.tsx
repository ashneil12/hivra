/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

let mockSearchParams = new URLSearchParams();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: jest.fn(() => ({
    push: mockPush,
  })),
  useSearchParams: jest.fn(() => mockSearchParams),
}));

jest.mock("framer-motion", () => {
  const forwardProps = <T extends object>(props: T): T => {
    const cleanRest = { ...props } as T & Record<string, unknown>;
    delete cleanRest.initial;
    delete cleanRest.animate;
    delete cleanRest.exit;
    delete cleanRest.transition;
    delete cleanRest.variants;
    delete cleanRest.whileTap;
    delete cleanRest.whileHover;
    return cleanRest;
  };

  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    (props, ref) => <div ref={ref} {...forwardProps(props)} />
  );
  MotionDiv.displayName = "MotionDiv";

  const MotionButton = React.forwardRef<
    HTMLButtonElement,
    React.ButtonHTMLAttributes<HTMLButtonElement>
  >((props, ref) => <button ref={ref} {...forwardProps(props)} />);
  MotionButton.displayName = "MotionButton";

  return {
    motion: {
      div: MotionDiv,
      button: MotionButton,
    },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

jest.mock("../tabs/ConfigurationTab", () => ({
  __esModule: true,
  default: ({ instanceId }: { instanceId: string }) => <div>configuration:{instanceId}</div>,
}));

jest.mock("../tabs/LogsTab", () => ({
  __esModule: true,
  default: () => <div>logs</div>,
}));

jest.mock("../tabs/BackupsTab", () => ({
  __esModule: true,
  default: () => <div>backups</div>,
}));

// Stub the Tasks panel so the console test doesn't have to satisfy its live
// /api/billing/usage + cron fetches; we only assert it mounts on the tab.
jest.mock("@/components/scheduled-tasks/TasksPanel", () => ({
  __esModule: true,
  TasksPanel: ({ instanceId }: { instanceId: string }) => <div>tasks:{instanceId}</div>,
}));

// fetchPlan hits /api/billing/usage; stub it to a Free plan so the page never
// reaches a real network call from the plan resolver.
jest.mock("@/lib/hivra/agent-api", () => ({
  __esModule: true,
  fetchPlan: jest.fn(async () => ({
    subscribed: false,
    name: "Free",
    key: "free",
    maxAgents: 1,
    maxCpuPerAgent: 0.5,
    maxRamPerAgent: 1,
    poolCpu: 0.5,
    poolRam: 1,
  })),
}));

const AdvancedConsolePage = jest.requireActual("../page").default as typeof import("../page").default;

function buildJsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    json: async () => payload,
  };
}

function buildSnapshotPayload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      public_ipv4: "203.0.113.10",
      config: {
        autoUpdate: {
          enabled: true,
          time: "07:45",
        },
      },
      ...overrides,
    },
  };
}

function createConsoleFetchMock(options?: {
  patchResponse?: unknown;
  postReject?: Error;
  postResponse?: unknown;
  snapshotData?: Record<string, unknown>;
}) {
  return jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/instances/inst_123?no_sync=true") {
      return Promise.resolve(buildJsonResponse(buildSnapshotPayload(options?.snapshotData)));
    }

    if (url === "/api/instances/inst_123" && init?.method === "POST") {
      if (options?.postReject) {
        return Promise.reject(options.postReject);
      }

      return Promise.resolve(buildJsonResponse(options?.postResponse ?? { success: true }));
    }

    if (url === "/api/instances/inst_123" && init?.method === "PATCH") {
      return Promise.resolve(
        buildJsonResponse(options?.patchResponse ?? { success: true, data: {} })
      );
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  }) as jest.Mock;
}

describe("AdvancedConsolePage", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    global.fetch = createConsoleFetchMock();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("renders the configuration tab by default and switches to backups and logs", async () => {
    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(await screen.findByText("configuration:inst_123")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /backups/i }));
    expect(screen.getByText("backups")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /logs/i }));
    expect(screen.getByText("logs")).toBeInTheDocument();
  });

  it("renders the Tasks tab when its tab button is clicked", async () => {
    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(await screen.findByText("configuration:inst_123")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /tasks/i }));
    expect(screen.getByText("tasks:inst_123")).toBeInTheDocument();
  });

  it("offers the Resources tab from Advanced Console", async () => {
    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /resources/i }));

    expect(await screen.findByText(/shared compute pool/i)).toBeInTheDocument();
    expect(screen.getByText(/virtual CPU and RAM across active agents/i)).toBeInTheDocument();
  });

  it("deep-links straight to the Tasks tab via ?tab=tasks", async () => {
    mockSearchParams = new URLSearchParams("tab=tasks");

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    // The Tasks panel is active on first paint, not the configuration tab.
    expect(await screen.findByText("tasks:inst_123")).toBeInTheDocument();
    expect(screen.queryByText("configuration:inst_123")).not.toBeInTheDocument();
  });

  it("falls back to the Settings tab when ?tab= is an unknown value", async () => {
    mockSearchParams = new URLSearchParams("tab=bogus");

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(await screen.findByText("configuration:inst_123")).toBeInTheDocument();
    expect(screen.queryByText("tasks:inst_123")).not.toBeInTheDocument();
  });

  it("shows the host IP in the header when the instance snapshot includes one", async () => {
    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(await screen.findByText(/host ip: 203\.0\.113\.10/i)).toBeInTheDocument();
  });

  it("shows failure ownership details from the instance snapshot", async () => {
    global.fetch = createConsoleFetchMock({
      snapshotData: {
        failureAlert: {
          title: "Runtime health check failed",
          message: "The runtime endpoint is unreachable.",
          lastSeenAt: "2026-05-05T08:00:00.000Z",
          owner: "runtime",
          ownerLabel: "Runtime issue",
          phase: "runtime",
          phaseLabel: "Runtime",
          severity: "fatal",
          recoveryAction: "repair_runtime",
          recoveryLabel: "Repair runtime",
          requestId: "req_123",
        },
      },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    const panel = await screen.findByTestId("console-failure-alert");
    expect(panel).toHaveTextContent(/runtime health check failed/i);
    expect(panel).toHaveTextContent(/owner: runtime issue/i);
    expect(panel).toHaveTextContent(/phase: runtime/i);
    expect(panel).toHaveTextContent(/recovery: repair runtime/i);
    expect(panel).toHaveTextContent(/request: req_123/i);
  });

  it("uses an in-app modal to confirm redeploys and posts the redeploy action", async () => {
    global.fetch = createConsoleFetchMock({
      postResponse: { success: true },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /redeploy config/i }));

    expect(screen.getByText(/redeploy the live agent stack/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm redeploy/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123", expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "redeploy" }),
      }));
    });
  });

  it("offers agent repair from the advanced console and posts the repair action", async () => {
    global.fetch = createConsoleFetchMock({
      postResponse: { success: true },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /repair agent/i }));

    expect(screen.getByText(/repairs permissions, and recreates the agent stack/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm agent repair/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123", expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repair_runtime" }),
      }));
    });
  });

  it("offers agent rebuild from the advanced console and posts the rebuild action", async () => {
    global.fetch = createConsoleFetchMock({
      postResponse: { success: true },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /rebuild agent/i }));

    expect(screen.getByText(/clears disposable state like generated logs/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm agent rebuild/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123", expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rebuild_runtime" }),
      }));
    });
  });

  it("opens the auto-update modal and saves a daily schedule through the instance PATCH api", async () => {
    global.fetch = createConsoleFetchMock({
      patchResponse: {
        success: true,
        data: {
          autoUpdateApplied: true,
          autoUpdateError: null,
          instance: {
            config: {
              autoUpdate: {
                enabled: true,
                time: "08:15",
              },
            },
          },
        },
      },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /auto-update/i }));
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123?no_sync=true");
    expect(
      await screen.findByRole("heading", { name: /^daily auto-update$/i })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/time \(utc\)/i)).toHaveValue("07:45");

    fireEvent.change(screen.getByLabelText(/time \(utc\)/i), {
      target: { value: "08:15" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save schedule/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123", expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoUpdate: {
            enabled: true,
            time: "08:15",
          },
        }),
      }));
    });

    expect(
      await screen.findByText(/daily auto-update is enabled\. hermes will refresh this instance every day at 08:15 utc\./i)
    ).toBeInTheDocument();
  });

  it("offers update now from the advanced console and posts the update action", async () => {
    global.fetch = createConsoleFetchMock({
      postResponse: { success: true },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /update now/i }));

    expect(screen.getByText(/without removing mounted docker volumes/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm update/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123", expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update" }),
      }));
    });
  });

  it("offers restart gateway from the advanced console and posts the restart action", async () => {
    global.fetch = createConsoleFetchMock({
      postResponse: { success: true },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /restart gateway/i }));

    expect(screen.getByText(/restarts the live hermes gateway process without redeploying configuration/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm gateway restart/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123", expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart_gateway" }),
      }));
    });

    expect(mockPush).toHaveBeenCalledWith("/dashboard/instances/inst_123?surface=chat");
  });

  it("treats a dropped update response as in-progress when the snapshot already shows redeploying", async () => {
    global.fetch = createConsoleFetchMock({
      postReject: new Error("Network Error"),
      snapshotData: {
        status: "redeploying",
      },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /update now/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm update/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText(/update is already in progress\. hermes is safely refreshing the agent now\./i)
      ).toBeInTheDocument();
    });

    expect(screen.queryByText(/network error executing command\./i)).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123?no_sync=true");
  });

  it("normalizes raw SSH warmup errors in redeploy feedback", async () => {
    global.fetch = createConsoleFetchMock({
      postResponse: {
        success: false,
        error: "Redeploy failed: SSH fingerprint capture failed: connect ETIMEDOUT 203.0.113.185:22",
      },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /redeploy config/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm redeploy/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText(/action failed: instance is still provisioning ssh access\. try again in a moment\./i)
      ).toBeInTheDocument();
    });
  });

  it("treats a dropped redeploy response as in-progress when the snapshot already shows redeploying", async () => {
    global.fetch = createConsoleFetchMock({
      postReject: new Error("Network Error"),
      snapshotData: {
        status: "redeploying",
      },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /redeploy config/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm redeploy/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText(/redeploy is already in progress\. hermes is rebuilding the live agent stack with your saved configuration\./i)
      ).toBeInTheDocument();
    });

    expect(screen.queryByText(/network error executing command\./i)).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123?no_sync=true");
  });

  it("renders the default console when the initial snapshot fetch fails (Safari 'Load failed')", async () => {
    const unhandled: unknown[] = [];
    const trackRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", trackRejection);

    global.fetch = jest.fn(() => Promise.reject(new TypeError("Load failed"))) as jest.Mock;

    try {
      await act(async () => {
        render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
      });

      await act(async () => {
        jest.runOnlyPendingTimers();
      });

      expect(await screen.findByText("configuration:inst_123")).toBeInTheDocument();
      expect(screen.queryByText(/host ip/i)).not.toBeInTheDocument();
    } finally {
      process.off("unhandledRejection", trackRejection);
    }

    expect(unhandled).toHaveLength(0);
  });

  it("renders the default console when the snapshot endpoint returns a non-JSON body (Safari DOMException)", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        json: () =>
          Promise.reject(
            new DOMException("The string did not match the expected pattern.", "SyntaxError")
          ),
      })
    ) as jest.Mock;

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    expect(await screen.findByText("configuration:inst_123")).toBeInTheDocument();
    expect(screen.queryByText(/host ip/i)).not.toBeInTheDocument();
  });

  it("shows the network error when the recovery snapshot body is unreadable", async () => {
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/instances/inst_123?no_sync=true") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.reject(
              new DOMException("The string did not match the expected pattern.", "SyntaxError")
            ),
        });
      }

      if (url === "/api/instances/inst_123" && init?.method === "POST") {
        return Promise.reject(new TypeError("Load failed"));
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    }) as jest.Mock;

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /redeploy config/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm redeploy/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/network error executing command\./i)).toBeInTheDocument();
    });
  });

  it("shows the network error when the recovery snapshot is not actually redeploying", async () => {
    global.fetch = createConsoleFetchMock({
      postReject: new Error("Network Error"),
      snapshotData: {
        status: "running",
      },
    });

    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /redeploy config/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm redeploy/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/network error executing command\./i)).toBeInTheDocument();
    });
  });

  it("labels the back link as a way back to chat", async () => {
    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/instances/inst_123");
  });

  it("collapses the ops buttons into one Actions disclosure below the tabs at phone width", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 640px)",
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })) as unknown as typeof window.matchMedia;
    global.fetch = createConsoleFetchMock({ postResponse: { success: true } });

    try {
      await act(async () => {
        render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
      });

      act(() => {
        jest.runOnlyPendingTimers();
      });

      expect(screen.queryByTestId("console-ops-row")).not.toBeInTheDocument();
      const actions = screen.getByTestId("console-actions");
      const backupsTab = screen.getByRole("button", { name: /backups/i });
      expect(backupsTab.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const labels = within(actions).getAllByRole("button", { hidden: true }).map((button) => button.textContent?.trim());
      expect(labels).toEqual([
        "REDEPLOY CONFIG",
        "UPDATE NOW",
        "RESTART GATEWAY",
        "Auto-Update",
        "Connect Desktop",
        "REPAIR AGENT",
        "REBUILD AGENT",
      ]);
      expect(within(actions).getByText("Recovery")).toBeInTheDocument();

      fireEvent.click(within(actions).getByText("Actions"));
      fireEvent.click(within(actions).getByRole("button", { name: /update now/i, hidden: true }));
      expect(screen.getByRole("dialog")).toHaveTextContent(/without removing mounted docker volumes/i);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /confirm update/i }));
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/instances/inst_123", expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "update" }),
        }));
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  // matchMedia whose answers can change, notifying subscribers like a rotate.
  function mockViewport(initial: string[]) {
    const originalMatchMedia = window.matchMedia;
    const listeners = new Set<() => void>();
    let matching = initial;
    window.matchMedia = ((query: string) => ({
      get matches() {
        return matching.includes(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })) as unknown as typeof window.matchMedia;
    return {
      set(next: string[]) {
        matching = next;
        act(() => listeners.forEach((listener) => listener()));
      },
      restore() {
        window.matchMedia = originalMatchMedia;
      },
    };
  }

  // Renders and lets the initial snapshot fetch settle inside act.
  async function renderConsole() {
    await act(async () => {
      render(<AdvancedConsolePage params={Promise.resolve({ id: "inst_123" })} />);
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
  }

  it("keeps the Connect Desktop guide open when a phone rotates across 640px", async () => {
    const viewport = mockViewport(["(max-width: 640px)"]);
    try {
      await renderConsole();

      const actions = screen.getByTestId("console-actions");
      fireEvent.click(within(actions).getByText("Actions"));
      fireEvent.click(within(actions).getByRole("button", { name: /connect desktop/i, hidden: true }));
      expect(screen.getByRole("dialog", { name: "Connect Hermes Desktop" })).toBeInTheDocument();

      viewport.set([]);
      expect(screen.getByTestId("console-ops-row")).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Connect Hermes Desktop" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog", { name: "Connect Hermes Desktop" })).not.toBeInTheDocument();
    } finally {
      viewport.restore();
    }
  });

  it("puts the primary action first in DOM order when the confirm buttons stack", async () => {
    const viewport = mockViewport(["(max-width: 640px)", "(max-width: 480px)"]);
    try {
      await renderConsole();

      const actions = screen.getByTestId("console-actions");
      fireEvent.click(within(actions).getByText("Actions"));
      fireEvent.click(within(actions).getByRole("button", { name: /redeploy config/i, hidden: true }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
        "Confirm Redeploy",
        "Cancel",
      ]);

      viewport.set([]);
      expect(within(dialog).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
        "Cancel",
        "Confirm Redeploy",
      ]);
    } finally {
      viewport.restore();
    }
  });

  it("closes the confirm modal only on a press that starts on the backdrop", async () => {
    await renderConsole();

    fireEvent.click(screen.getByRole("button", { name: /redeploy config/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.pointerDown(within(dialog).getByRole("heading", { name: /confirm redeploy/i }));
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
