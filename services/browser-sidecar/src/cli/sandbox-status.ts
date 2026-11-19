#!/usr/bin/env node
// Prints one JSON line describing the Chromium this container runs and whether
// its sandbox is on, then exits 0 only when the version is at or above the
// CVE floor AND Chromium reports an adequate sandbox.
//
//   docker exec <name>-browser-sidecar node /app/dist/cli/sandbox-status.js
//
// With AGENT_CDP_ENABLED it inspects the agent's running Chrome over CDP (one
// short-lived chrome://sandbox tab, closed again). Otherwise it launches a
// throwaway headless Chromium with the same flags the sidecar uses.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  assertCanSandbox,
  CHROMIUM_COMMON_ARGS,
  chromiumVersionAtLeast,
  MIN_CHROMIUM_VERSION,
  resolveChromiumExecutable,
} from "../browser/chromium.js";
import { parseSandboxPage, type SandboxReport } from "../browser/sandbox-status.js";

interface Status extends Partial<SandboxReport> {
  ok: boolean;
  mode: "cdp" | "launch";
  uid: number | null;
  chromium_version: string | null;
  min_chromium_version: string;
  version_ok: boolean;
  error?: string;
}

async function readFromContext(context: BrowserContext): Promise<SandboxReport> {
  const page = await context.newPage();
  try {
    await page.goto("chrome://sandbox", { waitUntil: "load", timeout: 20_000 });
    // The page fills its table asynchronously; wait for the verdict sentence.
    await page.getByText(/sandboxed/i).first().waitFor({ timeout: 10_000 });
    return parseSandboxPage(await page.innerText("body"));
  } finally {
    await page.close().catch(() => {});
  }
}

async function main(): Promise<number> {
  const cdp = /^(1|true|yes|on)$/i.test(process.env.AGENT_CDP_ENABLED ?? "");
  const status: Status = {
    ok: false,
    mode: cdp ? "cdp" : "launch",
    uid: process.getuid?.() ?? null,
    chromium_version: null,
    min_chromium_version: MIN_CHROMIUM_VERSION,
    version_ok: false,
  };
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let profile: string | undefined;
  try {
    if (cdp) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.AGENT_CDP_PORT || 9223)}`);
      context = browser.contexts()[0];
      if (!context) throw new Error("agent CDP browser has no context");
    } else {
      assertCanSandbox();
      profile = await mkdtemp(join(tmpdir(), "sandbox-status-"));
      context = await chromium.launchPersistentContext(profile, {
        executablePath: resolveChromiumExecutable(),
        chromiumSandbox: true,
        headless: true,
        args: [...CHROMIUM_COMMON_ARGS],
      });
      browser = context.browser() ?? undefined;
    }
    status.chromium_version = browser?.version() ?? null;
    status.version_ok = status.chromium_version !== null && chromiumVersionAtLeast(status.chromium_version);
    Object.assign(status, await readFromContext(context));
    status.ok = status.version_ok && status.verdict === "adequate";
  } catch (err) {
    status.error = String((err as Error).message ?? err).split("\n").slice(0, 8).join(" | ").slice(0, 1500);
  } finally {
    // In CDP mode this only disconnects; the agent's Chrome keeps running.
    if (cdp) await browser?.close().catch(() => {});
    else await context?.close().catch(() => {});
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(status)}\n`);
  return status.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err) })}\n`);
    process.exit(1);
  },
);
