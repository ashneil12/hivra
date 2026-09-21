import "server-only";

import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { createModelKeyCoordinator, ModelKeyError, type ModelKeyOutcome } from "./model-key-coordinator";
import { createModelKeyStore, modelKeyBinding, type ModelKeyAgent, type ModelKeyStore } from "./model-key-store";
import { createLaunchModelStore, type LaunchModelRequest, type LaunchModelStore } from "./launch-model-store";
import { ModelKeySelectionSchema } from "./model-key-selection";
import { inspectGuestLlmApplication } from "./guest-llm-transport";

type ModelDependencies = NonNullable<Parameters<typeof createModelKeyCoordinator>[0]>;
type Dependencies = Omit<ModelDependencies, "store"> & { store?: ModelKeyStore; launches?: LaunchModelStore };
export type LaunchModelOutcome = { requestId: string; operationId: string; status: "waiting" | "pending" | "applied"; reason?: string };
const Id = z.string().uuid();

function scope(userId: string, agentId: string, requestId?: string) {
  if (!userId.trim() || userId.length > 256 || !Id.safeParse(agentId).success
    || (requestId !== undefined && !Id.safeParse(requestId).success)) throw new ModelKeyError("invalid_request");
}
function originalAllocation(a: ModelKeyAgent, q: LaunchModelRequest) {
  const bound = modelKeyBinding(a);
  if (a.allocation_operation_id !== q.provision_operation_id
    || ["agentId", "userId", "runtime", "deploymentMode", "substrate", "host", "connectionId", "targetId", "orderId", "enrollmentId", "serverId"]
      .some(key => q.binding[key] !== bound[key])) throw new ModelKeyError("computer_not_ready");
}

/** The launch precursor owns only the pre-readiness intent. After atomic
 * promotion, the existing coordinator owns all delivery, recovery, receipt
 * settlement and key activation. There is no second guest write protocol. */
export function createLaunchModelCoordinator(deps: Dependencies = {}) {
  const store = deps.store ?? createModelKeyStore(), launches = deps.launches ?? createLaunchModelStore();
  const normal = createModelKeyCoordinator({ ...deps, store });
  async function agent(userId: string, agentId: string) {
    const a = await store.agent(userId, agentId);
    if (!a || a.status === "deleted") throw new ModelKeyError("not_found");
    return a;
  }
  async function request(userId: string, agentId: string, requestId: string) {
    const q = await launches.byAgent(userId, agentId);
    if (!q || q.request_id !== requestId || q.user_id !== userId || q.agent_id !== agentId) throw new ModelKeyError("operation_conflict");
    return q;
  }
  const wrap = (q: LaunchModelRequest, outcome: ModelKeyOutcome): LaunchModelOutcome => ({ requestId: q.request_id, ...outcome });
  return {
    async summary(userId: string, agentId: string) {
      scope(userId, agentId);
      const a = await agent(userId, agentId), q = await launches.byAgent(userId, agentId);
      if (!q || ["promoted", "cancelled", "deleted"].includes(q.phase)) return null;
      const ready = a.status === "running" && a.desired_state === "running" && !a.operation_id;
      return { requestId: q.request_id, operationId: q.model_operation_id, requested: q.selection, createdAt: q.created_at,
        state: !ready ? "waiting_for_computer" as const
          : q.attempt_expires_at && Date.parse(q.attempt_expires_at) > Date.now() ? "setup_requested" as const
            : q.attempted_at ? "needs_attention" as const : "ready_to_apply" as const };
    },
    async assertNoPendingLaunch(userId: string, agentId: string) {
      scope(userId, agentId); await agent(userId, agentId);
      const q = await launches.byAgent(userId, agentId);
      if (q && ["waiting", "admitting"].includes(q.phase)) throw new ModelKeyError("pending_change");
    },
    async cancel(userId: string, agentId: string, requestId: string) {
      scope(userId, agentId, requestId); await agent(userId, agentId);
      const q = await request(userId, agentId, requestId);
      if (q.phase === "promoted" || !await launches.cancel(userId, agentId, requestId)) throw new ModelKeyError("pending_change");
      return { requestId, status: "cancelled" as const };
    },
    async continue(userId: string, agentId: string, requestId: string, automatic: boolean): Promise<LaunchModelOutcome> {
      scope(userId, agentId, requestId);
      if (typeof automatic !== "boolean") throw new ModelKeyError("invalid_request");
      const a = await agent(userId, agentId), q = await request(userId, agentId, requestId);
      if (q.phase === "cancelled" || q.phase === "deleted") throw new ModelKeyError("operation_conflict");
      if (q.phase === "promoted") {
        // Reopening/polling never retries an uncertain delivery automatically.
        // The explicit Continue action resumes exactly the original journal.
        if (!automatic) return wrap(q, await normal.resume(userId, agentId, q.model_operation_id));
        const j = await store.operation(userId, agentId, q.model_operation_id);
        if (!j || j.phase === "deleted" || (j.phase === "applied" && !j.is_current)) throw new ModelKeyError("operation_conflict");
        return { requestId, operationId: q.model_operation_id, status: j.phase,
          ...(j.phase === "pending" ? { reason: "resume_required" } : {}) };
      }
      if (a.status !== "running" || a.desired_state !== "running" || a.operation_id) {
        return { requestId, operationId: q.model_operation_id, status: "waiting", reason: "computer_not_ready" };
      }
      originalAllocation(a, q);
      const started = performance.now();
      const claimed = await launches.claim(userId, agentId, requestId, automatic);
      if (!claimed) return { requestId, operationId: q.model_operation_id, status: "waiting", reason: "resume_required" };
      if (claimed.model_operation_id !== q.model_operation_id || claimed.provision_operation_id !== q.provision_operation_id) {
        throw new ModelKeyError("stored_setting_unavailable");
      }
      const wallNotAfter = Date.parse(claimed.attempt_expires_at!) - 500;
      const duration = Math.min(25_000 - (performance.now() - started), wallNotAfter - Date.now());
      const notAfter = performance.now() + duration;
      const fence = () => {
        if (!Number.isFinite(duration) || duration <= 0 || performance.now() >= notAfter || Date.now() >= wallNotAfter) {
          throw new ModelKeyError("computer_not_ready");
        }
      };
      fence();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), duration);
      try {
        let selection;
        try {
          const value = claimed.selection.mode === "byok" ? { ...claimed.selection,
            apiKey: (deps.decrypt ?? decryptSecret)(claimed.encrypted_key ?? "") } : claimed.selection;
          selection = ModelKeySelectionSchema.unwrap().parse(value);
        } catch { throw new ModelKeyError("stored_setting_unavailable"); }
        const fixedSelection = selection;
        let promotedByThisAttempt = false;
        const beforePromotion = () => { if (!promotedByThisAttempt) fence(); };
        const coordinator = createModelKeyCoordinator({ ...deps,
          store: { ...store,
            async agent(owner, id) {
              beforePromotion();
              const current = await store.agent(owner, id);
              beforePromotion();
              if (current) originalAllocation(current, claimed);
              return current;
            },
            async operation(owner, id, operationId) {
              beforePromotion();
              const current = await store.operation(owner, id, operationId);
              beforePromotion();
              // A suspended waiting caller cannot adopt a journal promoted by
              // a later attempt via normal.start's existing-operation resume.
              // The caller must observe promoted state in a new explicit call.
              if (current && !promotedByThisAttempt) throw new ModelKeyError("pending_change");
              return current;
            },
            async claim(owner, id, operationId) {
              if (!promotedByThisAttempt) throw new ModelKeyError("pending_change");
              return store.claim(owner, id, operationId);
            },
            async admit(owner, id, operationId, binding, body) {
              fence();
              if (owner !== userId || id !== agentId || operationId !== claimed.model_operation_id) throw new ModelKeyError("operation_conflict");
              const outcome = await launches.promote(owner, id, requestId, claimed.attempt_id!, binding, body);
              // Only an acknowledgement of THIS atomic promotion grants its
              // first delivery. Lost replies and already_promoted do not.
              // Once promoted, the normal journal's separate delivery lease
              // governs; do not extend or reuse the precursor admission lease.
              promotedByThisAttempt = outcome === "pending" || outcome === "applied";
              return outcome === "attempt_ended" ? "not_ready" : outcome;
            },
          },
          async inspect(target) {
            fence();
            const observed = await (deps.inspect ?? inspectGuestLlmApplication)(target, undefined, controller.signal);
            fence(); return observed;
          },
          encrypt(plaintext) {
            fence();
            // BYOK promotion moves the original encrypted value, rather than
            // replacing custody with a newly randomized encryption envelope.
            if (fixedSelection.mode === "byok") {
              if (plaintext !== fixedSelection.apiKey || !claimed.encrypted_key) throw new ModelKeyError("stored_setting_unavailable");
              return claimed.encrypted_key;
            }
            return (deps.encrypt ?? encryptSecret)(plaintext);
          },
        });
        return wrap(claimed, await coordinator.start(userId, agentId, claimed.model_operation_id, fixedSelection));
      } finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
