/**
 * Hivra — AUTHORITATIVE agent-slot + scheduling-priority source.
 *
 * Pre-flight V4 found slot counts had drifted across three registries
 * (subscription/plans.ts = 999, hivra/agent-catalog.ts = 2/4, hivra/agent-api.ts
 * = 2/4/8). This is now the single source of truth; the Hermes plans, the Hivra
 * catalog, and the Hivra API all import it so they can never drift again.
 *
 * Locked by Ash 2026-06-05: Free 1 / Pro 3 / Power 5 / Command 8 (internal-only).
 *
 * Slots cap DEPLOYMENT COUNT. CPU/RAM budget (PLANS.totalCpu/totalRam, the pool)
 * caps total resources. One agent = one isolated VM (architecture lock v1.1).
 */

// Keyed by INTERNAL plan keys (the marketing names Pro/Power map to operator/fleet).
export const AGENT_SLOTS = {
  free: 1,
  operator: 3, // "Pro"
  fleet: 5, // "Power"
  command: 8, // internal-only, not surfaced publicly for launch
} as const;

// Scheduling priority (Phase 5): cgroup CPU weight tier. 0 = lowest .. 2 = highest.
export const SCHEDULING_PRIORITY = {
  free: 0,
  operator: 1,
  fleet: 2,
  command: 2,
} as const;

type SlotPlanKey = keyof typeof AGENT_SLOTS;

// Marketing aliases used by the Hivra catalog UI.
const PLAN_ALIASES: Record<string, SlotPlanKey> = { pro: "operator", power: "fleet" };

function resolveKey(key: string): SlotPlanKey {
  return (PLAN_ALIASES[key] ?? key) as SlotPlanKey;
}

// hermes_instances.resource_tier uses credit_base/token_base for the free tiers.
const RESOURCE_TIER_PRIORITY: Record<string, number> = {
  credit_base: SCHEDULING_PRIORITY.free,
  token_base: SCHEDULING_PRIORITY.free,
  operator: SCHEDULING_PRIORITY.operator,
  fleet: SCHEDULING_PRIORITY.fleet,
  command: SCHEDULING_PRIORITY.command,
};

export function priorityForResourceTier(tier: string | null | undefined): number {
  return RESOURCE_TIER_PRIORITY[tier ?? ""] ?? SCHEDULING_PRIORITY.free;
}
