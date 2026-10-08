/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { UpdateAvailableBanner } from "@/components/instances/UpdateAvailableBanner";

const STATUS_URL = "/api/instances/inst_1/release-status";

function status(overrides: Record<string, unknown> = {}) {
  return {
    channel: "stable",
    currentVersion: "2026.9.1",
    currentDigest: "sha256:old",
    reportedAt: "2026-10-07T10:00:00Z",
    updateAvailable: true,
    direction: "upgrade",
    target: { version: "2026.10.2", digest: "sha256:new" },
    updateHealth: "ok",
    updateHealthDetail: null,
    updateHealthAt: null,
    updateStackVersion: 4,
    ...overrides,
  };
}

function json(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

type Handlers = { status?: () => unknown; post?: () => unknown };

function mockFetch(handlers: Handlers) {
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === STATUS_URL) return handlers.status ? handlers.status() : json({ success: true, data: status() });
    if (url === "/api/instances/inst_1" && init?.method === "POST") {
      return handlers.post ? handlers.post() : json({ success: true });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const statusOf = (data: unknown) => () => json({ success: true, data });

async function renderBanner(props: Partial<React.ComponentProps<typeof UpdateAvailableBanner>> = {}) {
  const view = render(<UpdateAvailableBanner instanceId="inst_1" onUpdate={jest.fn()} {...props} />);
  await act(async () => {});
  return view;
}

beforeEach(() => jest.clearAllMocks());

describe("UpdateAvailableBanner", () => {
  it("offers an update with the target and current versions", async () => {
    const onUpdate = jest.fn();
    mockFetch({});
    await renderBanner({ onUpdate });

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Update available");
    expect(notice).toHaveTextContent("Hermes 2026.10.2 is ready. This agent runs 2026.9.1.");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("says 'an earlier version' when the current version is unknown", async () => {
    mockFetch({ status: statusOf(status({ currentVersion: null, direction: "unknown_current" })) });
    await renderBanner();
    expect(screen.getByRole("status")).toHaveTextContent("This agent runs an earlier version.");
  });

  it("words a rollback as a safer version", async () => {
    mockFetch({ status: statusOf(status({ direction: "rollback", target: { version: "2026.8.5", digest: "sha256:safe" } })) });
    await renderBanner();
    expect(screen.getByRole("status")).toHaveTextContent("A safer version is available");
    expect(screen.getByRole("button", { name: "Move to 2026.8.5" })).toBeInTheDocument();
  });

  it("warns that automatic updates are paused, with the detail, and still offers the update", async () => {
    mockFetch({ status: statusOf(status({ updateHealth: "paused", updateHealthDetail: "Disk is nearly full." })) });
    await renderBanner();
    const notice = screen.getByTestId("update-available-banner");
    expect(notice).toHaveAttribute("data-kind", "warning");
    expect(notice).toHaveTextContent("Automatic updates are paused on this agent.");
    expect(notice).toHaveTextContent("Disk is nearly full.");
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("shows paused without a button when there is nothing to update to", async () => {
    mockFetch({ status: statusOf(status({ updateHealth: "paused", updateAvailable: false, direction: "none", target: null })) });
    await renderBanner();
    expect(screen.getByRole("status")).toHaveTextContent("Automatic updates are paused on this agent.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a rolled back update and lets the user retry", async () => {
    mockFetch({ status: statusOf(status({ updateHealth: "rolled_back", updateHealthDetail: "Health check timed out." })) });
    await renderBanner();
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("The last update did not stick and was rolled back.");
    expect(notice).toHaveTextContent("Health check timed out.");
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("explains a failed update and lets the user retry", async () => {
    mockFetch({ status: statusOf(status({ updateHealth: "failed", updateHealthDetail: "Image pull failed." })) });
    await renderBanner();
    expect(screen.getByRole("status")).toHaveTextContent("The last update failed.");
    expect(screen.getByRole("status")).toHaveTextContent("Image pull failed.");
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("truncates a long health detail", async () => {
    mockFetch({ status: statusOf(status({ updateHealth: "failed", updateHealthDetail: "x".repeat(500) })) });
    await renderBanner();
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("...");
    expect(text).not.toContain("x".repeat(200));
  });

  it("shows a quiet version label, with no button, when up to date", async () => {
    mockFetch({ status: statusOf(status({ updateAvailable: false, direction: "none", target: null })) });
    await renderBanner();
    expect(screen.getByTestId("hermes-version-label")).toHaveTextContent("Hermes 2026.9.1");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing for an ungoverned box with no version", async () => {
    mockFetch({ status: statusOf(status({ currentVersion: null, updateAvailable: false, direction: "none", target: null, channel: null })) });
    const { container } = await renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while loading", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    const { container } = render(<UpdateAvailableBanner instanceId="inst_1" onUpdate={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["a non-2xx answer", () => json({ success: false, error: "nope" }, false)],
    ["a non-JSON body", () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } })],
    ["an unsuccessful envelope", () => json({ success: false })],
    ["an undefined response", () => undefined],
  ])("renders nothing and does not throw on %s", async (_name, answer) => {
    mockFetch({ status: answer as () => unknown });
    const { container } = await renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the request itself fails", async () => {
    global.fetch = jest.fn(() => Promise.reject(new TypeError("Load failed"))) as unknown as typeof fetch;
    const { container } = await renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("disables the button and shows Updating... while busy", async () => {
    const onUpdate = jest.fn();
    mockFetch({});
    await renderBanner({ onUpdate, busy: true });
    const button = screen.getByRole("button", { name: "Updating..." });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("reads the status again when refreshKey changes", async () => {
    const fetchMock = mockFetch({});
    const view = await renderBanner({ refreshKey: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.rerender(<UpdateAvailableBanner instanceId="inst_1" onUpdate={jest.fn()} refreshKey={1} />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads the status again when the tab becomes visible", async () => {
    const fetchMock = mockFetch({});
    await renderBanner();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale answer from a previous instance", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input) === STATUS_URL) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve(json({ success: true, data: status({ updateAvailable: false, direction: "none", target: null, currentVersion: "2026.10.9" }) }));
    }) as unknown as typeof fetch;

    const view = render(<UpdateAvailableBanner instanceId="inst_1" onUpdate={jest.fn()} />);
    view.rerender(<UpdateAvailableBanner instanceId="inst_2" onUpdate={jest.fn()} />);
    await act(async () => {});
    await act(async () => resolveFirst(json({ success: true, data: status() })));

    expect(screen.queryByTestId("update-available-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("hermes-version-label")).toHaveTextContent("Hermes 2026.10.9");
  });

  it("says the update was requested instead of offering the button again, until the box reports a new image", async () => {
    let current = status();
    mockFetch({ status: () => json({ success: true, data: current }) });
    const view = await renderBanner({ refreshKey: 0 });
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();

    // The page ran the update successfully.
    view.rerender(<UpdateAvailableBanner instanceId="inst_1" onUpdate={jest.fn()} refreshKey={1} />);
    await act(async () => {});
    expect(screen.getByTestId("update-pending")).toHaveTextContent("Update requested");
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.queryByText(/is ready/)).not.toBeInTheDocument();

    // The box comes back on the new image: the notice gives way to the version label.
    current = status({ currentVersion: "2026.10.2", currentDigest: "sha256:new", updateAvailable: false, direction: "none" });
    view.rerender(<UpdateAvailableBanner instanceId="inst_1" onUpdate={jest.fn()} refreshKey={2} />);
    await act(async () => {});
    expect(screen.queryByTestId("update-pending")).not.toBeInTheDocument();
    expect(screen.getByTestId("hermes-version-label")).toHaveTextContent("Hermes 2026.10.2");
  });

  it("offers the button again once the request window has passed with no change", async () => {
    mockFetch({});
    const view = await renderBanner({ refreshKey: 0 });
    const realNow = Date.now;
    view.rerender(<UpdateAvailableBanner instanceId="inst_1" onUpdate={jest.fn()} refreshKey={1} />);
    await act(async () => {});
    expect(screen.getByTestId("update-pending")).toBeInTheDocument();

    Date.now = () => realNow() + 16 * 60 * 1000;
    try {
      view.rerender(<UpdateAvailableBanner instanceId="inst_1" onUpdate={jest.fn()} refreshKey={1} busy={false} />);
      expect(screen.queryByTestId("update-pending")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    } finally {
      Date.now = realNow;
    }
  });

  describe("selfConfirm", () => {
    it("asks first, then POSTs the update and shows success", async () => {
      const fetchMock = mockFetch({});
      await renderBanner({ selfConfirm: true, onUpdate: undefined });

      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      expect(screen.getByText("This briefly restarts the agent.")).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      });

      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post?.[0]).toBe("/api/instances/inst_1");
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: "update" });
      expect(await screen.findByText("Update requested. Hermes is refreshing the agent now.")).toBeInTheDocument();
      // The status is read again after a successful update.
      expect(fetchMock.mock.calls.filter(([url]) => url === STATUS_URL).length).toBeGreaterThanOrEqual(2);
    });

    it("keeps the success line after the notice goes away", async () => {
      let updated = false;
      mockFetch({
        status: () => json({ success: true, data: updated ? status({ updateAvailable: false, direction: "none", target: null }) : status() }),
        post: () => {
          updated = true;
          return json({ success: true });
        },
      });
      await renderBanner({ selfConfirm: true });
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      });
      expect(await screen.findByText("Update requested. Hermes is refreshing the agent now.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    });

    it("shows the server error inline and keeps the confirm open for a retry", async () => {
      mockFetch({ post: () => json({ success: false, error: "Box is busy" }, false) });
      await renderBanner({ selfConfirm: true });
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      });
      expect(await screen.findByRole("alert")).toHaveTextContent("Update failed: Box is busy");
      expect(screen.getByRole("button", { name: "Update now" })).toBeEnabled();
    });

    it("shows a network error inline", async () => {
      const fetchMock = mockFetch({});
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") throw new TypeError("Load failed");
        return json({ success: true, data: status() }) as never;
      });
      await renderBanner({ selfConfirm: true });
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      });
      expect(await screen.findByRole("alert")).toHaveTextContent("Network error starting the update.");
    });

    it("Cancel closes the confirm without posting", async () => {
      const fetchMock = mockFetch({});
      await renderBanner({ selfConfirm: true });
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByText("This briefly restarts the agent.")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    });

    it("disables the confirm while the update is being sent", async () => {
      let finish: (value: unknown) => void = () => {};
      mockFetch({ post: () => new Promise((resolve) => { finish = resolve; }) as never });
      await renderBanner({ selfConfirm: true });
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      });
      expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await act(async () => finish(json({ success: true })));
      await waitFor(() => expect(screen.getByTestId("update-result")).toBeInTheDocument());
    });
  });
});
