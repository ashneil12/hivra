/** @jest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { InstanceTelegramConnect } from "../InstanceTelegramConnect";
import { telegramGetMe } from "@/lib/channels/telegram-api";

jest.mock("posthog-js", () => ({ __esModule: true, default: { capture: jest.fn() } }));

jest.mock("@/lib/channels/telegram-api", () => ({
  telegramGetMe: jest.fn(),
  isValidBotTokenShape: () => true,
  isValidOwnerIdShape: (v: string) => /^\d{3,}$/.test(String(v).trim()),
}));

jest.mock("@/lib/channels/record-connection", () => ({
  recordChannelConnection: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/client/logger", () => ({ clientLog: { warn: jest.fn() } }));

// jsdom lacks AbortSignal.timeout (real browsers and Node both have it); a
// no-timer signal is enough here since fetch is mocked — only the signal's
// presence/type on the request matters.
if (typeof AbortSignal.timeout !== "function") {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = () =>
    new AbortController().signal;
}

// Regression: the Hermes-lane connect POSTs must carry an AbortSignal deadline so
// a slow/unreachable box resolves the spinner into an actionable error instead of
// hanging silently, and an abort must map to the friendly retryable message.
describe("InstanceTelegramConnect — bounded saves (regression: silent hang)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    (telegramGetMe as jest.Mock).mockResolvedValue({ ok: true, username: "bot", botId: 1, error: null });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  // getStatus (GET, on mount) reports "not connected" so the token step renders.
  const statusResponse = () => ({ ok: true, json: async () => ({ data: { statuses: {} } }) }) as Response;

  async function pasteTokenAndContinue() {
    fireEvent.change(await screen.findByPlaceholderText("123456789:ABCdef…"), {
      target: { value: "123456:SECRET" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  }

  it("sends the beginConnect POST with an AbortSignal deadline", async () => {
    const fetchMock = jest.fn((_url: string, opts?: RequestInit) =>
      opts?.method === "POST"
        ? Promise.resolve({ ok: true, json: async () => ({ success: true }) } as Response)
        : Promise.resolve(statusResponse()),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<InstanceTelegramConnect instanceId="inst-1" agentName="Ash" />);
    await pasteTokenAndContinue();

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

    render(<InstanceTelegramConnect instanceId="inst-1" agentName="Ash" />);
    await pasteTokenAndContinue();

    expect(await screen.findByText(/taking longer than expected/i)).toBeInTheDocument();
  });
});
