"use client";

import type { HivraAgent } from "@/lib/hivra/agent-api";

// Named places in Manage that other work fills in. Each renders nothing until
// that work lands, so no section shows a control the server can't back yet.

/**
 * Manage › Updates: the agent software (Claude Code or Codex) version, its
 * update state and automatic updates. agent.manage.agentCli names the agent
 * software and the version Hivra has tested. The #agent-software anchor opens
 * the Updates section.
 */
export function AgentSoftwareSlot(props: { agent: HivraAgent }) {
  void props;
  return null;
}

/** Header chips such as "Update available", which link to the Updates section. */
export function ManageHeaderChipsSlot(props: { agent: HivraAgent; onOpenUpdates: () => void }) {
  void props;
  return null;
}
