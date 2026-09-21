/**
 * first-run-audit-cleanup — reap orphaned audit accounts and their instances.
 *
 * A crashed audit run, a killed CI job, or a Playwright timeout can leave a
 * synthetic account owning a REAL, BILLING Proxmox VM. That is exactly the orphan
 * class the fleet just spent a day cleaning up, and this harness must not be a
 * new source of it. Run this after any audit campaign; the CI workflow runs it
 * unconditionally with `if: always()`.
 *
 * Safe by construction:
 *   - only ever touches accounts whose email begins `firstrun-audit-`
 *   - refuses any target that is not a canary host
 *   - skips accounts younger than --min-age-minutes (default 30) so it cannot
 *     reap a run that is still in flight
 *   - destroys through the app's own confirm-gated DELETE /api/instances/[id],
 *     which refuses to mark a row deleted unless the VM actually went away
 *   - keeps the Clerk user whenever an instance survives, so a later pass can
 *     still authenticate and finish the job
 *
 * Usage:
 *   npm run audit:first-run:cleanup                    # reap, min age 30m
 *   npm run audit:first-run:cleanup -- --dry-run       # list, touch nothing
 *   npm run audit:first-run:cleanup -- --min-age-minutes=0
 *   npm run audit:first-run:cleanup -- --run-id=ab12cd34
 *
 * Exits non-zero if anything leaked, so CI goes red on an un-reaped VM.
 */
import { assertNotProduction } from '../e2e/first-run-audit/config';
import { reapAuditAccounts } from '../e2e/first-run-audit/reaper';

interface Args {
  dryRun: boolean;
  minAgeMinutes: number;
  runId?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, minAgeMinutes: 30 };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--min-age-minutes=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value >= 0) args.minAgeMinutes = value;
    } else if (arg.startsWith('--run-id=')) {
      args.runId = arg.split('=')[1];
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const baseUrl = (
    process.env.FIRST_RUN_AUDIT_BASE_URL ||
    process.env.E2E_BASE_URL ||
    'https://canary.hermesos.cloud'
  ).replace(/\/$/, '');
  assertNotProduction(baseUrl);

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) throw new Error('CLERK_SECRET_KEY (canary) is required.');
  if (clerkSecretKey.startsWith('sk_live_')) {
    throw new Error('refusing to run the reaper against a LIVE Clerk instance.');
  }

  console.log(
    `[cleanup] target=${baseUrl} min-age=${args.minAgeMinutes}m` +
      `${args.runId ? ` run-id=${args.runId}` : ''}${args.dryRun ? ' (dry run)' : ''}`,
  );

  const report = await reapAuditAccounts({
    clerkSecretKey,
    baseUrl,
    minAgeMs: args.minAgeMinutes * 60_000,
    onlyRunId: args.runId,
    dryRun: args.dryRun,
  });

  console.log(`[cleanup] audit accounts found=${report.found} eligible=${report.eligible}`);

  if (report.eligible === 0) {
    console.log('[cleanup] nothing to reap — clean.');
    return;
  }

  if (report.dryRun) {
    console.log('[cleanup] dry run — would reap:');
    for (const account of report.eligibleAccounts) {
      console.log(`[cleanup]   ${account.email ?? account.userId} (${account.userId})`);
    }
    console.log('[cleanup] nothing was touched.');
    return;
  }

  for (const account of report.reaped) {
    const destroyed = account.instancesDestroyed.length;
    const survived = account.instancesSurvived.length;
    const hivraDestroyed = account.hivraAgentsDestroyed.length;
    const hivraSurvived = account.hivraAgentsSurvived.length;
    const status = account.error
      ? `ERROR ${account.error}`
      : `instances_destroyed=${destroyed} instances_survived=${survived} ` +
        `hivra_destroyed=${hivraDestroyed} hivra_survived=${hivraSurvived} ` +
        `clerk_deleted=${account.clerkUserDeleted}`;
    console.log(`[cleanup] ${account.email ?? account.userId}: ${status}`);
    for (const survivor of account.instancesSurvived) {
      console.error(
        `[cleanup]   !! LEAKED instance ${survivor.id} (HTTP ${survivor.httpStatus}) ${survivor.error ?? ''}`,
      );
    }
    for (const survivor of account.hivraAgentsSurvived) {
      console.error(
        `[cleanup]   !! LEAKED Hivra agent ${survivor.id} (HTTP ${survivor.httpStatus}) ${survivor.error ?? ''}`,
      );
    }
  }

  if (report.leaked) {
    console.error(
      '\n[cleanup] LEAK DETECTED. Instances survived teardown and are still billing.\n' +
        '          Their Clerk users were retained so this script can retry.\n' +
        '          Re-run, then inspect the configured host directly with qm list.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('[cleanup] all audit accounts reaped cleanly.');
}

main().catch((err: unknown) => {
  console.error('[cleanup] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
