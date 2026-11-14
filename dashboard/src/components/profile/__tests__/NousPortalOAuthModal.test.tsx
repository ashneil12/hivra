/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { NousPortalOAuthModal } from "../NousPortalOAuthModal";
import { copyTextToClipboard } from "@/lib/client/clipboard";

jest.mock("@/lib/client/clipboard", () => ({
  copyTextToClipboard: jest.fn(),
}));

jest.mock("@/lib/nous-oauth", () => ({
  verifyNousPortalConnection: jest.fn().mockResolvedValue(undefined),
}));

const mockPosthogCapture = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: (...args: unknown[]) => mockPosthogCapture(...args),
  },
}));

describe("NousPortalOAuthModal", () => {
  const mockedCopyTextToClipboard = copyTextToClipboard as jest.MockedFunction<
    typeof copyTextToClipboard
  >;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockedCopyTextToClipboard.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function getOauthCaptures(eventName: string) {
    return mockPosthogCapture.mock.calls.filter(
      ([event]) => event === eventName
    );
  }

  async function arriveAtWaitingStep(instanceId = "inst-nous-popup") {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            session_id: "sess_123",
            user_code: "NOUS-1234",
            verification_url: "https://portal.nousresearch.com/device?code=NOUS",
            poll_interval: 5,
            expires_in: 900,
          },
        }),
      }),
    });

    render(<NousPortalOAuthModal instanceId={instanceId} onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /connect nous portal/i }));
    });

    await screen.findByRole("button", { name: /open nous portal/i });
  }

  it("shows a neutral copy fallback without failed telemetry when window.open returns null", async () => {
    await arriveAtWaitingStep();

    const openSpy = jest.fn().mockReturnValue(null);
    Object.defineProperty(window, "open", {
      configurable: true,
      writable: true,
      value: openSpy,
    });

    fireEvent.click(screen.getByRole("button", { name: /open nous portal/i }));

    expect(openSpy).toHaveBeenCalledWith(
      "https://portal.nousresearch.com/device?code=NOUS",
      "_blank",
      "noopener,noreferrer"
    );
    expect(
      screen.getByText(/if the nous portal page did not open/i)
    ).toBeInTheDocument();

    const popupFailure = getOauthCaptures("provider_oauth_failed").find(
      ([, props]) => props.failure_reason === "popup_blocked"
    );
    expect(popupFailure).toBeUndefined();
    expect(screen.getByRole("button", { name: /copy url/i })).toBeInTheDocument();
  });

  it("emits safe diagnostic outcome properties when the provider returns an OAuth error", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            session_id: "sess_denied",
            user_code: "NOUS-1234",
            verification_url: "https://portal.nousresearch.com/device?code=NOUS",
            poll_interval: 5,
            expires_in: 900,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            status: "error",
            error_message: "access_denied: user cancelled authorization",
          },
        }),
      });

    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<NousPortalOAuthModal instanceId="inst-nous-denied" onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /connect nous portal/i }));
    });
    await screen.findByRole("button", { name: /open nous portal/i });

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    const failedCalls = getOauthCaptures("provider_oauth_failed");
    const providerError = failedCalls.find(
      ([, props]) => props.failure_reason === "device_status_error"
    );
    expect(providerError?.[1]).toEqual(
      expect.objectContaining({
        provider: "nous",
        instance_id: "inst-nous-denied",
        failure_reason: "device_status_error",
        failure_stage: "provider_callback",
        failure_category: "cancelled",
        provider_status: "error",
        retryable: true,
      })
    );
    expect(providerError?.[1]).not.toHaveProperty("error_message");
  });

  it("arms no poll or expiry timer when the modal closes while its start request is in flight", async () => {
    let resolveStart: (value: unknown) => void = () => {};
    const startResponse = new Promise(resolve => {
      resolveStart = resolve;
    });
    const fetchMock = jest.fn().mockReturnValueOnce(startResponse);
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
    const setIntervalSpy = jest.spyOn(window, "setInterval");
    const setTimeoutSpy = jest.spyOn(window, "setTimeout");

    const { unmount } = render(
      <NousPortalOAuthModal instanceId="inst-nous-unmounted" onClose={jest.fn()} />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /connect nous portal/i }));
    });
    unmount();
    const setIntervalAfterUnmount = setIntervalSpy.mock.calls.length;
    const setTimeoutAfterUnmount = setTimeoutSpy.mock.calls.length;

    await act(async () => {
      resolveStart({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            session_id: "sess_late",
            user_code: "NOUS-1234",
            verification_url: "https://portal.nousresearch.com/device?code=NOUS",
            poll_interval: 5,
            expires_in: 900,
          },
        }),
      });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    const lateIntervals = setIntervalSpy.mock.calls.slice(setIntervalAfterUnmount);
    const lateTimeouts = setTimeoutSpy.mock.calls.slice(setTimeoutAfterUnmount);
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    expect(lateIntervals).not.toContainEqual([expect.any(Function), 5000]);
    expect(lateTimeouts).not.toContainEqual([expect.any(Function), 900_000]);
    await act(async () => {
      jest.advanceTimersByTime(900_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      getOauthCaptures("provider_oauth_failed").find(
        ([, props]) => props.failure_reason === "session_expired"
      )
    ).toBeUndefined();
  });

  it("refuses a verification address that is not https and never offers or opens it", async () => {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            session_id: "sess_bad",
            user_code: "NOUS-0000",
            verification_url: "javascript:alert(1)",
            poll_interval: 5,
            expires_in: 900,
          },
        }),
      }),
    });
    const openSpy = jest.fn();
    Object.defineProperty(window, "open", { configurable: true, writable: true, value: openSpy });

    render(<NousPortalOAuthModal instanceId="inst-nous-bad-url" onClose={jest.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /connect nous portal/i }));
    });

    expect(screen.queryByRole("button", { name: /open nous portal/i })).not.toBeInTheDocument();
    expect(screen.queryByText("javascript:alert(1)")).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
