/**
 * In-memory breadcrumb ring for the current browser session.
 *
 * Every call to `captureClientOpsEvent` pushes here so that when a user
 * eventually clicks "Copy report" the banner can attach the recent
 * sequence of client-side events leading up to the failure — without
 * shipping a heavyweight session replay product.
 *
 * Bounded at MAX_BREADCRUMBS so a long-lived tab never grows unbounded.
 */

export interface BreadcrumbEntry {
  ts: string;
  source: string;
  severity: string;
  title: string;
  route?: string;
  instanceId?: string;
}

const MAX_BREADCRUMBS = 15;
const ring: BreadcrumbEntry[] = [];

export function pushBreadcrumb(entry: BreadcrumbEntry): void {
  ring.push(entry);
  if (ring.length > MAX_BREADCRUMBS) {
    ring.splice(0, ring.length - MAX_BREADCRUMBS);
  }
}

export function getBreadcrumbs(): BreadcrumbEntry[] {
  return ring.slice();
}
