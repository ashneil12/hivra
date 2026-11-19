import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { isOpsAdminUser, verifiedPrimaryEmailOf } from "@/lib/ops-access";
import { COMPONENT_NAMES } from "@/lib/status/derive-status";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SEVERITIES = ["degraded", "down", "maintenance"] as const;
const COLUMNS = "id, title, body, component, severity, started_at, resolved_at, published, created_at, updated_at";

/** Admin only: Bearer CRON_SECRET, or a Clerk session for an ops admin. Returns an error response or null. */
async function denyUnlessAdmin(req: NextRequest) {
  if (verifyBearerHeader(req, process.env.CRON_SECRET)) return null;
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  const user = await currentUser();
  if (!isOpsAdminUser({ userId, email: verifiedPrimaryEmailOf(user) })) return apiError("Forbidden", 403);
  return null;
}

function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function validComponent(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" && value in COMPONENT_NAMES ? value : undefined;
}

function validTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * POST /api/admin/status-incidents
 * { title, body?, component?, severity, startedAt?, published? }
 * component is one of: website, launching, ai, computers.
 */
export async function POST(req: NextRequest) {
  const denied = await denyUnlessAdmin(req);
  if (denied) return denied;
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  let input: Record<string, unknown>;
  try {
    input = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError("Invalid JSON", 400);
  }
  const title = text(input.title, 200);
  const severity = input.severity;
  const component = validComponent(input.component);
  if (!title) return apiError("title is required", 400);
  if (!SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) return apiError("severity is invalid", 400);
  if (input.component !== undefined && component === undefined) return apiError("component is invalid", 400);

  const row: Record<string, unknown> = {
    title,
    body: text(input.body, 2000) ?? null,
    component: component ?? null,
    severity,
    published: input.published === true,
  };
  if (input.startedAt !== undefined) {
    const startedAt = validTime(input.startedAt);
    if (!startedAt) return apiError("startedAt is invalid", 400);
    row.started_at = startedAt;
  }

  const { data, error } = await supabaseAdmin.from("hivra_status_incidents").insert(row).select(COLUMNS).single();
  if (error) return apiError("Could not save the incident", 500);
  return apiSuccess({ incident: data });
}

/**
 * PATCH /api/admin/status-incidents
 * { id, resolve?: boolean, published?, title?, body?, severity?, component? }
 * resolve: true stamps resolved_at now; resolve: false reopens.
 */
export async function PATCH(req: NextRequest) {
  const denied = await denyUnlessAdmin(req);
  if (denied) return denied;
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  let input: Record<string, unknown>;
  try {
    input = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError("Invalid JSON", 400);
  }
  if (typeof input.id !== "string" || !input.id) return apiError("id is required", 400);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.resolve === true) patch.resolved_at = new Date().toISOString();
  else if (input.resolve === false) patch.resolved_at = null;
  if (typeof input.published === "boolean") patch.published = input.published;
  if (input.title !== undefined) {
    const title = text(input.title, 200);
    if (!title) return apiError("title is invalid", 400);
    patch.title = title;
  }
  if (input.body !== undefined) patch.body = text(input.body, 2000) ?? null;
  if (input.severity !== undefined) {
    if (!SEVERITIES.includes(input.severity as (typeof SEVERITIES)[number])) return apiError("severity is invalid", 400);
    patch.severity = input.severity;
  }
  if (input.component !== undefined) {
    const component = validComponent(input.component);
    if (component === undefined) return apiError("component is invalid", 400);
    patch.component = component;
  }

  const { data, error } = await supabaseAdmin
    .from("hivra_status_incidents")
    .update(patch)
    .eq("id", input.id)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return apiError("Could not update the incident", 500);
  if (!data) return apiError("Incident not found", 404);
  return apiSuccess({ incident: data });
}
