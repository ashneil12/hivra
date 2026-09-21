export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/agent-notify — ingest for "my agent is blocked on you".
 *
 * The agent parks a worker thread on a threading.Event when a dangerous command
 * needs approval, and pushes an `approval.request` frame down the workspace
 * iframe's /api/ws socket. Nothing is pollable on the box (tui_gateway registers
 * `approval.respond` but no list/query method), so if the owner isn't watching
 * that iframe the agent just looks idle until it times out and unwinds as denied.
 *
 * The hivra_approval_relay plugin fires this route from the agent's existing
 * pre_approval_request / post_approval_response hooks.
 *
 * Auth: the caller presents the per-instance `api_server_key` as a bearer. We
 * look up that instance's encrypted key and timingSafeEqual it. No Clerk session
 * — this is server-to-server, originating inside the user's VM. Same shape as
 * /api/agent-usage/ingest and /api/internal/tier-check.
 *
 * NOTE: this route MUST live outside /api/instances/, which is Clerk-protected
 * by the middleware matcher in src/proxy.ts. (That's why /api/u/[id] exists as
 * an alias for the update-report route.)
 */

import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { decryptApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

const ROUTE = "/api/internal/agent-notify";
const SOURCE = "agent-notify-ingest";

const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = 300;

const PendingSchema = z.object({
  event: z.literal("prompt.pending"),
  instance_id: z.string().uuid(),
  prompt_id: z.string().min(1).max(128),
  kind: z.enum(["approval", "clarify"]).default("approval"),
  surface: z.string().max(32).optional(),
  summary: z.string().max(512).optional(),
  command: z.string().max(2048).optional(),
  session_key: z.string().max(256).optional(),
  ttl_seconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
});

const ResolvedSchema = z.object({
  event: z.literal("prompt.resolved"),
  instance_id: z.string().uuid(),
  prompt_id: z.string().min(1).max(128),
  kind: z.enum(["approval", "clarify"]).default("approval"),
  surface: z.string().max(32).optional(),
  session_key: z.string().max(256).optional(),
  choice: z.enum(["once", "session", "always", "deny", "timeout"]).default("timeout"),
});

const PayloadSchema = z.discriminatedUnion("event", [PendingSchema, ResolvedSchema]);

function bearerFromRequest(request: NextRequest): string | null {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

interface InstanceAuthRow {
  id: string;
  user_id: string;
  api_server_key_encrypted: string | null;
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return apiError("Database is not configured", 500, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: SOURCE,
        failureType: "supabase_unconfigured",
      });
    }

    const bearer = bearerFromRequest(request);
    if (!bearer) {
      return apiError("Unauthorized", 401, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: SOURCE,
        failureType: "missing_bearer",
        logLevel: "warn",
      });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("Invalid JSON body", 400, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: SOURCE,
        failureType: "invalid_json",
      });
    }

    const parsed = PayloadSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid payload", 400, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: SOURCE,
        failureType: "invalid_payload",
      });
    }

    const payload = parsed.data;

    const { data: instance, error: instanceError } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, user_id, api_server_key_encrypted")
      .eq("id", payload.instance_id)
      .neq("status", "deleted")
      .maybeSingle<InstanceAuthRow>();

    if (instanceError) {
      return apiError("Failed to load agent", 500, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: SOURCE,
        failureType: "instance_lookup_failed",
        instanceId: payload.instance_id,
      });
    }

    // Unknown instance and missing key are both "unauthorized" — never confirm
    // an instance id to an unauthenticated caller.
    if (!instance?.api_server_key_encrypted) {
      return apiError("Unauthorized", 401, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: SOURCE,
        failureType: "unknown_instance_or_missing_key",
        instanceId: payload.instance_id,
        logLevel: "warn",
      });
    }

    let storedKey = "";
    try {
      storedKey = decryptApiKey(instance.api_server_key_encrypted);
    } catch {
      storedKey = "";
    }

    if (!storedKey || !safeEqual(storedKey, bearer)) {
      // Expected during an api_server_key drift window — see
      // webui-handoff-key-resync.ts / recoverApiServerKeyFromVm.
      return apiError("Unauthorized", 401, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: SOURCE,
        failureType: "bearer_mismatch",
        instanceId: payload.instance_id,
        logLevel: "warn",
      });
    }

    if (payload.event === "prompt.resolved") {
      // Idempotent: a resolve for a prompt we never saw (relay dropped the
      // pending event on a full queue) is a no-op, not an error.
      const { error } = await supabaseAdmin
        .from("instance_pending_prompts")
        .update({
          resolved_at: new Date().toISOString(),
          resolved_choice: payload.choice,
        })
        .eq("instance_id", payload.instance_id)
        .eq("prompt_id", payload.prompt_id)
        .is("resolved_at", null);

      if (error) {
        return apiError("Failed to resolve prompt", 500, undefined, undefined, {
          route: ROUTE,
          method: "POST",
          source: SOURCE,
          failureType: "resolve_write_failed",
          instanceId: payload.instance_id,
        });
      }

      return apiSuccess({ event: "prompt.resolved", promptId: payload.prompt_id });
    }

    const ttlSeconds = payload.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    const now = Date.now();

    const { error } = await supabaseAdmin.from("instance_pending_prompts").upsert(
      {
        instance_id: payload.instance_id,
        prompt_id: payload.prompt_id,
        user_id: instance.user_id,
        kind: payload.kind,
        surface: payload.surface ?? null,
        summary: payload.summary ?? null,
        command: payload.command ?? null,
        session_key: payload.session_key ?? null,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
        // A retried pending event re-opens the row rather than leaving a stale
        // resolution behind.
        resolved_at: null,
        resolved_choice: null,
      },
      { onConflict: "instance_id,prompt_id" }
    );

    if (error) {
      return apiError("Failed to record prompt", 500, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: SOURCE,
        failureType: "pending_write_failed",
        instanceId: payload.instance_id,
      });
    }

    // Deliberately NO ops_events write here. The instance_pending_prompts row
    // IS the operator-queryable record. Writing a distinct-fingerprint
    // ops_event per approval (prompt_id in the message) accumulated unbounded
    // never-archived rows and — because getLatestInstanceFailureAlerts fetches
    // the newest ~8×N ops_events with no source filter and only skips
    // synthetic.* in JS afterward — a busy agent's approval rows could consume
    // that budget and evict a genuine failure alert, hiding a real failure
    // badge. Operators read instance_pending_prompts directly instead.

    return apiSuccess({ event: "prompt.pending", promptId: payload.prompt_id });
  } catch (err) {
    return handleApiError(err);
  }
}
