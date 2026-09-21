/**
 * Disposable public-WAN acceptance for Hivra's contained desktop preview.
 *
 * This is intentionally separate from the ordinary first-run audit. It creates
 * one throwaway Canary Clerk user, grants that synthetic identity the smallest
 * realistic 2 CPU / 4 GB test envelope without purchasing anything, launches a
 * real managed Hivra Codex VM, installs the exact pinned desktop bundle, drives
 * the public broker through the shipped UI, then destroys the VM and account.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type BrowserContext, type Page, type WebSocket } from "@playwright/test";

import {
  assertNotProduction,
  auditAgentName,
  auditEmail,
  newRunId,
} from "./first-run-audit/config";
import {
  createAuditUser,
  deleteAuditUser,
  mintSignInTicket,
} from "./first-run-audit/clerk-admin";
import {
  destroyAllHivraAgents,
  sleep,
} from "./first-run-audit/instances";
import {
  grantRemoteDesktopAuditPlan,
  preclearAbuseGate,
  remoteDesktopAuditRows,
  removeRemoteDesktopAuditPlan,
  removeRiskPreclear,
} from "./first-run-audit/probes";
import {
  buildGuestCommandInvocation,
  runGuestCommandProcess,
} from "./first-run-audit/guest-command";
import { reapAuditAccounts } from "./first-run-audit/reaper";
import { establishAuditSession } from "./first-run-audit/session";

const ENABLED = process.env.REMOTE_DESKTOP_AUDIT === "1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AuditEnvironment = {
  baseUrl: string;
  clerkSecretKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  outDir: string;
};

type IssuedSession = { id: string; brokerOrigin: string; issuedAtMs: number };

function environment(): AuditEnvironment {
  const baseUrl = (process.env.REMOTE_DESKTOP_AUDIT_BASE_URL || "https://canary.hermesos.cloud").replace(/\/$/, "");
  assertNotProduction(baseUrl);
  const clerkSecretKey = process.env.CLERK_SECRET_KEY ?? "";
  if (!clerkSecretKey.startsWith("sk_test_")) throw new Error("A Canary sk_test_ Clerk key is required.");
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl.startsWith("https://") || !supabaseServiceRoleKey) {
    throw new Error("Canary Supabase service-role configuration is required.");
  }
  return {
    baseUrl,
    clerkSecretKey,
    supabaseUrl,
    supabaseServiceRoleKey,
    outDir: process.env.REMOTE_DESKTOP_AUDIT_OUT_DIR || "e2e/.remote-desktop-audit",
  };
}

function runGuestCommand(script: string, agentId: string): Record<string, unknown> {
  const invocation = buildGuestCommandInvocation(process.cwd(), script, agentId);
  return runGuestCommandProcess(
    invocation.executable,
    invocation.args,
    path.basename(script),
    agentId,
    {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
      timeoutMs: 20 * 60_000,
      env: invocation.env,
    },
  );
}

async function launchAgent(page: Page, env: AuditEnvironment, name: string): Promise<string> {
  const result = await page.evaluate(async ({ url, name: agentName }) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "codex",
        name: agentName,
        cpu: 2,
        ram: 4,
        browser: false,
        deployment: { mode: "hivra-managed" },
        launchRequestId: crypto.randomUUID(),
      }),
    });
    return { status: response.status, ok: response.ok, payload: await response.json().catch(() => null) };
  }, { url: `${env.baseUrl}/api/hivra/agents`, name });
  const payload = result.payload as {
    success?: boolean;
    error?: string;
    data?: { agent?: { id?: string } };
  } | null;
  if (!result.ok || payload?.success !== true || !UUID.test(payload.data?.agent?.id ?? "")) {
    throw new Error(`Hivra launch failed: HTTP ${result.status} ${payload?.error ?? "invalid response"}`);
  }
  return payload.data!.agent!.id!;
}

async function waitForRunning(context: BrowserContext, env: AuditEnvironment, agentId: string) {
  const deadline = Date.now() + 20 * 60_000;
  let last = "never probed";
  while (Date.now() < deadline) {
    const response = await context.request.get(`${env.baseUrl}/api/hivra/agents/${agentId}`, { timeout: 90_000 });
    const payload = await response.json().catch(() => null) as {
      data?: { agent?: Record<string, unknown> };
    } | null;
    const agent = payload?.data?.agent;
    last = `HTTP ${response.status()} status=${String(agent?.status ?? "unknown")} operation=${String(agent?.operation_kind ?? "none")}`;
    if (response.ok() && agent?.status === "running" && agent.operation_id == null && agent.operation_kind == null) {
      return agent;
    }
    if (agent?.status === "error" || agent?.status === "failed") throw new Error(`Agent failed before readiness: ${last}`);
    await sleep(15_000);
  }
  throw new Error(`Agent did not reach a stable running state: ${last}`);
}

async function waitForDecodedSurface(page: Page, brokerOrigin: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const frames = page.frames().filter(candidate => candidate.url().startsWith(`${brokerOrigin}/desktop/`));
    for (const frame of frames) {
      last = await frame.evaluate(() => {
        const videos = [...document.querySelectorAll("video")];
        return {
          url: location.href,
          videos: videos.length,
          decodedVideos: videos.filter(video => video.readyState >= 2 && video.currentTime > 0).length,
          canvases: document.querySelectorAll("canvas").length,
        };
      }).catch(() => ({}));
      if (Number(last.decodedVideos) > 0) return { frame, details: last };
    }
    await sleep(1_000);
  }
  throw new Error(`Selkies never exposed a decoded video surface: ${JSON.stringify(last)}`);
}

async function revokeOwnerSession(page: Page, env: AuditEnvironment, sessionId: string) {
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, { method: "DELETE", credentials: "same-origin" });
    return { status: response.status, ok: response.ok };
  }, `${env.baseUrl}/api/remote-desktop/sessions/${sessionId}`);
  if (!result.ok) throw new Error(`Owner desktop revoke failed: HTTP ${result.status}`);
}

let activeRunId: string | null = null;
let teardownComplete = false;

test.describe.configure({ mode: "serial" });
test.describe("REMOTE DESKTOP AUDIT: disposable Hivra VM over the public WAN path", () => {
  test.skip(!ENABLED, "Set REMOTE_DESKTOP_AUDIT=1 — this test creates and destroys a real Canary VM.");

  test.afterAll(async () => {
    if (!ENABLED || teardownComplete || !activeRunId) return;
    const env = environment();
    const report = await reapAuditAccounts({
      clerkSecretKey: env.clerkSecretKey,
      baseUrl: env.baseUrl,
      minAgeMs: 0,
      onlyRunId: activeRunId,
    });
    if (report.leaked) throw new Error(`Remote desktop afterAll reaper leaked run ${activeRunId}.`);
  });

  test("installs, connects, reconnects, revokes, restarts, persists, and tears down", async ({ browser }, testInfo) => {
    test.setTimeout(55 * 60_000);
    const env = environment();
    const runId = newRunId();
    activeRunId = runId;
    const email = auditEmail(runId, "hermesos.cloud");
    const agentName = auditAgentName(runId);
    const startedAt = new Date().toISOString();
    let clerkUserId: string | null = null;
    let context: BrowserContext | null = null;
    let agentId: string | null = null;
    let failure: string | null = null;
    const evidence: Record<string, unknown> = {
      schema: "hivra.remote-desktop-canary-audit.v1",
      runId,
      target: env.baseUrl,
      gitSha: process.env.GITHUB_SHA || null,
      startedAt,
      browser: "Playwright Chromium on the local Mac; browser telemetry, not optical input-to-photon evidence",
    };

    try {
      const user = await createAuditUser(env.clerkSecretKey, email);
      clerkUserId = user.id;
      await grantRemoteDesktopAuditPlan(env.supabaseUrl, env.supabaseServiceRoleKey, user.id);
      await preclearAbuseGate(env.supabaseUrl, env.supabaseServiceRoleKey, user.id);
      const ticket = await mintSignInTicket(env.clerkSecretKey, user.id);
      context = await establishAuditSession(browser, { baseUrl: env.baseUrl, ticket });
      const page = await context.newPage();
      await page.goto(`${env.baseUrl}/dashboard/launch`, { waitUntil: "domcontentloaded" });

      agentId = await launchAgent(page, env, agentName);
      evidence.agentId = agentId;
      const runningAgent = await waitForRunning(context, env, agentId);
      evidence.agent = {
        status: runningAgent.status,
        type: runningAgent.type,
        cpu: runningAgent.cpu,
        ram: runningAgent.ram,
        vmid: runningAgent.vmid,
        deploymentMode: runningAgent.deployment_mode,
        substrate: runningAgent.computer_substrate,
      };

      const installStarted = Date.now();
      evidence.install = runGuestCommand("scripts/install-remote-desktop-canary.ts", agentId);
      evidence.installMs = Date.now() - installStarted;

      const issuedSessions: IssuedSession[] = [];
      const brokerRequests: string[] = [];
      const sockets: Array<{ socket: WebSocket; openedAt: number; closedAt: number | null; sent: number; received: number }> = [];
      page.on("request", request => {
        const latestOrigin = issuedSessions.at(-1)?.brokerOrigin;
        if (latestOrigin && request.url().startsWith(latestOrigin)) brokerRequests.push(request.url());
      });
      page.on("response", async response => {
        if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/remote-desktop/sessions") return;
        const payload = await response.json().catch(() => null) as { data?: { id?: string; brokerOrigin?: string } } | null;
        if (response.status() === 201 && UUID.test(payload?.data?.id ?? "") && payload?.data?.brokerOrigin) {
          issuedSessions.push({ id: payload.data.id!, brokerOrigin: payload.data.brokerOrigin, issuedAtMs: Date.now() });
        }
      });
      page.on("websocket", socket => {
        if (!new URL(socket.url()).pathname.endsWith("/desktop/api/websockets")) return;
        const record = { socket, openedAt: Date.now(), closedAt: null as number | null, sent: 0, received: 0 };
        sockets.push(record);
        socket.on("framesent", () => { record.sent += 1; });
        socket.on("framereceived", () => { record.received += 1; });
        socket.on("close", () => { record.closedAt = Date.now(); });
      });

      await page.goto(`/dashboard/agent/${agentId}`, { waitUntil: "domcontentloaded" });
      expect(await page.evaluate(() => "VideoDecoder" in window), "Chromium must expose WebCodecs").toBe(true);
      const connectStarted = Date.now();
      await page.getByRole("button", { name: "Desktop", exact: true }).click();
      await expect(page.getByText("Desktop connected", { exact: true })).toBeVisible({ timeout: 90_000 });
      await expect.poll(() => issuedSessions.length, { timeout: 30_000 }).toBeGreaterThan(0);
      const firstSession = issuedSessions[0];
      evidence.firstConnectMs = Date.now() - connectStarted;
      evidence.brokerOrigin = firstSession.brokerOrigin;

      const decoded = await waitForDecodedSurface(page, firstSession.brokerOrigin);
      await expect.poll(() => sockets.reduce((sum, item) => sum + item.received, 0), { timeout: 30_000 }).toBeGreaterThan(0);
      evidence.decodedSurface = decoded.details;
      await page.screenshot({ path: testInfo.outputPath("desktop-connected.png"), fullPage: false });

      const rowsActive = await remoteDesktopAuditRows(env.supabaseUrl, env.supabaseServiceRoleKey, agentId);
      expect(rowsActive.sessions.find(row => row.id === firstSession.id)?.input_state).toBe("active");

      const conflicting = await page.evaluate(async ({ url, computerId }) => {
        const response = await fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            computerKind: "hivra-agent",
            computerId,
            purpose: "daily-driver",
            inputRole: "controller",
            requestedTransport: "selkies-websocket",
            client: { kind: "browser", moonlight: false, webCodecs: true, udp: "blocked" },
            pkceChallenge: "A".repeat(43),
            ttlSeconds: 60,
          }),
        });
        return { status: response.status, payload: await response.json().catch(() => null) };
      }, { url: `${env.baseUrl}/api/remote-desktop/sessions`, computerId: agentId });
      expect(conflicting.status).toBe(409);
      expect((conflicting.payload as { code?: string } | null)?.code).toBe("controller_conflict");

      const inputBefore = sockets.reduce((sum, item) => sum + item.sent, 0);
      // Selkies keeps decoder canvases in the DOM as hidden implementation
      // details. Real pointer/keyboard listeners are bound at the document
      // surface, so exercise the visible frame body instead of selecting the
      // first media node by DOM order.
      const inputTarget = decoded.frame.locator("body");
      await expect(inputTarget).toBeVisible({ timeout: 30_000 });
      await inputTarget.click({ position: { x: 120, y: 100 } });
      await page.keyboard.type(`hivra-${runId}`, { delay: 15 });
      await expect.poll(() => sockets.reduce((sum, item) => sum + item.sent, 0), { timeout: 10_000 }).toBeGreaterThan(inputBefore);
      evidence.inputWebSocketFrames = sockets.reduce((sum, item) => sum + item.sent, 0) - inputBefore;

      const socketsBeforeReconnect = sockets.length;
      const reconnectStarted = Date.now();
      await decoded.frame.goto(`${firstSession.brokerOrigin}/desktop/`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => sockets.length, { timeout: 10_000 }).toBeGreaterThan(socketsBeforeReconnect);
      await expect.poll(() => sockets.at(-1)?.received ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      evidence.reconnectMs = Date.now() - reconnectStarted;

      await revokeOwnerSession(page, env, firstSession.id);
      await expect.poll(() => sockets.filter(item => item.closedAt === null).length, { timeout: 15_000 }).toBe(0);
      await expect.poll(async () => {
        const rows = await remoteDesktopAuditRows(env.supabaseUrl, env.supabaseServiceRoleKey, agentId!);
        return rows.sessions.find(row => row.id === firstSession.id)?.input_state;
      }, { timeout: 15_000 }).toBe("released");

      const restartStarted = Date.now();
      evidence.restart = runGuestCommand("scripts/verify-remote-desktop-restart-canary.ts", agentId);
      evidence.restartMs = Date.now() - restartStarted;

      await page.getByRole("button", { name: "Chat", exact: true }).click();
      const secondConnectStarted = Date.now();
      await page.getByRole("button", { name: "Desktop", exact: true }).click();
      await expect.poll(() => issuedSessions.length, { timeout: 30_000 }).toBeGreaterThan(1);
      await expect(page.getByText("Desktop connected", { exact: true })).toBeVisible({ timeout: 90_000 });
      const secondSession = issuedSessions.at(-1)!;
      await waitForDecodedSurface(page, secondSession.brokerOrigin);
      evidence.postRestartConnectMs = Date.now() - secondConnectStarted;
      await page.screenshot({ path: testInfo.outputPath("desktop-after-restart.png"), fullPage: false });
      await revokeOwnerSession(page, env, secondSession.id);
      await expect.poll(async () => {
        const rows = await remoteDesktopAuditRows(env.supabaseUrl, env.supabaseServiceRoleKey, agentId!);
        return rows.sessions.find(row => row.id === secondSession.id)?.input_state;
      }, { timeout: 15_000 }).toBe("released");

      const unsafeUrls = brokerRequests.filter(raw => {
        const url = new URL(raw);
        return [...url.searchParams.keys()].some(key => /token|code|verifier|secret|credential|session|auth/i.test(key));
      });
      expect(unsafeUrls).toEqual([]);
      const desktopFrame = page.frames().find(frame => frame.url() === `${secondSession.brokerOrigin}/desktop/`);
      expect(desktopFrame?.url()).toMatch(/^https:\/\/[^/?#]+\/desktop\/$/);
      evidence.websocket = {
        opened: sockets.length,
        sent: sockets.reduce((sum, item) => sum + item.sent, 0),
        received: sockets.reduce((sum, item) => sum + item.received, 0),
        allClosedAfterOwnerRevoke: sockets.every(item => item.closedAt !== null),
      };
      evidence.urlSecretLeakCount = unsafeUrls.length;
      await page.close();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      let destroyed: string[] = [];
      let survived: Array<{ id: string; httpStatus: number; error?: string }> = [];
      if (context) {
        const result = await destroyAllHivraAgents(context.request, env.baseUrl).catch(error => {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
          return { destroyed: [], survived: [] };
        });
        destroyed = result.destroyed;
        survived = result.survived.map(item => ({ id: item.id, httpStatus: item.httpStatus, error: item.error }));
      } else if (agentId) cleanupErrors.push("No authenticated context remained for agent teardown.");

      let finalDesktop: Awaited<ReturnType<typeof remoteDesktopAuditRows>> | null = null;
      if (agentId) {
        finalDesktop = await remoteDesktopAuditRows(env.supabaseUrl, env.supabaseServiceRoleKey, agentId).catch(error => {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
          return null;
        });
        if (finalDesktop) {
          const now = Date.now();
          const activeCapabilities = finalDesktop.capabilities.filter(row => !row.revoked_at && Date.parse(String(row.expires_at)) > now);
          const liveSessions = finalDesktop.sessions.filter(row => !row.revoked_at && Date.parse(String(row.expires_at)) > now);
          if (activeCapabilities.length || liveSessions.length) cleanupErrors.push("Remote desktop authority survived computer deletion.");
        }
      }

      if (clerkUserId) {
        if (!await removeRemoteDesktopAuditPlan(env.supabaseUrl, env.supabaseServiceRoleKey, clerkUserId)) cleanupErrors.push("Audit plan row cleanup failed.");
        await removeRiskPreclear(env.supabaseUrl, env.supabaseServiceRoleKey, clerkUserId);
        if (survived.length === 0 && cleanupErrors.length === 0) {
          try { await deleteAuditUser(env.clerkSecretKey, clerkUserId); }
          catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
        }
      }
      await context?.close().catch(() => undefined);

      teardownComplete = survived.length === 0 && cleanupErrors.length === 0;
      evidence.finishedAt = new Date().toISOString();
      evidence.failure = failure;
      evidence.teardown = {
        destroyed,
        survived,
        cleanupErrors,
        clerkUserDeleted: teardownComplete,
        finalDesktop,
      };
      evidence.verdict = failure || !teardownComplete ? "fail" : "pass";
      mkdirSync(env.outDir, { recursive: true });
      const verdictPath = path.join(env.outDir, `run-${runId}.json`);
      writeFileSync(verdictPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      await testInfo.attach("remote-desktop-canary-verdict.json", { path: verdictPath, contentType: "application/json" });
      if (survived.length > 0 || cleanupErrors.length > 0) {
        throw new Error(`Remote desktop audit cleanup failed: ${JSON.stringify({ survived, cleanupErrors })}`);
      }
    }
  });
});
