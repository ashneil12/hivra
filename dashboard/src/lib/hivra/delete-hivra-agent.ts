// Server-callable delete of a Proxmox-hosted Hivra computer: claims the durable
// delete lease, destroys the VM with ownership checks, then finalizes. The
// DELETE route and the Hermes move (which removes the new computer on failure
// and on undo) share it, so there is one deletion path.

import { randomUUID } from "node:crypto";

import { HivraAgentDeleteCleanupError } from "@/lib/hivra/agent-delete-cleanup";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import {
  describeHivraAgentExecutionContextError,
  hivraAgentProvisionLogPath,
  hivraAgentProvisionSecretPath,
  hivraAgentStartLogPath,
  resolveHivraAgentTeardownExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import {
  completeHivraAgentDelete,
  releaseHivraAgentOperation,
  requestHivraAgentDelete,
} from "@/lib/hivra/agent-operation-store";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  hivraPrivateAccessAuthority,
  prepareHivraTailscaleForDelete,
  sameHivraPrivateAccessAuthority,
  type HivraPrivateAccessAgentRow,
} from "@/lib/hivra/tailscale-private-access";
import { log } from "@/lib/logger";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

export type DeleteHivraAgentResult = { ok: true } | { ok: false; message: string; status: number };

const fail = (message: string, status: number): DeleteHivraAgentResult => ({ ok: false, message, status });

export function verifiedDestroyHivraVmScript(input: {
  vmid: number;
  storage: string;
  expectedAllocationOperationId: string | null;
  expectedInfrastructureBindingTag: string | null;
  allowManagedLegacyAuthority: boolean;
  cleanupPaths: string[];
}): string {
  const expectedTag = input.expectedAllocationOperationId
    ? `hivra-op-${input.expectedAllocationOperationId.replace(/-/g, "").toLowerCase()}`
    : null;
  const cleanupPaths = input.cleanupPaths.map((path) => shellQuote(path)).join(" ");
  return `set -euo pipefail
VMID='${input.vmid}'
STORAGE=${shellQuote(input.storage)}
${expectedTag ? `EXPECTED_TAG=${shellQuote(expectedTag)}` : "EXPECTED_TAG='' # pre-operation-tag managed VM"}
${input.expectedInfrastructureBindingTag ? `EXPECTED_BINDING_TAG=${shellQuote(input.expectedInfrastructureBindingTag)}` : "EXPECTED_BINDING_TAG='' # legacy managed VM pending guarded adoption"}
ALLOW_MANAGED_LEGACY=${input.allowManagedLegacyAuthority ? "1" : "0"}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for Hivra deletion lock" >&2; exit 1; }
PIDFILE="/run/hivra-provision/$VMID.pid"
if [ -r "$PIDFILE" ]; then
  PID="$(tr -dc '0-9' < "$PIDFILE")"
  if [ -z "$PID" ]; then
    echo "Provision PID file is invalid for VMID $VMID" >&2
    exit 1
  fi
  if kill -0 "$PID" 2>/dev/null; then
    CMD="$(tr '\\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
    if ! printf '%s' "$CMD" | grep -Fq "hivra-provision-on-host.sh $VMID "; then
      echo "Refusing to stop unexpected PID $PID for VMID $VMID" >&2
      exit 1
    fi
    if [ "$ALLOW_MANAGED_LEGACY" != 1 ]; then
      [ -n "$EXPECTED_TAG" ] && [ -n "$EXPECTED_BINDING_TAG" ] \
        || { echo "Tagged provision process ownership evidence is incomplete" >&2; exit 1; }
      [ -r "/proc/$PID/environ" ] \
        && tr '\\0' '\\n' < "/proc/$PID/environ" | grep -Fxq "HIVRA_OPERATION_ID=${input.expectedAllocationOperationId ?? ""}" \
        && tr '\\0' '\\n' < "/proc/$PID/environ" | grep -Fxq "HIVRA_BINDING_TAG=${input.expectedInfrastructureBindingTag ?? ""}" \
        || { echo "Refusing to stop an unowned provision process" >&2; exit 1; }
    fi
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "Provision process $PID is still active for VMID $VMID" >&2
      exit 1
    fi
  fi
fi
rm -f -- "$PIDFILE"
if qm status "$VMID" >/dev/null 2>&1; then
  if [ "$ALLOW_MANAGED_LEGACY" != 1 ] && { [ -z "$EXPECTED_TAG" ] || [ -z "$EXPECTED_BINDING_TAG" ]; }; then
    echo "Refusing to destroy VMID $VMID without complete provider ownership evidence" >&2
    exit 1
  fi
  for _ in 1 2 3; do
    qm status "$VMID" >/dev/null 2>&1 || break
    if [ "$ALLOW_MANAGED_LEGACY" != 1 ]; then
      TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
      printf '%s' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_TAG" \
        && printf '%s' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \
        || { echo "VMID $VMID ownership changed before deletion" >&2; exit 1; }
    fi
    qm stop "$VMID" --timeout 30 >/dev/null 2>&1 || true
    qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
    sleep 1
  done
fi
if qm status "$VMID" >/dev/null 2>&1; then
  echo "VMID $VMID still exists after destroy" >&2
  exit 1
fi
VOLUMES="$(pvesm list "$STORAGE" 2>/dev/null)" \
  || { echo "Could not verify storage $STORAGE after deletion" >&2; exit 1; }
if printf '%s\\n' "$VOLUMES" | grep -E "vm-${input.vmid}-"; then
  echo "VMID $VMID still has volumes on $STORAGE after destroy" >&2
  exit 1
fi
rm -f -- ${cleanupPaths} \
  "/run/hivra-provision/$VMID.env" \
  "/run/hivra-provision/$VMID.secret" \
  "/run/hivra-provision/$VMID.allocated" \
  "/var/lib/hivra/provision-results/$VMID.secret"
echo "destroyed $VMID"`;
}

/**
 * Delete one Proxmox-hosted Hivra computer owned by userId. Never throws for
 * expected refusals; returns the HTTP status and message the route reports.
 */
export async function deleteProxmoxHivraAgent(
  userId: string,
  existingAgent: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- a hivra_agents row
): Promise<DeleteHivraAgentResult> {
  if (!supabaseAdmin) return fail("Database not configured", 500);
  let deleteLease: { userId: string; agentId: string; operationId: string } | null = null;
  try {
    const operationId = randomUUID();
    const disposition = await requestHivraAgentDelete({
      userId,
      agentId: String(existingAgent.id),
      operationId,
    });
    if (disposition === "not_found") return fail("Agent not found", 404);
    if (disposition === "deleted") return { ok: true };
    if (disposition === "pending") {
      return fail(
        "Delete is requested. The current provider operation must finish or compensate before deletion can continue; retry shortly.",
        409,
      );
    }

    deleteLease = { userId, agentId: String(existingAgent.id), operationId };
    const { data: agent, error: reloadError } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", existingAgent.id)
      .eq("user_id", userId)
      .single();
    if (
      reloadError ||
      !agent ||
      agent.operation_kind !== "delete" ||
      agent.operation_id !== operationId ||
      agent.desired_state !== "deleted"
    ) {
      await releaseHivraAgentOperation({ ...deleteLease, error: "Delete lease reload failed.", markError: true });
      deleteLease = null;
      return fail("Delete authority changed before provider cleanup. Refresh and retry.", 409);
    }

    if (agent.vmid) {
      const vmid = Number(agent.vmid);
      const allocationOperationId =
        typeof agent.allocation_operation_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          agent.allocation_operation_id,
        )
          ? agent.allocation_operation_id
          : null;
      if (agent.deployment_mode === "self-managed" && !allocationOperationId) {
        await releaseHivraAgentOperation({
          ...deleteLease,
          error: "Portable VM ownership evidence is missing.",
          markError: true,
        }).catch(() => false);
        deleteLease = null;
        return fail(
          "This computer lacks verified VM ownership evidence. Verify and remove the VM on the target before finalizing deletion.",
          409,
        );
      }
      let context: HivraAgentExecutionContext;
      try {
        context = await resolveHivraAgentTeardownExecutionContext(userId, agent);
      } catch (contextError) {
        await releaseHivraAgentOperation({
          ...deleteLease,
          error: "Infrastructure authority could not be resolved for deletion.",
          markError: true,
        }).catch(() => false);
        deleteLease = null;
        const safeError = describeHivraAgentExecutionContextError(contextError);
        if (safeError) return fail(safeError.message, safeError.status);
        throw contextError;
      }
      const provisionLog = hivraAgentProvisionLogPath(context, vmid);
      const provisionSecret = hivraAgentProvisionSecretPath(context, vmid);
      const startLog = hivraAgentStartLogPath(context, vmid);
      const cleanupPaths = [provisionLog, startLog, provisionSecret]
        .filter((path): path is string => Boolean(path));
      const { data: privateAccess, error: privateAccessError } = await supabaseAdmin
        .from("hivra_private_access_connections")
        .select("authority,login_server")
        .eq("agent_id", agent.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (privateAccessError) {
        await releaseHivraAgentOperation({
          ...deleteLease,
          error: "Private-access authority could not be checked before deletion.",
          markError: true,
        }).catch(() => false);
        deleteLease = null;
        return fail("Private access could not be checked before VM deletion. Retry Delete.", 503);
      }
      const privateAccessAgent = agent as unknown as HivraPrivateAccessAgentRow;
      if (privateAccess && sameHivraPrivateAccessAuthority(
        privateAccess.authority,
        hivraPrivateAccessAuthority(privateAccessAgent),
      )) {
        const revocation = await prepareHivraTailscaleForDelete(privateAccessAgent, context);
        if (!revocation.ok) {
          await releaseHivraAgentOperation({
            ...deleteLease,
            error: `Private-access guest logout was not confirmed (${revocation.failureCode ?? "unknown"}).`,
            markError: true,
          }).catch(() => false);
          deleteLease = null;
          return fail(
            "The running computer's private-network logout could not be confirmed, so its VM was retained. Retry Delete.",
            502,
          );
        }
      }
      const destroy = await runProxmoxHostScript(
        verifiedDestroyHivraVmScript({
          vmid,
          storage: context.paths.storage,
          expectedAllocationOperationId: allocationOperationId,
          expectedInfrastructureBindingTag: context.infrastructureBindingTagEnforced
            ? context.infrastructureBindingTag
            : null,
          allowManagedLegacyAuthority:
            agent.deployment_mode === "hivra-managed" &&
            !context.infrastructureBindingTagEnforced,
          cleanupPaths,
        }),
        context.env,
      );
      if (!destroy.ok) {
        await releaseHivraAgentOperation({
          ...deleteLease,
          error: (destroy.error || destroy.stderr || "destroy failed").slice(0, 300),
          markError: true,
        }).catch(() => false);
        deleteLease = null;
        await logHivraAgentEvent({
          userId,
          event: "failed",
          agentId: agent.id,
          agentType: agent.type,
          detail: {
            reason: "delete_destroy_failed",
            vmid,
            proxmox_host: context.host,
            error: (destroy.error || destroy.stderr || "destroy failed").slice(0, 200),
          },
        });
        log.error("hivra agent destroy failed; not marking deleted", new Error(destroy.error || "destroy failed"), {
          source: "hivra/agents/[id]",
          failureType: "hivra_agent_destroy_failed",
          userId,
          agentId: agent.id,
          vmid,
          proxmoxHost: context.host,
          stdout: destroy.stdout?.slice(0, 500) ?? null,
          stderr: destroy.stderr?.slice(0, 500) ?? null,
          verboseErrors: true,
        });
        return fail("Agent VM destroy failed", 502);
      }
    }
    // The shared finalizer verifies tunnel/DNS/key revocation before the
    // terminal CAS, exactly as it does for background operation recovery.
    const completed = await completeHivraAgentDelete(deleteLease);
    if (!completed) {
      await releaseHivraAgentOperation({
        ...deleteLease,
        error: "Verified provider deletion could not be persisted.",
        markError: true,
      }).catch(() => false);
      deleteLease = null;
      return fail("The VM was removed, but deletion could not be finalized safely. Refresh and retry.", 409);
    }
    deleteLease = null;
    await logHivraAgentEvent({ userId, event: "deleted", agentId: agent.id, agentType: agent.type });
    return { ok: true };
  } catch (err) {
    if (deleteLease) {
      await releaseHivraAgentOperation({
        ...deleteLease,
        error: err instanceof HivraAgentDeleteCleanupError
          ? err.message : "Delete operation failed before verified completion.",
        markError: true,
      }).catch(() => false);
    }
    if (err instanceof HivraAgentDeleteCleanupError) {
      log.warn("hivra agent deletion awaits access cleanup", {
        source: "hivra/agents/[id]",
        failureType: "hivra_agent_delete_cleanup_pending",
        agentId: deleteLease?.agentId,
        stage: err.stage,
      });
      return fail(err.message, 502);
    }
    throw err;
  }
}
