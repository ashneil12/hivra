/**
 * Canonical support channels.
 *
 * Single source of truth for the Discord invite and support inbox that
 * the dashboard surfaces in multiple places (sidebar, billing dead-ends,
 * instance failure alerts, the shared ReportProblemLink). Keeping these
 * here means a channel change (new invite, new inbox) is one edit, not a
 * grep across the app.
 *
 * Safe to import from both client and server code: plain string constants
 * plus a pure mailto: builder, no env reads or server-only deps.
 */

/** Public Discord invite (matches DashboardSidebar). */
export const SUPPORT_DISCORD_URL = "https://discord.gg/tDQZq8479F";

/** Monitored support inbox (matches DashboardSidebar + CancelSaveFlow). */
export const SUPPORT_EMAIL = "info@hermesos.cloud";

export interface ReportProblemContext {
  /** Short summary used as the mailto subject, e.g. "Agent failed to start". */
  summary: string;
  /** Instance this report is about, when applicable. */
  instanceId?: string | null;
  /** Free-form error/diagnostic text appended to the body. */
  errorContext?: string | null;
}

/**
 * Build a prefilled mailto: link to the support inbox. The body carries the
 * instance id and error context so the founder can act on the report
 * without a back-and-forth. Mirrors the mailto pattern already used in
 * CancelSaveFlow.
 */
export function buildSupportMailto(ctx: ReportProblemContext): string {
  const subjectParts = ["[Report]", ctx.summary.trim()].filter(Boolean);
  const subject = subjectParts.join(" ");

  const bodyLines = [
    "Tell us what happened (a sentence is plenty):",
    "",
    "",
    "—",
    "Diagnostics (please keep — it helps us fix this):",
  ];
  if (ctx.instanceId) bodyLines.push(`Agent: ${ctx.instanceId}`);
  if (ctx.errorContext?.trim()) bodyLines.push(`Error: ${ctx.errorContext.trim()}`);

  const params = new URLSearchParams({
    subject,
    body: bodyLines.join("\n"),
  });
  return `mailto:${SUPPORT_EMAIL}?${params.toString()}`;
}
