/** @jest-environment jsdom */
import "@testing-library/jest-dom";

const mockInit = jest.fn();
const mockSetConfig = jest.fn();
const mockStopSessionRecording = jest.fn();
const originalLocation = window.location;

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: mockInit,
    set_config: mockSetConfig,
    stopSessionRecording: mockStopSessionRecording,
    capture: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
  },
}));

jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(() => "/"),
  useSearchParams: jest.fn(() => new URLSearchParams()),
}));

describe("PostHogProvider bootstrap", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    // PostHogProvider defers init via requestIdleCallback for perf — run it
    // synchronously in tests so assertions don't need to chase timers.
    (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback = (cb) => {
      cb();
      return 0;
    };
  });

  it("disables automatic exception capture on localhost", async () => {
    window.history.replaceState({}, "", "/test");

    await import("../PostHogProvider");

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        disable_external_dependency_loading: true,
        disable_session_recording: true,
        capture_dead_clicks: false,
        capture_exceptions: expect.objectContaining({
          capture_unhandled_errors: false,
          capture_unhandled_rejections: false,
        }),
      })
    );

    expect(mockSetConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_dead_clicks: false,
        disable_session_recording: true,
      })
    );
    expect(mockStopSessionRecording).toHaveBeenCalled();
  });

  it("disables automatic exception capture on the production host too", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        hostname: "hermesos.cloud",
        origin: "https://hermesos.cloud",
        href: "https://hermesos.cloud/token",
      },
    });

    await import("../PostHogProvider");

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        capture_exceptions: expect.objectContaining({
          capture_unhandled_errors: false,
          capture_unhandled_rejections: false,
        }),
      })
    );
    expect(mockInit).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        disable_external_dependency_loading: true,
      })
    );
  });
});

