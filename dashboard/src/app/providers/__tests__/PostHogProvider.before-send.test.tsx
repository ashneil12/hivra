/** @jest-environment jsdom */
import "@testing-library/jest-dom";

// $exception noise filtering: the before_send hook registered at init() must
// drop a NARROW denylist of browser-extension noise (263 of 366 prod
// $exceptions over 5 days were "Invalid call to runtime.sendMessage(). Tab not
// found." from Chrome extensions) while letting every real event through.
// Each case re-imports the module (jest.resetModules) so init() re-runs and
// the hook can be pulled out of the captured init config.

const mockInit = jest.fn();

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: mockInit,
    set_config: jest.fn(),
    stopSessionRecording: jest.fn(),
    startSessionRecording: jest.fn(),
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

const originalLocation = window.location;

type AnyEvent = { event: string; properties?: Record<string, unknown> } | null;
type BeforeSend = (event: AnyEvent) => AnyEvent;

async function importAndGetBeforeSend(): Promise<BeforeSend> {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...originalLocation,
      hostname: "hermesos.cloud",
      pathname: "/",
      origin: "https://hermesos.cloud",
      href: "https://hermesos.cloud/",
    },
  });
  await import("../PostHogProvider");
  expect(mockInit).toHaveBeenCalled();
  const config = mockInit.mock.calls[0][1] as { before_send?: BeforeSend };
  expect(typeof config.before_send).toBe("function");
  return config.before_send as BeforeSend;
}

function exceptionEvent(properties: Record<string, unknown>): AnyEvent {
  return { event: "$exception", properties };
}

const EXTENSION_NOISE_MESSAGE = "Invalid call to runtime.sendMessage(). Tab not found.";

describe("PostHog before_send browser-extension noise filter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback = (cb) => {
      cb();
      return 0;
    };
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("drops the runtime.sendMessage 'Tab not found' noise ($exception_list shape)", async () => {
    const beforeSend = await importAndGetBeforeSend();
    const event = exceptionEvent({
      $exception_list: [{ type: "Error", value: EXTENSION_NOISE_MESSAGE }],
    });
    expect(beforeSend(event)).toBeNull();
  });

  it("drops the runtime.sendMessage 'Tab not found' noise (legacy $exception_message shape)", async () => {
    const beforeSend = await importAndGetBeforeSend();
    const event = exceptionEvent({ $exception_message: EXTENSION_NOISE_MESSAGE });
    expect(beforeSend(event)).toBeNull();
  });

  it("drops exceptions whose stack frames all come from extension origins", async () => {
    const beforeSend = await importAndGetBeforeSend();
    const event = exceptionEvent({
      $exception_list: [
        {
          type: "TypeError",
          value: "Cannot read properties of undefined (reading 'id')",
          stacktrace: {
            frames: [
              { filename: "chrome-extension://abcdefghijklmnop/content.js" },
              { filename: "moz-extension://1234-5678/background.js" },
            ],
          },
        },
      ],
    });
    expect(beforeSend(event)).toBeNull();
  });

  it("keeps exceptions with mixed extension and app frames", async () => {
    const beforeSend = await importAndGetBeforeSend();
    const event = exceptionEvent({
      $exception_list: [
        {
          type: "TypeError",
          value: "Cannot read properties of undefined (reading 'id')",
          stacktrace: {
            frames: [
              { filename: "chrome-extension://abcdefghijklmnop/inject.js" },
              { filename: "https://hermesos.cloud/_next/static/chunks/app.js" },
            ],
          },
        },
      ],
    });
    expect(beforeSend(event)).toBe(event);
  });

  it("keeps real app exceptions", async () => {
    const beforeSend = await importAndGetBeforeSend();
    const event = exceptionEvent({
      $exception_list: [
        {
          type: "TypeError",
          value: "Failed to fetch",
          stacktrace: {
            frames: [{ filename: "https://hermesos.cloud/_next/static/chunks/app.js" }],
          },
        },
      ],
    });
    expect(beforeSend(event)).toBe(event);
  });

  it("keeps 'Tab not found' messages that do not mention runtime.sendMessage (narrow match)", async () => {
    const beforeSend = await importAndGetBeforeSend();
    const event = exceptionEvent({
      $exception_list: [{ type: "Error", value: "Tab not found in workspace switcher" }],
    });
    expect(beforeSend(event)).toBe(event);
  });

  it("keeps exceptions with no message and no frames (nothing to match on)", async () => {
    const beforeSend = await importAndGetBeforeSend();
    const event = exceptionEvent({});
    expect(beforeSend(event)).toBe(event);
  });

  it("never touches non-exception events, even with noisy-looking properties", async () => {
    const beforeSend = await importAndGetBeforeSend();
    const event: AnyEvent = {
      event: "$pageview",
      properties: { $exception_message: EXTENSION_NOISE_MESSAGE },
    };
    expect(beforeSend(event)).toBe(event);
  });

  it("passes through null without throwing", async () => {
    const beforeSend = await importAndGetBeforeSend();
    expect(beforeSend(null)).toBeNull();
  });
});
