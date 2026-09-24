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
export function unifyAll(hermes: HermesInstanceLite[], hivra: HivraAgent[]): UnifiedAgent[] {
  return [...hermes.map(unifyHermes), ...hivra.map(unifyHivra)]
    .sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || a.name.localeCompare(b.name));
}
