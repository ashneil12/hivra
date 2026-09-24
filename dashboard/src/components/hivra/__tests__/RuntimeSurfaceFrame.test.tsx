/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { clientLog } from "@/lib/client/logger";
import { RuntimeSurfaceFrame } from "../RuntimeSurfaceFrame";
import {
  SURFACE_NATIVE_START_LIMIT_MS,
  SURFACE_RECHECK_INTERVAL_MS,
  SURFACE_UNREACHABLE_GRACE_MS,
} from "../useSurfaceBootstrap";

jest.mock("@/lib/client/logger", () => ({
  clientLog: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const warn = clientLog.warn as jest.Mock;

const TOKEN = "fixture-box-token";
const BOOT_A = "00000000400080000000000000000001";
const BOOT_B = "00000000400080000000000000000002";

type Meta = Record<string, unknown> | null;
// Each /api/meta answer the next probe will receive; "down" rejects like a
// gateway that is restarting or a browser that is offline.
let answer: Meta | "down" = null;
let fetchMock: jest.Mock;
let requestSubmit: jest.SpyInstance;
// For each bootstrap POST, the frame its target named when it was sent.
let submittedInto: Array<HTMLIFrameElement | null>;

function meta(extra: Record<string, unknown> = {}): Meta {
  return { agentKind: "agent-zero", surfaceAuth: "post-cookie-v1", ...extra };
}

async function settle(ms = 0) {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}

function renderFrame(url = "https://box.example.com/agent-zero/") {
  return render(<RuntimeSurfaceFrame url={url} token={TOKEN} label="Agent Zero · runtime" />);
}

beforeEach(() => {
  jest.useFakeTimers();
  answer = meta({ bootId: BOOT_A });
  fetchMock = jest.fn(async () => {
    if (answer === "down") throw new TypeError("Failed to fetch");
    const body = answer;
    return { ok: true, status: 200, json: async () => body };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  submittedInto = [];
  requestSubmit = jest.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(function (this: HTMLFormElement) {
    submittedInto.push(document.querySelector<HTMLIFrameElement>(`iframe[name="${this.getAttribute("target")}"]`));
  });
  warn.mockClear();
});

afterEach(() => {
  requestSubmit.mockRestore();
  jest.useRealTimers();
});

describe("RuntimeSurfaceFrame gateway restart recovery", () => {
  it("signs in again, into a new frame with the same name, when the gateway's bootId changes", async () => {
    renderFrame();
    await settle();
    const frame = screen.getByTitle("Agent Zero · runtime");
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(submittedInto[0]).toBe(frame);

    // The gateway restarted while the page stayed open.
    answer = meta({ bootId: BOOT_B });
    await settle(5_000);
    await act(async () => { fireEvent.focus(window); });
    await settle();

    expect(requestSubmit).toHaveBeenCalledTimes(2);
    const form = requestSubmit.mock.instances[1] as HTMLFormElement;
    expect(form).toHaveAttribute("action", "https://box.example.com/auth/bootstrap");
    expect(form.querySelector('input[name="destination"]')).toHaveValue("/agent-zero/");
    // Posting into the frame that already loaded the surface would add a
    // history entry (Back would reload it). The POST goes into a frame mounted
    // for this sign-in, whose first navigation replaces its about:blank.
    const next = screen.getByTitle("Agent Zero · runtime");
    expect(next).not.toBe(frame);
    expect(frame.isConnected).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(next).toHaveAttribute("name", frame.getAttribute("name"));
    expect(form).toHaveAttribute("target", next.getAttribute("name"));
    expect(submittedInto[1]).toBe(next);
    // Never a bearer in a URL.
    expect(next).not.toHaveAttribute("src");
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe("https://box.example.com/api/meta");
      expect(call[1]).toMatchObject({ credentials: "omit", cache: "no-store" });
    }
  });

  it("notices a restart on its periodic check without any user action", async () => {
    renderFrame();
    await settle();
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    answer = meta({ bootId: BOOT_B });
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    expect(requestSubmit).toHaveBeenCalledTimes(2);

    // Settled on the new process: later checks leave the frame alone.
    await settle(SURFACE_RECHECK_INTERVAL_MS * 2);
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it("recovers within seconds when a probe failed across the restart window", async () => {
    renderFrame();
    await settle();
    answer = "down";
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    // Back up as a new process: the failure retry sees it long before 30 s.
    answer = meta({ bootId: BOOT_B });
    await settle(1_000);
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not reload a loaded frame while the bootId is unchanged, even across a failed probe", async () => {
    renderFrame();
    await settle();
    const frame = screen.getByTitle("Agent Zero · runtime");
    const probesAtStart = fetchMock.mock.calls.length;

    await settle(5_000);
    await act(async () => { fireEvent.focus(window); });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    answer = "down";
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    answer = meta({ bootId: BOOT_A });
    await settle(SURFACE_RECHECK_INTERVAL_MS);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(probesAtStart + 2);
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle("Agent Zero · runtime")).toBe(frame);
  });

  it("signs in again when the gateway stops advertising a bootId (rolled back to an older runtime)", async () => {
    renderFrame();
    await settle();
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    // The update's rollback restarted the previous gateway: a new process, so
    // the frame's session is gone even though there is no bootId to compare.
    answer = meta();
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    expect(requestSubmit).toHaveBeenCalledTimes(2);

    // From then on it behaves like any gateway without a bootId.
    await settle(SURFACE_RECHECK_INTERVAL_MS * 3);
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps a legacy gateway without bootId exactly as before: one bootstrap, no reloads", async () => {
    answer = meta();
    renderFrame();
    await settle();
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    answer = "down";
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    answer = meta();
    await settle(SURFACE_RECHECK_INTERVAL_MS * 2);
    await act(async () => { fireEvent.focus(window); });
    await settle();

    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
  });

  it("re-authenticates once a legacy gateway is updated to one that reports its bootId", async () => {
    // Update & restart replaces the gateway process, so the old session is gone.
    answer = meta();
    renderFrame();
    await settle();
    answer = meta({ bootId: BOOT_A });
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it("opens once an outdated gateway has been updated, without a page reload", async () => {
    answer = { agentKind: "agent-zero", model: null };
    renderFrame();
    await settle();
    expect(screen.getByText("Connection update needed")).toBeInTheDocument();
    // Not transient: no fast retries while it waits for Update & restart.
    await settle(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer = meta({ bootId: BOOT_A });
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it("opens by itself when a failed first check is followed by a healthy gateway", async () => {
    answer = "down";
    renderFrame();
    await settle();
    expect(screen.getByText("Couldn’t verify secure access")).toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();

    answer = meta({ bootId: BOOT_A });
    await settle(1_000);
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("RuntimeSurfaceFrame native runtime start", () => {
  const deepseek = (nativeReady: boolean, bootId = BOOT_A) => ({
    agentKind: "deepseek-harness", surfaceAuth: "post-cookie-v1", nativeSurface: "/", nativeReady, bootId,
  });

  it("waits for DeepSeek's nativeReady with backoff before sending the bearer", async () => {
    answer = deepseek(false);
    renderFrame("https://box.example.com/");
    await settle();

    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();
    expect(screen.getByText(/DeepSeek is still starting on this computer/)).toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(TOKEN);
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await settle(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await settle(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestSubmit).not.toHaveBeenCalled();

    answer = deepseek(true);
    await settle(4_000);
    const frame = screen.getByTitle("Agent Zero · runtime");
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    const form = requestSubmit.mock.instances[0] as HTMLFormElement;
    expect(form).toHaveAttribute("target", frame.getAttribute("name"));
    expect(form.querySelector('input[name="destination"]')).toHaveValue("/");
    expect(screen.queryByText("Starting DeepSeek…")).not.toBeInTheDocument();
  });

  it("waits again, instead of loading a 503, when DeepSeek's gateway restarts", async () => {
    answer = deepseek(true);
    renderFrame("https://box.example.com/");
    await settle();
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    answer = deepseek(false, BOOT_B);
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    answer = deepseek(true, BOOT_B);
    await settle(1_000);
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it("waits again when an older DeepSeek gateway without a bootId restarts, then signs in", async () => {
    const legacy = (nativeReady: boolean) => ({
      agentKind: "deepseek-harness", surfaceAuth: "post-cookie-v1", nativeSurface: "/", nativeReady,
    });
    answer = legacy(true);
    renderFrame("https://box.example.com/");
    await settle();
    const frame = screen.getByTitle("Agent Zero · runtime");
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    // Its native interface is down (the frame would show the broker's 503),
    // even though there is no bootId to say the process changed.
    answer = legacy(false);
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();

    answer = legacy(true);
    await settle(1_000);
    expect(requestSubmit).toHaveBeenCalledTimes(2);
    expect(screen.getByTitle("Agent Zero · runtime")).not.toBe(frame);
  });

  it("stops claiming DeepSeek is starting once the start limit has passed", async () => {
    answer = deepseek(false);
    renderFrame("https://box.example.com/");
    await settle();
    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    // A start that crash-loops keeps answering "not ready" forever.
    await settle(SURFACE_NATIVE_START_LIMIT_MS - 20_000);
    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();
    await settle(20_000 + 15_000);
    expect(screen.queryByText("Starting DeepSeek…")).not.toBeInTheDocument();
    expect(screen.getByText("DeepSeek hasn’t started")).toBeInTheDocument();
    expect(screen.getByText(/didn’t finish starting on this computer/)).toBeInTheDocument();
    expect(document.querySelector("svg.animate-spin")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(requestSubmit).not.toHaveBeenCalled();

    // Still watched: if it does come up, it opens.
    answer = deepseek(true);
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh wait when Try again is chosen after the start limit", async () => {
    answer = deepseek(false);
    renderFrame("https://box.example.com/");
    await settle();
    await settle(SURFACE_NATIVE_START_LIMIT_MS + 15_000);
    expect(screen.getByText("DeepSeek hasn’t started")).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    await settle();
    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();
    await settle(SURFACE_NATIVE_START_LIMIT_MS - 20_000);
    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();
  });

  it("rides out a gateway restart while waiting, but reports a gateway that stays unreachable", async () => {
    answer = deepseek(false);
    renderFrame("https://box.example.com/");
    await settle();

    // Down for a few seconds, as during a restart: still starting.
    answer = "down";
    await settle(5_000);
    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();

    // Down for longer than a restart takes: say so, with Try again.
    await settle(SURFACE_UNREACHABLE_GRACE_MS + 15_000);
    expect(screen.queryByText("Starting DeepSeek…")).not.toBeInTheDocument();
    expect(screen.getByText("Couldn’t verify secure access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

    // Reachable again and still starting: back to the honest wait.
    answer = deepseek(false);
    await settle(1_000);
    expect(screen.getByText("Starting DeepSeek…")).toBeInTheDocument();
    answer = deepseek(true);
    await settle(2_000);
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
  });

  it("does not hold a gateway surface such as the terminal behind the native start", async () => {
    answer = deepseek(false);
    renderFrame("https://box.example.com/terminal/");
    await settle();
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("RuntimeSurfaceFrame diagnostics", () => {
  it("logs a failing check once per reason, with origin and reason only", async () => {
    answer = "down";
    renderFrame();
    await settle();
    // Several backoff retries fail the same way: one line, not one per retry.
    await settle(1_000 + 2_000 + 4_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("computer surface check failed", expect.objectContaining({
      source: "client.diagnostic",
      surface: "computer-surface",
      origin: "https://box.example.com",
      reason: "request failed: Failed to fetch",
    }));

    // A different failure is worth its own line.
    fetchMock.mockImplementation(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    await settle(8_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toMatchObject({ reason: "metadata answered HTTP 502" });

    // Recovery is quiet; a later failure is a new episode and is logged again.
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => meta({ bootId: BOOT_A }) }));
    await settle(15_000);
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
    fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    await settle(SURFACE_RECHECK_INTERVAL_MS);
    expect(warn).toHaveBeenCalledTimes(3);

    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });
});
