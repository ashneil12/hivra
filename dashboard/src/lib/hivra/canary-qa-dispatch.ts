type Action = "start" | "resize" | "create";
type Outcome = "performed" | "refused";
type Scope = Readonly<{ ownerId: string; hostId: string; vmid: number }>;
type Operation = Scope & Readonly<{ action: Action; operationId: string }>;
type RpcCall =
  | [name: "claim_canary_qa_dispatch", args: {
    p_owner_id: string; p_host_id: string; p_vmid: number; p_action: Action; p_operation_id: string;
  }]
  | [name: "finish_canary_qa_dispatch", args: { p_operation_id: string; p_outcome: Outcome }];
type PublicDatabase = {
  rpc(...call: RpcCall): PromiseLike<{ data: unknown; error: unknown }>;
};
type DispatchResult =
  | { status: "denied"; reason: "disabled" | "invalid_operation" | "claim_not_granted" | "claim_unconfirmed" }
  | { status: "held"; reason: "runner_unconfirmed" | "finish_unconfirmed" }
  | { status: "settled"; outcome: Outcome };

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

function isOutcome(value: unknown): value is Outcome {
  return value === "performed" || value === "refused";
}

export function createCanaryQaDispatcher({
  enabled = false,
  scope: { ownerId, hostId, vmid },
  db,
  run,
}: {
  enabled?: boolean;
  scope: Scope;
  db: { schema(name: "public"): PublicDatabase };
  run: (operation: Operation) => Promise<Outcome | "unknown">;
}): (input: unknown) => Promise<DispatchResult> {
  return async (input) => {
    if (enabled !== true) return { status: "denied", reason: "disabled" };
    if (!validIdentity(ownerId) || !validIdentity(hostId)
      || !Number.isSafeInteger(vmid) || vmid <= 0 || vmid > 2_147_483_647
      || !isRecord(input) || input.ownerId !== ownerId || input.hostId !== hostId || input.vmid !== vmid) {
      return { status: "denied", reason: "invalid_operation" };
    }
    const { action, operationId } = input;
    if ((action !== "start" && action !== "resize" && action !== "create")
      || typeof operationId !== "string" || operationId.length !== 36 || !OPERATION_ID.test(operationId)) {
      return { status: "denied", reason: "invalid_operation" };
    }

    let publicDb: PublicDatabase;
    try {
      publicDb = db.schema("public");
      const response = await publicDb.rpc("claim_canary_qa_dispatch", {
        p_owner_id: ownerId, p_host_id: hostId, p_vmid: vmid, p_action: action, p_operation_id: operationId,
      });
      if (response?.error !== null || !isRecord(response.data)) {
        return { status: "denied", reason: "claim_unconfirmed" };
      }
      const claim = response.data;
      if (claim.status === "denied" || claim.status === "pending") {
        return { status: "denied", reason: "claim_not_granted" };
      }
      if (claim.status === "settled" && claim.operationId === operationId && isOutcome(claim.outcome)) {
        return { status: "settled", outcome: claim.outcome };
      }
      if (claim.status !== "claimed" || claim.ownerId !== ownerId || claim.hostId !== hostId
        || claim.vmid !== vmid || claim.action !== action || claim.operationId !== operationId) {
        return { status: "denied", reason: "claim_unconfirmed" };
      }
    } catch {
      return { status: "denied", reason: "claim_unconfirmed" };
    }

    let outcome: Awaited<ReturnType<typeof run>>;
    try {
      outcome = await run({ ownerId, hostId, vmid, action, operationId });
    } catch {
      return { status: "held", reason: "runner_unconfirmed" };
    }
    if (!isOutcome(outcome)) {
      return { status: "held", reason: "runner_unconfirmed" };
    }

    try {
      const response = await publicDb.rpc("finish_canary_qa_dispatch", {
        p_operation_id: operationId, p_outcome: outcome,
      });
      if (response?.error === null && isRecord(response.data) && response.data.status === "settled"
        && response.data.operationId === operationId && response.data.outcome === outcome) {
        return { status: "settled", outcome };
      }
    } catch {
      return { status: "held", reason: "finish_unconfirmed" };
    }
    return { status: "held", reason: "finish_unconfirmed" };
  };
}
