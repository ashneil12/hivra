/**
 * The reaper. Finds audit accounts and destroys everything they own.
 *
 * Shared by two callers, on purpose — one implementation, both safety nets:
 *   1. first-run-audit.spec.ts `afterAll`  — catches a Playwright *timeout*,
 *      which aborts the test body and can skip its `finally`.
 *   2. scripts/first-run-audit-cleanup.ts  — catches a crashed process, a killed
 *      CI job, or a run that gave up with instances still standing.
 *
 * It destroys through the app's own `DELETE /api/instances/[id]`, authenticating
 * as the audit user via a fresh Clerk sign-in ticket. That route refuses to mark
 * a row deleted unless the hypervisor teardown actually succeeded, which is the
 * property we want from a reaper.
 */
import { chromium } from '@playwright/test';

import { isAuditEmail } from './config';
import { deleteAuditUser, listAuditUsers, mintSignInTicket, type ClerkUser } from './clerk-admin';
import { destroyAllHivraAgents, destroyAllInstances } from './instances';
import { establishAuditSession } from './session';

export interface ReapOptions {
  clerkSecretKey: string;
  baseUrl: string;
  /**
   * Never touch accounts younger than this — an in-flight run's user must not be
   * reaped out from under it. Ignored when `onlyRunId` is set.
   */
  minAgeMs: number;
  /** Scope to a single run (the spec's own afterAll net). */
  onlyRunId?: string;
  dryRun?: boolean;
}

export interface ReapedAccount {
  userId: string;
  email: string | null;
  instancesDestroyed: string[];
  instancesSurvived: Array<{ id: string; httpStatus: number; error?: string }>;
  hivraAgentsDestroyed: string[];
  hivraAgentsSurvived: Array<{ id: string; httpStatus: number; error?: string }>;
  clerkUserDeleted: boolean;
  error?: string;
}

export interface ReapReport {
  /** Audit-named accounts present in the Clerk instance (not all users). */
  found: number;
  /** Of those, how many passed the age / run-id filter. */
  eligible: number;
  /** Identities that WOULD be reaped. Populated on dry runs too. */
  eligibleAccounts: Array<{ userId: string; email: string | null }>;
  dryRun: boolean;
  reaped: ReapedAccount[];
  /** True when anything at all survived — the caller should exit non-zero. */
  leaked: boolean;
}

function eligible(user: ClerkUser, opts: ReapOptions): boolean {
  if (!isAuditEmail(user.email)) return false;
  if (opts.onlyRunId) return user.email?.includes(opts.onlyRunId) ?? false;
  return Date.now() - user.createdAtMs >= opts.minAgeMs;
}

export async function reapAuditAccounts(opts: ReapOptions): Promise<ReapReport> {
  const all = await listAuditUsers(opts.clerkSecretKey, isAuditEmail);
  const targets = all.filter((u) => eligible(u, opts));

  const report: ReapReport = {
    found: all.length,
    eligible: targets.length,
    eligibleAccounts: targets.map((u) => ({ userId: u.id, email: u.email })),
    dryRun: Boolean(opts.dryRun),
    reaped: [],
    leaked: false,
  };

  if (targets.length === 0 || opts.dryRun) return report;

  const browser = await chromium.launch();
  try {
    for (const user of targets) {
      const entry: ReapedAccount = {
        userId: user.id,
        email: user.email,
        instancesDestroyed: [],
        instancesSurvived: [],
        hivraAgentsDestroyed: [],
        hivraAgentsSurvived: [],
        clerkUserDeleted: false,
      };

      try {
        const ticket = await mintSignInTicket(opts.clerkSecretKey, user.id);
        const context = await establishAuditSession(browser, {
          baseUrl: opts.baseUrl,
          ticket,
        });

        try {
          const result = await destroyAllInstances(
            context.request,
            opts.baseUrl,
            `first-run audit reaper (${user.email ?? user.id})`,
          );
          entry.instancesDestroyed = result.destroyed;
          entry.instancesSurvived = result.survived.map((s) => ({
            id: s.id,
            httpStatus: s.httpStatus,
            error: s.error,
          }));
          const hivra = await destroyAllHivraAgents(context.request, opts.baseUrl);
          entry.hivraAgentsDestroyed = hivra.destroyed;
          entry.hivraAgentsSurvived = hivra.survived.map((s) => ({
            id: s.id,
            httpStatus: s.httpStatus,
            error: s.error,
          }));
        } finally {
          await context.close().catch(() => undefined);
        }

        // Keep the user if anything survived — without them we cannot ever
        // authenticate to finish the teardown through the app's own route.
        if (entry.instancesSurvived.length === 0 && entry.hivraAgentsSurvived.length === 0) {
          entry.clerkUserDeleted = await deleteAuditUser(opts.clerkSecretKey, user.id);
        }
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }

      if (
        entry.instancesSurvived.length > 0 ||
        entry.hivraAgentsSurvived.length > 0 ||
        entry.error
      ) report.leaked = true;
      report.reaped.push(entry);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return report;
}
