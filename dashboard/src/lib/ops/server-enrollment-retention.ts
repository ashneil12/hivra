import { sweepServerEnrollments } from "@/lib/infrastructure/server-enrollment-store";

/**
 * Retention for server setup commands (docs/superpowers/specs/
 * 2026-09-24-server-enrollment-command.md, section 12). One database function
 * does all of it in one transaction: it marks expiry, wipes sealed keys, dates
 * receipts whose connection was removed, and deletes rows past retention
 * (their receipts go by cascade):
 * - ended without a connection (unsupported, rejected, cancelled, expired):
 *   30 days after it ended;
 * - receipts of a removed connection: 90 days after the sweep first saw it
 *   gone;
 * - receipts of a connection that still exists: kept.
 * On by default: it deletes only rows that never became, or no longer back, a
 * connection.
 */
export async function runServerEnrollmentRetention(now = new Date(), sweep = sweepServerEnrollments) {
  return sweep(now);
}
