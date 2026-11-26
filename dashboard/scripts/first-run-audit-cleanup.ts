/**
 * Recover the exact named resource from a stopped audit run, never the account.
 * Use the same standing account as that run; --dry-run only reads inventory.
 */
import { chromium } from '@playwright/test';
import { readCanaryQaEmail } from '../e2e/canary-qa/config';
import { assertLiveManagedHostingAuditAllowed, auditAgentName, loadAuditConfig } from '../e2e/first-run-audit/config';
import { destroyRunResources, runInventory } from '../e2e/first-run-audit/instances';
import { establishAuditSession } from '../e2e/first-run-audit/session';
import { browserLaunchOptions } from './lib/playwright-launch.cjs';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const run = args.filter((arg) => arg.startsWith('--run-id='));
  if (run.length !== 1 || args.some((arg) => arg !== run[0] && arg !== '--dry-run')) {
    throw new Error('Usage: npm run audit:first-run:cleanup -- --run-id=<eight hex characters> [--dry-run]');
  }
  const runId = run[0].slice('--run-id='.length);
  auditAgentName(runId);
  assertLiveManagedHostingAuditAllowed();
  const { baseUrl } = loadAuditConfig();
  const email = readCanaryQaEmail();
  const launch = browserLaunchOptions();
  const browser = await chromium.launch(launch);
  try {
    const { context } = await establishAuditSession(browser, { baseUrl, email });
    if (args.includes('--dry-run')) {
      const { agents, instances } = await runInventory(context.request, baseUrl, runId);
      console.log(`[cleanup] run=${runId}: ${agents.length + instances.length} matching resource(s); no deletes issued.`);
      return;
    }
    const { destroyed, survived } = await destroyRunResources(context.request, baseUrl, runId);
    if (survived.length) throw new Error('The exact run-owned resource is still listed');
    console.log(`[cleanup] run=${runId}: removed ${destroyed.length} resource(s); none remain listed.`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error('[cleanup] fatal:', err instanceof Error ? err.message : 'Unknown error');
  process.exitCode = 1;
});
