import type { HivraAgent } from "@/lib/hivra/agent-api";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";
import { agentPageSurfacesFor } from "@/lib/agent-computers/agent-surfaces";

/** A running agent row with the Manage capability map the server would send with it. */
export function agentRow(type: string, extra: Partial<HivraAgent> = {}): HivraAgent {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    name: `${type} 1`,
    type,
    status: "running",
    cpu: 2,
    ram: 4,
    deployment_mode: "hivra-managed",
    computer_substrate: "proxmox-kvm",
    chat_url: "https://box.example.test",
    ...extra,
  } as HivraAgent;
  return {
    ...row,
    manage: manageCapabilitiesFor(
      { ...row, infrastructure_binding_token_enforced: true, desired_state: "running" } as Parameters<typeof manageCapabilitiesFor>[0],
      { preparedMatch: true },
    ),
  };
}

export function tabsFor(agent: HivraAgent): string[] {
  return agentPageSurfacesFor(agent);
}
