export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// The browser reconnects with Last-Event-ID when this window ends, so a
// bounded function duration never loses events.
export const maxDuration = 300;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import {
  assertManagedSessionStreamable,
  ManagedSessionError,
  streamManagedSessionEvents,
} from "@/lib/hivra/do-managed-sessions";
import { managedSessionFailure, noStore, UUID, hivraApiUnavailable } from "../../route-support";

const EVENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const STREAM_WINDOW_MS = 280_000;
const HEARTBEAT_MS = 20_000;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Agent not found.", 404));
  const agentId = id.toLowerCase();
  const requested = request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("after");
  const after = requested && EVENT_ID.test(requested) ? requested : null;
  try {
    // An unready or foreign session fails as a normal JSON error, before any
    // event-stream bytes are sent.
    await assertManagedSessionStreamable(userId, agentId);
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions/[id]/events");
  }

  const upstreamAbort = new AbortController();
  request.signal.addEventListener("abort", () => upstreamAbort.abort(), { once: true });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (text: string) => { if (open) controller.enqueue(encoder.encode(text)); };
      const heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);
      const windowTimer = setTimeout(() => upstreamAbort.abort(), STREAM_WINDOW_MS);
      write("retry: 2000\n\n");
      try {
        for await (const event of streamManagedSessionEvents(userId, agentId, { after, signal: upstreamAbort.signal })) {
          write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        if (!upstreamAbort.signal.aborted) {
          const message = error instanceof ManagedSessionError ? error.message : "The DigitalOcean event stream stopped.";
          log.warn("DigitalOcean event relay stopped", {
            source: "hivra/managed-sessions",
            failureType: "do_event_relay_stopped",
            agentId,
            code: error instanceof ManagedSessionError ? error.code : "unknown",
          });
          write(`event: relay-error\ndata: ${JSON.stringify({ message })}\n\n`);
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(windowTimer);
        upstreamAbort.abort();
        open = false;
        controller.close();
      }
    },
    cancel() {
      upstreamAbort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
