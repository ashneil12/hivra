import "server-only";

import { randomUUID } from "node:crypto";
import net from "node:net";

import { accountCode } from "@/lib/account-code";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

import {
  buildUserProxmoxEnvironment,
  InfrastructureNetworkError,
  isAllowedSshAddress,
  resolveValidatedSshDestination,
} from "./connection-runtime";
import {
  getInfrastructureConnection,
  loadInfrastructureConnectionSecret,
  sealConnectionPrivateKey,
} from "./connection-store";
import { ProxmoxSshHostSchema, type InfrastructureConnectionDto } from "./contracts";
import { generateVerifiedEd25519SshKeyPair } from "./ed25519-ssh-key";
import {
  generateServerEnrollmentCode,
  SERVER_ENROLLMENT_ADMIN_KEY_COMMENT,
  serverEnrollmentCodeFromAuthorization,
  serverEnrollmentCodeSha256,
} from "./server-enrollment-code";
import type {
  ServerEnrollmentDto,
  ServerEnrollmentIssueResult,
  ServerEnrollmentList,
} from "./server-enrollment-contracts";
import {
  loadServerEnrollScriptBody,
  renderEnrollFinalLine,
  renderRefusalLine,
  SERVER_ENROLL_SCRIPT_SHA256,
  SERVER_ENROLL_SCRIPT_VERSION,
  serverEnrollmentCommands,
  servedScript,
  serverUninstallCommand,
  sha256Hex,
  UNINSTALL_FINAL_LINE,
  ServerEnrollScriptError,
} from "./server-enrollment-script";
import {
  beginServerEnrollmentReplacement,
  cancelServerEnrollmentRecord,
  completeServerEnrollmentReplacement,
  confirmServerEnrollmentRecord,
  declineServerEnrollmentRecord,
  failServerEnrollmentReplacement,
  findKnownServer,
  getServerEnrollmentRow,
  issueServerEnrollmentRecord,
  listServerEnrollmentRows,
  loadServerEnrollmentAdminKey,
  recordServerEnrollmentFetch,
  sealServerEnrollmentAdminKey,
  serverEnrollmentDto,
  type ReplacementFailure,
  type ServerEnrollmentRow,
} from "./server-enrollment-store";
import { PROXMOX_SUDO_TRANSPORT_READY } from "./sudo-transport-gate";
import { trustedAppOrigin } from "./trusted-app-origin";

export type ServerEnrollmentErrorCode =
  | "unavailable" | "active_limit" | "daily_limit" | "not_found" | "not_pending" | "known_identity"
  | "address_required" | "address_invalid" | "address_blocked" | "replace_not_offered" | "busy"
  | "attempts_exhausted" | "connection_changed" | "operation_running" | "agents_bound"
  | "verification_failed";

export class ServerEnrollmentError extends Error {
  constructor(readonly code: ServerEnrollmentErrorCode, readonly failure: ReplacementFailure | null = null) {
    super("Server enrollment failed: " + code);
    this.name = "ServerEnrollmentError";
  }
}

// --- The served script ------------------------------------------------------

export type ServedScript = { status: 200 | 503; body: string };

/**
 * GET /enroll. The body is the same for everyone; only the final line
 * differs. Downloading never spends the code, so "view first" and --dry-run
 * keep it valid. Every unusable code gets byte-identical bytes; the
 * download-limit refusal is served only for a usable code already fetched 20
 * times, which tells nothing to anyone who has not fetched it.
 */
export async function serveEnrollScript(
  input: { authorization: string | null; hasQuery: boolean },
  deps: { record?: typeof recordServerEnrollmentFetch; origin?: () => string | null; body?: () => Promise<string> } = {},
): Promise<ServedScript> {
  let body: string;
  try {
    body = await (deps.body ?? loadServerEnrollScriptBody)();
  } catch {
    return { status: 503, body: "" };
  }
  const origin = (deps.origin ?? trustedAppOrigin)();
  if (!origin) return { status: 503, body: "" };
  if (input.hasQuery || input.authorization === null) return { status: 200, body: servedScript(body, renderRefusalLine("missing_code")) };
  const code = serverEnrollmentCodeFromAuthorization(input.authorization);
  // A malformed header never reaches the database.
  if (!code) return { status: 200, body: servedScript(body, renderRefusalLine("expired_or_used")) };
  const fetched = await (deps.record ?? recordServerEnrollmentFetch)(serverEnrollmentCodeSha256(code));
  if (fetched.status === "fetch_limit") return { status: 200, body: servedScript(body, renderRefusalLine("fetch_limit")) };
  if (fetched.status !== "served") return { status: 200, body: servedScript(body, renderRefusalLine("expired_or_used")) };
  return {
    status: 200,
    body: servedScript(body, renderEnrollFinalLine({
      origin, code, adminPublicKey: fetched.adminPublicKey, accountCode: accountCode(fetched.userId),
    })),
  };
}

export async function serveUninstallScript(body: () => Promise<string> = loadServerEnrollScriptBody): Promise<ServedScript> {
  try {
    return { status: 200, body: servedScript(await body(), UNINSTALL_FINAL_LINE) };
  } catch {
    return { status: 503, body: "" };
  }
}

export async function serveScriptBody(body: () => Promise<string> = loadServerEnrollScriptBody): Promise<ServedScript> {
  try {
    return { status: 200, body: await body() };
  } catch {
    return { status: 503, body: "" };
  }
}

export async function serveScriptSha256(body: () => Promise<string> = loadServerEnrollScriptBody): Promise<ServedScript> {
  try {
    await body();
    return { status: 200, body: SERVER_ENROLL_SCRIPT_SHA256 + "\n" };
  } catch {
    return { status: 503, body: "" };
  }
}

// --- Owner actions -----------------------------------------------------------

type IssueDependencies = {
  origin: () => string | null;
  reachable: (origin: string) => Promise<boolean>;
  body: () => Promise<string>;
  now: () => Date;
};

async function enrollmentView(userId: string, row: ServerEnrollmentRow, now: Date): Promise<ServerEnrollmentDto> {
  const known = row.phase === "reported" && row.host_public_key
    ? await findKnownServer(userId, row.host_public_key, { proxmoxSudoAllowed: PROXMOX_SUDO_TRANSPORT_READY })
    : null;
  return serverEnrollmentDto(row, known, now);
}

/** Issue a one-time code with its own Ed25519 key for the hivra user. The
 * code is returned once, inside the command; it is stored only as a hash. */
export async function issueServerEnrollment(
  userId: string,
  request: { replaceEnrollmentId?: string | null },
  dependencies: Partial<IssueDependencies> & { reachable: IssueDependencies["reachable"] },
): Promise<ServerEnrollmentIssueResult> {
  const deps: IssueDependencies = {
    origin: trustedAppOrigin, body: loadServerEnrollScriptBody, now: () => new Date(), ...dependencies,
  };
  const origin = deps.origin();
  if (!origin) throw new ServerEnrollmentError("unavailable");
  let body: string;
  try {
    body = await deps.body();
  } catch (error) {
    if (error instanceof ServerEnrollScriptError) throw new ServerEnrollmentError("unavailable");
    throw error;
  }
  // A preview behind deployment protection shows "not available" instead of
  // a command that can't reach Hivra.
  if (!await deps.reachable(origin)) throw new ServerEnrollmentError("unavailable");
  const code = generateServerEnrollmentCode();
  const keyPair = generateVerifiedEd25519SshKeyPair(SERVER_ENROLLMENT_ADMIN_KEY_COMMENT);
  const issued = await issueServerEnrollmentRecord({
    userId,
    codeSha256: serverEnrollmentCodeSha256(code),
    scriptVersion: SERVER_ENROLL_SCRIPT_VERSION,
    adminPublicKey: keyPair.publicKey,
    adminKeyFingerprint: keyPair.fingerprintSha256,
    sealedAdminPrivateKey: sealServerEnrollmentAdminKey({
      userId, publicKey: keyPair.publicKey, privateKeyOpenSsh: keyPair.privateKeyOpenSsh,
    }),
    replaceEnrollmentId: request.replaceEnrollmentId ?? null,
  });
  if (issued.outcome !== "issued") throw new ServerEnrollmentError(issued.outcome);
  const row = await getServerEnrollmentRow(userId, issued.enrollmentId);
  if (!row) throw new ServerEnrollmentError("not_found");
  const ownerAccountCode = accountCode(userId);
  const finalLine = renderEnrollFinalLine({ origin, code, adminPublicKey: keyPair.publicKey, accountCode: ownerAccountCode });
  return {
    enrollment: serverEnrollmentDto(row, null, deps.now()),
    ...serverEnrollmentCommands(origin, code),
    finalLine,
    downloadSha256: sha256Hex(servedScript(body, finalLine)),
    scriptVersion: SERVER_ENROLL_SCRIPT_VERSION,
    scriptSha256: SERVER_ENROLL_SCRIPT_SHA256,
    accountCode: ownerAccountCode,
    origin,
  };
}

export async function getServerEnrollment(userId: string, enrollmentId: string, now = new Date()): Promise<ServerEnrollmentDto> {
  const row = await getServerEnrollmentRow(userId, enrollmentId);
  if (!row) throw new ServerEnrollmentError("not_found");
  return enrollmentView(userId, row, now);
}

export async function listServerEnrollments(userId: string, now = new Date()): Promise<ServerEnrollmentList> {
  const rows = await listServerEnrollmentRows(userId, now);
  const enrollments = await Promise.all(rows.map(row => enrollmentView(userId, row, now)));
  const origin = trustedAppOrigin();
  return { enrollments, uninstallCommand: origin ? serverUninstallCommand(origin) : null };
}

function pendingReport(row: ServerEnrollmentRow | null, now: Date): ServerEnrollmentRow {
  if (!row) throw new ServerEnrollmentError("not_found");
  if (row.phase !== "reported" || !row.confirm_by || Date.parse(row.confirm_by) <= now.getTime() || !row.host_public_key) {
    throw new ServerEnrollmentError("not_pending");
  }
  return row;
}

/** An owner-entered address: what the manual wizard accepts, checked with the
 * same SSRF rules before anything is stored. */
async function ownerAddress(raw: string): Promise<string> {
  const parsed = ProxmoxSshHostSchema.safeParse(raw);
  if (!parsed.success) throw new ServerEnrollmentError("address_invalid");
  try {
    await resolveValidatedSshDestination(parsed.data);
  } catch (error) {
    if (error instanceof InfrastructureNetworkError && error.code === "ssh_host_forbidden") {
      throw new ServerEnrollmentError("address_blocked");
    }
    throw new ServerEnrollmentError("address_invalid");
  }
  return parsed.data;
}

function connectionName(row: ServerEnrollmentRow): string {
  const facts = row.facts as { hostname?: unknown } | null;
  const hostname = typeof facts?.hostname === "string" && /^[A-Za-z0-9.-]{1,80}$/.test(facts.hostname) ? facts.hostname : null;
  return hostname ?? "My server";
}

/** Yes, this is my server: one pinned sudo connection for user hivra, at the
 * address Hivra saw (or the owner's own), then the normal inspection. */
export async function confirmServerEnrollment(
  userId: string,
  enrollmentId: string,
  request: { sshHost?: string | null },
  now = new Date(),
): Promise<InfrastructureConnectionDto> {
  const row = pendingReport(await getServerEnrollmentRow(userId, enrollmentId), now);
  if (await findKnownServer(userId, row.host_public_key!, { proxmoxSudoAllowed: PROXMOX_SUDO_TRANSPORT_READY })) {
    throw new ServerEnrollmentError("known_identity");
  }
  let sshHost: string;
  if (request.sshHost) {
    sshHost = await ownerAddress(request.sshHost);
  } else {
    // Checked again at Yes: IPv4 and not a reserved range.
    if (!row.observed_address || net.isIP(row.observed_address) !== 4 || !isAllowedSshAddress(row.observed_address)) {
      throw new ServerEnrollmentError("address_required");
    }
    sshHost = row.observed_address;
  }
  const privateKey = await loadServerEnrollmentAdminKey(userId, enrollmentId);
  if (!privateKey) throw new ServerEnrollmentError("not_pending");
  const result = await confirmServerEnrollmentRecord({
    userId, enrollmentId, sshHost, connectionName: connectionName(row),
    encryptedBundle: sealConnectionPrivateKey(privateKey),
  });
  if (result.outcome !== "connected") throw new ServerEnrollmentError(result.outcome);
  return getInfrastructureConnection(userId, result.connectionId);
}

export const REPLACEMENT_PROBE_MARKER = "HIVRA_REPLACE_PROBE_V2";
/** Fixed and read-only, through the sudo transport: the effective UID, and
 * whether the server runs Proxmox VE (/etc/pve or pveversion), which a switch
 * to the hivra user must not reach while Proxmox needs a root login. */
export const REPLACEMENT_PROBE_SCRIPT = [
  "pve=0",
  "if [ -d /etc/pve ] || command -v pveversion >/dev/null 2>&1; then pve=1; fi",
  `printf '${REPLACEMENT_PROBE_MARKER} %s %s\\n' "$(id -u)" "$pve"`,
  "",
].join("\n");

type ReplaceDependencies = {
  run: typeof runProxmoxHostScript;
  resolve: typeof resolveValidatedSshDestination;
  now: () => Date;
  newRunId: () => string;
  proxmoxSudoAllowed: boolean;
};

/** Sign in to the connection's server with its pinned key, user hivra and
 * this enrollment's key, and run the probe through the sudo transport.
 * Success proves three things at once: the server holds the pinned host key,
 * it accepted this enrollment's key, and sudo ran without a password as
 * UID 0. Nothing on the server changes. */
export async function verifyEnrollmentKeyOnServer(input: {
  connectionId: string; sshHost: string; sshPort: number; pinnedFingerprint: string; privateKey: string;
  /** A switch refuses a server that runs Proxmox VE while gate T43 is off. */
  refuseProxmox: boolean;
}, deps: Pick<ReplaceDependencies, "run" | "resolve">): Promise<ReplacementFailure | null> {
  let destination: Awaited<ReturnType<typeof resolveValidatedSshDestination>>;
  try {
    destination = await deps.resolve(input.sshHost);
  } catch {
    return "connection_failed";
  }
  const env = buildUserProxmoxEnvironment({
    id: input.connectionId, sshHost: input.sshHost, sshPort: input.sshPort, sshUser: "hivra",
    sshHostFingerprintSha256: input.pinnedFingerprint, sshPrivateKey: input.privateKey,
    sshPrivilege: "sudo", sshHostKeyType: "ssh-ed25519",
  }, destination);
  const result = await deps.run(REPLACEMENT_PROBE_SCRIPT, env, { timeoutMs: 20_000, maxOutputBytes: 4_096 });
  if (result.presentedHostFingerprintSha256) return "host_key_mismatch";
  if (result.sudoFailure) return "sudo_unavailable";
  if (!result.ok) {
    const error = (result.error ?? "").toLowerCase();
    if (/authentication|permission denied|no supported auth|configured authentication/.test(error)) return "authentication_failed";
    if (/host key|verification failed|fingerprint/.test(error)) return "host_key_mismatch";
    if (/remote bash exited/.test(error)) return "not_root";
    return "connection_failed";
  }
  const line = result.stdout.split("\n").find(value => value.startsWith(REPLACEMENT_PROBE_MARKER + " "));
  const [uid, pve] = line?.slice(REPLACEMENT_PROBE_MARKER.length + 1).trim().split(" ") ?? [];
  if (uid !== "0" || (pve !== "0" && pve !== "1")) return "not_root";
  return input.refuseProxmox && pve === "1" ? "proxmox_needs_root" : null;
}

/**
 * Replace access (8.1). Only for a report whose identity matches exactly one
 * connection that allows it. Hivra changes that connection only after signing
 * in to it with the new key; a forged report fails that sign-in and the
 * connection, its secret, revision and targets stay exactly as they were.
 */
export async function replaceServerEnrollmentAccess(
  userId: string,
  enrollmentId: string,
  request: { connectionId: string; connectionRevision: number; sshHost?: string | null },
  dependencies: Partial<ReplaceDependencies> = {},
): Promise<InfrastructureConnectionDto> {
  const deps: ReplaceDependencies = {
    run: runProxmoxHostScript, resolve: resolveValidatedSshDestination, now: () => new Date(),
    newRunId: randomUUID, proxmoxSudoAllowed: PROXMOX_SUDO_TRANSPORT_READY, ...dependencies,
  };
  const row = pendingReport(await getServerEnrollmentRow(userId, enrollmentId), deps.now());
  const known = await findKnownServer(userId, row.host_public_key!, { proxmoxSudoAllowed: deps.proxmoxSudoAllowed });
  if (!known || (known.offer !== "replace_key" && known.offer !== "switch_user")) {
    throw new ServerEnrollmentError("replace_not_offered");
  }
  if (known.connectionId !== request.connectionId || known.connectionRevision !== request.connectionRevision) {
    throw new ServerEnrollmentError("connection_changed");
  }
  const mode = known.offer === "replace_key" ? "key" : "switch";
  // A key-only change can't move the address, as in credential recovery.
  if (mode === "key" && request.sshHost) throw new ServerEnrollmentError("address_invalid");
  const chosenHost = mode === "switch" && request.sshHost ? await ownerAddress(request.sshHost) : null;
  const connection = await loadInfrastructureConnectionSecret(userId, request.connectionId);
  if (connection.revision !== request.connectionRevision) throw new ServerEnrollmentError("connection_changed");
  const privateKey = await loadServerEnrollmentAdminKey(userId, enrollmentId);
  if (!privateKey) throw new ServerEnrollmentError("not_pending");

  const runId = deps.newRunId();
  const begun = await beginServerEnrollmentReplacement({
    userId, enrollmentId, connectionId: request.connectionId, expectedRevision: request.connectionRevision, mode, runId,
  });
  if (begun.outcome !== "begun") throw new ServerEnrollmentError(begun.outcome);
  let failure: ReplacementFailure | null;
  try {
    failure = await verifyEnrollmentKeyOnServer({
      connectionId: connection.id, sshHost: chosenHost ?? connection.endpoint.sshHost,
      sshPort: connection.endpoint.sshPort, pinnedFingerprint: connection.endpoint.sshHostFingerprintSha256,
      privateKey,
      // A key-only change keeps the privilege the connection already has, so
      // it can't make Proxmox any less available. A switch would move a root
      // login to sudo, which Proxmox can't use until gate T43 opens.
      refuseProxmox: mode === "switch" && !deps.proxmoxSudoAllowed,
    }, deps);
  } catch {
    failure = "connection_failed";
  }
  if (failure) {
    await failServerEnrollmentReplacement({ userId, enrollmentId, runId, failure });
    throw new ServerEnrollmentError("verification_failed", failure);
  }
  const completed = await completeServerEnrollmentReplacement({
    userId, enrollmentId, runId, encryptedBundle: sealConnectionPrivateKey(privateKey), sshHost: chosenHost,
  }).catch(async (error: unknown) => {
    await failServerEnrollmentReplacement({ userId, enrollmentId, runId, failure: "connection_changed" }).catch(() => undefined);
    throw error;
  });
  if (completed.outcome !== "replaced") {
    await failServerEnrollmentReplacement({ userId, enrollmentId, runId, failure: "connection_changed" }).catch(() => undefined);
    throw new ServerEnrollmentError(completed.outcome === "not_found" ? "not_found" : "connection_changed");
  }
  return getInfrastructureConnection(userId, completed.connectionId);
}

export async function declineServerEnrollment(userId: string, enrollmentId: string): Promise<void> {
  const result = await declineServerEnrollmentRecord(userId, enrollmentId);
  if (result !== "rejected") throw new ServerEnrollmentError(result);
}

export async function cancelServerEnrollment(userId: string, enrollmentId: string): Promise<void> {
  const result = await cancelServerEnrollmentRecord(userId, enrollmentId);
  if (result !== "cancelled") throw new ServerEnrollmentError(result);
}
