import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { ModelKeyStoreError } from "./model-key-store";
import { createLaunchModelStore, launchModelFingerprints, LaunchModelIntentSchema, LaunchModelRequestError,
  type LaunchModelFingerprint, type LaunchModelIntent, type LaunchModelReservation, type LaunchModelStore } from "./launch-model-store";

type AgentRow = Record<string, unknown> & { id: string; user_id: string; type: "codex"; status: string };
async function readAgent(userId: string, agentId: string): Promise<AgentRow> {
  if (!supabaseAdmin) throw new ModelKeyStoreError();
  try {
    const { data, error } = await supabaseAdmin.from("hivra_agents").select("*").eq("user_id", userId).eq("id", agentId).maybeSingle();
    if (error || !data || data.id !== agentId || data.user_id !== userId || data.type !== "codex" || typeof data.status !== "string") {
      throw new ModelKeyStoreError();
    }
    return data as AgentRow;
  } catch { throw new ModelKeyStoreError(); }
}
type Dependencies = { store?: LaunchModelStore; agent?: typeof readAgent; fingerprints?: typeof launchModelFingerprints; newId?: () => string };
export type LaunchModelAdmission = {
  userId: string; requestId: string; modelOperationId: string; intent: LaunchModelIntent; fingerprints: LaunchModelFingerprint[];
};
function scope(userId: string, requestId: unknown): asserts requestId is string {
  if (!userId.trim() || userId.length > 256 || !z.string().uuid().safeParse(requestId).success) throw new LaunchModelRequestError("invalid_request");
}

/** Server-only bridge from canonical launch intent to the private reservation.
 * Raw rows stay internal; the route must use the normal agent sanitizer. */
export function createLaunchModelAdmissionService(deps: Dependencies = {}) {
  const store = deps.store ?? createLaunchModelStore(), agent = deps.agent ?? readAgent;
  async function original(userId: string, requestId: string) {
    scope(userId, requestId);
    const q = await store.byRequest(userId, requestId);
    if (!q) return null;
    const row = await agent(userId, q.agent_id);
    if (row.id !== q.agent_id || row.user_id !== userId || row.type !== "codex") throw new ModelKeyStoreError();
    return { requestId, phase: q.phase, agent: row };
  }
  return {
    original,
    async prepare(userId: string, requestId: unknown, raw: unknown) {
      scope(userId, requestId);
      const parsed = LaunchModelIntentSchema.safeParse(raw);
      if (!parsed.success) throw new LaunchModelRequestError("invalid_request");
      const fingerprints = (deps.fingerprints ?? launchModelFingerprints)(userId, requestId, parsed.data);
      const existing = await store.existing(userId, requestId, fingerprints);
      if (existing) {
        const saved = await original(userId, requestId);
        if (!saved || saved.agent.id !== existing.agent_id) throw new ModelKeyStoreError();
        return { existing: saved, admission: null };
      }
      return { existing: null, admission: {
        userId, requestId, modelOperationId: (deps.newId ?? randomUUID)(), intent: parsed.data, fingerprints,
      } satisfies LaunchModelAdmission };
    },
    async reserve(admission: LaunchModelAdmission, row: LaunchModelReservation, agentLimit: number) {
      scope(admission.userId, admission.requestId);
      const intent = admission.intent, placement = intent.deployment;
      if (row.type !== intent.type || row.name !== intent.name || row.deployment_mode !== placement.mode
        || (row.computer_substrate === "proxmox-kvm" && (row.cpu !== intent.cpu || row.ram !== intent.ram))
        // Only meaningful when the row actually carries an envelope: `cpu_max`
        // is written solely for explicit-envelope launches, so its absence means
        // no ceiling was declared and there is nothing to compare. Comparing the
        // fallback (`?? row.cpu`) against the intent's floor conflated a ceiling
        // with a floor and rejected legitimate provider-vm launches.
        || (row.cpu_max != null && (row.cpu_max !== intent.maximumCpu || row.ram_max !== intent.maximumRam))
        || ["goal", "context", "personality", "emoji"].some(key => (row[key as keyof LaunchModelReservation] ?? null) !== intent[key as keyof LaunchModelIntent])
        || JSON.stringify(row.template_skills ?? []) !== JSON.stringify(intent.templateSkills)
        || (placement.mode === "self-managed" && (row.infrastructure_connection_id !== placement.connectionId
          || row.deployment_target_id !== placement.targetId || row.infrastructure_connection_revision !== placement.expectedConnectionRevision))) {
        throw new LaunchModelRequestError("invalid_request");
      }
      const result = await store.reserve({ userId: admission.userId, requestId: admission.requestId,
        modelOperationId: admission.modelOperationId, fingerprints: admission.fingerprints, agent: row, llm: admission.intent.llm,
        agentLimit });
      const saved = await original(admission.userId, admission.requestId);
      if (!saved || saved.agent.id !== result.agentId) throw new ModelKeyStoreError();
      return { ...saved, created: result.created };
    },
  };
}
export type LaunchModelAdmissionService = ReturnType<typeof createLaunchModelAdmissionService>;
