// Telegram calls this when a message reaches the bot of an agent that sleeps
// with "Wake on Telegram messages" on. It wakes the agent and never takes the
// message: the answer is always 503, so Telegram keeps the update queued, and
// the wake deletes the webhook before the computer runs again, so Hermes polls
// and reads the message itself.
//
// Each arm has its own secret (telegram-wake/config.ts), which Telegram sends
// back in X-Telegram-Bot-Api-Secret-Token. A wrong or missing secret, an
// unknown agent, or a server without the setting all get 401. The body is
// never parsed or logged: at most 64 KB of it is read and thrown away.

export const runtime = "nodejs";
// The wake runs after the answer. Its worst case is a hibernated agent: the
// host slot, the webhook delete (up to 5 s), the restore (up to 120 s), the
// health check (up to 30 s) and the database calls, so 300 s leaves room. A
// wake cut off anyway leaves the row marked, and the sweep arms the bot again.
export const maxDuration = 300;

import { createHash, timingSafeEqual } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import { log } from "@/lib/logger";
import { isAgentUuid, telegramWakeSecret, telegramWakeSecretToken } from "@/lib/hivra/telegram-wake/config";
import { handleTelegramWakeCall } from "@/lib/hivra/telegram-wake/webhook";
import { readTelegramWakeRow, type TelegramWakeRow } from "@/lib/hivra/telegram-wake/store";

const LOG_SOURCE = "telegram-wake-webhook";
const MAX_BODY_BYTES = 64 * 1024;
const SECRET_HEADER = "x-telegram-bot-api-secret-token";
/** The only shape telegramWakeSecretToken makes. Anything else is refused before any database read. */
const SECRET_SHAPE = /^[0-9a-f]{64}$/;

function answer(status: 401 | 503): NextResponse {
  return NextResponse.json({ ok: false }, { status, headers: { "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "5" } : {}) } });
}

/** Constant-time comparison of two strings of any length. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

/** Reads and drops at most MAX_BODY_BYTES of the body. Never throws, never keeps it. */
async function discardBody(req: NextRequest): Promise<void> {
  const reader = req.body?.getReader();
  if (!reader) return;
  let seen = 0;
  try {
    while (seen <= MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value?.byteLength ?? 0;
    }
  } catch {
    // Nothing to do: the body is not used.
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await params;
    const secret = telegramWakeSecret();
    const given = req.headers.get(SECRET_HEADER) ?? "";
    if (!secret || !isAgentUuid(agentId) || !SECRET_SHAPE.test(given)) return answer(401);

    let row: TelegramWakeRow | null;
    try {
      row = await readTelegramWakeRow(agentId.toLowerCase());
    } catch {
      // Telegram retries a 503; the secret is checked on that try.
      return answer(503);
    }
    const expected = row?.arm_id ? telegramWakeSecretToken(secret, agentId, row.arm_id) : "";
    if (!row || !expected || !sameSecret(given, expected)) return answer(401);

    await discardBody(req);
    const id = agentId.toLowerCase();
    after(async () => {
      try {
        await handleTelegramWakeCall(id);
      } catch {
        log.warn("telegram wake call could not be handled", { source: LOG_SOURCE, failureType: "telegram_wake_call_failed", instanceId: id });
      }
    });
    return answer(503);
  } catch {
    return answer(503);
  }
}

// Anything but a POST is not Telegram.
export async function GET() {
  return answer(401);
}
