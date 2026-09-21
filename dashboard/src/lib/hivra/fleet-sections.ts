import type { UnifiedAgent } from "./unified-agent";

/**
 * Grouping for any surface that lists the whole fleet.
 *
 * The dashboard has two such surfaces — the switcher menu and the Chat control
 * pane — and they must agree about what the fleet contains, or one will offer a
 * resource the other hides. This is the shared half: the split, the ordering,
 * the text search, and the duplicate-name disambiguator.
 *
 * Presentation stays with each caller; only the facts live here.
 */

export interface FleetSection {
  key: "agent" | "computer";
  label: string;
  items: UnifiedAgent[];
}

/** Matches the switcher's behaviour: name, type, or vendor, case-insensitive. */
export function matchesFleetQuery(agent: UnifiedAgent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    agent.name.toLowerCase().includes(needle) ||
    agent.typeLabel.toLowerCase().includes(needle) ||
    agent.vendor.toLowerCase().includes(needle)
  );
}

/**
 * Agents and computers in two labelled groups, each preserving the incoming
 * order (which `unifyAll` already sorts running-first, then by name).
 *
 * Empty groups are dropped, so a fleet of only computers renders no empty
 * "Agents" heading.
 */
export function fleetSections(
  agents: readonly UnifiedAgent[],
  query = "",
): FleetSection[] {
  const matching = agents.filter((agent) => matchesFleetQuery(agent, query));
  const sections: FleetSection[] = [
    {
      key: "agent",
      label: "Agents",
      items: matching.filter((agent) => agent.resourceKind !== "computer"),
    },
    {
      key: "computer",
      label: "Computers",
      items: matching.filter((agent) => agent.resourceKind === "computer"),
    },
  ];
  return sections.filter((section) => section.items.length > 0);
}

/**
 * Names that appear more than once in the fleet, so a list can show a short id
 * suffix. Two boxes genuinely called "MY_UBUNTU_DESKTOP" are otherwise
 * indistinguishable in a picker.
 */
export function duplicateFleetNames(
  agents: readonly UnifiedAgent[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );
}

/**
 * Where a fleet entry lives. A Hermes instance is a different route from a
 * Hivra agent, and a desktop computer lands on its desktop rather than a
 * conversation — so the destination is derived, never guessed at the call site.
 */
export function fleetEntryHref(agent: UnifiedAgent): string {
  if (agent.kind === "hermes") {
    return `/dashboard/instances/${encodeURIComponent(agent.id)}`;
  }
  const tab = agent.resourceKind === "computer" ? "desktop" : "chat";
  return `/dashboard/agent/${encodeURIComponent(agent.id)}?tab=${tab}`;
}
