/** @jest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { InstanceChannelConnect } from "../InstanceChannelConnect";

jest.mock("posthog-js", () => ({ __esModule: true, default: { capture: jest.fn() } }));

// jsdom lacks AbortSignal.timeout (real browsers and Node both have it); a
// no-timer signal is enough here since fetch is mocked — only the signal's
// presence/type on the request matters.
if (typeof AbortSignal.timeout !== "function") {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = () =>
    new AbortController().signal;
}

// Regression: the generic channel connect (Discord/Slack/GitHub/…) POSTs to the
// same integrations route as Telegram and must carry the same AbortSignal
// deadline, so a slow/unreachable box resolves the spinner into an actionable
// error instead of hanging silently. Uses GitHub (a single-field platform).
describe("InstanceChannelConnect — bounded saves (regression: silent hang)", () => {
  const originalFetch = global.fetch;

  // getStatus (GET, on mount) reports "not connected" so the connect form renders.
  const statusResponse = () => ({ ok: true, json: async () => ({ data: { statuses: {} } }) }) as Response;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  async function fillTokenAndConnect() {
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByRole("button", { name: /connect github/i }));
  }

  it("sends the connect POST with an AbortSignal deadline", async () => {
    const fetchMock = jest.fn((_url: string, opts?: RequestInit) =>
      opts?.method === "POST"
        ? Promise.resolve({ ok: true, json: async () => ({ success: true }) } as Response)
        : Promise.resolve(statusResponse()),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<InstanceChannelConnect instanceId="inst-1" platform="GitHub" />);
    await fillTokenAndConnect();

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, opts]) => (opts as RequestInit)?.method === "POST");
      expect(postCall).toBeTruthy();
      expect(postCall![1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
  });

  it("maps a save timeout/abort to the friendly retryable error", async () => {
    const fetchMock = jest.fn((_url: string, opts?: RequestInit) =>
      opts?.method === "POST"
        ? Promise.reject(new DOMException("timed out", "TimeoutError"))
        : Promise.resolve(statusResponse()),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<InstanceChannelConnect instanceId="inst-1" platform="GitHub" />);
    await fillTokenAndConnect();

    expect(await screen.findByText(/taking longer than expected/i)).toBeInTheDocument();
  });
});
