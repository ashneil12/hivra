import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { buildLogger } from "../src/logger.js";
import { attachRequestLog } from "../src/request-log.js";
import { registerCookieRoutes } from "../src/routes/cookies.js";
import { registerNavigationRoutes } from "../src/routes/navigation.js";
import type { SessionManager } from "../src/playwright/session-manager.js";

// End to end: real routes, real request-log hook, real redaction config. The
// canary values are the secrets a caller sends; none of them may reach the log.
const COOKIE_CANARY = "CANARYCOOKIE9f3a";
const TICKET_CANARY = "CANARYTICKET7b2e";
const FRAGMENT_CANARY = "CANARYFRAG5d1c";

async function buildApp() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = buildLogger({ LOG_LEVEL: "info", NODE_ENV: "test" }, sink);
  const sessions = {
    get: () => undefined,
    importCookies: async () => ({ imported: 1, skipped: 0, domains: [".example.test"] }),
  } as unknown as SessionManager;

  const app = Fastify({ logger: false, disableRequestLogging: true });
  attachRequestLog(app, logger);
  registerNavigationRoutes(app, { sessions });
  registerCookieRoutes(app, { sessions });
  await app.ready();

  // The onResponse hook runs after the response is sent; let it write its line.
  const logged = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return chunks.join("");
  };
  return { app, logged };
}

const netscapeFile = [
  "# Netscape HTTP Cookie File",
  `.example.test\tTRUE\t/\tTRUE\t0\tsid\t${COOKIE_CANARY}`,
  "",
].join("\n");

describe("request log", () => {
  it("does not write the cookie-import file or its cookie values", async () => {
    const { app, logged } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/cookies/import",
      payload: { identity: "vex", file: netscapeFile, dryRun: false },
    });
    expect(res.statusCode).toBe(200);

    const output = await logged();
    expect(output).toContain('"tool":"/cookies/import"');
    expect(output).toContain('"file":"[REDACTED]"');
    expect(output).not.toContain(COOKIE_CANARY);
  });

  it("does not write a one-time ticket or fragment carried in a /goto url", async () => {
    const { app, logged } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/goto",
      payload: {
        session_id: "no-such-session",
        url: `https://login.example.test/cb?ticket=${TICKET_CANARY}#${FRAGMENT_CANARY}`,
      },
    });
    expect(res.statusCode).toBe(404);

    const output = await logged();
    expect(output).toContain('"tool":"/goto"');
    expect(output).toContain('"url":"https://login.example.test/cb"');
    expect(output).not.toContain(TICKET_CANARY);
    expect(output).not.toContain(FRAGMENT_CANARY);
  });
});
