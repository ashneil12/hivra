import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError } from "@/lib/api-response";
import { reportOpsEvent } from "@/lib/ops-events";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { supabaseAdmin } from "@/lib/supabase";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { scheduleSoulSeedReconcileAfterResponse } from "@/lib/recovery/soul-seed-reconcile";
import { isWebfreeBackend } from "@/lib/types/instance";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const POLLING_INTERVAL_MS = 3000;
// Wall-clock cap for the SSE readiness poll loop. Instances normally become
// ready in well under a minute; 5 minutes is a generous ceiling that still
// guarantees a never-ready instance can't keep an SSE connection + server
// timer alive forever (resource leak / runaway connection). Once exceeded we
// emit a terminal 'timeout' event and close the stream so the client stops.
const SSE_MAX_DURATION_MS = 5 * 60 * 1000;
const GATEWAY_PROBE_ERROR = "Gateway probe failed";
const INTERNAL_HEALTH_ERROR = "Internal server error";
// Statuses where the gateway probe is meaningful. For anything else
// (stopped/error/paused/etc) the row is legitimately not in a state
// that should be flipped to running by a successful probe.
const PROBEABLE_STATUSES = new Set(["running", "provisioning", "redeploying"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let instanceId: string | null = null;
  let userId: string | null = null;

  try {
    const authState = await auth();
    userId = authState.userId;
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    instanceId = id;

    const { instance, apiServerKey, error, instanceIpv4 } = await getSecureUserInstance({
      id,
      userId,
      requireRunning: false, // Health checks handle 'starting' state gracefully via JSON
    });

    if (error || !instance) {
      return apiError(error || "Instance not found", error === 'Instance not found or unauthorized' ? 404 : 400);
    }

    const acceptsSSE = req.headers.get("accept")?.includes("text/event-stream");

    // Track the row's status across SSE poll iterations so the DB promotion
    // only fires once at the moment of transition. The DB row is the source
    // of truth other consumers (chat workspace boot UI, dashboard list, etc.)
    // read; we must NOT let it stay at 'provisioning' once the gateway is
    // proven healthy, otherwise the user is stuck on the spinner forever.
    let currentStatus: string = instance.status;

    // Helper to probe the gateway
    const probeGateway = async () => {
      // Short-circuit only for statuses where a 200 from the gateway would
      // not legitimately mean the agent is running (e.g. stopped/error/
      // paused). 'provisioning' and 'redeploying' MUST fall through to the
      // real probe — those are exactly the transitional states the boot UI
      // is polling us to clear.
      if (!PROBEABLE_STATUSES.has(currentStatus)) {
        return { isReady: false, status: currentStatus };
      }

      const baseUrl = instance.gateway_url.replace(/\/$/, "");
      // Backend-aware probe: gateway exposes /v1/models (bearer-auth);
      // WebUI exposes /health publicly via the per-instance Caddyfile and
      // does NOT expose /v1/models — probing the wrong path gives 404 and
      // the chat workspace gets stuck on "Connecting to agent" forever
      // even though the agent is fully reachable. Mirrors the same
      // backend split in /api/instances summary mode (route.ts ~line 105).
      //
      // Modern webfree ('gateway' backend) boxes are probed over the CHAT
      // lane instead: '/health' only proves the official-dashboard shell,
      // which 200s seconds-to-minutes before the gateway that answers chat
      // (measured 2026-07-10, canary run fixturecase04 / prod run fixturecase05) —
      // promoting on it opened a workspace whose first message died. The
      // bearer-authed '/api/sessions' flips 200 in the same window as the
      // WS upgrade. Mirrors buildReadinessProbeOptions in the instance
      // routes; keyless rows fail open to '/health'.
      const isWebUI = isWebfreeBackend(instance.backend);
      const probeChatLane = instance.backend === "gateway" && Boolean(apiServerKey);
      const probePath = probeChatLane ? "/api/sessions" : isWebUI ? "/health" : "/v1/models";
      const headers: Record<string, string> = {};
      if (!isWebUI || probeChatLane) {
        headers.Authorization = `Bearer ${apiServerKey}`;
      }

      let gatewayRes: Response | null = null;
      let lastError = "";

      try {
        const { response } = await fetchFirstReachableGatewayResponse({
          baseUrl,
          pathname: probePath,
          instanceIpv4,
          headers,
          timeoutMs: 8_000,
        });
        gatewayRes = response;
      } catch {
        lastError = GATEWAY_PROBE_ERROR;
      }

      if (!gatewayRes) {
        return { isReady: false, status: currentStatus, error: lastError || GATEWAY_PROBE_ERROR };
      }

      // 🚨 CRITICAL: Always consume the response body when using undici custom agents
      // or the socket will be leaked/held open, causing subsequent fetch calls to hang
      // and preventing the UI from ever receiving an updated 'ready' state.
      await gatewayRes.text().catch(() => {});

      if (!gatewayRes.ok) {
        return { isReady: false, status: currentStatus, error: `Gateway status: ${gatewayRes.status}` };
      }

      // Gateway answered 200 — agent is up. Promote the DB row out of any
      // transitional state so other consumers stop seeing stale data.
      // Mirrors the same flip in /api/instances/[id] (route.ts ~line 945).
      if (currentStatus !== "running" && supabaseAdmin) {
        const now = new Date().toISOString();
        try {
          await supabaseAdmin
            .from("hermes_instances")
            .update(buildInstanceLifecyclePatch("running", { now }))
            .eq("id", instance.id);
          currentStatus = "running";
        } catch (err) {
          log.warn("health probe failed to promote instance to running", {
            source: "instance-health",
            route: "/api/instances/[id]/health",
            method: "GET",
            instanceId: instance.id,
            userId: userId || null,
            failureType: "health_probe_lifecycle_promote_failed",
          }, err);
          // Don't fail the probe — the gateway IS up; we just couldn't
          // persist that. UI will still advance off the response.
        }

        // Post-ready SOUL.md seed. The mirror above copies the promote; it must
        // also copy the reconcile. Whoever OBSERVES readiness first owns the
        // seed: once we've flipped the row here, the /api/instances/[id] poll's
        // own seed branches can never fire (they gate on
        // `promotedToRunning = nextStatus === "running" && status !== "running"`,
        // already false), so a box first seen healthy through /health would keep
        // the factory-default "You are Hermes Agent…" SOUL.md until the 20-min
        // cron sweep — on the persona lane, precisely the user's first
        // conversation with the agent they just hired.
        //
        // Gated on the promote having actually persisted: reconcileSoulSeedAfterReady
        // re-asserts status='running' against a FRESH row, so scheduling after a
        // failed write would only buy a wasted no-op round-trip. `isWebUI` is
        // isWebfreeBackend(instance.backend) — same gate as the other promote
        // sites. Deferred until after the response; guarded + idempotent; never
        // blocks the probe.
        if (currentStatus === "running" && isWebUI) {
          scheduleSoulSeedReconcileAfterResponse({
            instanceId: instance.id,
            trigger: "health_probe_promote",
          });
        }
      }

      return { isReady: true, status: "running" as const };
    };

    if (!acceptsSSE) {
      const probeResult = await probeGateway();
      return NextResponse.json(probeResult);
    }

    // Server-Sent Events mode
    const encoder = new TextEncoder();
    let isClosed = false;
    let timeoutId: NodeJS.Timeout | undefined;
    // Wall-clock deadline: stop re-arming the poll loop once we pass this so a
    // never-ready instance can't keep the connection + timer alive forever.
    const deadline = Date.now() + SSE_MAX_DURATION_MS;

    const stream = new ReadableStream({
      async start(controller) {

        // Close the stream cleanly once the deadline is reached, emitting a
        // terminal 'timeout' event so the client knows to stop listening.
        const finishWithTimeout = () => {
          if (isClosed) return;
          isClosed = true;
          clearTimeout(timeoutId);
          try {
            controller.enqueue(
              encoder.encode(
                `event: timeout\ndata: {"isReady":false,"timedOut":true}\n\n`
              )
            );
            controller.close();
          } catch {
            // Controller may already be closed/errored — nothing to do.
          }
        };

        req.signal.addEventListener("abort", () => {
          isClosed = true;
          clearTimeout(timeoutId);
        });

        const checkLoop = async () => {
          if (isClosed) return;
          try {
            const probeResult = await probeGateway();

            if (isClosed) return;
            const dataString = `data: ${JSON.stringify(probeResult)}\n\n`;
            controller.enqueue(encoder.encode(dataString));

            // Stop polling once the instance is completely ready and send an event
            if (probeResult.isReady) {
               controller.enqueue(encoder.encode(`event: ready\ndata: {"completed": true}\n\n`));
               controller.close();
               isClosed = true;
               return;
            }

            // Bounded poll loop: don't re-arm past the wall-clock deadline.
            if (Date.now() >= deadline) {
              finishWithTimeout();
              return;
            }

            timeoutId = setTimeout(checkLoop, POLLING_INTERVAL_MS);
          } catch (err: unknown) {
            log.warn("health probe stream failed", {
              source: "instance-health",
              route: "/api/instances/[id]/health",
              method: "GET",
              instanceId: instanceId || null,
              userId: userId || null,
              failureType: "health_probe_stream_failed",
            }, err);
            void reportOpsEvent({
              source: 'instance-health',
              severity: 'warn',
              title: 'Health stream probe failed',
              message: 'Health stream probe failed',
              route: '/api/instances/[id]/health',
              userId: userId || undefined,
              instanceId: instanceId || undefined,
              metadata: {
                failureOwner: 'hermes',
                failurePhase: 'runtime',
                failureType: 'health_probe_stream_failed',
                recoveryAction: 'retry_later',
                errorType: err instanceof Error ? err.name : typeof err,
              },
            });
            if (!isClosed) {
               // Same bounded-loop guard on the error path so a persistently
               // failing probe can't keep the connection + timer alive forever.
               if (Date.now() >= deadline) {
                 finishWithTimeout();
                 return;
               }
               timeoutId = setTimeout(checkLoop, POLLING_INTERVAL_MS);
            }
          }
        };

        checkLoop();
      },
      cancel() {
        isClosed = true;
        clearTimeout(timeoutId);
      }
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Content-Encoding": "none",
        "X-Accel-Buffering": "no",
      },
    });

  } catch (err: unknown) {
    void reportOpsEvent({
      source: 'instance-health',
      severity: 'error',
      title: 'Instance health route failed',
      message: 'Instance health route failed',
      route: '/api/instances/[id]/health',
      userId: userId || undefined,
      instanceId: instanceId || undefined,
      metadata: {
        failureOwner: 'hermes',
        failurePhase: 'runtime',
        failureType: 'instance_health_route_failed',
        recoveryAction: 'retry_later',
        errorType: err instanceof Error ? err.name : typeof err,
      },
    });
    return NextResponse.json({ isReady: false, error: INTERNAL_HEALTH_ERROR }, { status: 500 });
  }
}
