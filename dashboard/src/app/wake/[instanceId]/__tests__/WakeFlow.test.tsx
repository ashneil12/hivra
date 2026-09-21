/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

import WakeFlow from "../WakeFlow";

const BOX_URL = "https://abc123.agents.hermesos.cloud";
const replaceMock = jest.fn();

type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonRes(body: unknown, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  Object.defineProperty(window, "location", {
    value: { ...window.location, replace: replaceMock },
    writable: true,
  });
});

beforeEach(() => {
  replaceMock.mockClear();
  global.fetch = jest.fn();
});

describe("WakeFlow", () => {
  it("wakes a parked agent through the start API and redirects when health goes green", async () => {
    (global.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: { method?: string; body?: string }) => {
        const u = String(url);
        if (u.includes("/health")) {
          return jsonRes({ isReady: true, status: "running" });
        }
        if (u.includes("/wake")) {
          if (u.includes("wake_id=")) {
            return jsonRes({
              success: true,
              data: { running: true, wakeable: false, status: "running", lifecycleState: "active", boxUrl: BOX_URL },
            });
          }
          return jsonRes({
            success: true,
            data: { running: false, wakeable: true, status: "stopped", lifecycleState: "active", boxUrl: BOX_URL },
          });
        }
        if (init?.method === "POST") {
          return jsonRes({ success: true, data: { ok: true } });
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );

    render(<WakeFlow instanceId="inst-1" pollIntervalMs={10} />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(BOX_URL), {
      timeout: 3_000,
    });

    // The start action went through the instances API with the wake-page
    // source + a minted wake id (so admission + telemetry can attribute it).
    const postCall = (global.fetch as jest.Mock).mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(String(postCall![0])).toBe("/api/instances/inst-1");
    const postBody = JSON.parse((postCall![1] as { body: string }).body);
    expect(postBody).toMatchObject({ action: "start", wakeSource: "wake_page" });
    expect(typeof postBody.wakeId).toBe("string");
    expect(postBody.wakeId.length).toBeGreaterThan(0);

    // The success confirmation carried the same wake id back for telemetry.
    const confirmCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
      String(url).includes("wake_id="),
    );
    expect(confirmCall).toBeTruthy();
    expect(String(confirmCall![0])).toContain(encodeURIComponent(postBody.wakeId));
  });

  it("redirects immediately when the agent is already awake", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/wake")) {
        return jsonRes({
          success: true,
          data: { running: true, wakeable: false, status: "running", lifecycleState: "active", boxUrl: BOX_URL },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    render(<WakeFlow instanceId="inst-1" pollIntervalMs={10} />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(BOX_URL));
    // No start POST for an already-running box.
    const postCall = (global.fetch as jest.Mock).mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === "POST",
    );
    expect(postCall).toBeUndefined();
  });

  it("shows the honest queued state when admission defers the wake", async () => {
    (global.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: { method?: string }) => {
        const u = String(url);
        if (u.includes("/wake")) {
          return jsonRes({
            success: true,
            data: { running: false, wakeable: true, status: "stopped", lifecycleState: "active", boxUrl: BOX_URL },
          });
        }
        if (init?.method === "POST") {
          return jsonRes(
            { success: false, error: "The host is busy waking other agents.", retryAfterSeconds: 30 },
            429,
          );
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );

    const { unmount } = render(<WakeFlow instanceId="inst-1" pollIntervalMs={10} />);

    expect(
      await screen.findByText(/queued to wake/i, undefined, { timeout: 3_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/retrying automatically in 30 seconds/i)).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();

    unmount(); // cancel the pending retry timer
  });

  it("surfaces terminal start failures with a way out instead of spinning forever", async () => {
    (global.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: { method?: string }) => {
        const u = String(url);
        if (u.includes("/wake")) {
          return jsonRes({
            success: true,
            data: { running: false, wakeable: true, status: "stopped", lifecycleState: "active", boxUrl: BOX_URL },
          });
        }
        if (init?.method === "POST") {
          return jsonRes(
            { success: false, error: "Compute is suspended until billing is restored." },
            402,
          );
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );

    render(<WakeFlow instanceId="inst-1" pollIntervalMs={10} />);

    expect(
      await screen.findByText(/needs attention/i, undefined, { timeout: 3_000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/compute is suspended until billing is restored/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
