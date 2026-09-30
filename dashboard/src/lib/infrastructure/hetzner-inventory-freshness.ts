import type { HetznerCloudServerInventoryDto } from "./contracts";
import type { ProviderComputerSetupView } from "./provider-computer-setup-contracts";

/** Setup stages Hivra reaches only after Hetzner confirmed the server was powered on. */
const POWERED_ON_STAGES: ReadonlySet<ProviderComputerSetupView["stage"]> = new Set([
  "waiting_for_identity",
  "identity_enrolled",
  "waiting_for_provider",
  "environment_prepared",
]);

/**
 * Servers whose saved inventory power state is older than what Hivra's own
 * setup records know. The inventory is Hetzner's answer at the last sync, and
 * Start setup powers the server on after that sync, so a server that set up
 * fine could otherwise sit on the card as "Off" beside "Ready for agents"
 * until the owner pressed Sync servers. Each returned key names one
 * (server, setup step) pair, so the caller syncs once per step and a server
 * that really is off again stays shown as Off.
 */
export function staleHetznerPowerKeys(
  inventory: readonly HetznerCloudServerInventoryDto[],
  setups: readonly ProviderComputerSetupView[],
): string[] {
  const keys: string[] = [];
  for (const setup of setups) {
    if (!setup.providerServerId || !POWERED_ON_STAGES.has(setup.stage)) continue;
    const server = inventory.find((candidate) => candidate.providerResourceId === setup.providerServerId);
    if (!server || server.status === "running") continue;
    keys.push(`${setup.orderId}:${setup.stage}:${setup.observedAt ?? ""}`);
  }
  return keys;
}
