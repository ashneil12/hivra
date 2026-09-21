export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { decryptApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { normalizeUsageRows } from "./usage-normalization";

const ROUTE = "/api/agent-usage/ingest";
const INSTANCE_SOURCE = "agent_usage_beacon";
const OPERATOR_SOURCE = "operator_usage_beacon";
const MAX_DAYS = 90;

const PayloadSchema = z.object({
  instanceId: z.string().uuid(),
  days: z.array(z.unknown()).min(1).max(MAX_DAYS),
});

function bearerFromRequest(request: NextRequest): string | null {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1]?.trim();
  return bearer || null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export async function POST(request: NextRequest) {
  try {
    const bearer = bearerFromRequest(request);
    if (!bearer) {
      return apiError("Unauthorized", 401, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: INSTANCE_SOURCE,
        failureType: "missing_bearer",
        logLevel: "warn",
      });
    }

    if (!supabaseAdmin) {
      return apiError("Database not configured", 500, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: INSTANCE_SOURCE,
        failureType: "supabase_admin_missing",
      });
    }

    const parsed = PayloadSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return apiError(parsed.error.issues[0]?.message || "Invalid usage payload", 400, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: INSTANCE_SOURCE,
        failureType: "invalid_payload",
      });
    }

    const days = normalizeUsageRows(parsed.data.days);
    if (!days) {
      return apiError("Invalid usage rows", 400, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: INSTANCE_SOURCE,
        failureType: "invalid_usage_rows",
        instanceId: parsed.data.instanceId,
      });
    }

    const { data: instance, error: instanceError } = await supabaseAdmin
      .from("hermes_instances")
      .select("api_server_key_encrypted")
      .eq("id", parsed.data.instanceId)
      .neq("status", "deleted")
      .maybeSingle<{ api_server_key_encrypted: string | null }>();

    if (instanceError) {
      return apiError("Failed to load agent", 500, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: INSTANCE_SOURCE,
        failureType: "instance_lookup_failed",
        instanceId: parsed.data.instanceId,
      });
    }

    const harvestedAt = new Date().toISOString();

    if (instance?.api_server_key_encrypted) {
      let storedKey = "";
      try {
        storedKey = decryptApiKey(instance.api_server_key_encrypted);
      } catch {
        storedKey = "";
      }

      if (!storedKey || !safeEqual(storedKey, bearer)) {
        return apiError("Unauthorized", 401, undefined, undefined, {
          route: ROUTE,
          method: "POST",
          source: INSTANCE_SOURCE,
          failureType: "bearer_mismatch",
          instanceId: parsed.data.instanceId,
          logLevel: "warn",
        });
      }

      const rows = days.map((day) => ({
        instance_id: parsed.data.instanceId,
        stat_date: day.stat_date,
        input_tokens: day.input_tokens,
        output_tokens: day.output_tokens,
        total_tokens: day.total_tokens,
        cache_read_tokens: day.cache_read_tokens,
        reasoning_tokens: day.reasoning_tokens,
        estimated_cost_usd: day.estimated_cost_usd,
        sessions: day.sessions,
        api_calls: day.api_calls,
        by_model: day.by_model,
        by_provider: day.by_provider,
        source: INSTANCE_SOURCE,
        harvested_at: harvestedAt,
      }));

      const { error: upsertError } = await supabaseAdmin
        .from("instance_usage_snapshots")
        .upsert(rows, { onConflict: "instance_id,stat_date" });

      if (upsertError) {
        return apiError("Failed to save usage snapshot", 500, undefined, undefined, {
          route: ROUTE,
          method: "POST",
          source: INSTANCE_SOURCE,
          failureType: "usage_snapshot_upsert_failed",
          instanceId: parsed.data.instanceId,
        });
      }

      const rollupDates = Array.from(new Set(days.map((day) => day.stat_date))).sort();
      let rollupOk = true;
      for (const statDate of rollupDates) {
        try {
          const { error: rollupError } = await supabaseAdmin.rpc("compute_platform_stats_snapshot", {
            p_date: statDate,
          });
          if (rollupError) rollupOk = false;
        } catch {
          rollupOk = false;
        }
      }

      return apiSuccess({
        ingested: rows.length,
        instanceId: parsed.data.instanceId,
        source: INSTANCE_SOURCE,
        rollupOk,
        rollupDates,
      });
    }

    const { data: operatorSource, error: operatorError } = await supabaseAdmin
      .from("operator_usage_sources")
      .select("id, name, source_type, api_key_sha256, active")
      .eq("id", parsed.data.instanceId)
      .eq("active", true)
      .maybeSingle<{
        id: string;
        name: string | null;
        source_type: string | null;
        api_key_sha256: string | null;
        active: boolean | null;
      }>();

    if (operatorError || !operatorSource?.api_key_sha256) {
      return apiError("Agent not found", 404, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: OPERATOR_SOURCE,
        failureType: "source_not_found",
        instanceId: parsed.data.instanceId,
      });
    }

    if (!safeEqual(operatorSource.api_key_sha256, sha256Hex(bearer))) {
      return apiError("Unauthorized", 401, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: OPERATOR_SOURCE,
        failureType: "bearer_hash_mismatch",
        instanceId: parsed.data.instanceId,
        logLevel: "warn",
      });
    }

    const sourceType = operatorSource.source_type || "internal_operator_canary";
    const rows = days.map((day) => ({
      source_id: operatorSource.id,
      source_type: sourceType,
      stat_date: day.stat_date,
      input_tokens: day.input_tokens,
      output_tokens: day.output_tokens,
      total_tokens: day.total_tokens,
      cache_read_tokens: day.cache_read_tokens,
      reasoning_tokens: day.reasoning_tokens,
      estimated_cost_usd: day.estimated_cost_usd,
      sessions: day.sessions,
      api_calls: day.api_calls,
      by_model: day.by_model,
      by_provider: day.by_provider,
      source: OPERATOR_SOURCE,
      harvested_at: harvestedAt,
    }));

    const { error: upsertError } = await supabaseAdmin
      .from("operator_usage_snapshots")
      .upsert(rows, { onConflict: "source_id,stat_date" });

    if (upsertError) {
      return apiError("Failed to save usage snapshot", 500, undefined, undefined, {
        route: ROUTE,
        method: "POST",
        source: OPERATOR_SOURCE,
        failureType: "operator_usage_snapshot_upsert_failed",
        instanceId: parsed.data.instanceId,
      });
    }

    let anchorOk = true;
    try {
      const { error: anchorError } = await supabaseAdmin.rpc("roll_token_anchor");
      if (anchorError) anchorOk = false;
    } catch {
      anchorOk = false;
    }

    return apiSuccess({
      ingested: rows.length,
      instanceId: parsed.data.instanceId,
      source: OPERATOR_SOURCE,
      rollupOk: true,
      anchorOk,
      rollupDates: Array.from(new Set(days.map((day) => day.stat_date))).sort(),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
