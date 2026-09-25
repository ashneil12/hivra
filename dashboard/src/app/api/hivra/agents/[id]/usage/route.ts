// A computer's live usage and uptime for Manage › Overview (GET, read-only).
//
// Owner-scoped like its neighbours: another owner's computer, a deleted one
// or a malformed id is a 404. Proxmox computers (Hivra Cloud, My server and
// prepared) are read from their host by one read-only script behind the same
// ownership checks as Stop (computer-usage.ts); the read takes no lock and no
// operation lease, so it never waits behind a long operation. Reads are
// cached per computer (computer-usage-cache.ts): at most one host read per
// computer per 20 s across every server instance, and the last observation is
// still served when the host can't be reached. `?cached=1` never reads the
// host. Other computers get what Hivra already holds for them (status and
// size) and why live usage isn't available.
//
// The response never carries a host name, address, binding value or bearer.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
  type HivraAgentInfrastructureBinding,
} from "@/lib/hivra/agent-execution-context";
import { matchPreparedCanaryComputer } from "@/lib/hivra/prepared-canary-computers";
import { hivraInfrastructureBindingTag, isHivraInfrastructureBindingTokenHash } from "@/lib/hivra/agent-authority";
import { hasOwnershipBinding, isPreparedProfile, isWindowsOnMyServer } from "@/lib/hivra/lifecycle-support";
import {
  COMPUTER_USAGE_FRESH_SECONDS,
  type ComputerUsageView,
} from "@/lib/hivra/computer-usage-contract";
import {
  buildHivraComputerUsageScript,
  parseHivraComputerUsageOutput,
  proxmoxUsageView,
  readStoredUsage,
  statusOnlyUsageView,
  storedUsageFor,
  type HivraComputerUsageIdentity,
  type HivraUsageProbeOutcome,
} from "@/lib/hivra/computer-usage";
import {
  claimComputerUsageRefresh,
  readComputerUsageCache,
  recordComputerUsage,
  singleFlightUsageRead,
  type ComputerUsageCacheRow,
} from "@/lib/hivra/computer-usage-cache";

const SOURCE = "hivra/agents/[id]/usage";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROBE_TIMEOUT_MS = 20_000;

const USAGE_SELECT = [
  "id", "user_id", "type", "status", "desired_state", "computer_substrate", "computer_profile", "deployment_mode",
  "proxmox_host", "vmid", "ip", "cpu", "ram", "managed_provisioner_channel",
  "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced",
  "provider_capacity_order_id", "provider_enrollment_attempt_id", "provider_server_id",
  "gvisor_observation", "do_session_size",
].join(",");

const USAGE_MESSAGES = {
  bindingMismatch: "Hivra couldn't confirm this computer belongs to you, so it didn't read it.",
  hostUnreachable: "Hivra couldn't reach this computer's host just now.",
  preparedMismatch: "This prepared computer no longer matches the setup Hivra has on record, so Hivra didn't read it.",
  notReady: "Usage appears once this computer is set up.",
  notBound: "Live usage isn't available for this computer. It was created before Hivra recorded ownership checks.",
  cacheUnavailable: "Hivra couldn't load this computer's usage just now.",
} as const;

type AgentRow = Record<string, unknown> & HivraAgentInfrastructureBinding & {
  id: string;
  user_id: string;
  status: string;
  type?: unknown;
  computer_profile?: unknown;
  vmid?: unknown;
  ip?: unknown;
};

function respond(data: ComputerUsageView, status = 200) {
  const response = apiSuccess(data, status);
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}

function fail(message: string, status: number) {
  const response = apiError(message, status);
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** DigitalOcean, Linux Sandbox and My cloud: what Hivra holds, and why no live usage. */
function statusOnly(row: AgentRow): ComputerUsageView | null {
  const recordedStatus = String(row.status);
  if (row.computer_substrate === "do-managed-session") {
    return statusOnlyUsageView({
      source: "digitalocean",
      reason: "Live usage isn't available for DigitalOcean sessions. Status and last activity come from DigitalOcean.",
      recordedStatus,
      size: { cpu: numberOr(row.cpu, 0), ramGb: numberOr(row.ram, 0) },
    });
  }
  if (row.computer_substrate === "gvisor") {
    const observation = row.gvisor_observation && typeof row.gvisor_observation === "object"
      ? row.gvisor_observation as Record<string, unknown> : {};
    const cpu = numberOr(observation.cpu, numberOr(row.cpu, 0));
    const memoryMb = Number(observation.memoryMb);
    return statusOnlyUsageView({
      source: "gvisor",
      reason: "Live usage isn't available for Linux Sandboxes yet.",
      recordedStatus,
      size: { cpu, ramGb: Number.isFinite(memoryMb) && memoryMb > 0 ? Math.round((memoryMb / 1024) * 10) / 10 : numberOr(row.ram, 0) },
    });
  }
  if (row.computer_substrate === "provider-vm") {
    // No new provider calls: the size and status Hivra already stores.
    return statusOnlyUsageView({
      source: "hetzner",
      reason: "Live usage isn't available for My cloud computers yet. Your provider's console shows it.",
      recordedStatus,
      size: { cpu: numberOr(row.cpu, 0), ramGb: numberOr(row.ram, 0) },
    });
  }
  return null;
}

type Authority = { env: Record<string, string | undefined>; identity: HivraComputerUsageIdentity };

/** Where to read and what the host must confirm first, or a refusal. */
async function proxmoxAuthority(userId: string, row: AgentRow, vmid: number): Promise<Authority | Response> {
  if (isPreparedProfile(row) && !isWindowsOnMyServer(row)) {
    const prepared = matchPreparedCanaryComputer(row);
    if (!prepared) return fail(USAGE_MESSAGES.preparedMismatch, 409);
    // A prepared computer is bound on claim; one claimed before that is
    // still checked by its claim marker and VM name, like its power controls.
    const bindingTag = hasOwnershipBinding(row) && isHivraInfrastructureBindingTokenHash(row.infrastructure_binding_token_hash)
      ? hivraInfrastructureBindingTag(row.infrastructure_binding_token_hash) : null;
    return {
      env: resolveProxmoxTargetConfiguration(process.env, prepared.slot.host).env,
      identity: {
        vmid: prepared.slot.vmid,
        bindingTag,
        legacyName: null,
        prepared: {
          encodedMarker: `hivra-${prepared.profile}-operation%3A${prepared.slot.claim}`,
          plainMarker: `hivra-${prepared.profile}-operation:${prepared.slot.claim}`,
          name: `hivra-${prepared.profile}-canary`,
        },
      },
    };
  }
  let context;
  try {
    context = await resolveHivraAgentExecutionContext(userId, row);
  } catch (error) {
    const safe = describeHivraAgentExecutionContextError(error);
    if (safe) return fail(safe.message, safe.status);
    throw error;
  }
  // Every current computer carries its binding tag. An older Hivra Cloud one
  // without it is read under the exact host and VMID Stop accepts, plus its
  // exact VM name.
  const enforced = context.infrastructureBindingTagEnforced;
  return {
    env: context.env,
    identity: {
      vmid,
      bindingTag: enforced ? context.infrastructureBindingTag : null,
      legacyName: enforced ? null : `hivra-cc-${vmid}`,
      prepared: null,
    },
  };
}

type ReadResult =
  | { kind: "outcome"; outcome: HivraUsageProbeOutcome }
  | { kind: "failed"; code: "host_unreachable" | "probe_invalid" };

async function readHost(authority: Authority, agentId: string): Promise<ReadResult> {
  return singleFlightUsageRead(agentId, async () => {
    const result = await runProxmoxHostScript(
      buildHivraComputerUsageScript(authority.identity),
      authority.env,
      { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: 16_384 },
    );
    try {
      const outcome = parseHivraComputerUsageOutput(result.stdout);
      // A sample only counts from a script that finished; the two markers are
      // decisive either way.
      if (outcome.kind === "sample" && !result.ok) return { kind: "failed", code: "probe_invalid" } as const;
      return { kind: "outcome", outcome } as const;
    } catch {
      return { kind: "failed", code: result.ok ? "probe_invalid" : "host_unreachable" } as const;
    }
  });
}

/** The last read failed, so what is stored is older than it looks. */
const READ_FAILURES = new Set(["host_unreachable", "probe_invalid", "context_unavailable"]);

function viewFrom(row: AgentRow, cache: ComputerUsageCacheRow | null, options: { refreshing: boolean }): ComputerUsageView {
  return proxmoxUsageView({
    stored: readStoredUsage(cache?.sample),
    observedAt: cache?.observedAt ?? null,
    recordedStatus: String(row.status),
    now: new Date(),
    refreshing: options.refreshing,
    hostUnreachable: Boolean(cache?.lastErrorCode && READ_FAILURES.has(cache.lastErrorCode)),
  });
}

/** The identity check failed and nothing verified is stored. */
function refusedByBinding(cache: ComputerUsageCacheRow | null): boolean {
  return cache?.lastErrorCode === "binding_mismatch" && !readStoredUsage(cache.sample);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return fail("Not found", 404);
    const { userId } = await auth();
    if (!userId) return fail("Unauthorized", 401);
    if (!supabaseAdmin) return fail("Database not configured", 500);
    const { id } = await params;
    if (!UUID.test(id)) return fail("Agent not found", 404);

    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .select(USAGE_SELECT)
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle();
    if (error) return fail("Could not load this computer.", 503);
    if (!data) return fail("Agent not found", 404);
    const row = data as unknown as AgentRow;

    const limited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_computer_usage", userId, limit: 30, windowMs: 5 * 60_000,
    });
    if (limited) return limited;

    const other = statusOnly(row);
    if (other) return respond(other);

    // Proxmox from here: Hivra Cloud, My server and prepared computers.
    if (row.deployment_mode === "self-managed" && !hasOwnershipBinding(row)) return fail(USAGE_MESSAGES.notBound, 409);
    const vmid = Number(row.vmid);
    if (!Number.isSafeInteger(vmid) || vmid < 100) return fail(USAGE_MESSAGES.notReady, 409);

    const cachedOnly = req.nextUrl.searchParams.get("cached") === "1";
    let cache: ComputerUsageCacheRow | null;
    try {
      cache = await readComputerUsageCache(row.id, userId);
    } catch {
      return fail(USAGE_MESSAGES.cacheUnavailable, 503);
    }
    if (cachedOnly && refusedByBinding(cache)) return fail(USAGE_MESSAGES.bindingMismatch, 409);
    const stored = readStoredUsage(cache?.sample);
    const observedMs = cache?.observedAt ? Date.parse(cache.observedAt) : Number.NaN;
    const statusChanged = stored !== null && stored.recordedStatus !== String(row.status);
    const fresh = stored !== null && !statusChanged && Number.isFinite(observedMs)
      && Date.now() - observedMs < COMPUTER_USAGE_FRESH_SECONDS * 1000;
    if (cachedOnly || fresh) {
      return respond(viewFrom(row, cache, { refreshing: false }));
    }

    let claim;
    try {
      claim = await claimComputerUsageRefresh({ agentId: row.id, userId, source: "proxmox", force: statusChanged });
    } catch {
      return cache ? respond(viewFrom(row, cache, { refreshing: false })) : fail(USAGE_MESSAGES.cacheUnavailable, 503);
    }
    if (!claim.claimed) {
      // Someone else is reading the host (or just did): serve what is stored.
      const latest = claim.row ?? cache;
      if (refusedByBinding(latest)) return fail(USAGE_MESSAGES.bindingMismatch, 409);
      const nowFresh = Boolean(latest?.observedAt) && readStoredUsage(latest?.sample)?.recordedStatus === String(row.status)
        && Date.now() - Date.parse(String(latest?.observedAt)) < COMPUTER_USAGE_FRESH_SECONDS * 1000;
      return respond(viewFrom(row, latest, { refreshing: !nowFresh }));
    }

    const authority = await proxmoxAuthority(userId, row, vmid);
    if (authority instanceof Response) {
      await recordComputerUsage({ agentId: row.id, userId, sample: null, errorCode: "context_unavailable" }).catch(() => null);
      return authority;
    }

    const read = await readHost(authority, row.id);
    if (read.kind === "failed") {
      log.warn("hivra computer usage could not be read", {
        source: SOURCE, failureType: "hivra_usage_read_failed", userId, agentId: row.id, code: read.code,
      });
      const kept = await recordComputerUsage({ agentId: row.id, userId, sample: null, errorCode: read.code }).catch(() => null);
      const latest = kept ?? (cache ? { ...cache, lastErrorCode: read.code } : null);
      if (!readStoredUsage(latest?.sample)) return fail(USAGE_MESSAGES.hostUnreachable, 503);
      return respond(viewFrom(row, latest, { refreshing: false }));
    }
    if (read.outcome.kind === "binding_mismatch") {
      log.error("hivra computer usage refused: the host's computer does not carry this row's identity", new Error("Usage binding mismatch"), {
        source: SOURCE, failureType: "hivra_usage_binding_mismatch", userId, agentId: row.id, vmid,
      });
      await recordComputerUsage({ agentId: row.id, userId, sample: null, errorCode: "binding_mismatch", clearSample: true }).catch(() => null);
      return fail(USAGE_MESSAGES.bindingMismatch, 409);
    }
    const next = storedUsageFor(read.outcome, String(row.status));
    const saved = await recordComputerUsage({ agentId: row.id, userId, sample: next, errorCode: null }).catch(() => null);
    return respond(viewFrom(row, saved ?? { sample: next, observedAt: new Date().toISOString(), lastErrorCode: null }, { refreshing: false }));
  } catch (error) {
    return handleApiError(error);
  }
}
