import { vi } from "vitest";
import type { SessionManager } from "../src/playwright/session-manager.js";

// Fake Page with the methods our routes touch. Each method returns a vi.fn so
// tests can assert on calls and tweak behavior.
export function fakePage(overrides: Partial<Record<string, unknown>> = {}) {
  const locator = vi.fn(() => ({
    first: vi.fn(() => locator()),
    nth: vi.fn(() => locator()),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
    innerText: vi.fn(async () => "fake text"),
  }));
  const getByText = vi.fn(() => ({
    first: vi.fn(() => ({
      click: vi.fn(async () => {}),
      isVisible: vi.fn(async () => true),
    })),
    nth: vi.fn(() => ({
      click: vi.fn(async () => {}),
    })),
  }));
  return {
    goto: vi.fn(async (_url: string) => {}),
    url: vi.fn(() => "https://example.com/"),
    title: vi.fn(async () => "Example"),
    locator,
    getByText,
    screenshot: vi.fn(async () => Buffer.from("fake-png")),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

export function fakeSessionManager(initialSessionId = "fake-session-id"): SessionManager {
  const page = fakePage();
  const session = {
    session_id: initialSessionId,
    identity: "vex",
    page,
    created_at: Date.now(),
    last_used_at: Date.now(),
  };
  const mgr = {
    activeCount: vi.fn(() => 1),
    contextCount: vi.fn(() => 1),
    start: vi.fn(async (_identity: string) => ({ session_id: initialSessionId })),
    end: vi.fn(async (_id: string) => {}),
    get: vi.fn((id: string) => (id === initialSessionId ? session : undefined)),
    resetIdentity: vi.fn(async (_id: string) => {}),
    shutdown: vi.fn(async () => {}),
  };
  return mgr as unknown as SessionManager;
}

export function fakeConfig(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    PORT: 8789,
    HOST: "127.0.0.1",
    LOG_LEVEL: "fatal",
    NODE_ENV: "test",
    PROFILES_DIR: "/tmp/test-profiles",
    FLOWS_DIR: "/tmp/test-flows",
    SCREENSHOTS_DIR: "/tmp/test-screenshots",
    SIGNING_SECRET: "test-secret-at-least-16-chars-long",
    CLERK_POST_LOGIN_PATH: "/dashboard",
    IMAP_PORT: 993,
    IMAP_TLS: true,
    IMAP_MAILBOX: "INBOX",
    IMAP_CODE_SUBJECT_PATTERN: "(verification|sign-in|login)\\s+code|verify\\s+your\\s+email",
    NOVNC_INTERNAL_PORT: 6080,
    DISPLAY: ":99",
    PLAYWRIGHT_HEADLESS: true,
    PLAYWRIGHT_SLOW_MO_MS: 0,
    DEFAULT_NAVIGATION_TIMEOUT_MS: 30_000,
    DEFAULT_ACTION_TIMEOUT_MS: 15_000,
    ...overrides,
  } as unknown);
}

export function silentLogger() {
  const noop = () => {};
  const child = (): unknown => ({
    debug: noop, info: noop, warn: noop, error: noop, fatal: noop, trace: noop, child,
  });
  return child() as ReturnType<typeof child> & { child: typeof child };
}
