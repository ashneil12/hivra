import type { HetznerCloudServerInventoryDto } from "../contracts";
import type { ProviderComputerSetupView } from "../provider-computer-setup-contracts";
import { staleHetznerPowerKeys } from "../hetzner-inventory-freshness";

const server = (status: HetznerCloudServerInventoryDto["status"]) => ({
  providerResourceId: "4815162343", status,
}) as HetznerCloudServerInventoryDto;
const setup = (stage: ProviderComputerSetupView["stage"], providerServerId: string | null = "4815162343") => ({
  orderId: "00000000-0000-4000-8000-000000001016", providerServerId, stage, observedAt: "2026-08-26T15:30:00.000Z",
}) as ProviderComputerSetupView;

describe("staleHetznerPowerKeys", () => {
  it("flags a server Hivra saw powered on that the saved inventory still calls off", () => {
    for (const stage of ["waiting_for_identity", "identity_enrolled", "waiting_for_provider", "environment_prepared"] as const) {
      expect(staleHetznerPowerKeys([server("off")], [setup(stage)])).toHaveLength(1);
    }
    expect(staleHetznerPowerKeys([server("starting")], [setup("environment_prepared")])).toHaveLength(1);
  });

  it("leaves running servers, servers not yet powered on, and unmatched setups alone", () => {
    expect(staleHetznerPowerKeys([server("running")], [setup("environment_prepared")])).toEqual([]);
    for (const stage of ["awaiting_setup", "power_requested", "waiting_for_power", "stopped", "expired", "retired"] as const) {
      expect(staleHetznerPowerKeys([server("off")], [setup(stage)])).toEqual([]);
    }
    expect(staleHetznerPowerKeys([server("off")], [setup("environment_prepared", null)])).toEqual([]);
    expect(staleHetznerPowerKeys([], [setup("environment_prepared")])).toEqual([]);
  });

  it("names each setup step once, so a later step syncs again but the same step doesn't", () => {
    const [prepared] = staleHetznerPowerKeys([server("off")], [setup("environment_prepared")]);
    const [enrolled] = staleHetznerPowerKeys([server("off")], [setup("identity_enrolled")]);
    expect(prepared).not.toEqual(enrolled);
    expect(staleHetznerPowerKeys([server("off")], [setup("environment_prepared")])).toEqual([prepared]);
  });
});
