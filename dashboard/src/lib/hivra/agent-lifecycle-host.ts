import "server-only";

// The host side of a Proxmox agent lifecycle operation, shared by the
// lifecycle route (every Proxmox action) and the in-place update the
// automatic-update sweep runs (agent-runtime-update.ts): resolving the exact
// owner-bound host and guest address, the FD8 lifecycle-lock prelude with its
// binding-tag check, and staging the agent-run reporter credential for the
// helper that runs. Moved here unchanged from the lifecycle route so both
// callers go through one set of checks.

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import type { HostScriptResult } from "@/lib/services/proxmox-instance-service";
import { checkManagedHivraHostReadiness } from "./managed-provisioner-readiness";
import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "./agent-execution-context";
import {
  resolveHivraIpLastOctetStart,
  resolveHivraSubnetPrefix,
  resolveHivraVmidStart,
  shellQuote,
} from "./proxmox-target";
import {
  issueActivityCollectorCredential,
  parseActivityCollectorMarker,
  recordActivityCollectorIssued,
  recordCollectorInstallResult,
  supportsNativeTracing,
  type ActivityCollectorCredential,
} from "@/lib/activity-observability/collectors";

const DEFAULT_SOURCE = "hivra/agents/[id]/action";

// Printed by the start kickoff only after the reporter credential file was
// written for a start helper that consumes it.
export const ACTIVITY_CREDENTIAL_STAGED = "HIVRA_ACTIVITY_CREDENTIAL_STAGED";

export function providerFailureDetail(result: HostScriptResult, fallback: string): string {
  return result.stderr.trim() || result.error?.trim() || fallback;
}

export function lifecycleBindingVerificationBody(): string {
  return `if [ -n "$EXPECTED_BINDING_TAG" ]; then
  TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
  printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \
    || { echo "refusing to mutate VMID $VMID without its exact Hivra binding tag" >&2; exit 1; }
fi`;
}

export function lifecycleVmAuthorityBody(): string {
  return `qm status "$VMID" >/dev/null
${lifecycleBindingVerificationBody()}`;
}

export function lifecycleMutationPrelude(
  vmid: number,
  bindingTag: string | null,
  allowMissingForManagedRestore = false,
): string {
  const vmAuthority = allowMissingForManagedRestore
    ? `if qm status "$VMID" >/dev/null 2>&1; then
  ${lifecycleBindingVerificationBody().replaceAll("\n", "\n  ")}
fi`
    : lifecycleVmAuthorityBody();
  return `set -euo pipefail
VMID=${vmid}
EXPECTED_BINDING_TAG=${shellQuote(bindingTag ?? "")}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra lifecycle lock" >&2; exit 1; }
${vmAuthority}`;
}

/** The stored-row fields a lifecycle operation reads. */
export type HivraLifecycleAgentRow = Record<string, unknown> & {
  id?: unknown;
  user_id?: unknown;
  type?: unknown;
  vmid?: unknown;
  ip?: unknown;
  proxmox_host?: unknown;
};

export interface HivraLifecycleTarget {
  executionContext: HivraAgentExecutionContext;
  /** The binding tag the prelude must find on the VM, or null for a legacy managed row. */
  bindingTag: string | null;
  env: HivraAgentExecutionContext["env"];
  vmid: number;
  octet: number;
  subnetPrefix: string;
}

export type HivraLifecycleTargetFailure = {
  ok: false;
  code: "no_computer" | "infrastructure_unavailable" | "host_not_ready" | "misconfigured";
  status: number;
  message: string;
};

/**
 * The exact host, VM and guest address an owner-scoped lifecycle action on
 * this agent may touch, or why it can't run. Managed hosts must carry an
 * admitted provisioner (the exact current release for an in-place update);
 * stop and force_stop never call the helper and stay available on stale hosts. Throws only
 * for an unexpected execution-context error.
 */
export async function resolveHivraLifecycleTarget(input: {
  userId: string;
  agent: HivraLifecycleAgentRow;
  action: string;
  source?: string;
}): Promise<{ ok: true; target: HivraLifecycleTarget } | HivraLifecycleTargetFailure> {
  const { userId, agent, action } = input;
  const source = input.source ?? DEFAULT_SOURCE;
  if (!agent.vmid) return { ok: false, code: "no_computer", status: 400, message: "Agent has no box yet" };

  let executionContext: HivraAgentExecutionContext;
  try {
    executionContext = await resolveHivraAgentExecutionContext(userId, agent);
  } catch (contextError) {
    const safeError = describeHivraAgentExecutionContextError(contextError);
    if (safeError) return { ok: false, code: "infrastructure_unavailable", status: safeError.status, message: safeError.message };
    throw contextError;
  }
  // Self-managed unenforced rows fail during context resolution. Managed
  // N-1 rows are the one narrow compatibility exception: migration cannot
  // safely stamp a provider tag without touching live hosts. Every new row is
  // enforced, and the legacy path remains exact managed host + persisted VMID.
  const bindingTag = executionContext.infrastructureBindingTagEnforced
    ? executionContext.infrastructureBindingTag
    : null;
  const env = executionContext.env;

  // start/restart/resize all invoke the versioned start helper after crossing
  // a provider mutation boundary. Existing managed agents may still live on
  // hosts with an older compatible bundle, so prove the exact selected host
  // and persisted channel have an admitted VERSION, intact manifest, and
  // exact-result-path capability before claiming an operation lease or issuing
  // any VM command. Explicit runtime updates require the current version. Stop
  // and Force off do not call the helper and deliberately remain available for
  // stale hosts.
  if (executionContext.kind === "managed" && action !== "stop" && action !== "force_stop") {
    const readiness = await checkManagedHivraHostReadiness({
      targetId: executionContext.host,
      env,
      channel: executionContext.provisionerChannel,
      purpose: action === "update_runtime" ? "runtime-update" : "lifecycle",
    });
    if (!readiness.ok) {
      log.warn("hivra managed lifecycle blocked by stale host provisioner", {
        source,
        failureType: "hivra_agent_lifecycle_host_readiness_failed",
        userId,
        agentId: agent.id,
        proxmoxHost: executionContext.host,
        action,
        readinessError: readiness.error,
      });
      return { ok: false, code: "host_not_ready", status: readiness.status, message: readiness.message };
    }
  }

  const vmid = Number(agent.vmid);
  const vmidStart = resolveHivraVmidStart(env);
  // The IP we stored at provision time is the source of truth. The octet is no
  // longer a fixed function of VMID (the allocator now skips in-use IPs to avoid
  // collisions) and legacy boxes use an older vmid->octet scheme — so recomputing
  // from VMID would ssh to the wrong guest (or a negative octet for legacy boxes,
  // 500ing their lifecycle ops). Fall back to the VMID-derived octet only when
  // the row predates ip persistence.
  const storedOctet =
    typeof agent.ip === "string"
      ? Number.parseInt(String(agent.ip).split(".").pop() ?? "", 10)
      : NaN;
  const octet = Number.isInteger(storedOctet)
    ? storedOctet
    : resolveHivraIpLastOctetStart(env) + (vmid - vmidStart);
  if (!Number.isInteger(vmid) || !Number.isInteger(octet) || octet < 2 || octet > 254) {
    log.error("hivra agent lifecycle IP octet is outside the host range", new Error("Invalid Hivra IP octet"), {
      source,
      failureType: "hivra_agent_lifecycle_invalid_ip_octet",
      userId,
      agentId: agent.id,
      proxmoxHost: agent.proxmox_host ?? null,
      vmid,
      vmidStart,
      octet,
    });
    return { ok: false, code: "misconfigured", status: 500, message: "Hivra host IP range is not configured for this box" };
  }
  return {
    ok: true,
    target: { executionContext, bindingTag, env, vmid, octet, subnetPrefix: resolveHivraSubnetPrefix(env) },
  };
}

export interface LifecycleActivityCredential {
  /** The root-only file a helper reads the credential from. */
  file: string;
  /** Shell that stages a fresh credential for `helper` (only if it consumes one), and the env that passes it on. */
  kickoff(helper: string): { stage: string; env: string };
  /** Records the issuance once the host confirmed the credential file exists. */
  recordIssued(result: HostScriptResult): Promise<void>;
  /** Records the reporter install outcome a synchronous helper printed. */
  recordInstall(result: HostScriptResult): Promise<void>;
}

/**
 * Agent-run reporting: every start-helper run (and every in-place runtime
 * update) of a Claude Code / Codex Proxmox computer re-issues its 7-day
 * reporter credential, replacing one that expired while stopped and
 * backfilling computers launched before reporting existed once their host
 * carries the new helper. The credential reaches the host only inside the
 * script (stdin to bash -s) and a root-only file the helper consumes and
 * deletes. Lifecycle readiness admits older helpers that cannot consume it,
 * so the file is written only after probing the exact helper that will run.
 * A deployment without an origin or signing secret skips silently; Activity
 * then shows the computer's coverage as missing.
 */
export function lifecycleActivityCredential(input: {
  agent: HivraLifecycleAgentRow;
  userId: string;
  vmid: number;
  action: string;
  source?: string;
}): LifecycleActivityCredential {
  const { agent, userId, vmid, action } = input;
  const source = input.source ?? DEFAULT_SOURCE;
  const file = `/run/hivra-lifecycle/${vmid}.activity.env`;
  let staged: ActivityCollectorCredential | null = null;
  return {
    file,
    kickoff(helper: string) {
      staged = supportsNativeTracing(agent as { type?: string | null; computer_substrate?: string | null })
        ? issueActivityCollectorCredential({ userId: String(agent.user_id), agentId: String(agent.id) })
        : null;
      if (!staged) return { stage: "", env: "" };
      const quotedFile = shellQuote(file);
      const encoded = Buffer.from(JSON.stringify(staged), "utf8").toString("base64");
      return {
        stage: `HIVRA_ACTIVITY_FILE=''; if grep -Fq HIVRA_ACTIVITY_TELEMETRY_FILE ${shellQuote(helper)} 2>/dev/null && install -d -m 0700 /run/hivra-lifecycle && install -m 0600 /dev/null ${quotedFile} && printf '%s\\n' ${shellQuote(`HIVRA_ACTIVITY_TELEMETRY_B64=${encoded}`)} > ${quotedFile}; then HIVRA_ACTIVITY_FILE=${quotedFile}; echo ${ACTIVITY_CREDENTIAL_STAGED}; else rm -f -- ${quotedFile} 2>/dev/null || true; fi; `,
        env: `HIVRA_ACTIVITY_TELEMETRY_FILE="$HIVRA_ACTIVITY_FILE" `,
      };
    },
    // Best effort, and only once the host confirmed the credential file exists:
    // a failed record never fails the lifecycle operation.
    async recordIssued(result: HostScriptResult) {
      const credential = staged;
      if (!credential || !supabaseAdmin) return;
      if (!(result.stdout || "").split(/\r?\n/).includes(ACTIVITY_CREDENTIAL_STAGED)) return;
      const recorded = await recordActivityCollectorIssued(supabaseAdmin, {
        agentId: String(agent.id),
        userId: String(agent.user_id),
        expiresAt: credential.expiresAt,
        reason: "start",
      });
      if (!recorded) {
        log.warn("hivra activity collector issuance could not be recorded", {
          source,
          failureType: "hivra_activity_collector_issue_record_failed",
          userId,
          agentId: agent.id,
          action,
        });
      }
    },
    // A synchronous helper (the in-place runtime update) reports the reporter
    // install outcome on its own stdout instead of the start log the [id] poll
    // reads. Same closed-enum marker and the same best-effort record.
    async recordInstall(result: HostScriptResult) {
      if (!staged || !supabaseAdmin) return;
      const lines = (result.stdout || "").split(/\r?\n/);
      if (!lines.includes(ACTIVITY_CREDENTIAL_STAGED)) return;
      const install = parseActivityCollectorMarker(lines);
      if (!install) return;
      const recorded = await recordCollectorInstallResult(supabaseAdmin, {
        agentId: String(agent.id),
        userId: String(agent.user_id),
        status: install.status,
        ...(install.reason ? { reason: install.reason } : {}),
      });
      if (!recorded) {
        log.warn("hivra agent-run reporter install result could not be recorded", {
          source,
          failureType: "hivra_activity_collector_install_record_failed",
          userId,
          agentId: agent.id,
          action,
        });
      }
    },
  };
}
