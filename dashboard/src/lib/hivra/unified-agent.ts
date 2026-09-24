// UnifiedAgent — a SAFE normalization layer that maps both agent families
// (Hermes instances from hermes_instances, and Hivra boxes from hivra_agents)
// into ONE shape so the dashboard can list + handle them through a single code
// path. This is presentation-only: it does NOT merge the underlying tables or
// touch the prod Hermes flow — each source keeps its own API, store, and
// lifecycle. A deeper unification (one listing endpoint / shared status model
// across the two backends) would touch the prod Hermes instance pipeline, so
// that's deliberately left as a follow-up for Ash.

import { resourceAttention, type ResourceAttention } from "./resource-attention";
import type { HivraAgent } from "./agent-api";
import { getAgent as catalogAgent } from "./agent-catalog";
import { agentComputerPair, type AgentComputerPair } from "@/lib/agent-computers/agent-surfaces";

export type UnifiedKind = "hermes" | "hivra";
type UnifiedState = "running" | "updating" | "provisioning" | "stopped" | "error" | "other";

export interface HermesInstanceLite {
  pendingPrompt?: unknown;
  id: string;
  name: string;
  provider?: string;
  model?: string | null;
  status: string;
}

export interface UnifiedAgent {
  attention?: ResourceAttention | null;
  /** Unique across both families (kind-prefixed). */
  uid: string;
  kind: UnifiedKind;
  /** Underlying row id (hermes_instances.id or hivra_agents.id). */
  id: string;
  name: string;
  /** Agent signature emoji (Hivra bootstrap identity; null for Hermes). */
  emoji?: string | null;
  /** Raw backend status string (shown verbatim). */
  statusRaw: string;
  /** Normalized lifecycle bucket — lets one renderer reason across families. */
  state: UnifiedState;
  /** Status dot color (kept brand-distinct: Hermes green, Hivra gold). */
  dot: string;
  vendor: string;
  typeLabel: string;
  /** Distinguishes chat agents from desktop/computer profiles in shared lists. */
  resourceKind?: "agent" | "computer";
  /** Raw hivra_agents.computer_profile. Lets a renderer pick the right desktop
   *  transport without re-fetching the detail — the list carries it, so the two
   *  routes cannot disagree about what kind of computer a row is. */
  computerProfile?: string | null;
  cpu?: number | null;
  ram?: number | null;
  model?: string | null;
  provider?: string | null;
  /** Raw hivra_agents.type (claude-code/codex/aeon/...). null for Hermes. Lets a
   *  renderer show CLI-only affordances (e.g. the Tools quick-install). */
  agentType?: string | null;
  /** The catalog definition's `surface` discriminant, so a renderer can tell a
   *  chat agent from a dashboard runtime from a computer without a second
   *  catalog lookup. Undefined for Hermes. */
  surfaceKind?: "chat" | "dashboard" | "computer";
  /** An agent's linked computer: where it runs and its size, from the stored
   *  lifecycle binding (ATT-11). Null for computers and Hermes. */
  computerPair?: AgentComputerPair | null;
  /** An agent added to one of the owner's computers (design 5.8). Its `id` is
   *  that computer's hivra_agents.id, so every link to /dashboard/agent/<id>
   *  opens the computer that hosts it; its `uid` is `a-<attachment id>`.
   *  Absent on every other row. */
  attachment?: UnifiedAttachment | null;
  /** Where the row opens, when that is more than /dashboard/agent/<id>. */
  href?: string;
}

export interface UnifiedAttachment {
  /** hivra_agent_attachments.id (a lowercase UUID). */
  id: string;
  computerId: string;
  computerName: string;
  /** "attached" once its chat is ready; "claimed" or "dispatched" while it is being added. */
  phase: "claimed" | "dispatched" | "attached";
}

/** One agent added to a computer, as GET /api/hivra/attached-agents lists it. */
export interface AttachedAgentLite {
  id: string;
  phase: UnifiedAttachment["phase"];
  agentName: string;
  computerId: string;
  computerName: string;
  computerStatus: string | null;
}

const STATE_LABELS: Record<UnifiedState, string> = {
  running: "Running",
  updating: "Updating",
  provisioning: "Starting",
  stopped: "Stopped",
  error: "Needs attention",
  other: "Unknown",
};

/** The one human-facing status word for both families. */
export function unifiedStateLabel(state: UnifiedState): string {
  return STATE_LABELS[state];
}

function hivraState(s: string): UnifiedState {
  if (s === "running") return "running";
  if (s === "provisioning") return "provisioning";
  if (s === "stopped") return "stopped";
  if (s === "error") return "error";
  return "other";
}
function hermesState(s: string): UnifiedState {
  if (s === "running") return "running";
  if (s === "redeploying" || s === "updating") return "updating";
  if (s === "provisioning" || s === "restoring") return "provisioning";
  if (s === "stopped" || s === "suspended" || s === "paused") return "stopped";
  if (s === "error" || s === "failed") return "error";
  return "other";
}

const HIVRA_DOT: Record<UnifiedState, string> = { running: "#22c55e", updating: "#f59e0b", provisioning: "#3b82f6", stopped: "var(--text-muted)", error: "#c0392b", other: "var(--text-muted)" };
const HERMES_DOT: Record<UnifiedState, string> = { running: "#22c55e", updating: "#f59e0b", provisioning: "#3b82f6", stopped: "var(--text-muted)", error: "#c0392b", other: "var(--text-muted)" };

function unifyHivra(a: HivraAgent): UnifiedAgent {
  const def = catalogAgent(a.type);
  // A re-provision of an already-provisioned box (resize/restart) reads as
  // "updating", distinct from a first-time launch ("provisioning").
  let state = hivraState(a.status);
  if (state === "provisioning" && a.provisioned_at) state = "updating";
  const resourceKind = a.computer_profile || def?.resourceKind === "computer" ? "computer" : "agent";
  return {
    uid: `x-${a.id}`, kind: "hivra", id: a.id, name: a.name, emoji: a.emoji ?? null,
    attention: resourceAttention(a.status),
    statusRaw: a.status, state, dot: HIVRA_DOT[state],
    vendor: def?.vendor || a.type, typeLabel: def?.name || a.type,
    resourceKind,
    computerProfile: a.computer_profile ?? null,
    surfaceKind: def?.surface,
    cpu: a.cpu, ram: a.ram, model: null, provider: null, agentType: a.type,
    computerPair: resourceKind === "agent" ? agentComputerPair(a) : null,
  };
}

/**
 * An agent added to a computer the owner already has. It runs only while that
 * computer runs, and reads as starting while it is being added. It opens the
 * computer's Chat tab once ready, and its Manage (the progress) until then.
 */
export function unifyAttached(a: AttachedAgentLite): UnifiedAgent {
  const def = catalogAgent("codex");
  const ready = a.phase === "attached";
  const statusRaw = ready ? a.computerStatus ?? "unknown" : "provisioning";
  const state = hivraState(statusRaw);
  return {
    uid: `a-${a.id}`, kind: "hivra", id: a.computerId, name: `${a.agentName} on ${a.computerName}`, emoji: null,
    attention: resourceAttention(statusRaw),
    statusRaw, state, dot: HIVRA_DOT[state],
    vendor: def?.vendor || "OpenAI", typeLabel: a.agentName,
    resourceKind: "agent", computerProfile: null, surfaceKind: "chat",
    cpu: null, ram: null, model: null, provider: null, agentType: "codex",
    computerPair: null,
    attachment: { id: a.id, computerId: a.computerId, computerName: a.computerName, phase: a.phase },
    href: `/dashboard/agent/${encodeURIComponent(a.computerId)}?tab=${ready ? "chat" : "manage"}`,
  };
}

function unifyHermes(i: HermesInstanceLite): UnifiedAgent {
  const state = hermesState(i.status);
  return {
    uid: `h-${i.id}`, kind: "hermes", id: i.id, name: i.name,
    attention: resourceAttention(i.status, i.pendingPrompt),
    statusRaw: i.status, state, dot: HERMES_DOT[state],
    vendor: "Hermes", typeLabel: "Hermes", resourceKind: "agent",
    cpu: null, ram: null, model: i.model ?? null, provider: i.provider ?? null, agentType: null,
  };
}

// Single stable order for the merged list: running first, then provisioning,
// stopped, error, other — and by name within each bucket.
const STATE_RANK: Record<UnifiedState, number> = { running: 0, updating: 1, provisioning: 2, stopped: 3, error: 4, other: 5 };
// An agent added to a computer follows that computer's own row, so a lookup by
// the computer's id finds the computer first.
export function unifyAll(hermes: HermesInstanceLite[], hivra: HivraAgent[], attached: AttachedAgentLite[] = []): UnifiedAgent[] {
  const sorted = [...hermes.map(unifyHermes), ...hivra.map(unifyHivra)]
    .sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || a.name.localeCompare(b.name));
  if (!attached.length) return sorted;
  const byComputer = new Map<string, UnifiedAgent[]>();
  for (const row of attached.map(unifyAttached)) byComputer.set(row.id, [...(byComputer.get(row.id) ?? []), row]);
  const merged: UnifiedAgent[] = [];
  for (const row of sorted) {
    merged.push(row);
    const hosted = row.kind === "hivra" ? byComputer.get(row.id) : undefined;
    if (hosted) { merged.push(...hosted); byComputer.delete(row.id); }
  }
  for (const rows of byComputer.values()) merged.push(...rows);
  return merged;
}
