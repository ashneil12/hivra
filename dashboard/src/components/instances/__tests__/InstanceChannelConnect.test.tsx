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
    fireEvent.change(await screen.findByLabelText(/^GitHub Personal Access Token/i), { target: { value: "ghp_secret" } });
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

describe("InstanceChannelConnect — mobile keyboards and destructive actions", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("masks secrets behind a Show toggle and gives email/host fields the right keyboard", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ data: { statuses: {} } }) } as Response),
    ) as unknown as typeof fetch;

    render(<InstanceChannelConnect instanceId="inst-1" platform="Email" />);

    const address = await screen.findByLabelText(/^Email address/i);
    expect(address).toHaveAttribute("type", "email");
    expect(address).toHaveAttribute("inputmode", "email");
    expect(address).toHaveAttribute("autocapitalize", "none");
    expect(address).toHaveAttribute("autocorrect", "off");

    expect(screen.getByLabelText(/^IMAP host/i)).toHaveAttribute("inputmode", "url");

    const password = screen.getByLabelText(/^App password/i);
    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: /Show App password/i }));
    expect(password).toHaveAttribute("type", "text");
  });

  it("keeps password managers from filling the dashboard login into channel credentials", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ data: { statuses: {} } }) } as Response),
    ) as unknown as typeof fetch;

    render(<InstanceChannelConnect instanceId="inst-1" platform="Email" />);

    const address = await screen.findByLabelText(/^Email address/i);
    const password = screen.getByLabelText(/^App password/i);
    // Browsers ignore autocomplete="off" on password inputs; new-password opts out of saved logins.
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(address).toHaveAttribute("autocomplete", "off");
    for (const field of [address, password]) {
      expect(field).toHaveAttribute("data-1p-ignore");
      expect(field).toHaveAttribute("data-lpignore", "true");
      expect(field).toHaveAttribute("data-bwignore");
    }
  });

  it("asks for confirmation before disconnecting a channel", async () => {
    const fetchMock = jest.fn((_url: string, opts?: RequestInit) =>
      opts?.method === "POST"
        ? Promise.resolve({ ok: true, json: async () => ({ success: true }) } as Response)
        : Promise.resolve({ ok: true, json: async () => ({ data: { statuses: { GitHub: { configured: true } } } }) } as Response),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<InstanceChannelConnect instanceId="inst-1" platform="GitHub" />);

    fireEvent.click(await screen.findByRole("button", { name: /^Disconnect$/i }));
    expect(fetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "POST")).toBe(false);
    expect(screen.getByText(/Disconnect GitHub\? This removes its token\./i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(screen.queryByTestId("channel-disconnect-confirm")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Disconnect$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm disconnect/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ platform: "GitHub", disconnect: true });
    });
  });
});
