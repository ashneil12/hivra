import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { decryptApiKey } from "@/lib/crypto";
import { deriveBrowserVncPassword } from "@/lib/browser-vnc";
import { reportOpsEvent } from "@/lib/ops-events";
import { isProTierUser } from "@/lib/billing/pro-tier";
export const dynamic = 'force-dynamic';

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

    // The live browser stream is Pro-tier-gated, exactly like the sibling
    // cookie-import route (browser-sidecar/cookies/import). Without this a
    // downgraded user could still pull a live-viewer URL while the sidecar
    // keeps running. Mirror that 403 here. (F103)
    const tier = await isProTierUser(userId);
    if (!tier.ok) {
      return new NextResponse(
        "The live browser stream needs a Pro plan.",
        { status: 403 },
      );
    }

    const ipv4 = await resolveInstanceIpv4(instance as unknown as import('@/app/api/instances/[id]/route').HermesInstanceRow);
    if (!ipv4) return new NextResponse("No IPv4 address", { status: 400 });

    const instanceConfig = (instance.config as Record<string, unknown>) || {};
    const agentSettings = (instanceConfig.agentSettings as Record<string, unknown>) || {};

    // Build the public base once — used by both the auto-detect probe below
    // and the sidecar viewer rendering further down.
    let detectedPublicBase = instance.gateway_url?.replace(/\/$/, "") || `http://${ipv4}`;
    if (detectedPublicBase.startsWith("http://") && /http:\/\/\d+\.\d+\.\d+\.\d+/.test(detectedPublicBase)) {
      const ipStr = detectedPublicBase.replace("http://", "");
      detectedPublicBase = `https://${ipStr.replace(/\./g, "-")}.sslip.io`;
    }

    // Auto-detect sidecar even if the toggle hasn't been flipped in the DB.
    // Covers: manual provisioning, flag drift after a failed redeploy, or
    // any case where the sidecar is running but instance.config wasn't
    // updated. Probes the noVNC bundle's unauthenticated static asset; a
    // 200 means Caddy routes + sidecar container are both wired up.
    let sidecarAutoDetected = false;
    if (!agentSettings.browserSidecarEnabled) {
      try {
        const probeUrl = `${detectedPublicBase.replace(/^http:\/\//, "https://")}/vnc/core/rfb.js`;
        const probe = await fetch(probeUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(2000),
        });
        sidecarAutoDetected = probe.ok || probe.status === 304;
      } catch {
        sidecarAutoDetected = false;
      }
    }

    // Browser sidecar (Pro-tier, default-on). Mints a signed noVNC URL
    // (10-min TTL hard cap) and renders an RFB.js viewer that connects
    // through the user VM's outer Caddy to the sidecar's always-on Xvfb +
    // x11vnc + websockify stack. The agent drives this same Chromium, so
    // the user sees what Vex is doing in real time and can take over with
    // a click.
    if (agentSettings.browserSidecarEnabled || sidecarAutoDetected) {
      const rawKey = instance.api_server_key_encrypted
        ? decryptApiKey(instance.api_server_key_encrypted)
        : "";
      if (!rawKey) {
        return new NextResponse("Browser sidecar is not configured", { status: 500 });
      }

      // Redirect the dashboard's Browser iframe straight to the instance's own
      // noVNC app, served SAME-ORIGIN with its rfb.js + websockify on the
      // instance domain. This is exactly what the Claude Code boxes do
      // (agent/[id]/page.tsx). A custom viewer served from the dashboard origin
      // can't import rfb.js cross-origin from the instance domain — the
      // dashboard CSP blocks it ("Failed to load browser viewer"). noVNC's own
      // vnc.html auto-connects with the per-instance VNC password.
      const gatewayBase = detectedPublicBase.replace(/^http:\/\//, "https://");
      const vncPassword = deriveBrowserVncPassword(rawKey);
      const viewerUrl =
        `${gatewayBase}/vnc/vnc.html?path=vnc/websockify&autoconnect=true` +
        `&resize=scale&reconnect=true&password=${encodeURIComponent(vncPassword)}`;
      return NextResponse.redirect(viewerUrl, 302);
    }

    // No interactive browser for this instance (sidecar disabled, or not a
    // Pro+ tier). The agent still has its own browser tools; there's simply no
    // live view to stream here.
    return new NextResponse("No browser stream available for this instance", {
      status: 404,
    });
  } catch (err) {
    void reportOpsEvent({
      source: 'browser-stream',
      severity: 'error',
      title: 'Browser stream failed',
      message: 'Browser stream failed',
      route: '/api/instances/[id]/browser-stream',
      userId: userId || undefined,
      instanceId: instanceId || undefined,
      metadata: {
        failureType: 'browser_stream_failed',
        errorName: err instanceof Error ? err.name : typeof err,
      },
    });
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
