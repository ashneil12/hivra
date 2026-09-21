import { Resend } from "resend";
import { escapeHtml } from "@/lib/email/escape-html";

import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

interface SendParams {
  instanceId: string;
  userId: string;
  agentName: string | null;
  resourceTier: string | null;
  flagData: Record<string, unknown>;
  idempotencyKey: string;
}

interface SendResult {
  sent: boolean;
  reason?: "not_configured" | "send_failed";
  errorMessage?: string;
  resendId?: string;
}

const SUBJECT_PREFIX = "[abuse-flag]";

function formatPct(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  return `${(value * 100).toFixed(1)}%`;
}

function formatHours(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  return `${value.toFixed(1)}h`;
}

export function buildText(params: SendParams): string {
  const { flagData } = params;
  return [
    `${SUBJECT_PREFIX} cpu_sustained on instance ${params.instanceId}`,
    "",
    `User: ${params.userId}`,
    `Agent: ${params.agentName ?? "(unnamed)"}`,
    `Tier: ${params.resourceTier ?? "(unknown)"}`,
    `Average CPU: ${formatPct(flagData.avg_cpu_pct)} over ${formatHours(flagData.window_hours)}`,
    `CPU seconds delta: ${flagData.cpu_seconds_delta ?? "?"}`,
    `Sample count: ${flagData.sample_count ?? "?"}`,
    "",
    `Dashboard: ${SITE_URL}/dashboard/instances/${params.instanceId}`,
    "",
    "Resolve via DB or admin tooling. Customer has been emailed a friendly heads-up — review their reply before any suspend action.",
  ].join("\n");
}

export function buildHtml(params: SendParams): string {
  const { flagData } = params;
  const safeInstance = escapeHtml(params.instanceId);
  const safeUser = escapeHtml(params.userId);
  const safeAgent = escapeHtml(params.agentName ?? "(unnamed)");
  const safeTier = escapeHtml(params.resourceTier ?? "(unknown)");
  return `<!doctype html>
<html><body style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#1a1a1a;background:#fafafa;padding:16px;">
  <p><strong>${SUBJECT_PREFIX}</strong> cpu_sustained on instance <code>${safeInstance}</code></p>
  <table cellpadding="4" style="border-collapse:collapse;">
    <tr><td>User</td><td><code>${safeUser}</code></td></tr>
    <tr><td>Agent</td><td>${safeAgent}</td></tr>
    <tr><td>Tier</td><td>${safeTier}</td></tr>
    <tr><td>Avg CPU</td><td>${formatPct(flagData.avg_cpu_pct)} over ${formatHours(flagData.window_hours)}</td></tr>
    <tr><td>CPU seconds delta</td><td>${escapeHtml(String(flagData.cpu_seconds_delta ?? "?"))}</td></tr>
    <tr><td>Sample count</td><td>${escapeHtml(String(flagData.sample_count ?? "?"))}</td></tr>
  </table>
  <p><a href="${SITE_URL}/dashboard/instances/${safeInstance}">Open in dashboard</a></p>
  <p>Resolve via DB or admin tooling. Customer has been emailed; review their reply before any suspend action.</p>
</body></html>`;
}

export async function sendResourceWatchdogAdminEmail(
  params: SendParams
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const adminEmail = process.env.HERMES_ADMIN_ALERT_EMAIL?.trim();

  if (!apiKey) {
    return { sent: false, reason: "not_configured" };
  }
  if (!adminEmail) {
    log.warn("HERMES_ADMIN_ALERT_EMAIL is not set; skipping admin watchdog email", {
      source: "resource-watchdog-admin",
      failureType: "admin_email_unset",
      instanceId: params.instanceId,
    });
    return { sent: false, reason: "not_configured" };
  }

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send(
      {
        from: fromAddress,
        to: adminEmail,
        subject: `${SUBJECT_PREFIX} cpu_sustained on ${params.instanceId}`,
        text: buildText(params),
        html: buildHtml(params),
      },
      { idempotencyKey: params.idempotencyKey }
    );

    if (error) {
      log.warn("resource-watchdog admin email send failed", {
        source: "resource-watchdog-admin",
        failureType: "resend_send_failed",
        adminEmail,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }

    return { sent: true, resendId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("resource-watchdog admin email threw", {
      source: "resource-watchdog-admin",
      failureType: "resend_send_threw",
      adminEmail,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
