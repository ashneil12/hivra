export const runtime = "nodejs";

import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";

import { supabaseAdmin } from "@/lib/supabase";
import { decryptApiKey } from "@/lib/crypto";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { applyWorkspaceCloudModelConfig } from "@/lib/services/workspace-cloud-provisioner";

const ROUTE = "/api/workspace-cloud/apply-model";

const Schema = z
  .object({
    instanceId: z.string().uuid(),
    // Proof-of-possession: the agent's API server key, which only the connected
    // Workspace holds (it came from the handoff bundle). This is the auth — no
    // Clerk session (the Workspace is a machine).
    apiServerKey: z.string().min(16).max(256),
    // Key-based providers send a key; OAuth providers (openai-codex/nous) send
    // a `provider` (+ model) with no key — they authenticate via a token the
    // agent already holds.
    modelApiKey: z.string().min(8).max(256).optional(),
    provider: z.string().min(2).max(40).optional(),
    model: z.string().min(1).max(128).optional(),
  })
  .refine((d) => Boolean(d.modelApiKey || d.provider), {
    message: "Provide a provider or a model API key",
  });

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Push the user's model key + name onto an already-connected cloud agent. Used
 * when the Workspace sets/changes its model AFTER pairing (the paste-a-code
 * onboarding sets the model post-connect). Authenticated by proving possession
 * of the agent's api_server_key rather than a Clerk session.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`wc_apply_model_${ip}`, { limit: 20, windowMs: 60 * 1000 });
    if (!success) return apiError("Too Many Requests", 429, undefined, undefined, { route: ROUTE });
    if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, { route: ROUTE });

    const parsed = Schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400, undefined, undefined, { route: ROUTE });

    const { data: inst } = await supabaseAdmin
      .from("hermes_instances")
      .select("ipv4_address, api_server_key_encrypted")
      .eq("id", parsed.data.instanceId)
      .eq("product_surface", "workspace_cloud")
      .neq("status", "deleted")
      .maybeSingle<{ ipv4_address: string | null; api_server_key_encrypted: string | null }>();

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

    const applied = await applyWorkspaceCloudModelConfig({
      ip: inst.ipv4_address,
      provider: parsed.data.provider,
      apiKey: parsed.data.modelApiKey,
      model: parsed.data.model ?? "",
    });
    if (!applied.ok) return apiError(applied.error, 502, undefined, undefined, { route: ROUTE });

    return apiSuccess({ applied: true });
  } catch (err) {
    return handleApiError(err);
  }
}
