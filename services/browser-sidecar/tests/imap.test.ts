import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeConfig, silentLogger } from "./_fakes.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/logger.js";

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("imapflow");
  vi.doUnmock("../src/config.js");
  delete process.env.IMAP_MAX_POLL_MS;
});

describe("fetchVerificationCode — IMAP_MAX_POLL_MS clamp", () => {
  it("the constant is exactly 60_000 ms in production code", async () => {
    const cfg = await import("../src/config.js");
    expect(cfg.IMAP_MAX_POLL_MS).toBe(60_000);
  });

  it("env IMAP_MAX_POLL_MS=999999999 does not change the constant", async () => {
    process.env.IMAP_MAX_POLL_MS = "999999999";
    vi.resetModules();
    const cfg = await import("../src/config.js");
    expect(cfg.IMAP_MAX_POLL_MS).toBe(60_000);
  });

  it("polling deadline respects the constant, not env (substituted constant=250ms test)", async () => {
    // Substitute the constant via doMock so we can assert deadline behavior
    // without waiting 60s. Production code reads the same constant — if it ever
    // started reading process.env.IMAP_MAX_POLL_MS instead, this test would
    // hang for ~999s and fail by timeout.
    vi.doMock("../src/config.js", async () => {
      const actual =
        await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
      return { ...actual, IMAP_MAX_POLL_MS: 250 };
    });
    vi.doMock("imapflow", () => {
      class FakeImapFlow {
        async connect() {}
        async logout() {}
        async getMailboxLock() {
          return { release: () => undefined };
        }
        async *fetch() {
          // yields nothing — code never appears
        }
      }
      return { ImapFlow: FakeImapFlow };
    });
    process.env.IMAP_MAX_POLL_MS = "999999999"; // attempt to extend via env
    const { fetchVerificationCode } = await import("../src/imap/client.js");
    const config = fakeConfig({
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "u",
      IMAP_PASS: "p",
    }) as Config;
    const logger = silentLogger() as unknown as Logger;

    const start = Date.now();
    await expect(fetchVerificationCode(config, logger, {})).rejects.toThrow(/IMAP_CODE_TIMEOUT/);
    const elapsed = Date.now() - start;
    // 250ms deadline + one poll-interval ≤ 1s; if env mattered it would be 999s.
    expect(elapsed).toBeLessThan(2_000);
  }, 5_000);
});

describe("fetchVerificationCode — credential discipline", () => {
  it("throws with no creds configured", async () => {
    const { fetchVerificationCode } = await import("../src/imap/client.js");
    const config = fakeConfig({
      IMAP_HOST: undefined,
      IMAP_USER: undefined,
      IMAP_PASS: undefined,
    }) as Config;
    const logger = silentLogger() as unknown as Logger;
    await expect(fetchVerificationCode(config, logger, {})).rejects.toThrow(/IMAP not configured/);
  });

  it("never includes credentials in error messages", async () => {
    vi.doMock("imapflow", () => {
      class FakeImapFlow {
        async connect() {
          throw new Error(
            "connection failed for user=secret-user@example.com password=hunter2",
          );
        }
        async logout() {}
      }
      return { ImapFlow: FakeImapFlow };
    });
    const { fetchVerificationCode } = await import("../src/imap/client.js");
    const config = fakeConfig({
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "secret-user",
      IMAP_PASS: "hunter2",
    }) as Config;
    const logger = silentLogger() as unknown as Logger;

    let thrown: Error | undefined;
    try {
      await fetchVerificationCode(config, logger, {});
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toBe("IMAP_CONNECT_FAILED");
    expect(thrown!.message).not.toContain("hunter2");
    expect(thrown!.message).not.toContain("secret-user");
  });
});

describe("fetchVerificationCode — code extraction", () => {
  it("returns a 6-digit code from an envelope subject", async () => {
    vi.doMock("imapflow", () => {
      class FakeImapFlow {
        async connect() {}
        async logout() {}
        async getMailboxLock() {
          return { release: () => undefined };
        }
        async *fetch() {
          yield {
            envelope: { subject: "Your verification code is 123456" },
            source: undefined,
            uid: 1,
          };
        }
      }
      return { ImapFlow: FakeImapFlow };
    });
    const { fetchVerificationCode } = await import("../src/imap/client.js");
    const config = fakeConfig({
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "u",
      IMAP_PASS: "p",
    }) as Config;
    const logger = silentLogger() as unknown as Logger;
    const code = await fetchVerificationCode(config, logger, {});
    expect(code).toBe("123456");
  });
});
