export const runtime = "nodejs";

import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";

import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/crypto";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import {
  startWorkspaceCloudOAuth,
  pollWorkspaceCloudOAuth,
} from "@/lib/services/workspace-cloud-provisioner";

const ROUTE = "/api/workspace-cloud/oauth";

const Schema = z.object({
  instanceId: z.string().uuid(),
  // Proof-of-possession: the agent's API server key (from the handoff bundle).
  // This is the auth — the cloud client is a machine, no Clerk session.
  apiServerKey: z.string().min(16).max(256),
  provider: z.string().min(2).max(40),
  action: z.enum(["start", "status"]).default("start"),
});

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Run an OAuth device-login on a connected cloud agent via its own CLI.
 *
 * action=start  → launches `hermes auth add <provider> --type oauth` on the
 *   agent and returns the verification URL + user code to show the user.
 * action=status → reports whether the agent has finished authenticating.
 *
 * The agent owns the token + refresh; nothing sensitive ever touches us.
 * Authenticated by proving possession of the agent's api_server_key.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`wc_oauth_${ip}`, { limit: 30, windowMs: 60 * 1000 });
    if (!success) return apiError("Too Many Requests", 429, undefined, undefined, { route: ROUTE });
    if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, { route: ROUTE });

    const parsed = Schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400, undefined, undefined, { route: ROUTE });

    const { data: inst } = await supabaseAdmin
      .from("hermes_instances")
      .select("ipv4_address, api_server_key_encrypted, status")
      .eq("id", parsed.data.instanceId)
      .eq("product_surface", "workspace_cloud")
      .neq("status", "deleted")
      .maybeSingle<{ ipv4_address: string | null; api_server_key_encrypted: string | null; status: string }>();

    if (!inst?.ipv4_address || !inst.api_server_key_encrypted) {
      return apiError("Agent not found", 404, undefined, undefined, { route: ROUTE });
    }

    let storedKey = "";
    try {
      storedKey = decryptApiKey(inst.api_server_key_encrypted);
    } catch {
      storedKey = "";
    }
    if (!storedKey || !safeEqual(storedKey, parsed.data.apiServerKey)) {
      return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    }

    if (parsed.data.action === "status") {
      const r = await pollWorkspaceCloudOAuth({ ip: inst.ipv4_address, provider: parsed.data.provider });
      if (!r.ok) return apiError(r.error, 502, undefined, undefined, { route: ROUTE });
      return apiSuccess({ status: r.status });
    }

    const r = await startWorkspaceCloudOAuth({ ip: inst.ipv4_address, provider: parsed.data.provider });
    if (!r.ok) return apiError(r.error, 502, undefined, undefined, { route: ROUTE });
    return apiSuccess({ url: r.url, code: r.code });
  } catch (err) {
    return handleApiError(err);
  }
}
