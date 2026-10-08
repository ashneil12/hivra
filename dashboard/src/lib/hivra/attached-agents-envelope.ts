import type { AttachedAgentLite } from "./unified-agent";

// GET /api/hivra/attached-agents, read the same way by Home, the agent
// switcher and the shell's sidebar and Cmd-K palette.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTACHED_PHASES = new Set(["claimed", "dispatched", "attached"]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("invalid-source-record");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid-source-record");
  return value;
}

/** Agents added to the owner's computers: none where attach is not offered. */
export function parseAttachedAgentsEnvelope(value: unknown): AttachedAgentLite[] {
  const envelope = asRecord(value);
  const list = asRecord(envelope?.data);
  if (!envelope || envelope.success !== true || !list || !Array.isArray(list.agents)) {
    throw new Error("invalid-attached-envelope");
  }
  if (list.enabled !== true) return [];
  return list.agents.map((candidate) => {
    const row = asRecord(candidate);
    if (!row || typeof row.phase !== "string" || !ATTACHED_PHASES.has(row.phase)) throw new Error("invalid-source-record");
    return {
      id: requiredId(row.id),
      phase: row.phase as AttachedAgentLite["phase"],
      agentName: requiredString(row.agentName),
      computerId: requiredId(row.computerId),
      computerName: requiredString(row.computerName),
      computerStatus: typeof row.computerStatus === "string" ? row.computerStatus : null,
    };
  });
}
