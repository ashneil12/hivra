import {
  buildTailscaleConfigPatch,
  getPublicTailscaleConfig,
  sanitizeTailscaleConfig,
  type TailscaleConfig,
} from "@/lib/private-access/tailscale";
import { buildTailscaleSetCommand } from "@/lib/services/tailscale-private-access";

describe("tailscale private access helpers", () => {
  it("strips raw auth keys when sanitizing tailscale config", () => {
    const sanitized = sanitizeTailscaleConfig({
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: "atlas-agent",
      authKey: "tskey-auth-123",
      magicDnsName: "atlas-agent.customer.ts.net",
    } as TailscaleConfig & { authKey: string });

    expect(sanitized).toEqual({
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: "atlas-agent",
      magicDnsName: "atlas-agent.customer.ts.net",
    });
  });

  it("merges tailscale metadata into the private access config branch", () => {
    const nextConfig = buildTailscaleConfigPatch(
      {
        model: "gpt-5.4",
        privateAccess: {
          tailscale: {
            enabled: true,
            hostScoped: true,
            state: "error",
            lastError: "Old error",
          },
        },
      },
      {
        enabled: true,
        hostScoped: true,
        state: "connected",
        machineName: "atlas-agent",
      }
    );

    expect(nextConfig).toEqual({
      model: "gpt-5.4",
      privateAccess: {
        tailscale: {
          enabled: true,
          hostScoped: true,
          state: "connected",
          lastError: "Old error",
          machineName: "atlas-agent",
        },
      },
    });
  });

  it("returns undefined for missing public tailscale config", () => {
    expect(getPublicTailscaleConfig(undefined)).toBeUndefined();
  });

  it("never exposes secret-like fields from the public tailscale config", () => {
    const publicConfig = getPublicTailscaleConfig({
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: "atlas-agent",
      magicDnsName: "atlas-agent.customer.ts.net",
      lastError: null,
      authKey: "tskey-auth-123",
    } as TailscaleConfig & { authKey: string });

    expect(publicConfig).toEqual({
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: "atlas-agent",
      magicDnsName: "atlas-agent.customer.ts.net",
      lastError: null,
    });
    expect(publicConfig).not.toHaveProperty("authKey");
  });

  it("builds a persistent tailscale set command for connected hosts", () => {
    expect(
      buildTailscaleSetCommand({
        machineName: "atlas-agent-updated",
        enableSsh: false,
      })
    ).toBe("tailscale set --hostname='atlas-agent-updated' --ssh=false");
  });

  it("only includes explicitly changed tailscale settings", () => {
    expect(
      buildTailscaleSetCommand({
        enableSsh: true,
      })
    ).toBe("tailscale set --ssh");
  });
});
