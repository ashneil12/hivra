/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { CodexOAuthModal } from "../CodexOAuthModal";
import { copyTextToClipboard } from "@/lib/client/clipboard";

jest.mock("@/lib/client/clipboard", () => ({
  copyTextToClipboard: jest.fn(),
}));

const mockPosthogCapture = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: (...args: unknown[]) => mockPosthogCapture(...args),
  },
}));

describe("CodexOAuthModal", () => {
  const mockedCopyTextToClipboard = copyTextToClipboard as jest.MockedFunction<
    typeof copyTextToClipboard
  >;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockedCopyTextToClipboard.mockResolvedValue(true);
    mockPosthogCapture.mockClear();
  });

  function getOauthCaptures(eventName: string) {
    return mockPosthogCapture.mock.calls.filter(
      ([event]) => event === eventName
    );
  }

  async function arriveAtWaitingStep(instanceId = "inst-popup") {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            url: "https://chatgpt.com/auth/device?code=ABCD",
            code: "ABCD-1234",
          },
        }),
      }),
    });

    render(<CodexOAuthModal instanceId={instanceId} onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await screen.findByRole("button", { name: /open authorization page/i });
  }

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("surfaces a retryable error when starting Codex OAuth stalls", async () => {
    const fetchMock = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abortHandler = () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        };

        init?.signal?.addEventListener("abort", abortHandler, { once: true });
      });
    });

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<CodexOAuthModal instanceId="inst-123" onClose={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));

    expect(screen.getByText(/starting sign-in on your agent/i)).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(45_000);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/timed out starting codex login\. please try again\./i)
      ).toBeInTheDocument();
    });
  });

  it("normalizes raw SSH warmup errors returned by the start endpoint", async () => {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: "SSH fingerprint capture failed: connect ETIMEDOUT 203.0.113.185:22",
        }),
      }),
    });

    render(<CodexOAuthModal instanceId="inst-123" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText(/instance is still provisioning ssh access\. try again in a moment\./i)
      ).toBeInTheDocument();
    });
  });

  it("emits diagnostic outcome properties (stage, HTTP status, sanitized message) when start fails", async () => {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: "SSH fingerprint capture failed: connect ETIMEDOUT 203.0.113.185:22",
        }),
      }),
    });

    render(<CodexOAuthModal instanceId="inst-diagnostics" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    const failedCalls = getOauthCaptures("provider_oauth_failed");
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0][1]).toEqual(
      expect.objectContaining({
        provider: "codex",
        instance_id: "inst-diagnostics",
        failure_reason: "start_error",
        failure_stage: "start",
        failure_category: "app_error",
        retryable: true,
        http_status: 409,
      })
    );
    expect(typeof failedCalls[0][1].error_message).toBe("string");
    expect(failedCalls[0][1].error_message.length).toBeGreaterThan(0);
    expect(failedCalls[0][1]).not.toHaveProperty("error");
  });

  it("maps the 409 instance_off precondition to a friendly start-your-agent message without auto-retrying", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "instance_off" }),
    });
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    // autoStart mirrors the instance page's auto-firing modal — the exact
    // surface that produced the 100%-failure provider_oauth_failed cluster.
    await act(async () => {
      render(
        <CodexOAuthModal instanceId="inst-off" autoStart onClose={jest.fn()} />
      );
    });

    await waitFor(() => {
      expect(
        screen.getByText(/powered off right now\. start \(or restore\) your agent first/i)
      ).toBeInTheDocument();
    });
    // Raw machine code never rendered to the user.
    expect(screen.queryByText(/^instance_off$/)).not.toBeInTheDocument();

    // No auto-retry loop: exactly one start POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const failedCalls = getOauthCaptures("provider_oauth_failed");
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0][1]).toEqual(
      expect.objectContaining({
        provider: "codex",
        instance_id: "inst-off",
        failure_reason: "instance_off",
        failure_stage: "start",
        failure_category: "precondition",
        retryable: true,
        http_status: 409,
        error_message: "instance_off",
      })
    );
  });

  it("redacts token-shaped content from the error_message diagnostic", async () => {
    const jwtLikeToken =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ";
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          error: `Codex token exchange failed: ${jwtLikeToken}`,
        }),
      }),
    });

    render(<CodexOAuthModal instanceId="inst-redaction" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    const failedCalls = getOauthCaptures("provider_oauth_failed");
    expect(failedCalls).toHaveLength(1);
    const errorMessage = failedCalls[0][1].error_message as string;
    expect(errorMessage).toContain("[REDACTED]");
    expect(errorMessage).not.toContain(jwtLikeToken);
    expect(errorMessage).not.toContain("eyJhbGci");
  });

  it("shows a clean error (not a JSON parse crash) when the start endpoint answers with non-JSON", async () => {
    // Edge proxies answer 502/504 with HTML bodies; res.json() rejects.
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token '<', \"<html>\"... is not valid JSON");
        },
      }),
    });

    render(<CodexOAuthModal instanceId="inst-html-502" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/failed to start codex oauth/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/unexpected token/i)).not.toBeInTheDocument();

    const failedCalls = getOauthCaptures("provider_oauth_failed");
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0][1]).toEqual(
      expect.objectContaining({
        failure_stage: "start",
        http_status: 502,
      })
    );
  });

  it("surfaces an actionable error when the start payload is missing the device URL", async () => {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
      }),
    });

    render(<CodexOAuthModal instanceId="inst-no-url" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText(/no authorization url was returned/i)
      ).toBeInTheDocument();
    });

    const failedCalls = getOauthCaptures("provider_oauth_failed");
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0][1]).toEqual(
      expect.objectContaining({
        failure_stage: "start",
        http_status: 200,
      })
    );
  });

  it("shows actionable retry/redeploy guidance (not the dead Vault link) when the runtime cannot host the device flow (503)", async () => {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          error: "Agent container is not running. Please start your instance first.",
        }),
      }),
    });

    render(<CodexOAuthModal instanceId="inst-runtime-down" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText(/agent container is not running/i)
      ).toBeInTheDocument();
    });

    // The old /dashboard/vault CTA was a dead end (provider auth moved
    // WebUI-side); the 503 panel now guides the user to wait/redeploy + retry.
    expect(
      screen.queryByRole("link", { name: /connect via vault page/i })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/redeploy/i)).toBeInTheDocument();
    // Retry stays available — the runtime hiccup may be transient.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does not offer the Vault CTA for non-503 start failures", async () => {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Failed to start the Hermes Codex device flow." }),
      }),
    });

    render(<CodexOAuthModal instanceId="inst-500" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/failed to start the hermes codex device flow/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: /connect via vault page/i })).not.toBeInTheDocument();
  });

  it("keeps the copy button unchanged when copying the device code fails", async () => {
    mockedCopyTextToClipboard.mockResolvedValue(false);

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            url: "https://example.com/device",
            code: "ABCD-1234",
          },
        }),
      }),
    });

    render(<CodexOAuthModal instanceId="inst-123" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    const copyButton = await screen.findByRole("button", { name: /^copy$/i });

    await act(async () => {
      fireEvent.click(copyButton);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith("ABCD-1234");
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copied!/i })).not.toBeInTheDocument();
  });

  it("clears the copy reset timer when the modal unmounts early", async () => {
    const setTimeoutSpy = jest.spyOn(window, "setTimeout");
    const clearTimeoutSpy = jest.spyOn(window, "clearTimeout");

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            url: "https://example.com/device",
            code: "ABCD-1234",
          },
        }),
      }),
    });

    const { unmount } = render(<CodexOAuthModal instanceId="inst-123" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    const copyButton = await screen.findByRole("button", { name: /^copy$/i });

    await act(async () => {
      fireEvent.click(copyButton);
    });

    const copyTimeoutCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2000);
    expect(copyTimeoutCallIndex).toBeGreaterThanOrEqual(0);
    const copyTimeoutId = setTimeoutSpy.mock.results[copyTimeoutCallIndex]?.value;

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(copyTimeoutId);
  });

  it("cancels the delayed success callbacks when the modal closes early", async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            url: "https://example.com/device",
            code: "ABCD-1234",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            authenticated: true,
          },
        }),
      });

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<CodexOAuthModal instanceId="inst-123" onClose={onClose} onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await act(async () => {
      jest.advanceTimersByTime(4_000);
      await Promise.resolve();
    });

    await screen.findByText(/codex connected/i);

    fireEvent.click(screen.getAllByRole("button")[0]);

    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("starts and polls OAuth against the selected profile and returns the saved Vault key id", async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            url: "https://example.com/device",
            code: "ABCD-1234",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            authenticated: true,
            vaultKeyId: "vault-new",
          },
        }),
      });

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(
      <CodexOAuthModal
        instanceId="inst-123"
        profileName="research"
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await act(async () => {
      jest.advanceTimersByTime(4_000);
      await Promise.resolve();
    });

    await screen.findByText(/codex connected/i);

    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/instances/inst-123/oauth/codex/start?profile=research",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/instances/inst-123/oauth/codex/status?profile=research&apply=1"
    );
    expect(onSuccess).toHaveBeenCalledWith({ vaultKeyId: "vault-new" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("starts Codex OAuth automatically once when autoStart is enabled", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          url: "https://example.com/device",
          code: "ABCD-1234",
        },
      }),
    });

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    const { rerender } = render(
      <CodexOAuthModal instanceId="inst-autostart" autoStart onClose={jest.fn()} />
    );

    expect(screen.getByText(/starting sign-in on your agent/i)).toBeInTheDocument();

    await screen.findByRole("button", { name: /open authorization page/i });

    rerender(
      <CodexOAuthModal instanceId="inst-autostart" autoStart onClose={jest.fn()} />
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/instances/inst-autostart/oauth/codex/start",
      expect.objectContaining({ method: "POST" })
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Brief 3 regression suite
  //  Sessions D and E in the PostHog audit died on this flow with 19+
  //  minute hangs. The fix added: visible Open + Copy URL buttons from
  //  t=0 (no buried fallback), a neutral copy fallback for unknown tab-open
  //  results, a 12-min poll cap before the device code expires, and
  //  provider_oauth_* instrumentation. Lock those contracts in.
  // ─────────────────────────────────────────────────────────────────────

  it("renders both 'Open authorization page' and 'Copy URL' buttons immediately when the URL is shown", async () => {
    await arriveAtWaitingStep();

    expect(screen.getByRole("button", { name: /open authorization page/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy url/i })).toBeInTheDocument();
    // The URL must also be available as selectable text in case both
    // buttons are non-functional in some edge environment.
    expect(screen.getByText("https://chatgpt.com/auth/device?code=ABCD")).toBeInTheDocument();
  });

  it("fires provider_oauth_started with attempt_number=1 when the user clicks Start", async () => {
    // Use a unique instanceId so the module-scoped attempt-counter Map
    // (which intentionally persists across renders to track retries
    // within a session) doesn't carry state from sibling tests.
    await arriveAtWaitingStep("inst-started-fresh");

    const startedCalls = getOauthCaptures("provider_oauth_started");
    expect(startedCalls).toHaveLength(1);
    expect(startedCalls[0][1]).toEqual(
      expect.objectContaining({
        provider: "codex",
        instance_id: "inst-started-fresh",
        attempt_number: 1,
      })
    );
  });

  it("shows a neutral copy fallback without failed telemetry when window.open returns null", async () => {
    await arriveAtWaitingStep();

    // With noopener/noreferrer, some browsers return null even when the tab
    // opened successfully. Null is an unknown state, not a reliable failure.
    const openSpy = jest.fn().mockReturnValue(null);
    Object.defineProperty(window, "open", {
      configurable: true,
      writable: true,
      value: openSpy,
    });

    fireEvent.click(screen.getByRole("button", { name: /open authorization page/i }));

    expect(openSpy).toHaveBeenCalledWith(
      "https://chatgpt.com/auth/device?code=ABCD",
      "_blank",
      "noopener,noreferrer"
    );
    expect(
      screen.getByText(/if the authorization page did not open/i)
    ).toBeInTheDocument();

    const failedCalls = getOauthCaptures("provider_oauth_failed");
    const falsePopupFailure = failedCalls.find(
      ([, props]) => props.failure_reason === "popup_blocked"
    );
    expect(falsePopupFailure).toBeUndefined();

    // Even when the open result is unknown, Copy URL must still work as a fallback.
    expect(screen.getByRole("button", { name: /copy url/i })).toBeInTheDocument();
  });

  it("hides the neutral copy fallback when window.open succeeds on a retry", async () => {
    await arriveAtWaitingStep();

    Object.defineProperty(window, "open", {
      configurable: true,
      writable: true,
      value: jest.fn().mockReturnValueOnce(null).mockReturnValueOnce({}),
    });

    fireEvent.click(screen.getByRole("button", { name: /open authorization page/i }));
    expect(screen.getByText(/if the authorization page did not open/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open authorization page/i }));
    expect(screen.queryByText(/if the authorization page did not open/i)).not.toBeInTheDocument();
  });

  it("reassures users that Hermes keeps polling while Codex authorization is pending", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            url: "https://chatgpt.com/auth/device?code=ABCD",
            code: "ABCD-1234",
          },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: { authenticated: false } }),
      });

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<CodexOAuthModal instanceId="inst-pending" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await screen.findByRole("button", { name: /open authorization page/i });
    expect(screen.getByText(/hermes checks automatically every 4 seconds/i)).toBeInTheDocument();
    expect(screen.getByText(/saving the session and applying it to the agent can take about 30-60 seconds/i)).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(4_000);
      await Promise.resolve();
    });

    expect(await screen.findByText(/checked 1 time so far/i)).toBeInTheDocument();
  });

  it("trips a code-expired error and emits provider_oauth_failed{code_expired} after 12 minutes of polling", async () => {
    // Status endpoint always returns 'not authenticated yet' so polling
    // would naturally continue forever without our timeout.
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            url: "https://chatgpt.com/auth/device?code=ABCD",
            code: "ABCD-1234",
          },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: { authenticated: false } }),
      });

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<CodexOAuthModal instanceId="inst-timeout" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await screen.findByRole("button", { name: /open authorization page/i });

    // Advance past the 12-min cap. The interval ticks every 4s and the
    // timeout check fires inside the callback, so we just need the wall
    // clock to cross the threshold and one more tick to fire.
    await act(async () => {
      jest.advanceTimersByTime(12 * 60 * 1000 + 4_000);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        screen.getByText(/authorization code expired/i)
      ).toBeInTheDocument();
    });

    const failedCalls = getOauthCaptures("provider_oauth_failed");
    const codeExpired = failedCalls.find(
      ([, props]) => props.failure_reason === "code_expired"
    );
    expect(codeExpired).toBeDefined();
    expect(codeExpired![1]).toEqual(
      expect.objectContaining({
        provider: "codex",
        instance_id: "inst-timeout",
        failure_reason: "code_expired",
      })
    );
  });

  it("emits provider_oauth_completed with a numeric time_to_complete_ms on success", async () => {
    const onClose = jest.fn();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { url: "https://example.com/device", code: "ABCD-1234" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { authenticated: true } }),
      });

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<CodexOAuthModal instanceId="inst-ok" onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start codex login/i }));
    });

    await act(async () => {
      jest.advanceTimersByTime(4_000);
      await Promise.resolve();
    });

    await screen.findByText(/codex connected/i);

    const completedCalls = getOauthCaptures("provider_oauth_completed");
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0][1]).toEqual(
      expect.objectContaining({
        provider: "codex",
        instance_id: "inst-ok",
      })
    );
    expect(typeof completedCalls[0][1].time_to_complete_ms).toBe("number");

    // Drain the 3s success timer so the modal closes naturally before
    // afterEach unmounts. Otherwise the cleanup useEffect calls
    // clearTimeout on a fake-timer ID after jest.useRealTimers() has
    // ripped clearTimeout from the global, which throws ReferenceError.
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("puts the device code first and copies it and opens sign-in in one tap", async () => {
    await arriveAtWaitingStep("inst-code-first");
    const openSpy = jest.fn().mockReturnValue({} as Window);
    Object.defineProperty(window, "open", { configurable: true, writable: true, value: openSpy });

    const codeStep = screen.getByText(/step 1 — copy this code/i);
    const urlStep = screen.getByText(/step 2 — enter it on the sign-in page/i);
    expect(codeStep.compareDocumentPosition(urlStep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy code & open sign-in/i }));
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith("ABCD-1234");
    expect(openSpy).toHaveBeenCalledWith("https://chatgpt.com/auth/device?code=ABCD", "_blank", "noopener,noreferrer");
    expect(screen.getByRole("button", { name: /^copied!$/i })).toBeInTheDocument();

    // Drain the copy reset timer before afterEach swaps back to real timers.
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
  });

  it("closes from the labelled close button, Escape, or the backdrop, but not from inside the card", () => {
    const onClose = jest.fn();
    render(<CodexOAuthModal instanceId="inst-dismiss" onClose={onClose} />);

    fireEvent.click(screen.getByRole("heading", { name: /sign in with chatgpt/i }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("stays open when a text selection started in the card is released over the backdrop", () => {
    const onClose = jest.fn();
    render(<CodexOAuthModal instanceId="inst-drag" onClose={onClose} />);

    // The browser sends the click to the common ancestor: the backdrop.
    fireEvent.pointerDown(screen.getByRole("heading", { name: /sign in with chatgpt/i }));
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
