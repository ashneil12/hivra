import "server-only";

import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

// Generic admin-paging transport for FATAL ops events. Mirrors the wiring
// of email/resource-watchdog-admin.ts (same RESEND_API_KEY / RESEND_FROM_EMAIL
// / HERMES_ADMIN_ALERT_EMAIL envs, same best-effort posture) but is keyed on
// an ops-event fingerprint rather than a cpu_sustained flag, so the single
// reportOpsEvent() chokepoint can page on ANY fatal class — Caddy wedge,
// host-origin-unreachable, migration drift, cron dead-man — the first time it
// fires. Telegram is an optional second channel for operators who watch a
// chat faster than email; it no-ops when the bot envs are unset.
//
// Dedupe is owned by the caller: reportOpsEvent only invokes this on the
// INSERT branch (first sighting of a fingerprint), so an extended outage that
// keeps re-reporting the same fingerprint pages exactly once. We do NOT add a
// second dedupe layer here.

export interface OpsFatalAdminAlertInput {
  fingerprint: string;
  source: string;
  title: string;
  message: string;
  route?: string | null;
  instanceId?: string | null;
  userId?: string | null;
}

export interface OpsFatalAdminAlertResult {
  emailSent: boolean;
  telegramSent: boolean;
}

const SUBJECT_PREFIX = "[hermes-fatal]";

function buildEmailText(input: OpsFatalAdminAlertInput): string {
  return [
    `${SUBJECT_PREFIX} ${input.source}: ${input.title}`,
    "",
    input.message,
    "",
    `Source: ${input.source}`,
    input.route ? `Route: ${input.route}` : null,
    input.instanceId ? `Instance: ${input.instanceId}` : null,
    input.userId ? `User: ${input.userId}` : null,
    `Fingerprint: ${input.fingerprint}`,
    "",
    `Ops feed: ${SITE_URL}/dashboard/ops`,
    "",
    "This pages once per fingerprint. The same outage re-reporting will not page again until it archives and recurs.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function sendEmail(input: OpsFatalAdminAlertInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const adminEmail = process.env.HERMES_ADMIN_ALERT_EMAIL?.trim();

  if (!apiKey || !adminEmail) {
    // Unconfigured is not an error — many environments (preview, local) have
    // no admin transport. Stay silent like resource-watchdog-admin does.
    return false;
  }

  try {
    // Dynamic import keeps `resend` out of every reportOpsEvent caller's
    // server bundle; only the fatal-first-sighting path pays for it.
    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send(
      {
        from: fromAddress,
        to: adminEmail,
        subject: `${SUBJECT_PREFIX} ${input.source}: ${input.title}`.slice(0, 180),
        text: buildEmailText(input),
      },
      // Idempotency on the fingerprint hardens against a double-fire if two
      // cron invocations race the same INSERT (the DB unique index already
      // dedupes the row; this dedupes the page).
      { idempotencyKey: `ops-fatal/${input.fingerprint}` },
    );
    if (error) {
      log.warn("ops-fatal admin email send failed", {
        source: "ops-fatal-admin",
        failureType: "resend_send_failed",
        opsSource: input.source,
        errorName: error.name,
        errorMessage: error.message,
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("ops-fatal admin email threw", {
      source: "ops-fatal-admin",
      failureType: "resend_send_threw",
      opsSource: input.source,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function sendTelegram(input: OpsFatalAdminAlertInput): Promise<boolean> {
  const botToken = process.env.TELEGRAM_ADMIN_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  if (!botToken || !chatId) {
    return false;
  }

  const text =
    `🚨 ${SUBJECT_PREFIX} ${input.source}\n${input.title}\n\n${input.message}` +
    (input.instanceId ? `\n\nInstance: ${input.instanceId}` : "") +
    `\n${SITE_URL}/dashboard/ops`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn("ops-fatal admin telegram send failed", {
          source: "ops-fatal-admin",
          failureType: "telegram_send_failed",
          opsSource: input.source,
          status: res.status,
        });
        return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log.warn("ops-fatal admin telegram threw", {
      source: "ops-fatal-admin",
      failureType: "telegram_send_threw",
      opsSource: input.source,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Best-effort admin page for a first-sighting fatal ops event. NEVER throws —
 * the caller (reportOpsEvent) treats reporting as fire-and-forget and must not
 * have a transport hiccup mask the event write. Returns which channels fired
 * so a test can assert wiring without real network.
 */
export async function sendOpsFatalAdminAlert(
  input: OpsFatalAdminAlertInput,
): Promise<OpsFatalAdminAlertResult> {
  const [emailSent, telegramSent] = await Promise.all([
    sendEmail(input).catch(() => false),
    sendTelegram(input).catch(() => false),
  ]);
  return { emailSent, telegramSent };
}
