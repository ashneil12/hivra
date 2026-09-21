import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { decryptApiKey } from "@/lib/crypto";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { reportOpsEvent } from "@/lib/ops-events";
export const dynamic = 'force-dynamic';

/**
 * Readiness probe for the browser sidecar (Chromium over CDP, Pro-tier).
 *
 * Probes the sidecar's noVNC static asset through the instance gateway — a
 * 200 means Caddy routes + the sidecar container are both wired up and the
 * live browser view is available. Returns 200 when ready, non-2xx otherwise.
 * Used by the dashboard UIs to decide whether to show the "Browser" action.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let instanceId: string | null = null;
  let userId: string | null = null;

  try {
    const authState = await auth();
    userId = authState.userId;
    if (!userId) return new NextResponse("Unauthorized", { status: 401 });

    const { id } = await params;
    instanceId = id;

    const { data: instance } = await supabaseAdmin!
      .from("hermes_instances")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single();

    if (!instance) return new NextResponse("Not found", { status: 404 });
    if (instance.status !== "running")
      return new NextResponse("Instance is not running", { status: 400 });

    const ipv4 = await resolveInstanceIpv4(instance as unknown as import('@/app/api/instances/[id]/route').HermesInstanceRow);
    if (!ipv4) return new NextResponse("No IPv4 address", { status: 400 });

    const token = instance.api_server_key_encrypted
      ? decryptApiKey(instance.api_server_key_encrypted)
      : "";

    let gatewayBase = instance.gateway_url?.replace(/\/$/, "") || `http://${ipv4}`;
    if (gatewayBase.startsWith("http://") && /http:\/\/\d+\.\d+\.\d+\.\d+/.test(gatewayBase)) {
      const ipStr = gatewayBase.replace("http://", "");
      gatewayBase = `https://${ipStr.replace(/\./g, '-')}.sslip.io`;
    }

    // The sidecar's noVNC bundle ships an unauthenticated static asset behind
    // the instance's /vnc/ Caddy route; a 200 means the sidecar container +
    // routing are live. Mirrors the auto-detect probe in browser-stream.
    const { response: res } = await fetchFirstReachableGatewayResponse({
      baseUrl: gatewayBase,
      pathname: "/vnc/core/rfb.js",
      instanceIpv4: ipv4,
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 5000,
    });

    // Consume + discard the body; readiness is signalled by the status alone.
    await res.text().catch(() => {});

    if (!res.ok && res.status !== 304) {
      return new NextResponse("Browser sidecar not ready", { status: 503 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Treat connection errors as "not ready" — the UIs use the status code to
    // decide whether to show the Browser action, not whether to error.
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError" || err.message.includes("fetch"))
    ) {
      return new NextResponse("Manager not reachable", { status: 503 });
    }
    void reportOpsEvent({
      source: 'browser-sessions',
      severity: 'error',
      title: 'Browser session probe failed',
      message: 'Browser session probe failed',
      route: '/api/instances/[id]/browser-sessions',
      userId: userId || undefined,
      instanceId: instanceId || undefined,
      metadata: {
        failureType: 'browser_session_probe_failed',
        errorName: err instanceof Error ? err.name : typeof err,
      },
    });
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
