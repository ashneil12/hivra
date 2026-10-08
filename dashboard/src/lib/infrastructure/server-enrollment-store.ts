import "server-only";

import { z } from "zod";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

import { SERVER_ENROLLMENT_ADMIN_KEY_PURPOSE } from "./server-enrollment-code";
import {
  ServerEnrollmentFactsSchema,
  type KnownServer,
  type ServerEnrollmentDto,
  type ServerEnrollmentFacts,
} from "./server-enrollment-contracts";
import { canonicalEd25519HostKey } from "./ssh-host-key";

/**
 * Database access for one-command server enrollment. Every write is one
 * SECURITY DEFINER function in migration 20260924213000; the service role can
 * only read enrollments and receipts. Reads never select the code's hash or
 * the sealed private key, except the one explicit loader below that Yes and
 * Replace use.
 */

export class ServerEnrollmentStoreError extends Error {
  constructor(readonly code: "database_unavailable" | "database_error" | "invalid_record" | "credential_error") {
    super("Server enrollment storage failed: " + code);
    this.name = "ServerEnrollmentStoreError";
  }
}

function database() {
  if (!supabaseAdmin) throw new ServerEnrollmentStoreError("database_unavailable");
  return supabaseAdmin;
}

const IsoDate = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const NullableIsoDate = IsoDate.nullable();

const RowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1).max(256),
  phase: z.enum(["issued", "reported", "unsupported", "confirmed", "rejected", "cancelled", "expired"]),
  issued_at: IsoDate,
  expires_at: IsoDate,
  script_version: z.string(),
  admin_public_key: z.string(),
  admin_key_fingerprint: z.string(),
  script_fetches: z.number().int(),
  last_fetched_at: NullableIsoDate,
  refused_reports: z.number().int(),
  last_refusal: z.enum(["private_address", "ipv4_required", "invalid_report"]).nullable(),
  last_refused_at: NullableIsoDate,
  report_kind: z.enum(["enrolled", "unsupported"]).nullable(),
  reported_at: NullableIsoDate,
  confirm_by: NullableIsoDate,
  observed_address: z.string().nullable(),
  ssh_port: z.number().int().nullable(),
  host_public_key: z.string().nullable(),
  host_fingerprint_sha256: z.string().nullable(),
  facts: z.unknown().nullable(),
  consent: z.enum(["terminal", "no_terminal"]).nullable(),
  reenrollment: z.boolean().nullable(),
  words: z.string().nullable(),
  replacement_attempts: z.number().int(),
  replacement_lease_expires_at: NullableIsoDate,
  last_replacement_failure: z.enum([
    "host_key_mismatch", "connection_failed", "authentication_failed", "sudo_unavailable", "not_root",
    "connection_changed", "proxmox_needs_root",
  ]).nullable(),
  decided_at: NullableIsoDate,
  outcome: z.enum(["connected", "replaced_access"]).nullable(),
  replaced_from_revision: z.number().int().nullable(),
  connection_id: z.string().uuid().nullable(),
});
export type ServerEnrollmentRow = z.infer<typeof RowSchema>;
// Explicit projection: never the code hash or the sealed key.
const ROW_SELECT = Object.keys(RowSchema.shape).join(",");

function parseRow(data: unknown): ServerEnrollmentRow {
  const parsed = RowSchema.safeParse(data);
  if (!parsed.success) throw new ServerEnrollmentStoreError("invalid_record");
  return parsed.data;
}

function rpcResult(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ServerEnrollmentStoreError("invalid_record");
  return data as Record<string, unknown>;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await database().rpc(name, args);
  if (error) throw new ServerEnrollmentStoreError("database_error");
  return rpcResult(data);
}

// --- Sealed admin key ---------------------------------------------------------

const SealedKeySchema = z.object({
  version: z.literal(1),
  purpose: z.literal(SERVER_ENROLLMENT_ADMIN_KEY_PURPOSE),
  userId: z.string().min(1).max(256),
  publicKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/),
  privateKeyOpenSsh: z.string().min(64).max(8_192),
}).strict();

/** Seal an enrollment's admin private key, bound to its owner and public key.
 * It is never used for any other enrollment, server or account. */
export function sealServerEnrollmentAdminKey(input: { userId: string; publicKey: string; privateKeyOpenSsh: string }): string {
  return encryptSecret(JSON.stringify(SealedKeySchema.parse({
    version: 1, purpose: SERVER_ENROLLMENT_ADMIN_KEY_PURPOSE, ...input,
  })));
}

export function unsealServerEnrollmentAdminKey(sealed: string, expected: { userId: string; publicKey: string }): string {
  try {
    const bundle = SealedKeySchema.parse(JSON.parse(decryptSecret(sealed)));
    if (bundle.userId !== expected.userId || bundle.publicKey !== expected.publicKey) throw new Error();
    return bundle.privateKeyOpenSsh;
  } catch {
    throw new ServerEnrollmentStoreError("credential_error");
  }
}

/** The only read of a sealed key: Yes and Replace need it to sign in as
 * hivra. Null once the enrollment has ended (the key is wiped then). */
export async function loadServerEnrollmentAdminKey(userId: string, enrollmentId: string): Promise<string | null> {
  const { data, error } = await database().from("infrastructure_server_enrollments")
    .select("user_id,admin_public_key,sealed_admin_private_key")
    .eq("id", enrollmentId).eq("user_id", userId).maybeSingle();
  if (error) throw new ServerEnrollmentStoreError("database_error");
  const row = data as { user_id: string; admin_public_key: string; sealed_admin_private_key: string | null } | null;
  if (!row?.sealed_admin_private_key) return null;
  return unsealServerEnrollmentAdminKey(row.sealed_admin_private_key, { userId, publicKey: row.admin_public_key });
}

// --- Machine side ---------------------------------------------------------------

export async function issueServerEnrollmentRecord(input: {
  userId: string; codeSha256: string; scriptVersion: string; adminPublicKey: string;
  adminKeyFingerprint: string; sealedAdminPrivateKey: string; replaceEnrollmentId: string | null;
}): Promise<{ outcome: "issued"; enrollmentId: string } | { outcome: "active_limit" | "daily_limit" }> {
  const result = await rpc("issue_server_enrollment", {
    p_user_id: input.userId,
    p_code_sha256: input.codeSha256,
    p_script_version: input.scriptVersion,
    p_admin_public_key: input.adminPublicKey,
    p_admin_key_fingerprint: input.adminKeyFingerprint,
    p_sealed_admin_private_key: input.sealedAdminPrivateKey,
    p_replace_enrollment_id: input.replaceEnrollmentId,
  });
  if (result.outcome === "issued" && typeof result.enrollmentId === "string") {
    return { outcome: "issued", enrollmentId: result.enrollmentId };
  }
  if (result.outcome === "active_limit" || result.outcome === "daily_limit") return { outcome: result.outcome };
  throw new ServerEnrollmentStoreError("invalid_record");
}

export async function recordServerEnrollmentFetch(codeSha256: string): Promise<
  | { status: "served"; userId: string; adminPublicKey: string }
  | { status: "fetch_limit" | "not_usable" }
> {
  const result = await rpc("record_server_enrollment_fetch", { p_code_sha256: codeSha256 });
  if (result.status === "served" && typeof result.userId === "string" && typeof result.adminPublicKey === "string") {
    return { status: "served", userId: result.userId, adminPublicKey: result.adminPublicKey };
  }
  if (result.status === "fetch_limit" || result.status === "not_usable") return { status: result.status };
  throw new ServerEnrollmentStoreError("invalid_record");
}

/** What the report route needs before any other check. */
export async function findServerEnrollmentForReport(codeSha256: string): Promise<{
  id: string; userId: string; phase: ServerEnrollmentRow["phase"]; expiresAt: string;
  adminKeyFingerprint: string;
} | null> {
  const { data, error } = await database().from("infrastructure_server_enrollments")
    .select("id,user_id,phase,expires_at,admin_key_fingerprint")
    .eq("code_sha256", codeSha256).maybeSingle();
  if (error) throw new ServerEnrollmentStoreError("database_error");
  if (!data) return null;
  const row = data as { id: string; user_id: string; phase: ServerEnrollmentRow["phase"]; expires_at: string; admin_key_fingerprint: string };
  return { id: row.id, userId: row.user_id, phase: row.phase, expiresAt: row.expires_at,
    adminKeyFingerprint: row.admin_key_fingerprint };
}

export async function refuseServerEnrollmentReport(codeSha256: string,
  refusal: "private_address" | "ipv4_required" | "invalid_report"): Promise<void> {
  await rpc("refuse_server_enrollment_report", { p_code_sha256: codeSha256, p_refusal: refusal });
}

export type ReportTransition =
  | { status: "accepted"; enrollmentId: string; words: string; hostFingerprint: string; replay: boolean }
  | { status: "unsupported"; enrollmentId: string }
  | { status: "not_usable" };

export async function reportServerEnrollment(input: {
  codeSha256: string; reportDigest: string; kind: "enrolled" | "unsupported";
  adminKeyFingerprint: string | null; hostPublicKey: string | null; hostFingerprint: string | null;
  sshPort: number | null; facts: ServerEnrollmentFacts; consent: "terminal" | "no_terminal";
  reenrollment: boolean | null; observedAddress: string | null; words: string | null;
}): Promise<ReportTransition> {
  const result = await rpc("report_server_enrollment", {
    p_code_sha256: input.codeSha256,
    p_report_digest: input.reportDigest,
    p_kind: input.kind,
    p_admin_key_fingerprint: input.adminKeyFingerprint,
    p_host_public_key: input.hostPublicKey,
    p_host_fingerprint: input.hostFingerprint,
    p_ssh_port: input.sshPort,
    p_facts: input.facts,
    p_consent: input.consent,
    p_reenrollment: input.reenrollment,
    p_observed_address: input.observedAddress,
    p_words: input.words,
  });
  if (result.status === "accepted" && typeof result.enrollmentId === "string" && typeof result.words === "string"
    && typeof result.hostFingerprint === "string") {
    return { status: "accepted", enrollmentId: result.enrollmentId, words: result.words,
      hostFingerprint: result.hostFingerprint, replay: result.replay === true };
  }
  if (result.status === "unsupported" && typeof result.enrollmentId === "string") {
    return { status: "unsupported", enrollmentId: result.enrollmentId };
  }
  if (result.status === "not_usable") return { status: "not_usable" };
  throw new ServerEnrollmentStoreError("invalid_record");
}

// --- Owner side -----------------------------------------------------------------

export async function getServerEnrollmentRow(userId: string, enrollmentId: string): Promise<ServerEnrollmentRow | null> {
  const { data, error } = await database().from("infrastructure_server_enrollments").select(ROW_SELECT)
    .eq("id", enrollmentId).eq("user_id", userId).maybeSingle();
  if (error) throw new ServerEnrollmentStoreError("database_error");
  return data ? parseRow(data) : null;
}

/** Open codes, answers still to give, recent results and every receipt of a
 * connection that still exists. */
export async function listServerEnrollmentRows(userId: string, now: Date): Promise<ServerEnrollmentRow[]> {
  const recent = new Date(now.getTime() - 60 * 60_000).toISOString();
  const { data, error } = await database().from("infrastructure_server_enrollments").select(ROW_SELECT)
    .eq("user_id", userId)
    .or(`phase.in.(issued,reported),connection_id.not.is.null,decided_at.gte.${recent}`)
    .order("issued_at", { ascending: false })
    .limit(100);
  if (error) throw new ServerEnrollmentStoreError("database_error");
  return (data ?? []).map(parseRow);
}

export async function confirmServerEnrollmentRecord(input: {
  userId: string; enrollmentId: string; sshHost: string; connectionName: string; encryptedBundle: string;
}): Promise<{ outcome: "connected"; connectionId: string } | { outcome: "not_found" | "not_pending" | "known_identity" }> {
  const result = await rpc("confirm_server_enrollment", {
    p_user_id: input.userId,
    p_enrollment_id: input.enrollmentId,
    p_ssh_host: input.sshHost,
    p_connection_name: input.connectionName,
    p_encrypted_bundle: input.encryptedBundle,
    p_key_version: 1,
  });
  if (result.outcome === "connected" && typeof result.connectionId === "string") {
    return { outcome: "connected", connectionId: result.connectionId };
  }
  if (result.outcome === "not_found" || result.outcome === "not_pending" || result.outcome === "known_identity") {
    return { outcome: result.outcome };
  }
  throw new ServerEnrollmentStoreError("invalid_record");
}

export type ReplacementBegin =
  | { outcome: "begun"; attempt: number }
  | { outcome: "not_found" | "not_pending" | "busy" | "attempts_exhausted" | "connection_changed"
      | "operation_running" | "agents_bound" };

export async function beginServerEnrollmentReplacement(input: {
  userId: string; enrollmentId: string; connectionId: string; expectedRevision: number;
  mode: "key" | "switch"; runId: string;
}): Promise<ReplacementBegin> {
  const result = await rpc("begin_server_enrollment_replacement", {
    p_user_id: input.userId,
    p_enrollment_id: input.enrollmentId,
    p_connection_id: input.connectionId,
    p_expected_revision: input.expectedRevision,
    p_mode: input.mode,
    p_run_id: input.runId,
  });
  if (result.outcome === "begun" && typeof result.attempt === "number") return { outcome: "begun", attempt: result.attempt };
  const outcomes = ["not_found", "not_pending", "busy", "attempts_exhausted", "connection_changed",
    "operation_running", "agents_bound"] as const;
  const known = outcomes.find(outcome => outcome === result.outcome);
  if (known) return { outcome: known };
  throw new ServerEnrollmentStoreError("invalid_record");
}

export async function completeServerEnrollmentReplacement(input: {
  userId: string; enrollmentId: string; runId: string; encryptedBundle: string; sshHost: string | null;
}): Promise<{ outcome: "replaced"; connectionId: string } | { outcome: "not_found" | "lease_lost" | "connection_changed" }> {
  const result = await rpc("complete_server_enrollment_replacement", {
    p_user_id: input.userId,
    p_enrollment_id: input.enrollmentId,
    p_run_id: input.runId,
    p_encrypted_bundle: input.encryptedBundle,
    p_key_version: 1,
    p_ssh_host: input.sshHost,
  });
  if (result.outcome === "replaced" && typeof result.connectionId === "string") {
    return { outcome: "replaced", connectionId: result.connectionId };
  }
  if (result.outcome === "not_found" || result.outcome === "lease_lost" || result.outcome === "connection_changed") {
    return { outcome: result.outcome };
  }
  throw new ServerEnrollmentStoreError("invalid_record");
}

export type ReplacementFailure = NonNullable<ServerEnrollmentDto["lastReplacementFailure"]>;

export async function failServerEnrollmentReplacement(input: {
  userId: string; enrollmentId: string; runId: string; failure: ReplacementFailure;
}): Promise<void> {
  await rpc("fail_server_enrollment_replacement", {
    p_user_id: input.userId, p_enrollment_id: input.enrollmentId, p_run_id: input.runId, p_failure: input.failure,
  });
}

export async function declineServerEnrollmentRecord(userId: string, enrollmentId: string):
  Promise<"rejected" | "not_found" | "not_pending"> {
  const result = await rpc("decline_server_enrollment", { p_user_id: userId, p_enrollment_id: enrollmentId });
  if (result.outcome === "rejected" || result.outcome === "not_found" || result.outcome === "not_pending") return result.outcome;
  throw new ServerEnrollmentStoreError("invalid_record");
}

export async function cancelServerEnrollmentRecord(userId: string, enrollmentId: string):
  Promise<"cancelled" | "not_found" | "not_pending"> {
  const result = await rpc("cancel_server_enrollment", { p_user_id: userId, p_enrollment_id: enrollmentId });
  if (result.outcome === "cancelled" || result.outcome === "not_found" || result.outcome === "not_pending") return result.outcome;
  throw new ServerEnrollmentStoreError("invalid_record");
}

export async function sweepServerEnrollments(now: Date): Promise<{ expired: number; connectionsRemoved: number; deleted: number }> {
  const result = await rpc("sweep_server_enrollments", { p_now: now.toISOString() });
  const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : 0);
  return { expired: count(result.expired), connectionsRemoved: count(result.connectionsRemoved), deleted: count(result.deleted) };
}

/** Receipt of the first sign-in after Yes meeting another host key. */
export async function recordServerEnrollmentIdentityMismatch(userId: string, connectionId: string): Promise<boolean> {
  const { data, error } = await database().rpc("record_server_enrollment_identity_mismatch", {
    p_user_id: userId, p_connection_id: connectionId,
  });
  if (error) throw new ServerEnrollmentStoreError("database_error");
  return data === true;
}

/** What the server reported when it was enrolled, for the connection's
 * failure copy. Null for connections that no setup command created. */
export async function loadEnrolledServerFacts(userId: string, connectionId: string): Promise<{ sshMatchRules: boolean } | null> {
  const { data, error } = await database().from("infrastructure_server_enrollments")
    .select("facts").eq("user_id", userId).eq("connection_id", connectionId).eq("phase", "confirmed")
    .order("decided_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ServerEnrollmentStoreError("database_error");
  const facts = ServerEnrollmentFactsSchema.safeParse((data as { facts?: unknown } | null)?.facts);
  return facts.success ? { sshMatchRules: facts.data.sshMatchRules } : null;
}

// --- Known servers (8.1) ----------------------------------------------------------

type MatchedConnection = {
  id: string; name: string; provider: "host" | "proxmox" | "hetzner-cloud"; revision: number;
  ssh_user: string | null; ssh_host: string | null; ssh_privilege: "login" | "sudo" | null;
};

/** Connections in this account whose pinned identity is this host key, with
 * what each one allows. Another account's connections are never searched. */
export async function findKnownServer(
  userId: string,
  hostPublicKey: string,
  options: { proxmoxSudoAllowed: boolean },
): Promise<KnownServer | null> {
  const db = database();
  const canonical = canonicalEd25519HostKey(hostPublicKey);
  const hex = Buffer.from(canonical.fingerprintSha256.slice("SHA256:".length) + "=", "base64").toString("hex");
  const { data: sshRows, error: sshError } = await db.from("infrastructure_connections")
    .select("id,name,provider,revision,ssh_user,ssh_host,ssh_privilege")
    .eq("user_id", userId).in("provider", ["host", "proxmox"]).eq("ssh_host_fingerprint_sha256", hex);
  if (sshError) throw new ServerEnrollmentStoreError("database_error");
  const { data: bootRows, error: bootError } = await db.from("infrastructure_first_boot_enrollments")
    .select("connection_id").eq("user_id", userId).eq("phase", "enrolled").eq("host_public_key", canonical.publicKey);
  if (bootError) throw new ServerEnrollmentStoreError("database_error");
  const matches = new Map<string, MatchedConnection>();
  for (const row of (sshRows ?? []) as MatchedConnection[]) matches.set(row.id, row);
  const hetznerIds = [...new Set(((bootRows ?? []) as Array<{ connection_id: string }>).map(row => row.connection_id))];
  if (hetznerIds.length > 0) {
    const { data: hetznerRows, error: hetznerError } = await db.from("infrastructure_connections")
      .select("id,name,provider,revision,ssh_user,ssh_host,ssh_privilege").eq("user_id", userId).in("id", hetznerIds);
    if (hetznerError) throw new ServerEnrollmentStoreError("database_error");
    for (const row of (hetznerRows ?? []) as MatchedConnection[]) matches.set(row.id, row);
  }
  if (matches.size === 0) return null;
  const [first] = matches.values();
  const view = (offer: KnownServer["offer"], reason: KnownServer["reason"]): KnownServer => ({
    connectionId: first.id,
    connectionName: first.name,
    connectionRevision: Number(first.revision),
    provider: first.provider,
    sshUser: first.ssh_user,
    sshHost: first.ssh_host,
    offer,
    reason,
  });
  if (matches.size > 1) return view("none", "multiple");
  if (first.provider === "hetzner-cloud") return view("none", "hetzner");
  // A Proxmox connection keeps its root login: that lane has no sudo
  // privilege at all (only generic host connections can use sudo), whether
  // or not agents use it.
  if (first.provider === "proxmox") return view("none", "proxmox_connection");
  if (first.provider === "host" && first.ssh_user === "hivra" && first.ssh_privilege === "sudo") {
    return view("replace_key", null);
  }
  // A switch is an operational change: refused while any agent uses the
  // connection, and on Proxmox VE while sudo can't run Proxmox launches.
  const { count, error: agentError } = await db.from("hivra_agents").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("infrastructure_connection_id", first.id).eq("deployment_mode", "self-managed")
    .neq("status", "deleted");
  if (agentError) throw new ServerEnrollmentStoreError("database_error");
  if ((count ?? 0) > 0) return view("none", "login_in_use");
  if (!options.proxmoxSudoAllowed && await latestInspectionFoundProxmox(userId, first.id)) {
    return view("none", "proxmox_needs_root");
  }
  return view("switch_user", null);
}

async function latestInspectionFoundProxmox(userId: string, connectionId: string): Promise<boolean> {
  const { data, error } = await database().from("infrastructure_host_discovery_snapshots")
    .select("snapshot").eq("user_id", userId).eq("connection_id", connectionId)
    .order("observed_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ServerEnrollmentStoreError("database_error");
  const engines = (data as { snapshot?: { engines?: Array<{ id?: unknown; availability?: unknown }> } } | null)
    ?.snapshot?.engines;
  return Array.isArray(engines) && engines.some(engine => engine.id === "proxmox-kvm" && engine.availability === "installed");
}

// --- Read model -------------------------------------------------------------------

/** The owner's view. Expiry is a fact at read time: an issued code past
 * expires_at, or a report past confirm_by, reads as expired before the sweep
 * marks it. */
export function serverEnrollmentDto(row: ServerEnrollmentRow, knownServer: KnownServer | null, now: Date): ServerEnrollmentDto {
  const expired = (row.phase === "issued" && Date.parse(row.expires_at) <= now.getTime())
    || (row.phase === "reported" && row.confirm_by !== null && Date.parse(row.confirm_by) <= now.getTime());
  const facts = ServerEnrollmentFactsSchema.safeParse(row.facts);
  const report = row.report_kind && row.reported_at && facts.success && row.consent
    ? {
        kind: row.report_kind,
        reportedAt: row.reported_at,
        observedAddress: row.observed_address,
        sshPort: row.ssh_port,
        hostFingerprintSha256: row.host_fingerprint_sha256,
        facts: facts.data,
        consent: row.consent,
        words: row.words,
        reenrollment: row.reenrollment ?? false,
      }
    : null;
  return {
    id: row.id,
    phase: expired ? "expired" : row.phase,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    confirmBy: row.confirm_by,
    scriptFetches: row.script_fetches,
    lastFetchedAt: row.last_fetched_at,
    refusedReports: row.refused_reports,
    lastRefusal: row.last_refusal,
    lastRefusedAt: row.last_refused_at,
    report,
    knownServer: row.phase === "reported" && !expired ? knownServer : null,
    outcome: row.outcome,
    connectionId: row.connection_id,
    decidedAt: row.decided_at ?? (expired ? (row.phase === "issued" ? row.expires_at : row.confirm_by) : null),
    replacementAttempts: row.replacement_attempts,
    lastReplacementFailure: row.last_replacement_failure,
  };
}
