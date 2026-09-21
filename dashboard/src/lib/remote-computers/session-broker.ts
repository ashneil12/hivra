import crypto from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import {
  assessRemoteDesktopAccessGrant,
  REMOTE_DESKTOP_TRANSPORTS,
  remoteDesktopAudience,
  selectRemoteDesktopTransport,
  type DesktopAccessPurpose,
  type RemoteDesktopClientCapabilities,
  type RemoteDesktopComputerKind,
  type RemoteDesktopHostCapabilities,
  type RemoteDesktopTransportId,
} from "@/lib/remote-computers/transport-catalog";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const SESSION_TOKEN_RE = /^hrs1_[A-Za-z0-9_-]{43}$/;
const MAX_GRANT_TTL_MS = 5 * 60_000;
const DEFAULT_GRANT_TTL_MS = 4 * 60_000;

interface NativeDesktopPublicProfile {
  clientId: string;
  clientCertificatePem: string;
  clientCertificateSha256: string;
}

export interface RemoteDesktopCapabilityReceipt {
  protocol: "hivra-remote-desktop-capability-v1";
  computerKind: RemoteDesktopComputerKind;
  computerId: string;
  capabilityGeneration: string;
  /** Hash of an inspector-observed guest boot identity. Omitted by legacy and
   * provider receipts, which remain ineligible for automatic lease retirement. */
  bootIdentitySha256?: string;
  observedRevision: string;
  compositor: RemoteDesktopHostCapabilities["compositor"];
  /** Legacy wire name; entries are admitted only after capability inspection. */
  installedTransports: RemoteDesktopTransportId[];
  privateNetworkReachable: boolean;
  supportsInputTakeover: boolean;
  brokerOrigin: string;
  observedAt: string;
}

export interface RemoteDesktopInputReceipt {
  protocol: "hivra-remote-desktop-input-v1";
  action: "agent-input-suspended" | "agent-input-resumed";
  sessionId: string;
  computerKind: RemoteDesktopComputerKind;
  computerId: string;
  capabilityGeneration: string;
  transport: RemoteDesktopTransportId;
  agentInputSuspended: boolean;
  controllerCount: number;
  observedAt: string;
}

interface CapabilityRow {
  computer_kind: RemoteDesktopComputerKind;
  computer_id: string;
  user_id: string;
  generation: string;
  compositor: RemoteDesktopHostCapabilities["compositor"];
  installed_transports: RemoteDesktopTransportId[];
  private_network_reachable: boolean;
  supports_input_takeover: boolean;
  broker_origin: string;
  observed_revision: string;
  observed_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface ControllerSessionRow {
  id?: string;
  user_id?: string;
  computer_kind?: string;
  computer_id?: string;
  transport?: string;
  capability_generation: string;
  input_state: string;
  revoked_at: string | null;
  expires_at: string;
}

interface SessionProtocolEvidenceRow {
  computer_kind: RemoteDesktopComputerKind;
  computer_id: string;
  capability_generation: string;
  transport: RemoteDesktopTransportId;
  pkce_challenge: string;
}

interface CapabilityRevisionEvidenceRow {
  observed_revision: string;
}

type BrokerFailure = { ok: false; status: number; error: string; code: string };

function failure(status: number, code: string, error: string): BrokerFailure {
  return { ok: false, status, code, error };
}

function sha256Hex(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function validNativeDesktopPublicProfile(value: NativeDesktopPublicProfile): boolean {
  if (
    !UUID_RE.test(value.clientId)
    || value.clientCertificatePem.length < 64 || value.clientCertificatePem.length > 16_384
    || !/^[a-f0-9]{64}$/.test(value.clientCertificateSha256)
    || value.clientCertificatePem.includes("PRIVATE KEY")
  ) return false;
  try {
    const certificate = new crypto.X509Certificate(value.clientCertificatePem);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    return certificate.ca === false
      && sha256Hex(certificate.raw) === value.clientCertificateSha256
      && certificate.verify(certificate.publicKey)
      && Number.isFinite(validFrom) && validFrom <= Date.now()
      && Number.isFinite(validTo) && validTo > Date.now();
  } catch {
    return false;
  }
}

function validComputerRef(kind: string, id: string): kind is RemoteDesktopComputerKind {
  return (kind === "hermes-instance" || kind === "hivra-agent") && UUID_RE.test(id);
}

function objectResult(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function rpcStatus(data: unknown): string {
  const row = objectResult(data);
  return typeof row?.status === "string" ? row.status : "";
}

function statusFailure(status: string): BrokerFailure {
  switch (status) {
    case "generation_conflict":
      return failure(409, status, "This capability generation is already bound to different runtime state.");
    case "controller_conflict":
      return failure(409, status, "Another human controller still owns this computer input lease.");
    case "input_takeover_unavailable":
      return failure(409, status, "This computer has not proved safe human input takeover yet.");
    case "transport_unavailable":
      return failure(409, status, "The requested desktop transport is not compatible with this computer.");
    case "computer_not_ready":
    case "capability_unavailable":
      return failure(409, status, "The computer has no current remote-desktop capability.");
    case "expired":
      return failure(410, status, "The desktop handoff expired.");
    case "renewal_window_complete":
      return failure(410, status, "The continuous desktop session reached its renewal limit.");
    case "renewal_not_due":
      return failure(409, status, "The desktop session does not need renewal yet.");
    case "revoked":
      return failure(410, status, "The desktop handoff was revoked.");
    case "already_used":
      return failure(409, status, "The desktop handoff has already been used.");
    case "not_found":
      return failure(404, status, "Desktop session not found.");
    case "invalid":
    case "invalid_request":
    case "invalid_receipt":
      return failure(400, status || "invalid_request", "Invalid desktop session request.");
    default:
      return failure(409, status || "operation_conflict", "The desktop session changed before this request completed.");
  }
}

function desktopUpgradeRequired(): BrokerFailure {
  return failure(
    409,
    "desktop_upgrade_required",
    "This desktop needs the current Hivra runtime before a secure session can start.",
  );
}

/**
 * Capability inspection records the canonical revision, but it also records
 * receipts through this module. Resolve the constant at call time so the two
 * modules retain one source of truth without a module-initialization cycle.
 */
async function currentRemoteDesktopRevisions(
  transport: RemoteDesktopTransportId,
): Promise<readonly string[] | null> {
  try {
    const revisions = transport === "sunshine-moonlight"
      ? [(await import("@/lib/remote-computers/omarchy-native-capability"))
        .OMARCHY_DESKTOP_SESSION_REVISION]
      : (await import("@/lib/remote-computers/capability-inspection"))
        .REMOTE_DESKTOP_SESSION_REVISIONS;
    return revisions?.length > 0 && revisions.every(revision => /^[a-f0-9]{64}$/.test(revision))
      ? revisions : null;
  } catch {
    return null;
  }
}

async function requireCurrentTransportRevision(
  transport: RemoteDesktopTransportId,
  observedRevision: string,
): Promise<{ ok: true } | BrokerFailure> {
  if (transport !== "selkies-websocket" && transport !== "sunshine-moonlight") return { ok: true };
  const currentRevisions = await currentRemoteDesktopRevisions(transport);
  if (!currentRevisions) {
    return failure(503, "desktop_revision_unavailable", "Desktop sessions are unavailable.");
  }
  if (!currentRevisions.includes(observedRevision)) return desktopUpgradeRequired();
  return { ok: true };
}

async function loadSessionProtocolEvidence(params: {
  lookupColumn: "exchange_code_hash" | "session_token_hash";
  lookupHash: string;
}): Promise<{ ok: true; session: SessionProtocolEvidenceRow | null } | BrokerFailure> {
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  try {
    const { data, error } = await supabaseAdmin
      .from("hivra_remote_desktop_sessions")
      .select("computer_kind,computer_id,capability_generation,transport,pkce_challenge")
      .eq(params.lookupColumn, params.lookupHash)
      .maybeSingle<SessionProtocolEvidenceRow>();
    if (error) {
      return failure(503, "session_protocol_lookup_failed", "Desktop sessions are unavailable.");
    }
    return { ok: true, session: data };
  } catch {
    return failure(503, "session_protocol_lookup_failed", "Desktop sessions are unavailable.");
  }
}

async function requireCurrentSessionProtocol(
  session: SessionProtocolEvidenceRow,
): Promise<{ ok: true } | BrokerFailure> {
  if (session.transport !== "selkies-websocket" && session.transport !== "sunshine-moonlight") {
    return { ok: true };
  }
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  try {
    const { data, error } = await supabaseAdmin
      .from("hivra_remote_desktop_capabilities")
      .select("observed_revision")
      .eq("computer_kind", session.computer_kind)
      .eq("computer_id", session.computer_id)
      .eq("generation", session.capability_generation)
      .maybeSingle<CapabilityRevisionEvidenceRow>();
    if (error) {
      return failure(503, "capability_lookup_failed", "Desktop sessions are unavailable.");
    }
    // Never let a capability appear between this read and the mutation RPC.
    // A current exact generation is required before any Selkies authority is
    // issued, exchanged, checked or renewed.
    if (!data) {
      return failure(409, "capability_unavailable", "The computer has no current remote-desktop capability.");
    }
    return requireCurrentTransportRevision(session.transport, data.observed_revision);
  } catch {
    return failure(503, "capability_lookup_failed", "Desktop sessions are unavailable.");
  }
}

/**
 * Refine the database's deliberately coarse controller conflict without
 * weakening its serialized one-controller fence. A release-pending row is an
 * old controller whose guest still needs to prove input release. Only an
 * explicit, fully owner-verified browser handoff may revoke an active grant;
 * it still cannot bypass the guest's release acknowledgement.
 */
async function classifyControllerConflict(params: {
  computerKind: RemoteDesktopComputerKind;
  computerId: string;
  capabilityGeneration: string;
  ownerHandoffUserId?: string;
}): Promise<BrokerFailure> {
  const fallback = statusFailure("controller_conflict");
  if (!supabaseAdmin) return fallback;
  let rows: ControllerSessionRow[];
  try {
    const { data, error } = await supabaseAdmin
      .from("hivra_remote_desktop_sessions")
      .select("id,user_id,computer_kind,computer_id,transport,capability_generation,input_state,revoked_at,expires_at")
      .eq("computer_kind", params.computerKind)
      .eq("computer_id", params.computerId)
      .eq("input_role", "controller")
      .in("input_state", ["takeover-pending", "active", "release-pending"])
      .returns<ControllerSessionRow[]>();
    if (error || !Array.isArray(data)) return fallback;
    rows = data;
  } catch {
    return fallback;
  }

  const now = Date.now();
  if (params.ownerHandoffUserId) {
    // Validate the complete snapshot before revoking anything. UUID session
    // identities are immutable; never broaden revocation to a computer/user.
    if (rows.some(row => !row || typeof row.id !== "string" || !UUID_RE.test(row.id)
      || row.user_id !== params.ownerHandoffUserId
      || row.computer_kind !== params.computerKind || row.computer_id !== params.computerId
      || row.capability_generation !== params.capabilityGeneration
      || row.transport !== "selkies-websocket"
      || !["active", "takeover-pending", "release-pending"].includes(row.input_state)
      || (row.revoked_at !== null && (typeof row.revoked_at !== "string" || !Number.isFinite(Date.parse(row.revoked_at))))
      || typeof row.expires_at !== "string" || !Number.isFinite(Date.parse(row.expires_at)))) return fallback;
    const targets = rows.filter(row => row.revoked_at === null
      && Date.parse(row.expires_at) > now
      && (row.input_state === "active" || row.input_state === "takeover-pending"));
    if (targets.length) {
      for (const row of targets) {
        const revoked = await revokeRemoteDesktopSession({
          userId: params.ownerHandoffUserId, sessionId: row.id!, reason: "user_revoked",
        });
        if (!revoked.ok) return revoked;
      }
      // Revocation is not a guest release acknowledgement. The next issue
      // remains behind the SQL fence until the real guest releases input.
      return failure(409, "controller_releasing", "The previous desktop is still releasing this computer input lease.");
    }
  }
  const activeController = rows.some(row => {
    const expiresAt = Date.parse(row.expires_at);
    return row.capability_generation === params.capabilityGeneration
      && row.revoked_at === null
      && Number.isFinite(expiresAt)
      && expiresAt > now
      && (row.input_state === "takeover-pending" || row.input_state === "active");
  });
  if (activeController) return fallback;
  if (rows.some(row => row.input_state === "release-pending")) {
    return failure(
      409,
      "controller_releasing",
      "The previous desktop is still releasing this computer input lease.",
    );
  }
  return fallback;
}

async function loadCapability(params: {
  userId: string;
  computerKind: RemoteDesktopComputerKind;
  computerId: string;
}): Promise<{ ok: true; capability: CapabilityRow } | BrokerFailure> {
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  const { data, error } = await supabaseAdmin
    .from("hivra_remote_desktop_capabilities")
    .select("computer_kind,computer_id,user_id,generation,compositor,installed_transports,private_network_reachable,supports_input_takeover,broker_origin,observed_revision,observed_at,expires_at,revoked_at")
    .eq("computer_kind", params.computerKind)
    .eq("computer_id", params.computerId)
    .eq("user_id", params.userId)
    .maybeSingle<CapabilityRow>();
  if (error) return failure(503, "capability_lookup_failed", "Desktop sessions are unavailable.");
  if (!data || data.revoked_at || new Date(data.expires_at).getTime() <= Date.now()) {
    return failure(409, "capability_unavailable", "The computer has no current remote-desktop capability.");
  }
  return { ok: true, capability: data };
}

/** Record a control-plane-observed guest capability. Never expose this as an owner-authored API. */
export async function recordRemoteDesktopCapability(params: {
  userId: string;
  receipt: RemoteDesktopCapabilityReceipt;
  expiresAt: string;
}): Promise<{ ok: true; generation: string } | BrokerFailure> {
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  const receipt = params.receipt;
  if (
    !params.userId || !validComputerRef(receipt.computerKind, receipt.computerId)
    || !UUID_RE.test(receipt.capabilityGeneration)
    || (receipt.bootIdentitySha256 !== undefined && !/^[a-f0-9]{64}$/.test(receipt.bootIdentitySha256))
  ) return failure(400, "invalid_receipt", "Invalid desktop capability receipt.");
  const { bootIdentitySha256, ...wireReceipt } = receipt;
  const { data, error } = await supabaseAdmin.rpc(
    bootIdentitySha256 === undefined
      ? "record_hivra_remote_desktop_capability"
      : "record_hivra_remote_desktop_capability_v2", {
    p_user_id: params.userId,
    p_computer_kind: receipt.computerKind,
    p_computer_id: receipt.computerId,
    p_generation: receipt.capabilityGeneration,
    p_receipt: wireReceipt,
    p_expires_at: params.expiresAt,
    ...(bootIdentitySha256 === undefined ? {} : { p_boot_identity_sha256: bootIdentitySha256 }),
  });
  if (error) return failure(503, "capability_record_failed", "Desktop sessions are unavailable.");
  if (rpcStatus(data) !== "ready") return statusFailure(rpcStatus(data));
  return { ok: true, generation: receipt.capabilityGeneration };
}

export async function issueRemoteDesktopSession(params: {
  userId: string;
  ownerHandoff?: boolean;
  sessionId?: string;
  computerKind: RemoteDesktopComputerKind;
  computerId: string;
  purpose: DesktopAccessPurpose;
  inputRole: "controller" | "viewer";
  streamingMode: "hq" | "qhd" | "uhd" | "performance";
  requestedTransport?: RemoteDesktopTransportId;
  client: RemoteDesktopClientCapabilities;
  nativeProfile?: NativeDesktopPublicProfile;
  pkceChallenge: string;
  ttlMs?: number;
}): Promise<{
  ok: true;
  session: {
    id: string;
    exchangeCode: string;
    handoff: "message";
    transport: RemoteDesktopTransportId;
    inputRole: "controller" | "viewer";
    streamingMode: "hq" | "qhd" | "uhd" | "performance";
    brokerOrigin: string;
    audience: string;
    issuedAt: string;
    expiresAt: string;
  };
} | BrokerFailure> {
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  if (
    !params.userId || !validComputerRef(params.computerKind, params.computerId)
    || (params.ownerHandoff !== undefined && typeof params.ownerHandoff !== "boolean")
    || (params.ownerHandoff === true && (params.computerKind !== "hivra-agent"
      || params.purpose !== "daily-driver" || params.inputRole !== "controller"
      || params.client.kind !== "browser" || params.requestedTransport !== "selkies-websocket"
      || params.sessionId !== undefined || params.nativeProfile !== undefined))
    || (params.sessionId !== undefined && !UUID_RE.test(params.sessionId))
    || !PKCE_CHALLENGE_RE.test(params.pkceChallenge)
    || !["daily-driver", "recovery"].includes(params.purpose)
    || !["controller", "viewer"].includes(params.inputRole)
    || !["hq", "qhd", "uhd", "performance"].includes(params.streamingMode)
    || (params.nativeProfile !== undefined && !validNativeDesktopPublicProfile(params.nativeProfile))
    || (params.sessionId !== undefined && (
      params.client.kind !== "native" || !params.client.moonlight
      || params.requestedTransport !== "sunshine-moonlight"
      || params.purpose !== "daily-driver" || params.inputRole !== "controller"
    ))
  ) return failure(400, "invalid_request", "Invalid desktop session request.");

  const loaded = await loadCapability(params);
  if (!loaded.ok) return loaded;
  const capability = loaded.capability;
  const installedTransports = params.requestedTransport
    ? capability.installed_transports.filter((id) => id === params.requestedTransport)
    : capability.installed_transports;
  const selection = selectRemoteDesktopTransport({
    purpose: params.purpose,
    host: {
      compositor: capability.compositor,
      installedTransports,
      // Capability rows are written only from the service-side inspection
      // path. The stored legacy field name is `installed_transports`, but each
      // admitted entry has already passed that revision-bound inspection.
      verifiedTransports: installedTransports,
      privateNetworkReachable: capability.private_network_reachable,
    },
    client: params.client,
  });
  if (!selection.selected) {
    return failure(409, "transport_unavailable", "No observed desktop transport matches this client.");
  }
  if (
    selection.selected.id === "sunshine-moonlight"
      ? (params.sessionId === undefined || params.nativeProfile === undefined)
      : params.nativeProfile !== undefined
  ) return failure(400, "invalid_request", "Invalid desktop session request.");
  const protocolAdmission = await requireCurrentTransportRevision(
    selection.selected.id,
    capability.observed_revision,
  );
  if (!protocolAdmission.ok) return protocolAdmission;
  if (params.inputRole === "controller" && !capability.supports_input_takeover) {
    return failure(409, "input_takeover_unavailable", "This computer has not proved safe human input takeover yet.");
  }

  const requestedTtl = params.ttlMs ?? DEFAULT_GRANT_TTL_MS;
  if (!Number.isSafeInteger(requestedTtl) || requestedTtl < 30_000 || requestedTtl > MAX_GRANT_TTL_MS) {
    return failure(400, "invalid_request", "Desktop grants must last between 30 seconds and five minutes.");
  }
  const issuedAtMs = Date.now();
  const capabilityExpiresAtMs = new Date(capability.expires_at).getTime();
  const expiresAtMs = Math.min(issuedAtMs + requestedTtl, capabilityExpiresAtMs);
  if (expiresAtMs - issuedAtMs < 5_000) {
    return failure(409, "capability_unavailable", "The computer capability is too close to expiry.");
  }
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const audience = remoteDesktopAudience(params.computerKind, params.computerId);
  const assessed = assessRemoteDesktopAccessGrant({
    computerKind: params.computerKind,
    computerId: params.computerId,
    userId: params.userId,
    audience,
    surface: "desktop",
    inputRole: params.inputRole,
    issuedAtMs,
    expiresAtMs,
    handoff: "message",
    activeControllerCount: 0,
    relayCredentialExpiresAtMs: selection.selected.media.requiresUdp ? expiresAtMs : null,
  });
  if (!assessed.accepted) return failure(400, "invalid_grant", "Invalid desktop grant.");

  // The native app prepares its isolated Moonlight profile before authority
  // is issued. Accept that UUID only for the exact native Sunshine controller
  // shape; browser and recovery identifiers remain server-generated.
  const sessionId = params.sessionId ?? crypto.randomUUID();
  const exchangeCode = crypto.randomBytes(32).toString("base64url");
  const { data, error } = await supabaseAdmin.rpc("issue_hivra_remote_desktop_session_v3", {
    p_user_id: params.userId,
    p_session_id: sessionId,
    p_computer_kind: params.computerKind,
    p_computer_id: params.computerId,
    p_transport: selection.selected.id,
    p_input_role: params.inputRole,
    p_handoff: "message",
    p_exchange_code_hash: sha256Hex(exchangeCode),
    p_pkce_challenge: params.pkceChallenge,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_relay_credential_expires_at: selection.selected.media.requiresUdp ? expiresAt : null,
    p_streaming_mode: params.streamingMode,
    p_native_client_id: params.nativeProfile?.clientId ?? null,
    p_native_client_certificate_pem: params.nativeProfile?.clientCertificatePem ?? null,
    p_native_client_certificate_sha256: params.nativeProfile?.clientCertificateSha256 ?? null,
  });
  if (error) return failure(503, "session_issue_failed", "Desktop sessions are unavailable.");
  const issueStatus = rpcStatus(data);
  if (issueStatus !== "issued") {
    if (issueStatus === "controller_conflict" && params.inputRole === "controller") {
      return classifyControllerConflict({
        computerKind: params.computerKind,
        computerId: params.computerId,
        capabilityGeneration: capability.generation,
        ownerHandoffUserId: params.ownerHandoff === true ? params.userId : undefined,
      });
    }
    return statusFailure(issueStatus);
  }
  const row = objectResult(data);
  if (row?.streamingMode !== params.streamingMode) {
    // A caller must never receive a one-time exchange secret unless the
    // serialized database mutation confirms the exact requested profile.
    return failure(503, "invalid_issue_receipt", "Desktop sessions are unavailable.");
  }
  if (
    selection.selected.id === "sunshine-moonlight"
    && (
      row?.nativeProfileBound !== true
      || row.nativeClientId !== params.nativeProfile?.clientId
      || row.nativeClientCertificateSha256 !== params.nativeProfile?.clientCertificateSha256
    )
  ) return failure(503, "invalid_issue_receipt", "Desktop sessions are unavailable.");
  if (
    (selection.selected.id === "selkies-websocket" || selection.selected.id === "sunshine-moonlight")
    && row?.capabilityGeneration !== capability.generation
  ) {
    // Never return the one-time exchange secret when the serialized database
    // mutation bound the session to a capability other than the one admitted
    // above. The unreachable row expires on its bounded grant window.
    return failure(409, "capability_changed", "The desktop capability changed during session creation.");
  }
  return {
    ok: true,
    session: {
      id: sessionId,
      exchangeCode,
      handoff: "message",
      transport: selection.selected.id,
      inputRole: params.inputRole,
      streamingMode: params.streamingMode,
      brokerOrigin: String(row?.brokerOrigin ?? capability.broker_origin),
      audience,
      issuedAt,
      expiresAt,
    },
  };
}

export async function claimOmarchyNativeActivation(params: {
  userId: string;
  sessionId: string;
  sessionToken: string;
  activationId: string;
}): Promise<{ ok: true; claim: {
  activationId: string;
  sessionId: string;
  ownerId: string;
  computerId: string;
  capabilityGeneration: string;
  observedRevision: string;
  clientId: string;
  clientCertificatePem: string;
  clientCertificateSha256: string;
  streamingMode: "hq" | "qhd" | "uhd" | "performance";
  expiresAt: string;
  continuousExpiresAt: string;
} } | BrokerFailure> {
  if (
    !supabaseAdmin || !params.userId || !UUID_RE.test(params.sessionId)
    || !UUID_RE.test(params.activationId) || !SESSION_TOKEN_RE.test(params.sessionToken)
  ) return failure(401, "denied", "Native desktop activation denied.");
  const { data, error } = await supabaseAdmin.rpc("claim_hivra_omarchy_native_activation", {
    p_user_id: params.userId,
    p_session_id: params.sessionId,
    p_session_token_hash: sha256Hex(params.sessionToken),
    p_activation_id: params.activationId,
  });
  if (error) return failure(503, "activation_claim_failed", "Native desktop activation is unavailable.");
  const status = rpcStatus(data);
  if (status !== "claimed") {
    if (status === "denied") return failure(401, "denied", "Native desktop activation denied.");
    return statusFailure(status);
  }
  const row = objectResult(data);
  const profile = {
    clientId: typeof row?.clientId === "string" ? row.clientId : "",
    clientCertificatePem: typeof row?.clientCertificatePem === "string" ? row.clientCertificatePem : "",
    clientCertificateSha256: typeof row?.clientCertificateSha256 === "string"
      ? row.clientCertificateSha256 : "",
  };
  if (
    !row || row.activationId !== params.activationId || row.sessionId !== params.sessionId
    || row.ownerId !== params.userId || typeof row.computerId !== "string" || !UUID_RE.test(row.computerId)
    || typeof row.capabilityGeneration !== "string" || !UUID_RE.test(row.capabilityGeneration)
    || typeof row.observedRevision !== "string" || !/^[a-f0-9]{64}$/.test(row.observedRevision)
    || !validNativeDesktopPublicProfile(profile)
    || !["hq", "qhd", "uhd", "performance"].includes(String(row.streamingMode))
    || typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt))
    || typeof row.continuousExpiresAt !== "string"
    || !Number.isFinite(Date.parse(row.continuousExpiresAt))
    || Date.parse(row.continuousExpiresAt) <= Date.parse(row.expiresAt)
  ) return failure(503, "invalid_activation_claim", "Native desktop activation is unavailable.");
  return {
    ok: true,
    claim: {
      activationId: row.activationId as string,
      sessionId: row.sessionId as string,
      ownerId: row.ownerId as string,
      computerId: row.computerId,
      capabilityGeneration: row.capabilityGeneration,
      observedRevision: row.observedRevision,
      ...profile,
      streamingMode: row.streamingMode as "hq" | "qhd" | "uhd" | "performance",
      expiresAt: row.expiresAt,
      continuousExpiresAt: row.continuousExpiresAt,
    },
  };
}

/** Persist the exact generated guardian authority before any guest dispatch. */
export async function recordOmarchyNativeActivationGrant(params: {
  userId: string;
  sessionId: string;
  activationId: string;
  guardianGrant: Record<string, unknown>;
}): Promise<{ ok: true } | BrokerFailure> {
  if (
    !supabaseAdmin || !params.userId || !UUID_RE.test(params.sessionId)
    || !UUID_RE.test(params.activationId) || !params.guardianGrant
    || typeof params.guardianGrant !== "object" || Array.isArray(params.guardianGrant)
  ) return failure(401, "denied", "Native desktop activation denied.");
  const { data, error } = await supabaseAdmin.rpc("record_hivra_omarchy_native_activation_grant", {
    p_user_id: params.userId,
    p_session_id: params.sessionId,
    p_activation_id: params.activationId,
    p_guardian_grant: structuredClone(params.guardianGrant),
  });
  if (error) return failure(503, "activation_grant_record_failed", "Native desktop activation is unavailable.");
  const row = objectResult(data);
  if (
    rpcStatus(data) !== "recorded" || row?.sessionId !== params.sessionId
    || row.activationId !== params.activationId
  ) return failure(409, "activation_grant_denied", "Native desktop activation denied.");
  return { ok: true };
}

/** Load only the immutable authority recorded before this activation dispatch. */
export async function loadOmarchyNativeActivationGrant(params: {
  userId: string;
  sessionId: string;
  activationId: string;
}): Promise<{ ok: true; guardianGrant: Record<string, unknown> } | BrokerFailure> {
  if (
    !supabaseAdmin || !params.userId || !UUID_RE.test(params.sessionId)
    || !UUID_RE.test(params.activationId)
  ) return failure(401, "denied", "Native desktop session denied.");
  const { data, error } = await supabaseAdmin.rpc("load_hivra_omarchy_native_activation_grant", {
    p_user_id: params.userId,
    p_session_id: params.sessionId,
    p_activation_id: params.activationId,
  });
  if (error) return failure(503, "activation_grant_load_failed", "Native desktop session is unavailable.");
  const row = objectResult(data);
  const guardianGrant = row?.guardianGrant;
  if (
    rpcStatus(data) !== "loaded" || row?.sessionId !== params.sessionId
    || row.activationId !== params.activationId || !guardianGrant
    || typeof guardianGrant !== "object" || Array.isArray(guardianGrant)
  ) return failure(401, "denied", "Native desktop session denied.");
  return { ok: true, guardianGrant: structuredClone(guardianGrant as Record<string, unknown>) };
}

export async function claimOmarchyNativeRenewal(params: {
  userId: string;
  sessionId: string;
  activationId: string;
  renewalId: string;
  ttlMs?: number;
}): Promise<{ ok: true; renewal: {
  sessionId: string;
  activationId: string;
  renewalId: string;
  renewalCount: number;
  previousExpiresAt: string;
  expiresAt: string;
  continuousExpiresAt: string;
  guardianRenewal: Record<string, unknown> | null;
} } | BrokerFailure> {
  const ttlMs = params.ttlMs ?? DEFAULT_GRANT_TTL_MS;
  if (
    !supabaseAdmin || !params.userId || !UUID_RE.test(params.sessionId)
    || !UUID_RE.test(params.activationId) || !UUID_RE.test(params.renewalId)
    || !Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > MAX_GRANT_TTL_MS
    || ttlMs % 1_000 !== 0
  ) return failure(401, "denied", "Native desktop renewal denied.");
  const { data, error } = await supabaseAdmin.rpc("claim_hivra_omarchy_native_renewal", {
    p_user_id: params.userId,
    p_session_id: params.sessionId,
    p_activation_id: params.activationId,
    p_renewal_id: params.renewalId,
    p_ttl_seconds: ttlMs / 1_000,
  });
  if (error) return failure(503, "renewal_claim_failed", "Native desktop renewal is unavailable.");
  if (rpcStatus(data) !== "claimed") return statusFailure(rpcStatus(data));
  const row = objectResult(data);
  const renewalCount = typeof row?.renewalCount === "number" ? row.renewalCount : NaN;
  const previousExpiresAt = typeof row?.previousExpiresAt === "string" ? row.previousExpiresAt : "";
  const expiresAt = typeof row?.expiresAt === "string" ? row.expiresAt : "";
  const continuousExpiresAt = typeof row?.continuousExpiresAt === "string" ? row.continuousExpiresAt : "";
  const guardianRenewal = row?.guardianRenewal === null ? null
    : row?.guardianRenewal && typeof row.guardianRenewal === "object" && !Array.isArray(row.guardianRenewal)
      ? structuredClone(row.guardianRenewal as Record<string, unknown>) : undefined;
  if (
    !row || row.sessionId !== params.sessionId || row.activationId !== params.activationId
    || row.renewalId !== params.renewalId || !Number.isSafeInteger(renewalCount)
    || renewalCount < 1 || renewalCount > 240
    || !Number.isFinite(Date.parse(previousExpiresAt)) || !Number.isFinite(Date.parse(expiresAt))
    || !Number.isFinite(Date.parse(continuousExpiresAt))
    || Date.parse(expiresAt) <= Date.parse(previousExpiresAt)
    || Date.parse(expiresAt) > Date.parse(continuousExpiresAt)
    || guardianRenewal === undefined
  ) return failure(503, "invalid_renewal_claim", "Native desktop renewal is unavailable.");
  return { ok: true, renewal: {
    sessionId: params.sessionId, activationId: params.activationId, renewalId: params.renewalId,
    renewalCount, previousExpiresAt, expiresAt, continuousExpiresAt, guardianRenewal,
  } };
}

/** Refresh only an already-proven native capability after exact guest reinspection. */
export async function refreshOmarchyNativeCapability(params: {
  userId: string;
  computerId: string;
  capabilityGeneration: string;
  observedRevision: string;
  observedAt: string;
  expiresAt: string;
}): Promise<{ ok: true } | BrokerFailure> {
  if (
    !supabaseAdmin || !params.userId || !UUID_RE.test(params.computerId)
    || !UUID_RE.test(params.capabilityGeneration) || !/^[a-f0-9]{64}$/.test(params.observedRevision)
    || !Number.isFinite(Date.parse(params.observedAt)) || !Number.isFinite(Date.parse(params.expiresAt))
  ) return failure(401, "denied", "Native desktop capability refresh denied.");
  const { data, error } = await supabaseAdmin.rpc("refresh_hivra_omarchy_native_capability", {
    p_user_id: params.userId,
    p_computer_id: params.computerId,
    p_generation: params.capabilityGeneration,
    p_observed_revision: params.observedRevision,
    p_observed_at: params.observedAt,
    p_expires_at: params.expiresAt,
  });
  if (error) return failure(503, "capability_refresh_failed", "Native desktop renewal is unavailable.");
  const row = objectResult(data);
  if (rpcStatus(data) !== "ready" || row?.computerId !== params.computerId
    || row.generation !== params.capabilityGeneration
    || typeof row.expiresAt !== "string"
    || Date.parse(row.expiresAt) !== Date.parse(params.expiresAt)) {
    return failure(409, "capability_refresh_denied", "Native desktop capability refresh denied.");
  }
  return { ok: true };
}

export async function recordOmarchyNativeRenewal(params: {
  userId: string;
  sessionId: string;
  activationId: string;
  renewalId: string;
  guardianRenewal: Record<string, unknown>;
}): Promise<{ ok: true } | BrokerFailure> {
  if (
    !supabaseAdmin || !params.userId || !UUID_RE.test(params.sessionId)
    || !UUID_RE.test(params.activationId) || !UUID_RE.test(params.renewalId)
    || !params.guardianRenewal || typeof params.guardianRenewal !== "object"
    || Array.isArray(params.guardianRenewal)
  ) return failure(401, "denied", "Native desktop renewal denied.");
  const { data, error } = await supabaseAdmin.rpc("record_hivra_omarchy_native_renewal", {
    p_user_id: params.userId,
    p_session_id: params.sessionId,
    p_activation_id: params.activationId,
    p_renewal_id: params.renewalId,
    p_guardian_renewal: structuredClone(params.guardianRenewal),
  });
  if (error) return failure(503, "renewal_record_failed", "Native desktop renewal is unavailable.");
  const row = objectResult(data);
  if (rpcStatus(data) !== "recorded" || row?.sessionId !== params.sessionId
    || row.renewalId !== params.renewalId) {
    return failure(409, "renewal_record_denied", "Native desktop renewal denied.");
  }
  return { ok: true };
}

export async function exchangeRemoteDesktopSession(params: {
  exchangeCode: string;
  verifier: string;
}): Promise<{
  ok: true;
  grant: {
    sessionToken: string;
    sessionId: string;
    computerKind: RemoteDesktopComputerKind;
    computerId: string;
    capabilityGeneration: string;
    transport: RemoteDesktopTransportId;
    inputRole: "controller" | "viewer";
    inputReady: boolean;
    audience: string;
    brokerOrigin: string;
    expiresAt: string;
  };
} | BrokerFailure> {
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.exchangeCode) || !VERIFIER_RE.test(params.verifier)) {
    return failure(400, "invalid", "Invalid desktop handoff.");
  }
  const exchangeCodeHash = sha256Hex(params.exchangeCode);
  const evidence = await loadSessionProtocolEvidence({
    lookupColumn: "exchange_code_hash",
    lookupHash: exchangeCodeHash,
  });
  if (!evidence.ok) return evidence;
  if (
    evidence.session
    && evidence.session.pkce_challenge === pkceChallenge(params.verifier)
  ) {
    const protocolAdmission = await requireCurrentSessionProtocol(evidence.session);
    if (!protocolAdmission.ok) return protocolAdmission;
  }
  const sessionToken = `hrs1_${crypto.randomBytes(32).toString("base64url")}`;
  const { data, error } = await supabaseAdmin.rpc("exchange_hivra_remote_desktop_session", {
    p_exchange_code_hash: exchangeCodeHash,
    p_pkce_challenge: pkceChallenge(params.verifier),
    p_session_token_hash: sha256Hex(sessionToken),
  });
  if (error) return failure(503, "session_exchange_failed", "Desktop sessions are unavailable.");
  if (rpcStatus(data) !== "exchanged") return statusFailure(rpcStatus(data));
  const row = objectResult(data);
  if (
    !row || typeof row.sessionId !== "string" || typeof row.computerKind !== "string"
    || typeof row.computerId !== "string" || typeof row.capabilityGeneration !== "string"
    || typeof row.transport !== "string" || typeof row.inputRole !== "string"
    || typeof row.inputReady !== "boolean" || typeof row.audience !== "string"
    || typeof row.brokerOrigin !== "string" || typeof row.expiresAt !== "string"
  ) return failure(503, "invalid_exchange_receipt", "Desktop sessions are unavailable.");
  return {
    ok: true,
    grant: {
      sessionToken,
      sessionId: row.sessionId,
      computerKind: row.computerKind as RemoteDesktopComputerKind,
      computerId: row.computerId,
      capabilityGeneration: row.capabilityGeneration,
      transport: row.transport as RemoteDesktopTransportId,
      inputRole: row.inputRole as "controller" | "viewer",
      inputReady: row.inputReady,
      audience: row.audience,
      brokerOrigin: row.brokerOrigin,
      expiresAt: row.expiresAt,
    },
  };
}

export async function authorizeRemoteDesktopSession(params: {
  sessionToken: string;
  computerKind: RemoteDesktopComputerKind;
  computerId: string;
  transport: RemoteDesktopTransportId;
  wantsInput: boolean;
}): Promise<{ ok: true; authorization: Record<string, unknown> } | BrokerFailure> {
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  if (
    !SESSION_TOKEN_RE.test(params.sessionToken)
    || !validComputerRef(params.computerKind, params.computerId)
    || !REMOTE_DESKTOP_TRANSPORTS.some((candidate) => candidate.id === params.transport)
  ) return failure(401, "denied", "Desktop session denied.");
  if (params.transport === "selkies-websocket" || params.transport === "sunshine-moonlight") {
    const evidence = await loadSessionProtocolEvidence({
      lookupColumn: "session_token_hash",
      lookupHash: sha256Hex(params.sessionToken),
    });
    if (!evidence.ok) return evidence;
    if (
      evidence.session
      && evidence.session.computer_kind === params.computerKind
      && evidence.session.computer_id === params.computerId
      && evidence.session.transport === params.transport
    ) {
      const protocolAdmission = await requireCurrentSessionProtocol(evidence.session);
      if (!protocolAdmission.ok) return protocolAdmission;
    }
  }
  const { data, error } = await supabaseAdmin.rpc("authorize_hivra_remote_desktop_session", {
    p_session_token_hash: sha256Hex(params.sessionToken),
    p_computer_kind: params.computerKind,
    p_computer_id: params.computerId,
    p_transport: params.transport,
    p_wants_input: params.wantsInput,
  });
  if (error) return failure(503, "session_authorize_failed", "Desktop sessions are unavailable.");
  if (rpcStatus(data) !== "authorized") return failure(401, "denied", "Desktop session denied.");
  return { ok: true, authorization: objectResult(data) ?? {} };
}

/**
 * Renew one already exchanged guest-held controller lease.
 *
 * The bearer never enters the browser. The database rechecks the exact active
 * session, current capability generation, computer ownership/readiness and the
 * twelve-hour continuous-session bound before extending it.
 */
export async function renewRemoteDesktopSessionByToken(params: {
  sessionToken: string;
  ttlMs?: number;
}): Promise<{
  ok: true;
  renewal: {
    sessionId: string;
    expiresAt: string;
    continuousExpiresAt: string;
    renewalCount: number;
  };
} | BrokerFailure> {
  if (!supabaseAdmin || !SESSION_TOKEN_RE.test(params.sessionToken)) {
    return failure(401, "denied", "Desktop session renewal denied.");
  }
  const ttlMs = params.ttlMs ?? DEFAULT_GRANT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > MAX_GRANT_TTL_MS || ttlMs % 1_000 !== 0) {
    return failure(400, "invalid_request", "Invalid desktop session renewal.");
  }
  const evidence = await loadSessionProtocolEvidence({
    lookupColumn: "session_token_hash",
    lookupHash: sha256Hex(params.sessionToken),
  });
  if (!evidence.ok) return evidence;
  if (evidence.session) {
    const protocolAdmission = await requireCurrentSessionProtocol(evidence.session);
    if (!protocolAdmission.ok) return protocolAdmission;
  }
  const { data, error } = await supabaseAdmin.rpc(
    "renew_hivra_remote_desktop_session_by_token",
    {
      p_session_token_hash: sha256Hex(params.sessionToken),
      p_ttl_seconds: ttlMs / 1_000,
    },
  );
  if (error) return failure(503, "session_renew_failed", "Desktop session renewal is unavailable.");
  const status = rpcStatus(data);
  if (status !== "renewed") return statusFailure(status);
  const row = objectResult(data);
  const sessionId = typeof row?.sessionId === "string" ? row.sessionId : "";
  const expiresAt = typeof row?.expiresAt === "string" ? row.expiresAt : "";
  const continuousExpiresAt = typeof row?.continuousExpiresAt === "string" ? row.continuousExpiresAt : "";
  const renewalCount = typeof row?.renewalCount === "number" ? row.renewalCount : NaN;
  if (
    !UUID_RE.test(sessionId)
    || !Number.isFinite(Date.parse(expiresAt))
    || !Number.isFinite(Date.parse(continuousExpiresAt))
    || !Number.isSafeInteger(renewalCount)
    || renewalCount < 1
  ) return failure(503, "invalid_renewal_receipt", "Desktop session renewal is unavailable.");
  return { ok: true, renewal: { sessionId, expiresAt, continuousExpiresAt, renewalCount } };
}

export async function revokeRemoteDesktopSession(params: {
  userId: string;
  sessionId: string;
  reason: "user_revoked" | "handoff_abandoned" | "connection_closed" | "computer_stopping" | "security_event";
}): Promise<{ ok: true; inputState: string } | BrokerFailure> {
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  if (!params.userId || !UUID_RE.test(params.sessionId)) return failure(400, "invalid_request", "Invalid desktop session request.");
  const { data, error } = await supabaseAdmin.rpc("revoke_hivra_remote_desktop_session", {
    p_user_id: params.userId,
    p_session_id: params.sessionId,
    p_reason: params.reason,
  });
  if (error) return failure(503, "session_revoke_failed", "Desktop sessions are unavailable.");
  if (rpcStatus(data) !== "revoked") return statusFailure(rpcStatus(data));
  const row = objectResult(data);
  return { ok: true, inputState: typeof row?.inputState === "string" ? row.inputState : "released" };
}

/**
 * Revoke the current capability generation for one owned computer.
 *
 * The database function serializes this with session issue/record operations
 * and revokes every session tied to that generation. A missing capability is
 * already the desired state and is therefore idempotently successful.
 */
export async function revokeRemoteDesktopCapability(params: {
  userId: string;
  computerKind: RemoteDesktopComputerKind;
  computerId: string;
}): Promise<{ ok: true; revoked: boolean } | BrokerFailure> {
  if (!supabaseAdmin) return failure(503, "database_unavailable", "Desktop sessions are unavailable.");
  if (!params.userId || !validComputerRef(params.computerKind, params.computerId)) {
    return failure(400, "invalid_request", "Invalid desktop capability request.");
  }
  const { data, error } = await supabaseAdmin
    .from("hivra_remote_desktop_capabilities")
    .select("generation")
    .eq("user_id", params.userId)
    .eq("computer_kind", params.computerKind)
    .eq("computer_id", params.computerId)
    .is("revoked_at", null)
    .maybeSingle<{ generation: string }>();
  if (error) return failure(503, "capability_lookup_failed", "Desktop capability cleanup is unavailable.");
  if (!data) return { ok: true, revoked: false };
  if (!UUID_RE.test(data.generation)) {
    return failure(503, "invalid_capability", "Desktop capability cleanup is unavailable.");
  }
  const { data: revoked, error: revokeError } = await supabaseAdmin.rpc(
    "revoke_hivra_remote_desktop_capability",
    {
      p_user_id: params.userId,
      p_computer_kind: params.computerKind,
      p_computer_id: params.computerId,
      p_generation: data.generation,
    },
  );
  if (revokeError) return failure(503, "capability_revoke_failed", "Desktop capability cleanup is unavailable.");
  if (revoked !== true) return failure(409, "capability_changed", "Desktop capability changed during cleanup.");
  return { ok: true, revoked: true };
}

export async function confirmRemoteDesktopInputTransition(params: {
  userId: string;
  receipt: RemoteDesktopInputReceipt;
}): Promise<{ ok: true } | BrokerFailure> {
  if (!supabaseAdmin || !params.userId || !UUID_RE.test(params.receipt.sessionId)) {
    return failure(400, "invalid_receipt", "Invalid desktop input receipt.");
  }
  const functionName = params.receipt.action === "agent-input-suspended"
    ? "confirm_hivra_remote_desktop_takeover"
    : "confirm_hivra_remote_desktop_release";
  const { data, error } = await supabaseAdmin.rpc(functionName, {
    p_user_id: params.userId,
    p_session_id: params.receipt.sessionId,
    p_receipt: params.receipt,
  });
  if (error) return failure(503, "input_transition_failed", "Desktop input transition could not be confirmed.");
  if (data !== true) return failure(409, "input_transition_rejected", "Desktop input transition was rejected.");
  return { ok: true };
}

/**
 * Confirm the guest-side input transition using the exchanged session bearer.
 * Unlike owner revocation, release must remain available after the session is
 * revoked so the guest can close its stream and clear release-pending safely.
 */
export async function confirmRemoteDesktopInputTransitionByToken(params: {
  sessionToken: string;
  receipt: RemoteDesktopInputReceipt;
}): Promise<{ ok: true } | BrokerFailure> {
  if (
    !supabaseAdmin || !SESSION_TOKEN_RE.test(params.sessionToken)
    || !UUID_RE.test(params.receipt.sessionId)
  ) {
    return failure(401, "denied", "Desktop input transition denied.");
  }
  const { data, error } = await supabaseAdmin.rpc(
    "confirm_hivra_remote_desktop_input_transition_by_token",
    {
      p_session_token_hash: sha256Hex(params.sessionToken),
      p_receipt: params.receipt,
    },
  );
  if (error) return failure(503, "input_transition_failed", "Desktop input transition could not be confirmed.");
  if (rpcStatus(data) !== "confirmed") return failure(401, "denied", "Desktop input transition denied.");
  return { ok: true };
}

export async function revokeRemoteDesktopSessionByToken(params: {
  sessionToken: string;
  reason: "connection_closed" | "computer_stopping" | "security_event";
}): Promise<{ ok: true; inputState: string } | BrokerFailure> {
  if (!supabaseAdmin || !SESSION_TOKEN_RE.test(params.sessionToken)) {
    return failure(401, "denied", "Desktop session termination denied.");
  }
  const { data, error } = await supabaseAdmin.rpc(
    "revoke_hivra_remote_desktop_session_by_token",
    {
      p_session_token_hash: sha256Hex(params.sessionToken),
      p_reason: params.reason,
    },
  );
  if (error) return failure(503, "session_revoke_failed", "Desktop session could not be terminated.");
  if (rpcStatus(data) !== "revoked") return failure(401, "denied", "Desktop session termination denied.");
  const row = objectResult(data);
  return {
    ok: true,
    inputState: typeof row?.inputState === "string" ? row.inputState : "released",
  };
}

export { SESSION_TOKEN_RE };
