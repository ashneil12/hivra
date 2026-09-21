import { isManagedVeniceInstance } from "@/components/billing/ManagedVeniceByokSwitchPanel";

describe("isManagedVeniceInstance", () => {
  it("matches the real fleet state: managed-proxy customLlmBaseUrl, no config.managedVenice marker", () => {
    expect(
      isManagedVeniceInstance({
        config: {
          agentSettings: { customLlmBaseUrl: "https://hivra.cloud/api/managed-venice/v1" },
        },
      })
    ).toBe(true);
  });

  it("still matches the legacy config.managedVenice marker", () => {
    expect(isManagedVeniceInstance({ config: { managedVenice: { enabled: true } } })).toBe(true);
  });

  it("does not match a BYO / non-managed box", () => {
    expect(
      isManagedVeniceInstance({
        config: { agentSettings: { customLlmBaseUrl: "https://api.anthropic.com" }, model: "claude-sonnet-4-6" },
      })
    ).toBe(false);
    expect(isManagedVeniceInstance({ config: {} })).toBe(false);
    expect(isManagedVeniceInstance({})).toBe(false);
  });
});
