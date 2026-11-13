// Hivra's Matrix push gateway: POST /_matrix/push/v1/notify, rewritten here
// in next.config.ts (folders that start with "_" are private in the app
// router). An agent's homeserver calls it through the pusher added when the
// owner turned on "Wake on Matrix messages" (channel-wake/owner.ts).
//
// Checked against https://spec.matrix.org/latest/push-gateway-api/: the body
// is {notification: {..., devices: [{app_id, pushkey, ...}]}} and the answer
// is 200 {rejected: [pushkey...]}; a rejected pushkey makes the homeserver
// delete that pusher. The endpoint has no authentication of its own, so each
// pushkey carries an HMAC (adapters/matrix-pusher-program.ts). A forged one
// gets 401 before any database read. Without HIVRA_CHANNEL_WAKE_SECRET the
// route answers 404, as if it did not exist.

export const runtime = "nodejs";
// The wake runs after the answer; its worst case is a hibernated agent (see the Telegram wake route).
export const maxDuration = 300;

import { after, NextResponse, type NextRequest } from "next/server";
import { log } from "@/lib/logger";
import { ensureHivraAgentAwake } from "@/lib/hivra/agent-wake";
import { handleMatrixNotify } from "@/lib/hivra/channel-wake/adapters/matrix-notify";
import { channelWakeSecret } from "@/lib/hivra/channel-wake/config";

const LOG_SOURCE = "channel-wake-matrix";
const MAX_BODY_BYTES = 64 * 1024;
const WAKE_WAIT_MS = 120_000;

function json(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function unrecognized(status: 404 | 405): NextResponse {
  return json(status, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" });
}

/** At most MAX_BODY_BYTES of the body, parsed as JSON; null for anything larger or not JSON. */
async function readBody(req: NextRequest): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value?.byteLength ?? 0;
      if (seen > MAX_BODY_BYTES) return null;
      if (value) chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readBody(req);
    const outcome = await handleMatrixNotify(body, {
      wake: (agentId) => {
        after(async () => {
          try {
            await ensureHivraAgentAwake(agentId, { trigger: "channel", waitMs: WAKE_WAIT_MS });
          } catch {
            log.warn("matrix wake could not be started", { source: LOG_SOURCE, failureType: "channel_wake_matrix_wake_failed", instanceId: agentId });
          }
        });
      },
    });
    if (outcome.status === 200) return json(200, { rejected: outcome.rejected });
    if (outcome.status === 404) return unrecognized(404);
    if (outcome.status === 400) return json(400, { errcode: "M_BAD_JSON", error: "Bad notification" });
    return json(401, { errcode: "M_FORBIDDEN", error: "Unknown pushkey" });
  } catch {
    // The homeserver retries an error with backoff.
    return json(503, { errcode: "M_UNKNOWN", error: "Try again" });
  }
}

export async function GET() {
  return unrecognized(channelWakeSecret() ? 405 : 404);
}
