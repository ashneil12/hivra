export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

import { randomUUID } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { z } from "zod";

import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import {
  connectHivraNetbird,
  connectHivraTailscale,
  DEFAULT_TAILSCALE_LOGIN_SERVER,
  disconnectHivraTailscale,
  hivraPrivateAccessAuthority,
  hivraPrivateAccessReason,
  isCompatibleHivraPrivateAccessAgent,
  normalizeTailscaleLoginServer,
  observeHivraNetbird,
  observeHivraTailscale,
  reapplyHivraOutboundBlock,
  sameHivraPrivateAccessAuthority,
  type HivraPrivateAccessAgentRow,
  type HivraTailscaleReceipt,
} from "@/lib/hivra/tailscale-private-access";
import {
  isPrivateNetworkV2Enabled,
  normalizeNetbirdManagementUrl,
  privateAccessFailureMessage,
} from "@/lib/hivra/private-network";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";

const BODY_LIMIT = 2_048;
const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("connect"),
    authKey: z.string().min(1).max(1024).refine(value => !/[\r\n\0]/.test(value)),
    loginServer: z.string().max(500).optional(),
    provider: z.enum(["tailscale", "headscale", "netbird"]).optional(),
  }).strict(),
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("reapply") }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
]);

const AGENT_FIELDS = [
  "id","user_id","type","computer_profile","status","desired_state","operation_id","operation_kind",
  "vmid","ip","computer_substrate","deployment_mode","proxmox_host","infrastructure_connection_id",
  "deployment_target_id","infrastructure_connection_revision","infrastructure_binding_token_hash",
  "infrastructure_binding_token_enforced","managed_provisioner_channel",
].join(",");

type StoredConnection = {
  authority: Record<string, unknown>;
  state: HivraTailscaleReceipt["state"];
  machine_name: string | null;
  magic_dns_name: string | null;
  tailnet_name: string | null;
  login_server: string;
  ipv4: string | null;
  ipv6: string | null;
  connected_at: string | null;
  observed_at: string;
  failure_code: string | null;
  // Saved by the additive 20261112000200 migration; absent where it is not applied.
  provider?: "tailscale" | "headscale" | "netbird" | null;
  can_see_other_devices?: boolean | null;
  visible_peer_count?: number | null;
  tagged_hivra?: boolean | null;
  block_present?: boolean | null;
  client_version?: string | null;
};

const BASE_COLUMNS = "authority,state,machine_name,magic_dns_name,tailnet_name,login_server,ipv4,ipv6,connected_at,observed_at,failure_code";
const EXTRA_COLUMNS = "provider,can_see_other_devices,visible_peer_count,tagged_hivra,block_present,client_version";

type ActiveOperation = {
  id: string;
  action: "connect" | "disconnect";
  login_server: string;
  authority: Record<string, unknown>;
  phase: "claimed" | "dispatched";
};

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

function publicConnection(row: StoredConnection | null) {
  if (!row) return null;
  return {
    state: row.state,
    machineName: row.machine_name,
    magicDnsName: row.magic_dns_name,
    tailnetName: row.tailnet_name,
    loginServer: row.login_server,
    ipv4: row.ipv4,
    ipv6: row.ipv6,
    sshEnabled: false,
    connectedAt: row.connected_at,
    observedAt: row.observed_at,
    failureCode: row.failure_code,
    ...(row.provider ? { provider: row.provider === "netbird" ? "netbird" : "tailscale", providerKind: row.provider } : {}),
    ...(row.can_see_other_devices != null ? { canSeeOtherDevices: row.can_see_other_devices } : {}),
    ...(row.visible_peer_count != null ? { visiblePeerCount: row.visible_peer_count } : {}),
    ...(row.tagged_hivra != null ? { taggedHivra: row.tagged_hivra } : {}),
    ...(row.block_present != null ? { blockPresent: row.block_present } : {}),
    ...(row.client_version ? { clientVersion: row.client_version } : {}),
  };
}

/**
 * Keeps the provider and the computer's own view next to the saved connection,
 * so a reload still knows them. Best effort: where the migration is not applied
 * the columns do not exist, the write fails, and the live receipt still carries them.
 */
async function persistExtras(userId: string, agentId: string, receipt: HivraTailscaleReceipt,
  kind: "tailscale" | "headscale" | "netbird") {
  if (receipt.state !== "connected") return;
  try {
    await supabaseAdmin!.from("hivra_private_access_connections").update({
      provider: kind,
      can_see_other_devices: receipt.canSeeOtherDevices ?? null,
      visible_peer_count: receipt.visiblePeerCount ?? null,
      tagged_hivra: receipt.taggedHivra ?? null,
      block_present: receipt.blockPresent ?? null,
      client_version: receipt.clientVersion ?? null,
    }).eq("agent_id", agentId).eq("user_id", userId);
  } catch { /* best effort */ }
}

function providerKind(receipt: HivraTailscaleReceipt, stored: StoredConnection | null,
  requested?: "tailscale" | "headscale" | "netbird"): "tailscale" | "headscale" | "netbird" {
  if (receipt.provider === "netbird") return "netbird";
  if (requested) return requested;
  if (stored?.provider === "headscale" || stored?.provider === "tailscale") return stored.provider;
  return receipt.loginServer === DEFAULT_TAILSCALE_LOGIN_SERVER ? "tailscale" : "headscale";
}

async function loadOwned(id: string, userId: string) {
  const { data, error } = await supabaseAdmin!.from("hivra_agents").select(AGENT_FIELDS)
    .eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error("owner_lookup_failed");
  return data as unknown as HivraPrivateAccessAgentRow | null;
}

async function loadConnection(id: string, userId: string): Promise<StoredConnection | null> {
  const table = () => supabaseAdmin!.from("hivra_private_access_connections");
  const withExtras = await table().select(`${BASE_COLUMNS},${EXTRA_COLUMNS}`)
    .eq("agent_id", id).eq("user_id", userId).maybeSingle();
  if (!withExtras.error) return withExtras.data as StoredConnection | null;
  // The extra columns are missing where the migration is not applied: read what is there.
  const { data, error } = await table().select(BASE_COLUMNS)
    .eq("agent_id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error("connection_lookup_failed");
  return data as StoredConnection | null;
}

async function loadActiveOperation(id: string, userId: string): Promise<ActiveOperation | null> {
  const { data, error } = await supabaseAdmin!.from("hivra_private_access_operations")
    .select("id,action,login_server,authority,phase").eq("agent_id", id).eq("user_id", userId)
    .in("phase", ["claimed", "dispatched"]).maybeSingle();
  if (error) throw new Error("operation_lookup_failed");
  return data as ActiveOperation | null;
}

async function rpcBoolean(name: string, args: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await supabaseAdmin!.rpc(name, args);
  if (error || data !== true) return false;
  return true;
}

type Receipt = HivraTailscaleReceipt;
type OperationOutcome =
  | { response: Response }
  | { result: { ok: boolean; receipt: Receipt } };

/**
 * One leased guest change: reserve, dispatch, run, and save the exact result.
 * Used once for connect or disconnect, and twice when the owner switches network.
 */
async function runLeasedOperation(input: {
  userId: string;
  agentId: string;
  authority: Record<string, unknown>;
  action: "connect" | "disconnect";
  loginServer: string;
  run: () => Promise<{ ok: boolean; receipt: Receipt }>;
}): Promise<OperationOutcome> {
  const operationId = randomUUID();
  const claimed = await rpcBoolean("begin_hivra_private_access_operation", {
    p_user_id: input.userId, p_agent_id: input.agentId, p_operation_id: operationId,
    p_action: input.action, p_login_server: input.loginServer, p_expected_authority: input.authority,
  });
  if (!claimed) return { response: response({ success: false, code: "operation_conflict", error: "The computer changed or another operation started. Refresh Manage and retry." }, 409) };
  const dispatched = await rpcBoolean("dispatch_hivra_private_access_operation", {
    p_user_id: input.userId, p_operation_id: operationId,
  });
  if (!dispatched) {
    const cancelled = await rpcBoolean("cancel_undispatched_hivra_private_access_operation", {
      p_user_id: input.userId, p_operation_id: operationId,
    });
    return { response: response({ success: false, code: cancelled ? "operation_conflict" : "operation_pending",
      error: cancelled
        ? "The computer changed before private access started. Refresh Manage and retry."
        : "Private access was reserved but could not be cancelled safely. Retry after its status is reconciled." }, 409) };
  }
  let result: { ok: boolean; receipt: Receipt };
  try {
    result = await input.run();
  } catch {
    result = { ok: false, receipt: { state: "unknown", sshEnabled: false, loginServer: input.loginServer,
      observedAt: new Date().toISOString(), failureCode: "guest_command_failed" } };
  }
  const completed = await rpcBoolean("complete_hivra_private_access_operation", {
    p_user_id: input.userId, p_operation_id: operationId, p_success: result.ok, p_receipt: result.receipt,
  });
  if (!completed) return { response: response({ success: false, code: "completion_unconfirmed",
    error: "The guest command finished, but Hivra could not save its exact result. Refresh before retrying." }, 503) };
  return { result };
}

/** Tailscale first; NetBird too only when the v2 flag is on and Tailscale shows nothing. */
async function observeAnyNetwork(agent: HivraPrivateAccessAgentRow, loginServer: string) {
  const observed = await observeHivraTailscale(agent, loginServer);
  if (!isPrivateNetworkV2Enabled() || observed.connectionPresent !== false) return observed;
  const netbird = await observeHivraNetbird(agent, loginServer);
  return netbird.ok && netbird.connectionPresent === true ? netbird : observed;
}

type AuthenticationResult =
  | { failure: Response }
  | { userId: string; agent: HivraPrivateAccessAgentRow };

async function authenticate(request: NextRequest, id: string): Promise<AuthenticationResult> {
  const { userId } = await auth();
  if (!userId) return { failure: response({ success: false, error: "Unauthorized" }, 401) };
  if (!z.string().uuid().safeParse(id).success) {
    return { failure: response({ success: false, error: "Computer not found" }, 404) };
  }
  if (!supabaseAdmin) return { failure: response({ success: false, error: "Private access is unavailable." }, 503) };
  let agent: HivraPrivateAccessAgentRow | null;
  try { agent = await loadOwned(id, userId); }
  catch { return { failure: response({ success: false, error: "Private access is unavailable." }, 503) }; }
  if (!agent) return { failure: response({ success: false, error: "Computer not found" }, 404) };
  return { userId, agent };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await authenticate(request, id);
  if ("failure" in owner) return owner.failure;
  let connection: StoredConnection | null;
  try { connection = await loadConnection(id, owner.userId); }
  catch { return response({ success: false, error: "Private access is unavailable." }, 503); }
  // reason says why supported is false, so the panel can say "start this
  // computer" rather than refuse an eligible Ubuntu computer outright.
  const reason = hivraPrivateAccessReason(owner.agent);
  return response({ success: true, data: { supported: reason === null, reason,
    pending: owner.agent.operation_kind === "private_access" && owner.agent.operation_id != null,
    connection: publicConnection(connection) } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await authenticate(request, id);
  if ("failure" in owner) return owner.failure;
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
    return response({ success: false, error: "Request denied" }, 403);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return response({ success: false, error: "JSON required" }, 415);
  }
  const body = await readBoundedJson(request, BODY_LIMIT, 5_000);
  if (!body.ok) return response({ success: false, error: "Invalid request" }, body.reason === "too_large" ? 413 : 400);
  const parsed = inputSchema.safeParse(body.body);
  if (!parsed.success) return response({ success: false, error: "Invalid request" }, 400);
  const rateLimitBucket = parsed.data.action === "refresh" ? "read" : "write";
  const limited = !enforceRateLimit(`hivra_private_access:${rateLimitBucket}:${owner.userId}:${getIP(request)}:${id}`, {
    limit: parsed.data.action === "refresh" ? 12 : 3, windowMs: 15 * 60_000,
  }).success;
  if (limited) return response({ success: false, code: "rate_limited", error: "Wait before changing private access again." }, 429);
  if (owner.agent.operation_kind === "private_access" && owner.agent.operation_id != null) {
    if (parsed.data.action !== "refresh") {
      return response({ success: false, code: "operation_pending",
        error: "A private-access change is still being reconciled. Refresh its status before another change." }, 409);
    }
    let pending: ActiveOperation | null;
    try { pending = await loadActiveOperation(id, owner.userId); }
    catch { return response({ success: false, error: "Private access is unavailable." }, 503); }
    const authority = hivraPrivateAccessAuthority(owner.agent);
    if (!pending || pending.id !== owner.agent.operation_id || !sameHivraPrivateAccessAuthority(pending.authority, authority)) {
      return response({ success: false, code: "operation_pending",
        error: "The saved private-access operation could not be reconciled safely." }, 409);
    }
    if (pending.phase === "claimed") {
      const cancelled = await rpcBoolean("cancel_undispatched_hivra_private_access_operation", {
        p_user_id: owner.userId, p_operation_id: pending.id,
      });
      return response({ success: false, code: cancelled ? "operation_cancelled" : "operation_pending",
        error: cancelled ? "The private-access change had not reached the guest and was cancelled. Retry when ready."
          : "The private-access change is still pending." }, cancelled ? 409 : 202);
    }
    const observed = await observeAnyNetwork(owner.agent, pending.login_server);
    if (observed.receipt.state === "unknown") {
      return response({ success: false, code: "operation_pending", data: { supported: false, pending: true,
        connection: observed.receipt }, error: "The guest result is still uncertain. Refresh again after the computer is reachable." }, 202);
    }
    const succeeded = pending.action === "connect"
      ? observed.receipt.state === "connected" : observed.receipt.state === "disconnected";
    const completed = await rpcBoolean("complete_hivra_private_access_operation", {
      p_user_id: owner.userId, p_operation_id: pending.id, p_success: succeeded, p_receipt: observed.receipt,
    });
    if (!completed) return response({ success: false, code: "completion_unconfirmed",
      error: "The fresh guest result could not be saved. Refresh again before retrying." }, 503);
    return response({ success: succeeded, data: { supported: true, pending: false,
      connection: observed.receipt.state === "disconnected" ? null : observed.receipt },
      ...(!succeeded ? { error: "The private-access change did not reach its requested state." } : {}) }, succeeded ? 200 : 409);
  }
  if (!isCompatibleHivraPrivateAccessAgent(owner.agent)) {
    return response({ success: false, code: "computer_not_ready",
      error: "Private access requires a current, running Hivra Proxmox Ubuntu computer with no active operation." }, 409);
  }
  const authority = hivraPrivateAccessAuthority(owner.agent);
  let stored: StoredConnection | null;
  try { stored = await loadConnection(id, owner.userId); }
  catch { return response({ success: false, error: "Private access is unavailable." }, 503); }
  if (stored && !sameHivraPrivateAccessAuthority(stored.authority, authority)) {
    return response({ success: false, code: "stale_connection",
      error: "This saved connection belongs to an older computer identity and cannot control the current guest." }, 409);
  }

  if (parsed.data.action === "refresh") {
    const loginServer = stored?.login_server ?? DEFAULT_TAILSCALE_LOGIN_SERVER;
    const observed = await observeAnyNetwork(owner.agent, loginServer);
    if (!stored && observed.connectionPresent === true) {
      return response({ success: false, code: "unmanaged_connection",
        error: "This computer is already connected outside Hivra. Disconnect it in the guest before connecting here." }, 409);
    }
    if (stored) {
      if (observed.receipt.state === "connected" && stored.connected_at) {
        observed.receipt.connectedAt = stored.connected_at;
      }
      const saved = await rpcBoolean("record_hivra_private_access_observation", {
        p_user_id: owner.userId, p_agent_id: id, p_expected_authority: authority, p_receipt: observed.receipt,
      });
      if (!saved) return response({ success: false, error: "The fresh private-access observation could not be saved." }, 409);
    }
    if (stored) await persistExtras(owner.userId, id, observed.receipt, providerKind(observed.receipt, stored));
    return response({ success: observed.ok, data: { supported: true,
      connection: observed.receipt.state === "disconnected" ? null : observed.receipt },
      ...(!observed.ok ? { ...(observed.receipt.failureCode ? { failureCode: observed.receipt.failureCode } : {}),
        error: privateAccessFailureMessage(observed.receipt.failureCode)
          ?? "The computer's private-network state could not be confirmed." } : {}) }, observed.ok ? 200 : 202);
  }

  if (parsed.data.action === "reapply") {
    if (!stored || stored.state !== "connected") {
      return response({ success: false, code: "not_managed", error: "Connect a private network before reapplying protection." }, 409);
    }
    const seen = await observeAnyNetwork(owner.agent, stored.login_server);
    if (seen.receipt.state !== "connected") {
      return response({ success: false, code: "not_connected", error: "The computer isn't connected to a private network right now. Refresh status first." }, 409);
    }
    const kind = providerKind(seen.receipt, stored);
    let redone: { ok: boolean; receipt: HivraTailscaleReceipt };
    try {
      redone = await reapplyHivraOutboundBlock(owner.agent, kind === "netbird" ? "netbird" : "tailscale", stored.login_server);
    } catch {
      redone = { ok: false, receipt: { ...seen.receipt, failureCode: "guest_command_failed" } };
    }
    if (redone.ok) {
      if (redone.receipt.connectedAt === undefined && stored.connected_at) redone.receipt.connectedAt = stored.connected_at;
      const saved = await rpcBoolean("record_hivra_private_access_observation", {
        p_user_id: owner.userId, p_agent_id: id, p_expected_authority: authority, p_receipt: redone.receipt,
      });
      if (saved) await persistExtras(owner.userId, id, redone.receipt, kind);
    }
    return response({ success: redone.ok, data: { supported: true, connection: redone.receipt },
      ...(!redone.ok ? { ...(redone.receipt.failureCode ? { failureCode: redone.receipt.failureCode } : {}),
        error: privateAccessFailureMessage(redone.receipt.failureCode)
          ?? "Hivra could not confirm the protection is back. Refresh status and try again." } : {}) }, redone.ok ? 200 : 202);
  }

  const v2 = isPrivateNetworkV2Enabled();
  const provider = parsed.data.action === "connect" ? (parsed.data.provider ?? "tailscale") : "tailscale";
  if (provider === "netbird" && !v2) {
    return response({ success: false, code: "provider_unavailable", error: "That private network isn't available yet." }, 400);
  }
  const switching = parsed.data.action === "connect" && stored !== null;
  if (switching && !v2) {
    return response({ success: false, code: "already_managed", error: "Disconnect the saved private connection before enrolling again." }, 409);
  }
  if (parsed.data.action === "disconnect" && !stored) {
    return response({ success: false, code: "not_managed", error: "Hivra has no owner-bound private connection to disconnect." }, 409);
  }
  const loginServer = parsed.data.action === "connect"
    ? (provider === "netbird" ? normalizeNetbirdManagementUrl(parsed.data.loginServer)
      : normalizeTailscaleLoginServer(parsed.data.loginServer))
    : stored!.login_server;
  if (!loginServer) return response({ success: false, error: "Use an HTTPS coordination URL without credentials, query, path, or fragment." }, 400);

  const connectFor = () => provider === "netbird"
    ? connectHivraNetbird(owner.agent, (parsed.data as { authKey: string }).authKey, loginServer)
    : connectHivraTailscale(owner.agent, (parsed.data as { authKey: string }).authKey, loginServer);

  // Switching: leave the old network first, in the same request, then join the new one.
  if (switching) {
    const left = await runLeasedOperation({ userId: owner.userId, agentId: id, authority, action: "disconnect",
      loginServer: stored!.login_server, run: () => disconnectHivraTailscale(owner.agent, stored!.login_server) });
    if ("response" in left) return left.response;
    if (!left.result.ok || left.result.receipt.state !== "disconnected") {
      return response({ success: false, data: { supported: true,
        connection: left.result.receipt.state === "disconnected" ? null : left.result.receipt },
      error: "Hivra could not leave your current network, so it did not join the new one. Refresh status and try again." }, 202);
    }
  }

  if (parsed.data.action === "connect") {
    const before = await observeAnyNetwork(owner.agent, loginServer);
    if (before.connectionPresent !== false) {
      return response({ success: false, code: "unmanaged_connection",
        error: "This computer is already connected outside Hivra. Disconnect it in the guest before connecting here." }, 409);
    }
  }

  const outcome = await runLeasedOperation({ userId: owner.userId, agentId: id, authority,
    action: parsed.data.action, loginServer,
    run: () => parsed.data.action === "connect" ? connectFor() : disconnectHivraTailscale(owner.agent, loginServer) });
  if ("response" in outcome) return outcome.response;
  const result = outcome.result;
  if (result.ok && parsed.data.action === "connect") {
    await persistExtras(owner.userId, id, result.receipt, provider === "netbird" ? "netbird"
      : provider === "headscale" || loginServer !== DEFAULT_TAILSCALE_LOGIN_SERVER ? "headscale" : "tailscale");
  }
  const failureCode = result.receipt.failureCode;
  return response({ success: result.ok, data: { supported: true,
    connection: result.receipt.state === "disconnected" ? null : result.receipt },
    ...(!result.ok ? { ...(failureCode ? { failureCode } : {}),
      error: privateAccessFailureMessage(failureCode)
        ?? "The guest result is uncertain. Refresh status before retrying or changing the computer." } : {}) }, result.ok ? 200 : 202);
}
