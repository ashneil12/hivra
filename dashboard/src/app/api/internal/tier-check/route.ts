// Internal endpoint called by the browser-sidecar on container start (and on
// any tier-change webhook re-trigger). Verifies the user's tier still qualifies
// for the Pro+ feature. The sidecar exits 0 on { tier_ok: false }, which the
// supervisor honors by leaving the container down.
//
// This is Layer 2 of the four-layer browser-sidecar tier defense:
//   Layer 1 (provisioning):  webui-instance-builder.ts only emits the service
//                            block when the orchestrator resolves the user as
//                            Pro+ (see instance-orchestrator.ts).
//   Layer 2 (this endpoint): on container start, the sidecar revalidates. If
//                            the user downgraded between deploy and start,
//                            the container exits cleanly and stays down.
//   Layer 3 (PATCH guard):   /api/instances/[id] blocks transitions to
//                            browserSidecarEnabled=true for non-Pro+ users.
//   Layer 4 (tool gate):     conditional inclusion of the tool in agent
//                            tool registry — TBD in agent runtime, not here.
//
// Auth: caller (the sidecar) presents the per-instance api_server_key as a
// bearer token. We look up the instance's encrypted bearer in Supabase and
// compare with timingSafeEqual. No Clerk session — this call is server-to-
// server, originating inside the user's VM.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { decryptApiKey } from "@/lib/crypto";
import { isProTierUser } from "@/lib/billing/pro-tier";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SAFE_ID = /^[a-zA-Z0-9_-]{8,128}$/;

interface TierCheckSuccess {
  tier_ok: boolean;
  tier: string | null;
  reason?: string;
}

function deny(status: number, body?: TierCheckSuccess): NextResponse {
  if (body) return NextResponse.json(body, { status });
  return new NextResponse(null, { status });
}

function compareBearer(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!supabaseAdmin) return deny(503);

  const instanceId = request.nextUrl.searchParams.get("instance_id")?.trim() || "";
  if (!instanceId || !SAFE_ID.test(instanceId)) return deny(400);

  const authHeader = request.headers.get("authorization") || "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!bearerMatch) return deny(401);
  const providedBearer = bearerMatch[1].trim();
  if (!providedBearer) return deny(401);

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, user_id, api_server_key_encrypted")
    .eq("id", instanceId)
    .maybeSingle<{ id: string; user_id: string; api_server_key_encrypted: string | null }>();

  if (error || !data?.api_server_key_encrypted) {
    return deny(404);
  }

  let expected: string;
  try {
    expected = decryptApiKey(data.api_server_key_encrypted);
  } catch {
    return deny(500);
  }
  if (!compareBearer(providedBearer, expected)) return deny(401);

  // Fail CLOSED on any unexpected throw. isProTierUser already catches its own
  // query errors and returns { ok:false, reason:"lookup_failed" }, but a future
  // refactor or an upstream Stripe/Supabase blip must never surface as a 500
  // (whose handling by the sidecar is ambiguous) — a security gate should deny
  // on uncertainty, so we return a well-formed { tier_ok:false } 200 instead.
  let tierCheck: TierCheckSuccess;
  try {
    const result = await isProTierUser(data.user_id);
    tierCheck = {
      tier_ok: result.ok,
      tier: result.tier ?? null,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  } catch (err) {
    tierCheck = {
      tier_ok: false,
      tier: null,
      reason: `tier_check_error:${(err as Error).message}`,
    };
  }

  return NextResponse.json(tierCheck satisfies TierCheckSuccess, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
