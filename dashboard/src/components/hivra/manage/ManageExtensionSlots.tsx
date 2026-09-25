"use client";

import type { HivraAgent } from "@/lib/hivra/agent-api";

// Named places in Manage that other work fills in. Each renders nothing until
// that work lands, so no section shows a control the server can't back yet.

/**
 * Manage › Agents: the agents working on this computer, and adding one.
 * The section is listed only when agent.manage.attachAgents is true, which no
 * computer reports until the attach work sets it (manage-capabilities.ts,
 * ManageCapabilitiesContext.attachAgents). That work renders
 * <ComputerAgentsPanel computerId={agent.id} computerName={agent.name}
 * autoOpenAdd={autoOpenAdd} /> here; ?addAgent=1 already opens this section.
 */
export function ComputerAgentsSlot(props: { agent: HivraAgent; autoOpenAdd: boolean }) {
  void props;
  return null;
}
