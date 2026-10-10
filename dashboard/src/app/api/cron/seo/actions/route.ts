/**
 * Cron/automation endpoint: record SEO actions.
 *
 * POST body upserts a row into seo_actions. Without an `id` the row is
 * inserted (a new action the analyst brief surfaced); with an `id` the
 * existing row is updated (status transitions, PR link, result notes as
 * the action moves through its lifecycle).
 *
 * Auth: Bearer CRON_SECRET — this is written to by automation (the SEO
 * analyst loop), not by browsers.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const LOG_SOURCE = "cron:seo-actions";

interface SeoActionBody {
  id?: string;
  action_type?: string;
  target?: string;
  score?: number;
  rationale?: string;
  status?: string;
  pr_url?: string | null;
  result?: string | null;
}

/**
 * Manual field-by-field validation (the cron routes in this repo do not
 * use zod). Returns the sanitized payload or a string describing the
 * first problem.
 */
function parseBody(raw: unknown): { payload: SeoActionBody } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const payload: SeoActionBody = {};

  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !body.id) {
      return { error: "`id` must be a non-empty string" };
    }
    payload.id = body.id;
  }

  const stringFields = ["action_type", "target", "rationale", "status"] as const;
  for (const field of stringFields) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string" || !body[field]) {
        return { error: `\`${field}\` must be a non-empty string` };
      }
      payload[field] = body[field] as string;
    }
  }

  if (body.score !== undefined) {
    if (typeof body.score !== "number" || !Number.isFinite(body.score)) {
      return { error: "`score` must be a finite number" };
    }
    payload.score = body.score;
  }

  const nullableFields = ["pr_url", "result"] as const;
  for (const field of nullableFields) {
    if (body[field] !== undefined) {
      if (body[field] !== null && typeof body[field] !== "string") {
        return { error: `\`${field}\` must be a string or null` };
      }
      payload[field] = body[field] as string | null;
    }
  }

  if (!payload.id) {
    // Inserts need the full action shape.
    if (!payload.action_type || !payload.target || payload.score === undefined || !payload.rationale) {
      return {
        error: "Inserts require `action_type`, `target`, `score` and `rationale` (or pass `id` to update)",
      };
    }
  }

  return { payload };
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: LOG_SOURCE,
      route: "/api/cron/seo/actions",
      method: "POST",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const db = supabaseAdmin;
  if (!db) {
    return apiError("Supabase admin client is not configured", 500);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError("Body must be valid JSON", 400);
  }

  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return apiError(parsed.error, 400);
  }
  const { id, ...fields } = parsed.payload;

  try {
    if (id) {
      const { data, error } = await db
        .from("seo_actions")
        .update(fields)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        return apiError(`No seo_actions row with id ${id}`, 404);
      }
      return apiSuccess({ mode: "updated", action: data });
    }

    const { data, error } = await db
      .from("seo_actions")
      .insert({ status: "proposed", ...fields })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return apiSuccess({ mode: "inserted", action: data });
  } catch (err) {
    log.error("seo-actions write failed", err, {
      source: LOG_SOURCE,
      route: "/api/cron/seo/actions",
      method: "POST",
      failureType: "seo_actions_write_failed",
    });
    const message = err instanceof Error ? err.message : "seo_actions write failed";
    return apiError(message, 500);
  }
}
