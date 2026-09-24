/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { RuntimeSurfaceFrame } from "../RuntimeSurfaceFrame";
import { SURFACE_RECHECK_INTERVAL_MS } from "../useSurfaceBootstrap";

const TOKEN = "fixture-box-token";
const BOOT_A = "00000000400080000000000000000001";
const BOOT_B = "00000000400080000000000000000002";

type Meta = Record<string, unknown> | null;
// Each /api/meta answer the next probe will receive; "down" rejects like a
// gateway that is restarting or a browser that is offline.
let answer: Meta | "down" = null;
let fetchMock: jest.Mock;
let requestSubmit: jest.SpyInstance;

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
  requestSubmit = jest.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
});

afterEach(() => {
  requestSubmit.mockRestore();
  jest.useRealTimers();
});

describe("RuntimeSurfaceFrame gateway restart recovery", () => {
  it("re-submits the bootstrap into the same frame when the gateway's bootId changes", async () => {
    renderFrame();
    await settle();
    const frame = screen.getByTitle("Agent Zero · runtime");
    expect(requestSubmit).toHaveBeenCalledTimes(1);

    // The gateway restarted while the page stayed open.
    answer = meta({ bootId: BOOT_B });
    await settle(5_000);
    await act(async () => { fireEvent.focus(window); });
    await settle();

    expect(requestSubmit).toHaveBeenCalledTimes(2);
    const form = requestSubmit.mock.instances[1] as HTMLFormElement;
    expect(form).toHaveAttribute("action", "https://box.example.com/auth/bootstrap");
    expect(form).toHaveAttribute("target", frame.getAttribute("name"));
    expect(form.querySelector('input[name="destination"]')).toHaveValue("/agent-zero/");
    // Same frame, re-authenticated in place; never a bearer in a URL.
    expect(screen.getByTitle("Agent Zero · runtime")).toBe(frame);
    expect(frame).not.toHaveAttribute("src");
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

  it("does not hold a gateway surface such as the terminal behind the native start", async () => {
    answer = deepseek(false);
    renderFrame("https://box.example.com/terminal/");
    await settle();
    expect(screen.getByTitle("Agent Zero · runtime")).toBeInTheDocument();
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});
