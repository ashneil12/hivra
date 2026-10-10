import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { firstBootPowerOnAction, parseFirstBootFirewallReceipt, type FirstBootFirewallReceipt } from "@/lib/hetzner/first-boot-firewall";
import { FIRST_BOOT_RECIPE_VERSIONS, type FirstBootBinding } from "./first-boot-enrollment";
import { FirstBootStoreError, loadFirstBootRecipeVersion } from "./first-boot-store";

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const DATE = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const ID = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const BindingSchema = z.object({
  userId: z.string().min(1).max(256), connectionId: UUID, connectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  orderId: UUID, attemptId: UUID, quoteFingerprint: DIGEST, recipeVersion: z.enum(FIRST_BOOT_RECIPE_VERSIONS),
}).strict();
const ScopeSchema = z.object({ binding: BindingSchema, providerServerId: ID }).strict();
// Order-only callers know neither the attempt nor its recipe; both are read
// from the original records, never assumed from the current recipe.
const OrderScopeSchema = ScopeSchema.extend({ binding: BindingSchema.omit({ attemptId: true, recipeVersion: true }) });
const LeaseSchema = ScopeSchema.extend({ leaseId: UUID });
export type FirstBootOperationScope = { binding: FirstBootBinding; providerServerId: string };
export type FirstBootOrderScope = z.infer<typeof OrderScopeSchema>;
export type FirstBootOperationLease = FirstBootOperationScope & { leaseId: string };
export const FIRST_BOOT_ABANDON_CONFIRMATION = "Stop setup; provider resources and billing remain" as const;
const RowSchema = z.object({
  order_id: UUID, attempt_id: UUID, user_id: z.string().min(1).max(256), connection_id: UUID,
  connection_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), quote_fingerprint_sha256: DIGEST,
  provider_server_id: ID, lease_id: UUID.nullable(), lease_expires_at: DATE.nullable(),
  firewall_post_attempted_at: DATE.nullable(), firewall_receipt: z.unknown(), firewall_verified_at: DATE.nullable(),
  power_on_post_attempted_at: DATE.nullable(), power_on_action: z.unknown(), abandoned_at: DATE.nullable(),
  created_at: DATE, updated_at: DATE,
});
const SELECT = Object.keys(RowSchema.shape).join(",");
export type FirstBootOperation = FirstBootOperationScope & {
  leaseId: string | null; leaseExpiresAt: string | null;
  firewallPostAttemptedAt: string | null; firewallReceipt: FirstBootFirewallReceipt | null;
  firewallVerifiedAt: string | null; powerOnPostAttemptedAt: string | null;
  powerOnAction: ReturnType<typeof firstBootPowerOnAction> | null; abandonedAt: string | null;
};

class FirstBootOperationError extends Error {
  constructor(readonly code: "invalid_scope" | "invalid_record" | "invalid_evidence" | "database_error" | "database_unavailable") {
    super("First-boot operation failed: " + code);
    this.name = "FirstBootOperationError";
  }
}
function database() {
  if (!supabaseAdmin) throw new FirstBootOperationError("database_unavailable");
  return supabaseAdmin;
}
function scope(input: FirstBootOperationScope) {
  const parsed = ScopeSchema.safeParse(input);
  if (!parsed.success) throw new FirstBootOperationError("invalid_scope");
  return parsed.data;
}

/** Snapshot the complete binding before asynchronous provider work. Parsing is
 * not operation authority: the caller must separately hold the owning lease.
 */
export function parseFirstBootOperationScope(input: FirstBootOperationScope): FirstBootOperationScope {
  return scope(input);
}
function lease(input: FirstBootOperationLease) {
  const parsed = LeaseSchema.safeParse(input);
  if (!parsed.success) throw new FirstBootOperationError("invalid_scope");
  return parsed.data;
}
function bindingParameters(input: FirstBootOperationScope) {
  const b = input.binding;
  return { p_user_id: b.userId, p_connection_id: b.connectionId, p_revision: b.connectionRevision,
    p_order_id: b.orderId, p_attempt_id: b.attemptId };
}
function parameters(input: FirstBootOperationScope) {
  return { ...bindingParameters(input), p_quote: input.binding.quoteFingerprint, p_server: input.providerServerId };
}
async function rpc(name: string, params: Record<string, unknown>) {
  const db = database();
  try {
    const { data, error } = await db.rpc(name, params);
    if (error) throw new FirstBootOperationError("database_error");
    return data;
  } catch { throw new FirstBootOperationError("database_error"); }
}
function firewallScope(input: FirstBootOperationScope) {
  return { orderId: input.binding.orderId, attemptId: input.binding.attemptId,
    quoteFingerprint: input.binding.quoteFingerprint, serverId: Number(input.providerServerId) };
}
function record(raw: unknown, expected: FirstBootOperationScope): FirstBootOperation {
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) throw new FirstBootOperationError("invalid_record");
  const r = parsed.data;
  // The operation row does not carry the recipe; the caller's scope does, and
  // it came from the enrollment (or loadFirstBootRecipeVersion) for this attempt.
  const actual = { binding: { userId: r.user_id, connectionId: r.connection_id, connectionRevision: r.connection_revision,
    orderId: r.order_id, attemptId: r.attempt_id, quoteFingerprint: r.quote_fingerprint_sha256, recipeVersion: expected.binding.recipeVersion },
  providerServerId: r.provider_server_id };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new FirstBootOperationError("invalid_record");
  let firewallReceipt: FirstBootFirewallReceipt | null = null;
  let powerOnAction: ReturnType<typeof firstBootPowerOnAction> | null = null;
  try {
    if (r.firewall_receipt !== null) firewallReceipt = parseFirstBootFirewallReceipt(r.firewall_receipt, firewallScope(expected));
    if (r.power_on_action !== null) powerOnAction = firstBootPowerOnAction(Number(expected.providerServerId), r.power_on_action);
  } catch { throw new FirstBootOperationError("invalid_record"); }
  if ((r.lease_id === null) !== (r.lease_expires_at === null) || (r.abandoned_at !== null && r.lease_id !== null)
    || (firewallReceipt !== null && r.firewall_post_attempted_at === null)
    || (r.firewall_verified_at !== null && firewallReceipt === null)
    || (r.power_on_post_attempted_at !== null && r.firewall_verified_at === null)
    || (powerOnAction !== null && r.power_on_post_attempted_at === null)) throw new FirstBootOperationError("invalid_record");
  return { ...actual, leaseId: r.lease_id, leaseExpiresAt: r.lease_expires_at,
    firewallPostAttemptedAt: r.firewall_post_attempted_at, firewallReceipt, firewallVerifiedAt: r.firewall_verified_at,
    powerOnPostAttemptedAt: r.power_on_post_attempted_at, powerOnAction, abandonedAt: r.abandoned_at };
}

/** Private, owner-bound projection. Never selects/decrypts provider tokens,
 * enrollment delivery secrets or administrative SSH keys. No passive resume.
 */
export async function loadFirstBootOperation(input: FirstBootOperationScope): Promise<FirstBootOperation | null> {
  const current = scope(input); // Snapshot caller-owned objects before an await.
  const b = current.binding;
  const db = database();
  try {
    const { data, error } = await db.from("infrastructure_first_boot_operations").select(SELECT)
      .eq("user_id", b.userId).eq("connection_id", b.connectionId).eq("connection_revision", b.connectionRevision)
      .eq("order_id", b.orderId).eq("attempt_id", b.attemptId).eq("quote_fingerprint_sha256", b.quoteFingerprint)
      .eq("provider_server_id", current.providerServerId).maybeSingle();
    if (error) throw new FirstBootOperationError("database_error");
    return data === null ? null : record(data, current);
  } catch (error) {
    if (error instanceof FirstBootOperationError) throw error;
    throw new FirstBootOperationError("database_error");
  }
}

/** Cleanup knows the original order, not a browser-supplied attempt. Discover
 * that one attempt only inside the complete owner/order/provider binding.
 */
export async function loadFirstBootOperationForOrder(input: FirstBootOrderScope): Promise<FirstBootOperation | null> {
  const parsed = OrderScopeSchema.safeParse(input);
  if (!parsed.success) throw new FirstBootOperationError("invalid_scope");
  const current = parsed.data, b = current.binding, db = database();
  try {
    const { data, error } = await db.from("infrastructure_first_boot_operations").select(SELECT)
      .eq("user_id", b.userId).eq("connection_id", b.connectionId).eq("connection_revision", b.connectionRevision)
      .eq("order_id", b.orderId).eq("quote_fingerprint_sha256", b.quoteFingerprint)
      .eq("provider_server_id", current.providerServerId).maybeSingle();
    if (error) throw new FirstBootOperationError("database_error");
    if (data === null) return null;
    const row = RowSchema.safeParse(data);
    if (!row.success) throw new FirstBootOperationError("invalid_record");
    const attempt = { ...b, attemptId: row.data.attempt_id };
    let recipeVersion: FirstBootBinding["recipeVersion"];
    try { recipeVersion = await loadFirstBootRecipeVersion(attempt); }
    catch (error) {
      throw new FirstBootOperationError(error instanceof FirstBootStoreError
        && ["database_error", "database_unavailable"].includes(error.code) ? "database_error" : "invalid_record");
    }
    return record(data, ScopeSchema.parse({ ...current, binding: { ...attempt, recipeVersion } }));
  } catch (error) {
    if (error instanceof FirstBootOperationError) throw error;
    throw new FirstBootOperationError("database_error");
  }
}

type FirstBootClaim =
  { outcome: "claimed"; operation: FirstBootOperation; lease: FirstBootOperationLease }
  | { outcome: "rejected" | "busy" };
async function claimOperation(input: FirstBootOperationScope,
  name: "claim_hetzner_first_boot_operation" | "claim_hetzner_enrolled_guest_operation",
): Promise<FirstBootClaim> {
  const current = scope(input);
  const data = await rpc(name, parameters(current));
  if (!data || !["claimed", "rejected", "busy"].includes(data.outcome)) throw new FirstBootOperationError("database_error");
  if (data.outcome !== "claimed") return { outcome: data.outcome };
  const operation = record(data.record, current);
  if (!operation.leaseId || operation.abandonedAt) throw new FirstBootOperationError("invalid_record");
  return { outcome: "claimed", operation, lease: { ...current, leaseId: operation.leaseId } };
}

export function claimFirstBootOperation(input: FirstBootOperationScope) {
  return claimOperation(input, "claim_hetzner_first_boot_operation");
}

/** Only already-enrolled identities qualify, including after the one-time
 * token has expired. Shares the original cleanup/revocation lease, never
 * restores enrollment authority or authorizes another provider boot POST.
 */
export function claimEnrolledGuestOperation(input: FirstBootOperationScope) {
  return claimOperation(input, "claim_hetzner_enrolled_guest_operation");
}

type Checkpoint = "firewall_dispatch" | "firewall_receipt" | "firewall_verified" | "power_dispatch" | "power_receipt";
async function checkpoint(current: FirstBootOperationLease, event: Checkpoint, evidence: unknown = null, observedAt: string | null = null) {
  const data = await rpc("checkpoint_hetzner_first_boot_operation", {
    ...parameters(current), p_lease_id: current.leaseId, p_event: event, p_evidence: evidence, p_observed_at: observedAt,
  });
  if (typeof data !== "boolean") throw new FirstBootOperationError("database_error");
  return data;
}
function receipt(raw: unknown, current: FirstBootOperationScope) {
  try { return parseFirstBootFirewallReceipt(raw, firewallScope(current)); }
  catch { throw new FirstBootOperationError("invalid_evidence"); }
}

/** Persist BEFORE dispatch. A false result never permits another POST. The
 * caller must additionally enforce its synchronous local mutation deadline.
 */
export function markFirstBootFirewallDispatch(input: FirstBootOperationLease) {
  return checkpoint(lease(input), "firewall_dispatch");
}
export function saveFirstBootFirewallReceipt(input: FirstBootOperationLease, originalReceipt: unknown) {
  const current = lease(input);
  return checkpoint(current, "firewall_receipt", receipt(originalReceipt, current));
}
export function recordFirstBootFirewallVerified(input: FirstBootOperationLease, originalReceipt: unknown, observedAt: Date) {
  const current = lease(input);
  if (!Number.isFinite(observedAt.getTime())) throw new FirstBootOperationError("invalid_evidence");
  return checkpoint(current, "firewall_verified", receipt(originalReceipt, current), observedAt.toISOString());
}
export function markFirstBootPowerDispatch(input: FirstBootOperationLease) {
  return checkpoint(lease(input), "power_dispatch");
}
export function saveFirstBootPowerAction(input: FirstBootOperationLease, originalAction: unknown) {
  const current = lease(input);
  let action: ReturnType<typeof firstBootPowerOnAction>;
  try { action = firstBootPowerOnAction(Number(current.providerServerId), originalAction); }
  catch { throw new FirstBootOperationError("invalid_evidence"); }
  return checkpoint(current, "power_receipt", action);
}
export async function releaseFirstBootOperation(input: FirstBootOperationLease) {
  const current = lease(input);
  const data = await rpc("release_hetzner_first_boot_operation", { ...parameters(current), p_lease_id: current.leaseId });
  if (typeof data !== "boolean") throw new FirstBootOperationError("database_error");
  return data;
}
/** Stop only this setup attempt. Provider/admin credentials remain available
 * for inspection until a separate confirmed disconnect removes them.
 */
export async function abandonFirstBootOperation(input: FirstBootOperationScope, serverName: string,
  confirmation: typeof FIRST_BOOT_ABANDON_CONFIRMATION) {
  const current = scope(input);
  if (confirmation !== FIRST_BOOT_ABANDON_CONFIRMATION || !/^hivra-[a-f0-9]{20}$/.test(serverName)) {
    throw new FirstBootOperationError("invalid_evidence");
  }
  const data = await rpc("abandon_hetzner_first_boot_operation", {
    ...parameters(current), p_server_name: serverName, p_confirmation: confirmation,
  });
  if (typeof data !== "boolean") throw new FirstBootOperationError("database_error");
  return data;
}
