import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  OmarchyGuardianGrant,
  type OmarchyGuardianGrant as GuardianGrant,
} from "@/lib/remote-computers/omarchy-native-guardian-host";
import {
  OMARCHY_DESKTOP_SESSION_REVISION,
  type PreparedOmarchyNativeDescriptor,
} from "@/lib/remote-computers/omarchy-native-capability";

const ACTIVATION_BUDGET_USEC = 60_000_000;
const MAX_RUNTIME_USEC = 240_000_000;
const MAX_SESSION_TTL_MS = 5 * 60_000;
const MAX_CONTINUOUS_SESSION_MS = 12 * 60 * 60_000;

type NativeSessionAuthority = {
  ownerId: string;
  capabilityGeneration: string;
  sessionId: string;
  clientId: string;
  clientCertificatePem: string;
  clientCertificateSha256: string;
  expiresAt: string;
  continuousExpiresAt: string;
};

/** Exact unit bytes hashed into the one-use guardian grant. */
export function omarchyGuardianUnitSource(sessionId: string, runtimeMaxUsec: number): string {
  return [
    "[Unit]",
    `Description=Hivra Omarchy native desktop lease ${sessionId}`,
    "[Service]",
    "Type=notify",
    "User=root",
    `ExecStart=/usr/bin/python3 -I -B /usr/local/libexec/hivra/omarchy-native-supervisor.py run ${sessionId}`,
    "Restart=no",
    "KillMode=control-group",
    "KillSignal=SIGKILL",
    "SendSIGKILL=yes",
    "TimeoutStartSec=15",
    "TimeoutStopSec=5",
    `RuntimeMaxSec=${runtimeMaxUsec}us`,
    "RuntimeRandomizedExtraSec=0",
    "NoNewPrivileges=no",
    "NotifyAccess=main",
    "UMask=0077",
    "",
  ].join("\n");
}

/**
 * Convert already-exchanged session authority and a fresh prepared descriptor
 * into one exact guest grant. This function does not dispatch or retry it.
 */
export function buildOmarchyNativeGuardianGrant(params: {
  session: NativeSessionAuthority;
  descriptor: PreparedOmarchyNativeDescriptor;
  nowMs?: number;
  leaseId?: string;
}): GuardianGrant | null {
  const nowMs = params.nowMs ?? Date.now();
  const observedAtMs = Date.parse(params.descriptor.observedAt);
  const expiresAtMs = Date.parse(params.session.expiresAt);
  const continuousExpiresAtMs = Date.parse(params.session.continuousExpiresAt);
  if (
    !Number.isFinite(nowMs) || !Number.isFinite(observedAtMs) || !Number.isFinite(expiresAtMs)
    || !Number.isFinite(continuousExpiresAtMs)
    || observedAtMs > nowMs + 1_000 || nowMs - observedAtMs > 2 * 60_000
    || expiresAtMs <= nowMs || expiresAtMs > nowMs + MAX_SESSION_TTL_MS
    || continuousExpiresAtMs <= expiresAtMs
    || continuousExpiresAtMs > nowMs + MAX_CONTINUOUS_SESSION_MS
  ) return null;

  const runtimeMaxUsec = Math.min(
    MAX_RUNTIME_USEC,
    Math.floor((expiresAtMs - nowMs) * 1_000) - ACTIVATION_BUDGET_USEC,
  );
  if (!Number.isSafeInteger(runtimeMaxUsec) || runtimeMaxUsec <= 0) return null;

  let deadlineBoottimeNs: number;
  let continuousDeadlineBoottimeNs: number;
  try {
    const observedBoottimeNs = BigInt(params.descriptor.observedBoottimeNs);
    const untilExpiryNs = BigInt(Math.floor(expiresAtMs - observedAtMs)) * 1_000_000n;
    const untilContinuousExpiryNs = BigInt(Math.floor(continuousExpiresAtMs - observedAtMs)) * 1_000_000n;
    const deadline = observedBoottimeNs + untilExpiryNs;
    const continuousDeadline = observedBoottimeNs + untilContinuousExpiryNs;
    deadlineBoottimeNs = Number(deadline);
    continuousDeadlineBoottimeNs = Number(continuousDeadline);
    if (
      !Number.isSafeInteger(deadlineBoottimeNs) || deadlineBoottimeNs <= 0
      || !Number.isSafeInteger(continuousDeadlineBoottimeNs)
      || continuousDeadlineBoottimeNs <= deadlineBoottimeNs
    ) return null;
  } catch {
    return null;
  }

  const leaseId = params.leaseId ?? randomUUID();
  const unitSha256 = createHash("sha256")
    .update(omarchyGuardianUnitSource(params.session.sessionId, runtimeMaxUsec))
    .digest("hex");
  const parsed = OmarchyGuardianGrant.safeParse({
    protocol: "hivra-omarchy-guardian-grant-v2",
    binding: {
      computerId: params.descriptor.computerId,
      operationId: params.descriptor.preparationOperationId,
      vmid: params.descriptor.vmid,
      ownerUid: params.descriptor.serviceOwnerUid,
      guestPrivateIpv4: params.descriptor.guestPrivateIpv4,
      waylandDisplay: params.descriptor.waylandDisplay,
    },
    ownerId: params.session.ownerId,
    capabilityGeneration: params.session.capabilityGeneration,
    observedRevision: OMARCHY_DESKTOP_SESSION_REVISION,
    sessionId: params.session.sessionId,
    leaseId,
    clientId: params.session.clientId,
    clientCertificatePem: params.session.clientCertificatePem,
    clientCertificateSha256: params.session.clientCertificateSha256,
    guestBootId: params.descriptor.guestBootId,
    expiresAtUnixMs: Math.floor(expiresAtMs),
    deadlineBoottimeNs,
    continuousDeadlineBoottimeNs,
    runtimeMaxUsec,
    sunshineSha256: params.descriptor.sunshineSha256,
    guardianSha256: params.descriptor.guardianSha256,
    ownershipSha256: params.descriptor.ownershipSha256,
    preparedSha256: params.descriptor.preparedSha256,
    unitSha256,
  });
  return parsed.success ? parsed.data : null;
}
