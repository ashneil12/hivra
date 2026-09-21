import "server-only";

import { z } from "zod";

import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

const UUID = z.string().uuid();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const PRIVATE_IPV4 = z.string().refine(value => {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(part => part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
});

const Binding = z.object({
  computerId: UUID,
  operationId: UUID,
  vmid: z.number().int().min(100),
  ownerUid: z.number().int().min(1000),
  guestPrivateIpv4: PRIVATE_IPV4,
  waylandDisplay: z.string().regex(/^wayland-[0-9]{1,3}$/),
}).strict();

export const OmarchyGuardianGrant = z.object({
  protocol: z.literal("hivra-omarchy-guardian-grant-v2"),
  binding: Binding,
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  capabilityGeneration: UUID,
  observedRevision: SHA256,
  sessionId: UUID,
  leaseId: UUID,
  clientId: UUID,
  clientCertificatePem: z.string().min(1).max(16_384),
  clientCertificateSha256: SHA256,
  guestBootId: UUID,
  expiresAtUnixMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  deadlineBoottimeNs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  continuousDeadlineBoottimeNs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  runtimeMaxUsec: z.number().int().positive().max(240_000_000),
  sunshineSha256: SHA256,
  guardianSha256: SHA256,
  ownershipSha256: SHA256,
  preparedSha256: SHA256,
  unitSha256: SHA256,
}).strict();

export const OmarchyGuardianRenewal = z.object({
  protocol: z.literal("hivra-omarchy-guardian-renewal-v1"),
  sessionId: UUID,
  leaseId: UUID,
  capabilityGeneration: UUID,
  guestBootId: UUID,
  renewalId: UUID,
  renewalCount: z.number().int().min(1).max(240),
  deadlineBoottimeNs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  continuousDeadlineBoottimeNs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type OmarchyGuardianRenewal = z.infer<typeof OmarchyGuardianRenewal>;

export type OmarchyGuardianGrant = z.infer<typeof OmarchyGuardianGrant>;
export type OmarchyGuardianAction = "activate" | "observe-ready" | "renew" | "observe-renew" | "revoke" | "observe-stop" | "release-stop";

const ActivationResult = z.object({
  sessionId: UUID, leaseId: UUID, activation: z.literal("started"), desktopReady: z.literal(false),
}).strict();
const ReadyResult = z.object({
  sessionId: UUID,
  leaseId: UUID,
  guestBootId: UUID,
  capabilityGeneration: UUID,
  observedRevision: SHA256,
  serverId: UUID,
  guestPrivateIpv4: PRIVATE_IPV4,
  serverCertificatePem: z.string().min(1).max(16_384),
  serverCertificateSha256: SHA256,
  pairingVerified: z.literal(true),
  desktopReady: z.literal(true),
}).strict();
const RevocationResult = z.object({
  leaseId: UUID, sessionId: UUID, reason: z.literal("control-plane-revoked"),
  revocation: z.literal("requested"), releasePending: z.boolean(), desktopReady: z.literal(false),
}).strict();
const RenewalResult = z.object({
  sessionId: UUID, leaseId: UUID, guestBootId: UUID, renewalId: UUID,
  renewalCount: z.number().int().min(1).max(240),
  deadlineBoottimeNs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  continuousDeadlineBoottimeNs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  renewal: z.enum(["accepted", "applied"]), desktopReady: z.literal(true),
}).strict();
const StopResult = z.object({
  leaseId: UUID, sessionId: UUID, guestBootId: UUID,
  invocationId: z.string().regex(/^[a-f0-9]{32}$/),
  ownedProcessBoundaryStopped: z.literal(true), releasePending: z.literal(true), desktopReady: z.literal(false),
}).strict();
const ReleaseResult = StopResult.omit({ releasePending: true }).extend({
  releasePending: z.literal(false), controllerReleased: z.literal(true),
}).strict();

const RESULT_SCHEMAS = {
  activate: ActivationResult,
  "observe-ready": ReadyResult,
  renew: RenewalResult.extend({ renewal: z.literal("accepted") }),
  "observe-renew": RenewalResult.extend({ renewal: z.literal("applied") }),
  revoke: RevocationResult,
  "observe-stop": StopResult,
  "release-stop": ReleaseResult,
} as const;

const GUARDIAN_PATH = "/usr/local/libexec/hivra/omarchy-native-supervisor.py";
const OWNERSHIP_PATH = "/usr/local/libexec/hivra/omarchy-sunshine-ownership.py";
const TIMEOUTS = Object.freeze({
  activate: Object.freeze({ guestSeconds: 30, hostMs: 55_000 }),
  "observe-ready": Object.freeze({ guestSeconds: 10, hostMs: 30_000 }),
  renew: Object.freeze({ guestSeconds: 10, hostMs: 30_000 }),
  "observe-renew": Object.freeze({ guestSeconds: 10, hostMs: 30_000 }),
  revoke: Object.freeze({ guestSeconds: 15, hostMs: 35_000 }),
  "observe-stop": Object.freeze({ guestSeconds: 20, hostMs: 40_000 }),
  "release-stop": Object.freeze({ guestSeconds: 25, hostMs: 45_000 }),
});

type Dependencies = {
  resolveContext: (userId: string, agent: RemoteDesktopAgentRow) => Promise<HivraAgentExecutionContext>;
  runHostScript: typeof runProxmoxHostScript;
};

type GuardianResult = z.infer<(typeof RESULT_SCHEMAS)[OmarchyGuardianAction]>;
type ExecutionResult =
  | { ok: true; action: OmarchyGuardianAction; result: GuardianResult }
  | { ok: false; code: "invalid_target" | "authority_unavailable" | "transport_failed" | "invalid_result" };

function stableAgentTarget(userId: string, agent: RemoteDesktopAgentRow, grant: OmarchyGuardianGrant): boolean {
  const bindingHash = typeof agent.infrastructure_binding_token_hash === "string"
    ? agent.infrastructure_binding_token_hash : "";
  return agent.user_id === userId && grant.ownerId === userId && agent.id === grant.binding.computerId
    && agent.type === "linux-desktop" && agent.computer_profile === "omarchy"
    && agent.status === "running" && agent.desired_state === "running"
    && agent.operation_id === null && agent.operation_kind === null
    && agent.vmid === grant.binding.vmid && agent.ip === grant.binding.guestPrivateIpv4
    && agent.infrastructure_binding_token_enforced === true && /^[a-f0-9]{64}$/.test(bindingHash);
}

export function parseOmarchyGuardianResult(
  action: OmarchyGuardianAction,
  stdout: string,
  grant: OmarchyGuardianGrant,
  renewal?: OmarchyGuardianRenewal,
): GuardianResult | null {
  if (Buffer.byteLength(stdout) > 32_768) return null;
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  const parsed = RESULT_SCHEMAS[action].safeParse(value);
  if (!parsed.success || parsed.data.sessionId !== grant.sessionId || parsed.data.leaseId !== grant.leaseId) return null;
  if ("guestBootId" in parsed.data && parsed.data.guestBootId !== grant.guestBootId) return null;
  if ("capabilityGeneration" in parsed.data && (
    parsed.data.capabilityGeneration !== grant.capabilityGeneration
    || parsed.data.observedRevision !== grant.observedRevision
    || parsed.data.serverId !== grant.binding.computerId
    || parsed.data.guestPrivateIpv4 !== grant.binding.guestPrivateIpv4
  )) return null;
  if (renewal && (
    !("renewalId" in parsed.data) || parsed.data.renewalId !== renewal.renewalId
    || parsed.data.renewalCount !== renewal.renewalCount
    || parsed.data.deadlineBoottimeNs !== renewal.deadlineBoottimeNs
    || parsed.data.continuousDeadlineBoottimeNs !== renewal.continuousDeadlineBoottimeNs
  )) return null;
  return parsed.data;
}

export function buildOmarchyGuardianHostScript(
  action: OmarchyGuardianAction,
  rawGrant: unknown,
  infrastructureBindingTag: string,
  rawRenewal?: unknown,
): string {
  const grant = OmarchyGuardianGrant.parse(rawGrant);
  if (!Object.hasOwn(TIMEOUTS, action) || !/^hivra-bind-[a-f0-9]{32}$/.test(infrastructureBindingTag)) {
    throw new Error("Invalid Omarchy guardian dispatch.");
  }
  const renewal = action === "renew" || action === "observe-renew"
    ? OmarchyGuardianRenewal.parse(rawRenewal) : undefined;
  if (renewal && (
    renewal.sessionId !== grant.sessionId || renewal.leaseId !== grant.leaseId
    || renewal.capabilityGeneration !== grant.capabilityGeneration
    || renewal.guestBootId !== grant.guestBootId
    || renewal.continuousDeadlineBoottimeNs !== grant.continuousDeadlineBoottimeNs
  )) throw new Error("Invalid Omarchy guardian renewal.");
  const payload = JSON.stringify(renewal ? { grant, renewal } : grant);
  const guestProgram = String.raw`set -euo pipefail
[ "$(/usr/bin/sha256sum ${GUARDIAN_PATH} | /usr/bin/awk '{print $1}')" = "$2" ]
[ "$(/usr/bin/sha256sum ${OWNERSHIP_PATH} | /usr/bin/awk '{print $1}')" = "$3" ]
exec /usr/bin/python3 -I -B ${GUARDIAN_PATH} "$1"`;
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${grant.binding.vmid}
GUEST_IP=${shellQuote(grant.binding.guestPrivateIpv4)}
EXPECTED_BINDING_TAG=${shellQuote(infrastructureBindingTag)}
qm() { command timeout --kill-after=5 20 qm "$@"; }
[ "$(qm status "$VMID" | awk '{print $2}')" = running ]
VM_CONFIG="$(qm config "$VMID")"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
qm() { command timeout --kill-after=5 ${TIMEOUTS[action].guestSeconds} qm "$@"; }
printf '%s' ${shellQuote(payload)} | run_vmid_bound_guest_exec_stdin /bin/bash -c ${shellQuote(guestProgram)} hivra ${shellQuote(action)} ${shellQuote(grant.guardianSha256)} ${shellQuote(grant.ownershipSha256)}
`;
}

/** Execute one exact guardian transition. Uncertain responses are never retried here. */
export async function executeOmarchyGuardianAction(
  userId: string,
  action: OmarchyGuardianAction,
  rawGrant: unknown,
  rawAgent: RemoteDesktopAgentRow,
  dependencies: Partial<Dependencies> = {},
  rawRenewal?: unknown,
): Promise<ExecutionResult> {
  const parsed = OmarchyGuardianGrant.safeParse(rawGrant);
  if (!parsed.success) return { ok: false, code: "invalid_target" };
  const grant = structuredClone(parsed.data);
  const agent = structuredClone(rawAgent);
  if (!stableAgentTarget(userId, agent, grant) || !Object.hasOwn(TIMEOUTS, action)) {
    return { ok: false, code: "invalid_target" };
  }
  const deps = {
    resolveContext: resolveHivraAgentExecutionContext,
    runHostScript: runProxmoxHostScript,
    ...dependencies,
  };
  let context: HivraAgentExecutionContext;
  try { context = await deps.resolveContext(userId, agent); }
  catch { return { ok: false, code: "authority_unavailable" }; }
  const expectedBindingTag = "hivra-bind-" + String(agent.infrastructure_binding_token_hash).slice(0, 32);
  if (!context.infrastructureBindingTagEnforced || context.infrastructureBindingTag !== expectedBindingTag) {
    return { ok: false, code: "authority_unavailable" };
  }
  let script: string;
  let renewal: OmarchyGuardianRenewal | undefined;
  if (action === "renew" || action === "observe-renew") {
    const parsedRenewal = OmarchyGuardianRenewal.safeParse(rawRenewal);
    if (!parsedRenewal.success) return { ok: false, code: "invalid_target" };
    renewal = parsedRenewal.data;
  }
  try { script = buildOmarchyGuardianHostScript(action, grant, context.infrastructureBindingTag, renewal); }
  catch { return { ok: false, code: "invalid_target" }; }
  try {
    const response = await deps.runHostScript(script, { ...context.env }, {
      timeoutMs: TIMEOUTS[action].hostMs,
      maxOutputBytes: 32_768,
    });
    if (!response.ok) return { ok: false, code: "transport_failed" };
    const result = parseOmarchyGuardianResult(action, response.stdout, grant, renewal);
    return result ? { ok: true, action, result } : { ok: false, code: "invalid_result" };
  } catch {
    return { ok: false, code: "transport_failed" };
  }
}

export async function executeOmarchyGuardianRenewalAction(
  userId: string,
  action: "renew" | "observe-renew",
  rawGrant: unknown,
  rawRenewal: unknown,
  rawAgent: RemoteDesktopAgentRow,
  dependencies: Partial<Dependencies> = {},
): Promise<ExecutionResult> {
  return executeOmarchyGuardianAction(
    userId, action, rawGrant, rawAgent, dependencies, rawRenewal,
  );
}
