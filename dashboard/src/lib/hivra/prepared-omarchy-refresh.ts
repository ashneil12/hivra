import "server-only";
import { resolveLatestOmarchyInstaller } from "../../../scripts/omarchy-release";
import { desktopPrepareAuthority } from "@/lib/remote-computers/desktop-prepare-operation";
import { runProxmoxHostScript, resolveProxmoxTargetConfiguration } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import { preparedOmarchyRefreshHostScript } from "./prepared-omarchy-refresh-host";
import { OmarchyRefreshReleaseSchema, OmarchyRefreshRequestSchema, preparedOmarchyRefreshPending,
  readOmarchyRefreshHostStatus, type OmarchyRefreshRelease, type OmarchyRefreshRequest, type OmarchyRefreshReceipt } from "./prepared-omarchy-refresh-contract";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import type { PreparedCanarySlot, PreparedCanaryAgentRow } from "./prepared-canary-computers";

type Row = PreparedCanaryAgentRow;
type Job = { id: string; agent_id: string; user_id: string; authority: Record<string, unknown>;
  requested_release: unknown; slot: unknown; phase: string; terminal_receipt: unknown };
type Dependencies = {
  loadJob: (userId: string, operationId: string) => Promise<Job | null>;
  reload: (userId: string, id: string) => Promise<Row | null>;
  ensureBinding: (row: Row, slot: PreparedCanarySlot) => Promise<Row>;
  dispatch: (userId: string, operationId: string) => Promise<boolean>;
  cancel: (userId: string, operationId: string) => Promise<boolean>;
  finish: (userId: string, operationId: string, receipt: OmarchyRefreshReceipt) => Promise<boolean>;
  host: (request: OmarchyRefreshRequest, cancel: boolean) => Promise<string>;
};

const CACHE_MS = 5 * 60_000;
let cached: { until: number; promise: Promise<OmarchyRefreshRelease> } | null = null;
/** Only new reservations consult upstream. Failure never returns a stale pin. */
export async function latestPreparedOmarchyRelease(): Promise<OmarchyRefreshRelease> {
  if (cached && cached.until > Date.now()) return cached.promise;
  const promise = resolveLatestOmarchyInstaller(fetch, AbortSignal.timeout(8_000)).then(value => OmarchyRefreshReleaseSchema.parse(value));
  const entry = { until: Date.now() + CACHE_MS, promise }; cached = entry;
  try { return await promise; }
  catch (error) { if (cached === entry) cached = null; throw error; }
}

export function preparedRefreshAuthority(row: Row): Record<string, unknown> {
  const value = desktopPrepareAuthority(row as unknown as RemoteDesktopAgentRow);
  delete value.infrastructure_binding_token_enforced;
  return { ...value, allocation_operation_id: row.allocation_operation_id ?? null };
}
function same(left: unknown, right: unknown): boolean {
  const ordered = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, ordered(v)]))
    : Array.isArray(value) ? value.map(ordered) : value;
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}
async function rpc(name: string, args: Record<string, unknown>): Promise<boolean> {
  if (!supabaseAdmin) throw new Error("prepared_refresh_database_unavailable");
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error || typeof data !== "boolean") throw new Error("prepared_refresh_unconfirmed");
  return data;
}
const defaults: Dependencies = {
  loadJob: async (userId, id) => {
    if (!supabaseAdmin) throw new Error("prepared_refresh_database_unavailable");
    const { data, error } = await supabaseAdmin.from("hivra_prepared_omarchy_refreshes").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
    if (error) throw new Error("prepared_refresh_unconfirmed");
    return data as Job | null;
  },
  reload: async (userId, id) => {
    if (!supabaseAdmin) throw new Error("prepared_refresh_database_unavailable");
    const { data, error } = await supabaseAdmin.from("hivra_agents").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
    if (error) throw new Error("prepared_refresh_unconfirmed");
    return data as Row | null;
  },
  ensureBinding: async (row, slot) => {
    const { preparedCanaryBindingScript } = await import("./prepared-canary-computers");
    const request = OmarchyRefreshRequestSchema.pick({ operationId: true }).parse({ operationId: row.operation_id });
    const hash = row.infrastructure_binding_token_hash;
    if (typeof hash !== "string") throw new Error("prepared_binding_unavailable");
    // The same VM lock used by the updater and cancellation prevents stale
    // HTTP binding work from surviving a completed cancellation and slot reuse.
    const binding = preparedCanaryBindingScript("omarchy", slot, hash).replace("set -euo pipefail", `set -euo pipefail
exec 8>/run/lock/hivra-prepared-${slot.vmid}.lock
flock -x -w 5 8
[ ! -e /var/lib/hivra/prepared-omarchy-refresh/${request.operationId}/cancel ]`);
    const result = await runProxmoxHostScript(binding, resolveProxmoxTargetConfiguration(process.env, slot.host).env,
      { timeoutMs: 15_000, maxOutputBytes: 4096 });
    if (!result.ok || !result.stdout.split(/\r?\n/).includes("HIVRA_PREPARED_BINDING_READY")
      || !await rpc("bind_hivra_prepared_omarchy", { p_user_id: row.user_id, p_operation_id: request.operationId })) {
      throw new Error("prepared_binding_unavailable");
    }
    const latest = await defaults.reload(row.user_id, row.id);
    if (!latest) throw new Error("prepared_binding_unavailable");
    return latest;
  },
  dispatch: (userId, operationId) => rpc("dispatch_hivra_prepared_omarchy", { p_user_id: userId, p_operation_id: operationId }),
  cancel: (userId, operationId) => rpc("cancel_hivra_prepared_omarchy", { p_user_id: userId, p_operation_id: operationId }),
  finish: (userId, operationId, receipt) => rpc("complete_hivra_prepared_omarchy", { p_user_id: userId, p_operation_id: operationId, p_receipt: receipt }),
  host: async (request, cancel) => {
    const result = await runProxmoxHostScript(preparedOmarchyRefreshHostScript(request, cancel),
      resolveProxmoxTargetConfiguration(process.env, request.slot.host).env,
      { timeoutMs: 15_000, maxOutputBytes: 32_768 });
    if (!result.ok) throw new Error("prepared_refresh_unconfirmed");
    return result.stdout;
  },
};

/** GET polls resume the same host operation; no update is tied to HTTP lifetime. */
export async function advancePreparedOmarchyRefresh(userId: string, initial: Row, dependencies: Partial<Dependencies> = {}): Promise<Row> {
  if (initial.user_id !== userId || !preparedOmarchyRefreshPending(initial) || typeof initial.operation_id !== "string") {
    throw new Error("prepared_refresh_authority_changed");
  }
  const deps = { ...defaults, ...dependencies }; const operationId = initial.operation_id;
  const job = await deps.loadJob(userId, operationId);
  if (!job || job.agent_id !== initial.id || !same(job.authority, preparedRefreshAuthority(initial))) throw new Error("prepared_refresh_authority_changed");
  if (job.phase === "failed" && initial.desired_state !== "deleted") return initial;
  let row = initial;
  const slot = OmarchyRefreshRequestSchema.shape.slot.parse(job.slot);
  if (row.desired_state !== "deleted" && row.infrastructure_binding_token_enforced !== true) row = await deps.ensureBinding(row, slot);
  const bound = await deps.reload(userId, initial.id);
  if (!bound) throw new Error("prepared_refresh_authority_changed");
  row = bound;
  if (!preparedOmarchyRefreshPending(row) || row.operation_id !== operationId || !same(job.authority, preparedRefreshAuthority(row))) throw new Error("prepared_refresh_authority_changed");
  const hash = row.infrastructure_binding_token_hash;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("prepared_refresh_authority_changed");
  const request = OmarchyRefreshRequestSchema.parse({ version: 1, operationId, computerId: row.id,
    bindingTag: `hivra-bind-${hash.slice(0, 32)}`, slot, release: job.requested_release });
  if (job.phase !== "failed" && !await deps.dispatch(userId, operationId)) throw new Error("prepared_refresh_authority_changed");
  // Reload delete intent after dispatch. The host fence is monotonic: a stale
  // HTTP request can never remove it or restart a cancelled guest operation.
  const dispatched = await deps.reload(userId, row.id);
  if (!dispatched) throw new Error("prepared_refresh_authority_changed");
  row = dispatched;
  if (row.operation_id !== operationId || !same(job.authority, preparedRefreshAuthority(row))) throw new Error("prepared_refresh_authority_changed");
  const cancel = row.desired_state === "deleted";
  const result = readOmarchyRefreshHostStatus(await deps.host(request, cancel));
  if (result.state === "terminal") {
    const receipt = result.receipt;
    if (receipt.operationId !== operationId || receipt.computerId !== row.id || receipt.vmid !== slot.vmid
      || receipt.bindingTag !== request.bindingTag || !same(receipt.requestedRelease, request.release)) throw new Error("prepared_refresh_receipt_mismatch");
    if (!await deps.finish(userId, operationId, receipt)) throw new Error("prepared_refresh_completion_unconfirmed");
    const completed = await deps.reload(userId, row.id);
    if (!completed) throw new Error("prepared_refresh_completion_unconfirmed");
    return completed;
  }
  return { ...row, prepared_update_stage: result.state === "unconfirmed" ? "verification_unavailable" : result.phase ?? "preparing" };
}

export async function cancelPreparedOmarchyRefresh(userId: string, row: Row, dependencies: Partial<Dependencies> = {}): Promise<Row> {
  if (!preparedOmarchyRefreshPending(row) || typeof row.operation_id !== "string") throw new Error("prepared_refresh_authority_changed");
  const deps = { ...defaults, ...dependencies };
  if (!await deps.cancel(userId, row.operation_id)) throw new Error("prepared_refresh_cancellation_unconfirmed");
  const latest = await deps.reload(userId, row.id);
  if (!latest) throw new Error("prepared_refresh_cancellation_unconfirmed");
  return advancePreparedOmarchyRefresh(userId, latest, deps);
}
