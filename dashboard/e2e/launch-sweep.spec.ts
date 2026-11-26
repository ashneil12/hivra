/**
 * Launch and prove every Canary tile with a preconfigured paid QA account.
 * Each test names and removes only its own work. The catalog certifier uses a
 * separate standing fixture that must start and finish empty.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { assertCanaryQaSupabaseUrl, readCanaryQaEmail } from './canary-qa/config';
import { auditAgentName, newRunId } from './first-run-audit/config';
import { assertUnusedRunId, destroyRunResources, listHivraAgents, listInstances, runInventory } from './first-run-audit/instances';
import { establishAuditSession, verifyAuditSession } from './first-run-audit/session';
import { proveAppOpen, proveRustpadCollaboration } from './launch-sweep/app-open';
import { proveChat, proveComputerOpen } from './launch-sweep/chat';
import { measureIdle } from './launch-sweep/idle';
import { checkPrivateOnly, privateOnlyCheckEnabled } from './launch-sweep/private-only';
import { readSweepSoftware } from './launch-sweep/software';
import { certificationEmail } from './launch-sweep/standing-account';
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from '../src/lib/infrastructure/portable-provisioner-contract';
import { launchFromTile, offeredTileNames, openFromLaunch, waitForReady } from './launch-sweep/journey';
import { agentEvidence, agentsStillOnRecord } from './launch-sweep/plan';
import { SweepFailure, SweepRecorder } from './launch-sweep/result';
import { OWN_SERVER_ONLY_TILES, SWEEP_TARGETS, selectedTargets, type SweepTarget } from './launch-sweep/targets';

const ENABLED = process.env.LAUNCH_SWEEP === '1';
const targets = selectedTargets();

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
  supabaseUrl: string;
  serviceRoleKey: string;
  outDir: string;
  checkoutSha?: string;
  expectedCanarySha?: string;
  runId: string;
  readyTimeoutMs: number;
  composerTimeoutMs: number;
  replyTimeoutMs: number;
  idleMinutes: number;
  email: string;
  certification: boolean;
}

function checkoutSha(): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function sweepEnv(): SweepEnv {
  const baseUrl = (process.env.LAUNCH_SWEEP_BASE_URL || process.env.E2E_BASE_URL || 'https://canary.hermesos.cloud').replace(/\/$/, '');
  const certEmail = certificationEmail(process.env, targets, baseUrl);
  const supabaseUrl = assertCanaryQaSupabaseUrl(process.env.LAUNCH_SWEEP_SUPABASE_URL?.trim());
  const serviceRoleKey = process.env.LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
  if (!serviceRoleKey) throw new Error('[launch-sweep] Canary service role key is required for launch evidence.');
  const expectedCanarySha = process.env.LAUNCH_SWEEP_CANARY_SHA?.trim() || undefined;
  if (expectedCanarySha && !/^[0-9a-f]{40}$/.test(expectedCanarySha)) {
    throw new Error('[launch-sweep] LAUNCH_SWEEP_CANARY_SHA must be the full lowercase merge-commit SHA verified as served by Canary.');
  }
  return {
    baseUrl,
    supabaseUrl,
    serviceRoleKey,
    outDir: process.env.LAUNCH_SWEEP_OUT_DIR?.trim() || 'e2e/.launch-sweep',
    checkoutSha: checkoutSha(),
    expectedCanarySha,
    // One id for the whole run, shared by every worker through the env.
    runId: process.env.LAUNCH_SWEEP_RUN_ID?.trim() || newRunId(),
    readyTimeoutMs: envInt('LAUNCH_SWEEP_READY_TIMEOUT_MS', 25 * 60_000),
    composerTimeoutMs: envInt('LAUNCH_SWEEP_COMPOSER_TIMEOUT_MS', 6 * 60_000),
    replyTimeoutMs: envInt('LAUNCH_SWEEP_REPLY_TIMEOUT_MS', 4 * 60_000),
    idleMinutes: envMinutes('LAUNCH_SWEEP_IDLE_MINUTES', 10),
    email: certEmail ?? readCanaryQaEmail(),
    certification: Boolean(certEmail),
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

test.describe.configure({ mode: 'serial' });

test.describe('launch sweep', () => {
  test.skip(!ENABLED, 'LAUNCH_SWEEP=1 is required: this launches real computers.');

  test('every tile Launch offers is covered by the sweep', async ({ browser }) => {
    test.skip(process.env.LAUNCH_SWEEP_CERTIFICATION === '1', 'Certification runs exactly one target.');
    const env = sweepEnv();
    const { context, page } = await establishAuditSession(browser, env);
    try {
      const offered = await offeredTileNames(page);
      const known = new Set([...SWEEP_TARGETS.map((target) => target.tile), ...OWN_SERVER_ONLY_TILES]);
      const uncovered = offered.filter((name) => !known.has(name));
      expect(uncovered, `Launch offers tiles the sweep doesn't test. Add them to e2e/launch-sweep/targets.ts`).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const target of targets) {
    test(`${target.tile} launches and answers`, async ({ browser }, testInfo) => {
      testInfo.setTimeout(envInt('LAUNCH_SWEEP_TEST_TIMEOUT_MS', 60 * 60_000));
      const env = sweepEnv();
      await runTarget(browser, env, target);
    });
  }
});

async function runTarget(browser: Browser, env: SweepEnv, target: SweepTarget): Promise<void> {
  const resourceRunId = newRunId();
  console.log(`[launch-sweep] ${target.tile}: resource run ${resourceRunId}`);
  const recorder = new SweepRecorder({
    runId: env.runId,
    resourceRunId,
    baseUrl: env.baseUrl,
    profileId: target.profileId,
    tile: target.tile,
    kind: target.kind,
    knownBroken: target.knownBroken,
    catalog: target.catalog,
    checkoutSha: env.checkoutSha,
    expectedCanarySha: env.expectedCanarySha,
    expectedProvisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
  });
  let session: Awaited<ReturnType<typeof establishAuditSession>> | undefined;
  let launchAttempted = false;
  let stage: SweepFailure['stage'] = 'account';

  try {
    session = await establishAuditSession(browser, env);
    const { context, page, userId } = session;
    context.setDefaultTimeout(30_000);
    await assertUnusedRunId(context.request, env.baseUrl, resourceRunId);
    if (env.certification) {
      const [listed, onRecord, instances] = await Promise.all([
        listHivraAgents(context.request, env.baseUrl, true),
        agentsStillOnRecord(env.supabaseUrl, env.serviceRoleKey, userId),
        listInstances(context.request, env.baseUrl, true),
      ]);
      if (!onRecord || listed.length || onRecord.length || instances.length) {
        throw new Error('Certification requires a verified empty standing fixture.');
      }
    }
    recorder.done('account');

    stage = 'choose';
    await launchFromTile(page, target, resourceRunId, () => { launchAttempted = true; });
    recorder.done('launch');

    stage = 'ready';
    const outcome = await waitForReady(page, context.request, env.baseUrl, target, env.readyTimeoutMs, resourceRunId);
    recorder.result.agentId = outcome.agentId;
    recorder.done('ready');

    stage = 'open';
    await openFromLaunch(page);
    recorder.done('open');

    stage = 'chat';
    const proof = target.proof === 'computer-open'
      ? await proveComputerOpen(page, env.readyTimeoutMs)
      : target.proof === 'app-open'
        ? target.profileId === 'rustpad'
          ? await proveRustpadCollaboration(page, env.composerTimeoutMs)
          : await proveAppOpen(page, target, env.composerTimeoutMs)
        : await proveChat(page, target, { composerTimeoutMs: env.composerTimeoutMs, replyTimeoutMs: env.replyTimeoutMs });
    recorder.result.chat = proof;
    if (recorder.result.agentId) {
      recorder.result.software = await readSweepSoftware(context.request, env.baseUrl, recorder.result.agentId);
    }
    const pinnedDigest = target.catalog?.runtimeRefs
      .map(ref => /@(sha256:[a-f0-9]{64})$/.exec(ref)?.[1]).find(Boolean);
    if (pinnedDigest && recorder.result.software?.installed !== pinnedDigest) {
      throw new SweepFailure('chat', 'product', 'The installed image digest did not match the reviewed catalog pin.');
    }
    recorder.done('chat');
    recorder.result.passed = true;
    await screenshot(page, recorder, env.outDir, 'pass');

    if (target.proof !== 'computer-open' && target.proof !== 'app-open' && privateOnlyCheckEnabled() && recorder.result.agentId) {
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
      const idleId = recorder.result.agentId;
      if (idleId) {
        recorder.result.idle = await measureIdle(page, idleId, env.idleMinutes);
      }
      recorder.done('idle');
    }
  } catch (err) {
    recorder.fail(stage === 'account'
      ? new SweepFailure('account', 'harness_environment', 'Standing account setup or inventory verification failed')
      : err, stage);
    if (stage !== 'account') await screenshot(session?.page ?? null, recorder, env.outDir, 'fail');
  } finally {
    if (session && launchAttempted) {
      const { page, context, userId } = session;
      try {
        await verifyAuditSession(page, env.baseUrl, userId);
        const { agents, instances } = await runInventory(context.request, env.baseUrl, resourceRunId);
        recorder.result.agentId ??= agents[0]?.id ?? instances[0]?.id ?? null;
        if (!recorder.result.passed && recorder.result.agentId) {
          recorder.result.evidence = await agentEvidence(env.supabaseUrl, env.serviceRoleKey, recorder.result.agentId);
        }
        const result = await destroyRunResources(context.request, env.baseUrl, resourceRunId);
        const onRecord = await agentsStillOnRecord(env.supabaseUrl, env.serviceRoleKey, userId,
          env.certification ? undefined : auditAgentName(resourceRunId));
        if (!onRecord) throw new Error('Could not verify Canary agent records');
        const record = {
          agentsLeft: onRecord.length,
          instancesLeft: result.survived.length,
          accountDeleted: false,
        };
        if (env.certification) {
          const [listed, remainingInstances] = await Promise.all([
            listHivraAgents(context.request, env.baseUrl, true),
            listInstances(context.request, env.baseUrl, true),
          ]);
          record.agentsLeft = Math.max(record.agentsLeft, listed.length);
          record.instancesLeft = Math.max(record.instancesLeft, remainingInstances.length);
        }
        recorder.result.teardown = record;
      } catch {
        recorder.result.teardown = { agentsLeft: 0, instancesLeft: 0, accountDeleted: false, error: 'Run-owned cleanup could not be verified' };
      }
      recorder.done('teardown');
    }
    await session?.context.close().catch(() => undefined);
    const file = recorder.write(env.outDir);
    // eslint-disable-next-line no-console -- the run's one line per target
    console.log(`[launch-sweep] ${target.tile}: ${recorder.result.passed ? 'PASS' : `FAIL at ${recorder.result.failure?.stage}: ${recorder.result.failure?.reason}`}${recorder.result.privateOnly ? `; private models only: ${recorder.result.privateOnly.state}` : ''} (${file})`);
  }

  const { failure, teardown: torn } = recorder.result;
  if (torn?.error) throw new Error(`${torn.error}; inspect run ${resourceRunId}.`);
  if (torn && (torn.agentsLeft > 0 || torn.instancesLeft > 0)) {
    throw new Error(`[launch-sweep] ${target.tile}: teardown left ${torn.agentsLeft} agent(s) and ${torn.instancesLeft} instance(s) running (resource run ${resourceRunId}).`);
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
