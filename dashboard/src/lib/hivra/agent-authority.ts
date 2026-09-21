/**
 * Deliberately invalid managed-fleet target id persisted on self-managed rows.
 *
 * N-1 Hivra routes only understand `proxmox_host`. Keeping a real user node
 * name in that legacy column lets an older deployment accidentally resolve it
 * through ambient managed credentials after an application rollback. This
 * sentinel forces target-specific resolution to fail closed instead.
 */
export const SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL =
  "__hivra_self_managed_no_ambient_authority__";

export type HivraAgentDeploymentMode = "hivra-managed" | "self-managed";

export type HivraAgentDesiredState = "running" | "stopped" | "deleted";

export type HivraAgentOperationKind =
  | "provision"
  | "start"
  | "stop"
  | "restart"
  | "resize"
  | "snapshot"
  | "restore"
  | "desktop_prepare"
  | "private_access"
  | "delete";

/** Display-only lifecycle signal. No operation IDs, payloads, or target authority. */
export type HivraAgentActivity = HivraAgentOperationKind | "cancelling";

export function publicHivraAgentActivity(row: Record<string, unknown>): HivraAgentActivity | null {
  if (row.operation_kind === "desktop_prepare" && row.operation_id != null) {
    return row.desired_state === "deleted" ? "cancelling" : "desktop_prepare";
  }
  if (row.status !== "provisioning") return null;
  // Delete intent retains an in-flight provision/start lease until its worker
  // has stopped and compensated. It must not be advertised as a new launch or
  // as active deletion before the delete worker actually owns the operation.
  if (row.desired_state === "deleted" && row.operation_kind !== "delete") return "cancelling";
  switch (row.operation_kind) {
    case "provision":
    case "start":
    case "stop":
    case "restart":
    case "resize":
    case "snapshot":
    case "restore":
    case "delete":
      return row.operation_kind;
    default:
      return null;
  }
}

const BINDING_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function hivraInfrastructureBindingTag(tokenHash: string): string {
  if (!BINDING_TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new Error("Invalid Hivra infrastructure binding token hash");
  }
  return `hivra-bind-${tokenHash.slice(0, 32)}`;
}

export function isHivraInfrastructureBindingTokenHash(value: unknown): value is string {
  return typeof value === "string" && BINDING_TOKEN_HASH_PATTERN.test(value);
}
