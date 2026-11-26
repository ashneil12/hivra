import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import { assertCanaryQaSupabaseUrl, readCanaryQaEmail } from '../canary-qa/config';
import { findAuditUserByEmail } from '../first-run-audit/clerk-admin';
import { destroyAllHivraAgents, listHivraAgents, listInstances } from '../first-run-audit/instances';
import { establishAuditSession } from '../first-run-audit/session';
import { agentsStillOnRecord } from './plan';
import type { SweepTarget } from './targets';

type AccountEnv = { baseUrl: string; clerkSecretKey: string; supabaseUrl: string; serviceRoleKey: string };

export function certificationEmail(env: NodeJS.ProcessEnv, targets: SweepTarget[], baseUrl: string): string | undefined {
  if (env.LAUNCH_SWEEP_CERTIFICATION !== '1') return undefined;
  if (baseUrl !== 'https://canary.hermesos.cloud' || targets.length !== 1 || !targets[0].catalog) {
    throw new Error('[launch-sweep] certification requires exactly one catalog target on public Canary');
  }
  if (env.LAUNCH_SWEEP_KEEP_FAILED === '1' || env.LAUNCH_SWEEP_KEEP_PASSED?.trim()) {
    throw new Error('[launch-sweep] certification cannot leave computers running');
  }
  return readCanaryQaEmail({ CANARY_QA_EMAIL: env.CERTIFICATION_ACCOUNT_EMAIL });
}

export async function openCertificationAccount(
  browser: Browser,
  env: AccountEnv,
  email: string,
  onContext: (context: BrowserContext) => void,
): Promise<{ page: Page; userId: string }> {
  assertCanaryQaSupabaseUrl(env.supabaseUrl);
  const user = await findAuditUserByEmail(env.clerkSecretKey, email);
  if (!user) throw new Error('[launch-sweep] standing certification account does not exist');

  let context: BrowserContext;
  try {
    context = await establishAuditSession(browser, { baseUrl: env.baseUrl, email, onContext });
  } catch {
    throw new Error('[launch-sweep] standing certification account could not sign in with Clerk email code');
  }
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((id) => {
    const clerk = (window as unknown as { Clerk?: { user?: { id?: string } } }).Clerk;
    return clerk?.user?.id === id;
  }, user.id, { timeout: 30_000 }).catch(() => {
    throw new Error('[launch-sweep] could not verify the signed-in certification identity');
  });

  const inventory = await certificationInventory(context.request, env, user.id);
  if (inventory.agentsLeft || inventory.instancesLeft) {
    throw new Error('[launch-sweep] certification account is not empty; refusing to launch or delete existing computers');
  }
  return { page, userId: user.id };
}

async function certificationInventory(request: APIRequestContext, env: AccountEnv, userId: string) {
  const [listed, onRecord, instances] = await Promise.all([
    listHivraAgents(request, env.baseUrl, true),
    agentsStillOnRecord(env.supabaseUrl, env.serviceRoleKey, userId),
    listInstances(request, env.baseUrl, true),
  ]);
  if (!onRecord) throw new Error('[launch-sweep] could not verify certification inventory in Canary records');
  return {
    agentsLeft: new Set([...listed, ...onRecord].map(({ id }) => id)).size,
    instancesLeft: instances.length,
  };
}

export async function cleanCertificationLaunch(page: Page, env: AccountEnv, userId: string) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(
    (window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session,
  ), undefined, { timeout: 30_000 });
  await destroyAllHivraAgents(page.context().request, env.baseUrl, 30, 15_000, { verifyDisappearance: true });
  return certificationInventory(page.context().request, env, userId);
}
