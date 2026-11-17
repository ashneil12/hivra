// An agent computer's allowed sites (Manage › Advanced › Privacy).
//
// GET reads the owner's list and whether its server enforces it; PUT turns the
// limit on or off and replaces the list, then writes it to the computer's
// Proxmox host. Owner-scoped: another owner's agent, a deleted one or a
// malformed id is a 404. While NEXT_PUBLIC_HIVRA_ALLOWED_SITES is off the route
// answers 404 so the dashboard hides the control.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { resolveSleepTarget } from "@/lib/hivra/agent-wake";
import { runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import {
  MAX_ALLOWED_SITES,
  allowedSitesEnabled,
  applyOutcome,
  buildAllowedSitesHostScript,
  buildEgressPolicy,
  normalizeSites,
  parseEgressReceipt,
  requiredSites,
} from "@/lib/hivra/allowed-sites";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";

const SOURCE = "hivra/agents/[id]/allowed-sites";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_TIMEOUT_MS = 45_000;
const Body = z.object({
  enabled: z.boolean(),
  sites: z.array(z.string().max(300)).max(MAX_ALLOWED_SITES * 2),
}).strict();

type StoredRow = {
  enabled: boolean;
  sites: string[];
  apply_state: string;
  apply_error: string | null;
  applied_at: string | null;
  updated_at: string;
};

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}

function disabled() {
  return noStore(apiError("Not found", 404, undefined, { code: "feature_disabled" }));
}

async function loadAgent(userId: string, id: string) {
  if (!UUID.test(id)) return null;
  const { data, error } = await supabaseAdmin!
    .from("hivra_agents")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Could not load this agent");
  const row = data as (Record<string, unknown> & { status?: string; vmid?: number | null; computer_substrate?: string | null }) | null;
  if (!row || row.status === "deleted") return null;
  return row;
}

function view(row: StoredRow | null) {
  return {
    enabled: row?.enabled ?? false,
    sites: row?.sites ?? [],
    applyState: row?.apply_state ?? null,
    applyError: row?.apply_error ?? null,
    appliedAt: row?.applied_at ?? null,
    updatedAt: row?.updated_at ?? null,
    alwaysAllowed: requiredSites(),
    maxSites: MAX_ALLOWED_SITES,
  };
}

async function readStored(agentId: string): Promise<StoredRow | null> {
  const { data, error } = await supabaseAdmin!
    .from("hivra_agent_allowed_sites")
    .select("enabled, sites, apply_state, apply_error, applied_at, updated_at")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) throw new Error("Could not read this computer's allowed sites");
  return (data as StoredRow | null) ?? null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!allowedSitesEnabled()) return disabled();
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!supabaseAdmin) return noStore(apiError("Database not configured", 500));
    const { id } = await params;
    const agent = await loadAgent(userId, id);
    if (!agent) return noStore(apiError("Agent not found", 404));
    return noStore(apiSuccess(view(await readStored(String(agent.id)))));
  } catch (err) {
    return noStore(handleApiError(err));
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!allowedSitesEnabled()) return disabled();
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!supabaseAdmin) return noStore(apiError("Database not configured", 500));
    if (!isSameOriginMutationRequest(req)) return noStore(apiError("Change allowed sites from the Hivra dashboard.", 403));
    if (!hasStrictJsonContentType(req)) return noStore(apiError("Send the list as JSON.", 415));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_allowed_sites", userId, ...RATE_LIMIT_PRESETS.secretWrite });
    if (limited) return noStore(limited);
    const body = await readBoundedJson(req, 32 * 1024, 5000);
    if (!body.ok) return noStore(apiError("Send a list of at most 32 KB.", body.reason === "too_large" ? 413 : 400));
    const parsed = Body.safeParse(body.body);
    if (!parsed.success) return noStore(apiError(`Send "enabled" and up to ${MAX_ALLOWED_SITES} sites.`, 400));

    const { id } = await params;
    const agent = await loadAgent(userId, id);
    if (!agent) return noStore(apiError("Agent not found", 404));
    if (agent.computer_substrate && agent.computer_substrate !== "proxmox-kvm") {
      return noStore(apiError("Allowed sites work on Hivra computers only.", 409, undefined, { code: "unsupported_computer" }));
    }

    const { sites, rejected } = normalizeSites(parsed.data.sites);
    if (rejected.length > 0) {
      return noStore(apiError(`These can't be used: ${rejected.map((r) => `${r.input} (${r.reason})`).join(", ")}.`, 400, undefined, { code: "invalid_sites", rejected }));
    }
    if (sites.length > MAX_ALLOWED_SITES) return noStore(apiError(`List at most ${MAX_ALLOWED_SITES} sites.`, 400));

    const agentId = String(agent.id);
    const now = new Date().toISOString();
    const { error: saveError } = await supabaseAdmin
      .from("hivra_agent_allowed_sites")
      .upsert({ agent_id: agentId, user_id: userId, enabled: parsed.data.enabled, sites, apply_state: "pending", apply_error: null, updated_at: now }, { onConflict: "agent_id" });
    if (saveError) throw new Error("Could not save this computer's allowed sites");

    // Write it to the computer's host. The list is saved either way.
    let outcome = applyOutcome(null);
    try {
      const resolved = await resolveSleepTarget(agent, SOURCE);
      if (!resolved.ok || !resolved.target.bindingTag) {
        outcome = { state: "failed", error: "This computer's server can't be reached for this change right now. Your list is saved; save again to retry." };
      } else {
        const { vmid, bindingTag, env } = resolved.target;
        const mode = parsed.data.enabled ? "set" : "remove";
        const policy = buildEgressPolicy({ vmid, bindingTag, sites });
        const run = await runProxmoxHostScriptWithStdin(
          buildAllowedSitesHostScript({ vmid, bindingTag, mode }),
          mode === "set" ? JSON.stringify(policy) : "",
          env,
          { timeoutMs: HOST_TIMEOUT_MS },
        );
        outcome = applyOutcome(parseEgressReceipt(run?.stdout ?? "", vmid));
        if (!parsed.data.enabled && outcome.state === "saved") outcome = { state: "applied", error: null };
      }
    } catch (error) {
      log.warn("allowed sites: host write failed", { source: SOURCE, agentId, failureType: "allowed_sites_host_write_failed", error: error instanceof Error ? error.message : String(error) });
    }

    const { error: stateError } = await supabaseAdmin
      .from("hivra_agent_allowed_sites")
      .update({ apply_state: outcome.state, apply_error: outcome.error, ...(outcome.state === "applied" ? { applied_at: new Date().toISOString() } : {}) })
      .eq("agent_id", agentId);
    if (stateError) log.warn("allowed sites: state write failed", { source: SOURCE, agentId, failureType: "allowed_sites_state_write_failed" });
    log.info("allowed sites saved", { source: SOURCE, agentId, enabled: parsed.data.enabled, count: sites.length, state: outcome.state });

    return noStore(apiSuccess(view(await readStored(agentId))));
  } catch (err) {
    return noStore(handleApiError(err));
  }
}
