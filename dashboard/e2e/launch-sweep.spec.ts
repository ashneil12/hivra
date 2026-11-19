/**
 * LAUNCH SWEEP: launch every agent and computer on Canary the way a new
 * customer does, and prove each one works.
 *
 * For each tile on Launch, in its own throwaway account:
 *   1. a new Clerk user on Canary's test instance, holding the Pro plan
 *      (the cheapest paid plan) so Hivra Cloud is offered;
 *   2. sign in, open /dashboard/launch, click the tile, Review, pick Hivra
 *      credits (the $2 starter credit every new paid account gets), Launch;
 *   3. wait on the after-launch screen until it says ready, press Open;
 *   4. ask the agent "What is 389 + 448?" in the box a customer types into
 *      and wait for 837 on screen (computers: their desktop or terminal opens);
 *   4b. on an agent using Hivra credits, turn on "private models only" the way
 *      its owner does and ask a second question, which must still be answered
 *      (LAUNCH_SWEEP_PRIVATE_ONLY=0 skips; not offered where the switch is off);
 *   5. close the tab and read what it uses idle for a few minutes, from the
 *      owner's own usage view (LAUNCH_SWEEP_IDLE_MINUTES, default 10, 0 skips);
 *   6. delete everything through the app's own delete route, then the account.
 *
 * Real infrastructure, real money (a Canary VM per target for ~10 min, and a
 * few cents of model use, capped by the account's $2 credit). Double-gated like
 * the first-run audit: the project only exists with LAUNCH_SWEEP=1, and every
 * test skips without it. Canary only: production hosts are refused.
 *
 * Run:   LAUNCH_SWEEP=1 CLERK_SECRET_KEY=sk_test_… LAUNCH_SWEEP_SUPABASE_URL=… \
 *        LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY=… npm run test:launch-sweep
 * One:   LAUNCH_SWEEP_ONLY=agent-zero,openclaw npm run test:launch-sweep
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

import { assertNotProduction, auditEmail, newRunId } from './first-run-audit/config';
import { createAuditUser, deleteAuditUser, mintSignInTicket } from './first-run-audit/clerk-admin';
import { destroyAllHivraAgents, destroyAllInstances, listHivraAgents, listInstances } from './first-run-audit/instances';
import { establishAuditSession } from './first-run-audit/session';
import { proveChat, proveComputerOpen } from './launch-sweep/chat';
import { measureIdle } from './launch-sweep/idle';
import { checkPrivateOnly, privateOnlyCheckEnabled } from './launch-sweep/private-only';
import { launchFromTile, offeredTileNames, openFromLaunch, waitForReady } from './launch-sweep/journey';
import { agentEvidence, agentsStillOnRecord, grantSweepPlan, removeSweepPlan } from './launch-sweep/plan';
import { SweepFailure, SweepRecorder } from './launch-sweep/result';
import { OWN_SERVER_ONLY_TILES, SWEEP_TARGETS, selectedTargets, type SweepTarget } from './launch-sweep/targets';

const ENABLED = process.env.LAUNCH_SWEEP === '1';

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

interface SweepEnv {
  baseUrl: string;
  clerkSecretKey: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  outDir: string;
  runId: string;
  readyTimeoutMs: number;
  composerTimeoutMs: number;
  replyTimeoutMs: number;
  keepFailed: boolean;
  idleMinutes: number;
  /** Profile ids to keep running after a pass, to read inside them (reap later). */
  keepPassed: string[];
}

function sweepEnv(): SweepEnv {
  const baseUrl = (process.env.LAUNCH_SWEEP_BASE_URL || process.env.E2E_BASE_URL || 'https://canary.hermesos.cloud').replace(/\/$/, '');
  assertNotProduction(baseUrl);
  const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim() ?? '';
  if (!clerkSecretKey.startsWith('sk_test_')) {
    throw new Error('[launch-sweep] CLERK_SECRET_KEY must be the Canary test key (sk_test_…). A live key is refused.');
  }
  const supabaseUrl = process.env.LAUNCH_SWEEP_SUPABASE_URL?.trim() ?? '';
  const serviceRoleKey = process.env.LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[launch-sweep] LAUNCH_SWEEP_SUPABASE_URL and LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY (Canary) are required to give the test account its plan.');
  }
  return {
    baseUrl,
    clerkSecretKey,
    supabaseUrl,
    serviceRoleKey,
    outDir: process.env.LAUNCH_SWEEP_OUT_DIR?.trim() || 'e2e/.launch-sweep',
    // One id for the whole run, shared by every worker through the env.
    runId: process.env.LAUNCH_SWEEP_RUN_ID?.trim() || newRunId(),
    readyTimeoutMs: envInt('LAUNCH_SWEEP_READY_TIMEOUT_MS', 25 * 60_000),
    composerTimeoutMs: envInt('LAUNCH_SWEEP_COMPOSER_TIMEOUT_MS', 6 * 60_000),
    replyTimeoutMs: envInt('LAUNCH_SWEEP_REPLY_TIMEOUT_MS', 4 * 60_000),
    // Keep a failed launch's computer and account so its logs can be read.
    // The cleanup script reaps it later (npm run audit:first-run:cleanup).
    keepFailed: process.env.LAUNCH_SWEEP_KEEP_FAILED === '1',
    // How long to watch each working agent sit idle (0 skips).
    idleMinutes: envMinutes('LAUNCH_SWEEP_IDLE_MINUTES', 10),
    keepPassed: (process.env.LAUNCH_SWEEP_KEEP_PASSED ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  };
}

async function screenshot(page: Page | null, recorder: SweepRecorder, outDir: string, label: string): Promise<void> {
  if (!page || page.isClosed()) return;
  const file = path.join(outDir, `${recorder.result.runId}-${recorder.result.profileId}-${label}.png`);
  // Bring the first visible problem on screen, so the picture shows why.
  await page.locator('[role="alert"]').first().scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
  await page.screenshot({ path: file, fullPage: false }).then(
    () => recorder.result.screenshots.push(path.basename(file)),
    () => undefined,
  );
}

async function signedInContext(browser: Browser, env: SweepEnv, userId: string): Promise<BrowserContext> {
  const ticket = await mintSignInTicket(env.clerkSecretKey, userId);
  const context = await establishAuditSession(browser, { baseUrl: env.baseUrl, ticket });
  context.setDefaultTimeout(30_000);
  return context;
}

/** Delete everything the account owns, then the account. Never throws. */
async function teardown(
  context: BrowserContext | null,
  page: Page | null,
  env: SweepEnv,
  userId: string,
  recorder: SweepRecorder,
): Promise<void> {
  const record = { agentsLeft: 0, instancesLeft: 0, accountDeleted: false, error: undefined as string | undefined };
  try {
    if (context) {
      // Clerk's session token lasts about a minute and only a live page
      // renews it. After a long idle, open a Hivra page first so the delete
      // calls are signed in (an expired one reads as "nothing to delete").
      await page?.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page?.waitForTimeout(3_000).catch(() => undefined);
      const agents = await destroyAllHivraAgents(context.request, env.baseUrl, 30, 15_000);
      const instances = await destroyAllInstances(context.request, env.baseUrl, `launch sweep ${env.runId}`);
      record.agentsLeft = agents.survived.length;
      record.instancesLeft = instances.survived.length;
    }
    // Trust Canary's records over the app's list: anything not deleted there
    // is still a computer someone pays for.
    const onRecord = await agentsStillOnRecord(env.supabaseUrl, env.serviceRoleKey, userId);
    if (onRecord === null) {
      record.error = 'could not read the agent records to confirm the delete';
      record.agentsLeft = Math.max(record.agentsLeft, 1);
    } else if (onRecord.length > 0) {
      record.agentsLeft = Math.max(record.agentsLeft, onRecord.length);
      record.error = `still on record: ${onRecord.map((row) => `${row.id} (${row.status}, VM ${row.vmid ?? '?'})`).join(', ')}`;
    }
    await removeSweepPlan(env.supabaseUrl, env.serviceRoleKey, userId);
    // Keep the account if anything survived: without it nothing can sign in
    // to finish the delete through the app's own route.
    if (record.agentsLeft === 0 && record.instancesLeft === 0) {
      record.accountDeleted = await deleteAuditUser(env.clerkSecretKey, userId).catch(() => false);
    }
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
  }
  recorder.result.teardown = record;
}

test.describe.configure({ mode: 'parallel' });

test.describe('launch sweep', () => {
  test.skip(!ENABLED, 'LAUNCH_SWEEP=1 is required: this launches real computers.');

  test('every tile Launch offers is covered by the sweep', async ({ browser }) => {
    const env = sweepEnv();
    const user = await createAuditUser(env.clerkSecretKey, auditEmail(`sweep-tiles-${env.runId}`, 'hermesos.cloud'));
    let context: BrowserContext | null = null;
    try {
      await grantSweepPlan(env.supabaseUrl, env.serviceRoleKey, user.id);
      context = await signedInContext(browser, env, user.id);
      const page = await context.newPage();
      const offered = await offeredTileNames(page);
      const known = new Set([...SWEEP_TARGETS.map((target) => target.tile), ...OWN_SERVER_ONLY_TILES]);
      const uncovered = offered.filter((name) => !known.has(name));
      expect(uncovered, `Launch offers tiles the sweep doesn't test. Add them to e2e/launch-sweep/targets.ts`).toEqual([]);
    } finally {
      await context?.close().catch(() => undefined);
      await removeSweepPlan(env.supabaseUrl, env.serviceRoleKey, user.id);
      await deleteAuditUser(env.clerkSecretKey, user.id).catch(() => undefined);
    }
  });

  for (const target of selectedTargets()) {
    test(`${target.tile} launches and answers`, async ({ browser }, testInfo) => {
      testInfo.setTimeout(envInt('LAUNCH_SWEEP_TEST_TIMEOUT_MS', 60 * 60_000));
      const env = sweepEnv();
      await runTarget(browser, env, target);
    });
  }
});

async function runTarget(browser: Browser, env: SweepEnv, target: SweepTarget): Promise<void> {
  const recorder = new SweepRecorder({
    runId: env.runId,
    baseUrl: env.baseUrl,
    profileId: target.profileId,
    tile: target.tile,
    kind: target.kind,
    knownBroken: target.knownBroken,
  });
  let userId: string | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let stage: SweepFailure['stage'] = 'account';

  try {
    const user = await createAuditUser(env.clerkSecretKey, auditEmail(`sweep-${target.profileId}-${env.runId}`, 'hermesos.cloud'));
    userId = user.id;
    await grantSweepPlan(env.supabaseUrl, env.serviceRoleKey, user.id);
    context = await signedInContext(browser, env, user.id);
    page = await context.newPage();
    recorder.done('account');

    stage = 'choose';
    await launchFromTile(page, target);
    recorder.done('launch');

    stage = 'ready';
    const outcome = await waitForReady(page, context.request, env.baseUrl, target, env.readyTimeoutMs);
    recorder.result.agentId = outcome.agentId;
    recorder.done('ready');

    stage = 'open';
    await openFromLaunch(page);
    recorder.done('open');

    stage = 'chat';
    const proof = target.proof === 'computer-open'
      ? await proveComputerOpen(page, env.readyTimeoutMs)
      : await proveChat(page, target, { composerTimeoutMs: env.composerTimeoutMs, replyTimeoutMs: env.replyTimeoutMs });
    recorder.result.chat = proof;
    recorder.done('chat');
    recorder.result.passed = true;
    await screenshot(page, recorder, env.outDir, 'pass');

    if (target.proof !== 'computer-open' && privateOnlyCheckEnabled() && recorder.result.agentId) {
      stage = 'private';
      // Its own result: the launch above has already passed either way.
      recorder.result.privateOnly = await checkPrivateOnly(page, context.request, env.baseUrl, recorder.result.agentId, target, {
        composerTimeoutMs: env.composerTimeoutMs,
        replyTimeoutMs: env.replyTimeoutMs,
      }).catch((err: unknown) => ({ state: 'failed' as const, reason: err instanceof Error ? err.message : String(err) }));
      recorder.done('private');
    }

    if (env.idleMinutes > 0) {
      stage = 'idle';
      // Walk away like a customer: leave the agent for the dashboard home,
      // which keeps the sign-in fresh for the usage reads.
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      const idleId = recorder.result.agentId
        ?? (await listHivraAgents(context.request, env.baseUrl).catch(() => []))[0]?.id
        ?? null;
      if (idleId) {
        recorder.result.idle = await measureIdle(page, idleId, env.idleMinutes);
      }
      recorder.done('idle');
    }
  } catch (err) {
    recorder.fail(err, stage);
    await screenshot(page, recorder, env.outDir, 'fail');
  } finally {
    if (!recorder.result.agentId && context) {
      recorder.result.agentId = (await listHivraAgents(context.request, env.baseUrl).catch(() => []))[0]?.id
        ?? (await listInstances(context.request, env.baseUrl).catch(() => []))[0]?.id
        ?? null;
    }
    if (!recorder.result.passed && recorder.result.agentId) {
      recorder.result.evidence = await agentEvidence(env.supabaseUrl, env.serviceRoleKey, recorder.result.agentId);
    }
    const keep = (env.keepFailed && !recorder.result.passed && recorder.result.failure?.category === 'product')
      || (recorder.result.passed && env.keepPassed.includes(target.profileId));
    if (userId && !keep) {
      await teardown(context, page, env, userId, recorder);
      recorder.done('teardown');
    }
    await context?.close().catch(() => undefined);
    const file = recorder.write(env.outDir);
    // eslint-disable-next-line no-console -- the run's one line per target
    console.log(`[launch-sweep] ${target.tile}: ${recorder.result.passed ? 'PASS' : `FAIL at ${recorder.result.failure?.stage}: ${recorder.result.failure?.reason}`}${recorder.result.privateOnly ? `; private models only: ${recorder.result.privateOnly.state}` : ''} (${file})`);
  }

  const { failure, teardown: torn } = recorder.result;
  if (torn && (torn.agentsLeft > 0 || torn.instancesLeft > 0)) {
    throw new Error(`[launch-sweep] ${target.tile}: teardown left ${torn.agentsLeft} agent(s) and ${torn.instancesLeft} instance(s) running.`);
  }
  if (failure?.category === 'not_offered') test.skip(true, failure.reason);
  if (failure && target.knownBroken) {
    test.info().annotations.push({ type: 'known broken', description: `${target.knownBroken} Now: ${failure.reason}` });
    return;
  }
  if (failure) throw new Error(`${target.tile} failed at "${failure.stage}" (${failure.category}): ${failure.reason}`);
  const privateOnly = recorder.result.privateOnly;
  if (privateOnly?.state === 'failed') {
    test.info().annotations.push({ type: 'private models only failed', description: privateOnly.reason });
  }
}
