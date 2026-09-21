import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { decryptApiKey } from "@/lib/crypto";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { isProTierUser } from "@/lib/billing/pro-tier";
import { reportOpsEvent } from "@/lib/ops-events";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Cookie import — load a user-exported cookie file into the instance's browser
 * sidecar (the Chromium the agent drives over CDP and the user watches over
 * noVNC), logging that browser into the user's accounts.
 *
 * Body: { file: string (raw exported cookies), identity?: string, dryRun?: boolean }
 *
 * The file is parsed ON THE BOX — the sidecar owns the parser, so the cookie
 * values never touch the language model and the format logic lives in one
 * place. Proxied server-side with the per-instance bearer (== webuiPassword ==
 * the sidecar's SIDECAR_AUTH_TOKEN), so the secret never reaches the client.
 */
export async function POST(
  req: NextRequest,
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

    const body = (await req.json().catch(() => null)) as
      | { file?: unknown; identity?: unknown; dryRun?: unknown }
      | null;
    const file = body && typeof body.file === "string" ? body.file : "";
    const identity =
      body && typeof body.identity === "string" && body.identity ? body.identity : undefined;
    const dryRun = Boolean(body && body.dryRun);
    if (!file) {
      return NextResponse.json({ ok: false, error: "No cookie file provided." }, { status: 400 });
    }
    if (Buffer.byteLength(file, "utf8") > MAX_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: "Cookie file is too large." }, { status: 413 });
    }

    const { data: instance } = await supabaseAdmin!
      .from("hermes_instances")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single();

    if (!instance) return new NextResponse("Not found", { status: 404 });
    if (instance.status !== "running") {
      return new NextResponse("Instance is not running", { status: 400 });
    }

    // The browser sidecar — and therefore cookie import — is Pro-tier-gated.
    const tier = await isProTierUser(userId);
    if (!tier.ok) {
      return NextResponse.json(
        { ok: false, error: "Cookie import needs a Pro plan (it uses the live browser)." },
        { status: 403 }
      );
    }

    const ipv4 = await resolveInstanceIpv4(
      instance as unknown as import("@/app/api/instances/[id]/route").HermesInstanceRow
    );
    if (!ipv4) return new NextResponse("No IPv4 address", { status: 400 });

    const token = instance.api_server_key_encrypted
      ? decryptApiKey(instance.api_server_key_encrypted)
      : "";

    let gatewayBase = instance.gateway_url?.replace(/\/$/, "") || `http://${ipv4}`;
    if (gatewayBase.startsWith("http://") && /http:\/\/\d+\.\d+\.\d+\.\d+/.test(gatewayBase)) {
      const ipStr = gatewayBase.replace("http://", "");
      gatewayBase = `https://${ipStr.replace(/\./g, "-")}.sslip.io`;
    }

    const { response: res } = await fetchFirstReachableGatewayResponse({
      baseUrl: gatewayBase,
      pathname: "/browser-sidecar/cookies/import",
      instanceIpv4: ipv4,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file, identity, dryRun }),
      timeoutMs: 20000,
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // 404 from the box's Caddy => the sidecar route isn't present, i.e. the
      // live browser isn't enabled on this instance.
      if (res.status === 404) {
        return NextResponse.json(
          { ok: false, error: "The live browser isn't enabled on this instance yet." },
          { status: 409 }
        );
      }
      // Surface the sidecar's own 400 (bad cookie file) verbatim.
      try {
        const j = text ? JSON.parse(text) : null;
        if (j && typeof j.message === "string") {
          return NextResponse.json({ ok: false, error: j.message }, { status: res.status === 400 ? 400 : 502 });
        }
      } catch {
        /* not JSON — fall through */
      }
      return NextResponse.json({ ok: false, error: "Cookie import failed." }, { status: 502 });
    }

    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* leave json as {} */
    }
    return NextResponse.json(json);
  } catch (err) {
    void reportOpsEvent({
      source: "browser-sidecar-cookies",
      severity: "error",
      title: "Cookie import failed",
      message: "Cookie import proxy failed",
      route: "/api/instances/[id]/browser-sidecar/cookies/import",
      userId: userId || undefined,
      instanceId: instanceId || undefined,
      metadata: {
        failureType: "cookie_import_failed",
        errorName: err instanceof Error ? err.name : typeof err,
      },
    });
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
