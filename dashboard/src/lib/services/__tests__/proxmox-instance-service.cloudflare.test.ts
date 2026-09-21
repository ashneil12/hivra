/**
 * Regression tests for the Cloudflare DNS integration in
 * provisionProxmoxInstance. The Proxmox path differs from Hetzner in two
 * important ways the tests below pin:
 *
 *  1. The Proxmox host's public IP is known up front (it's the gateway
 *     IP, not a per-VM IP), so the mint can complete BEFORE the host
 *     script runs. Mint failure should fall back to sslip rather than
 *     refusing to provision — Proxmox VMs are always reachable via the
 *     host's wildcard sslip whether or not Cloudflare cooperated.
 *  2. Script failure AFTER a successful mint must trigger a DNS rollback
 *     so the next provision attempt starts from a clean slate (no
 *     orphan A record pointing at a host where the VM no longer exists).
 */

import { provisionProxmoxInstance } from "../proxmox-instance-service";
import {
  getCloudflareDnsConfig,
  mintInstanceDns,
  removeInstanceDnsBestEffort,
} from "../cloudflare-dns";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

jest.mock("../cloudflare-dns", () => ({
  getCloudflareDnsConfig: jest.fn(),
  mintInstanceDns: jest.fn(),
  // Provisioning rollback paths call the helper directly. removeInstanceDns
  // is still exported but no longer reached from this service.
  removeInstanceDnsBestEffort: jest.fn().mockResolvedValue(undefined),
}));

const HOSTED_ZONE = "hermesos.cloud";
const TEST_PUBLIC_IP = "203.0.113.10";
const TEST_SUBDOMAIN = "abc123";

function buildBaseParams() {
  return {
    userId: "user_123",
    instanceId: "inst_test_123",
    tier: "operator",
    cpuLimit: 2,
    ramLimit: 2048,
    name: "Proxmox Smoke",
    provider: "openai",
    apiKey: "provider-key",
    model: "gpt-5.4-mini",
    subdomain: TEST_SUBDOMAIN,
    agentSettings: {
      maxIterations: 60,
      toolProgressMode: "all" as const,
      compressionThreshold: 0.85,
      sessionResetMode: "both" as const,
      enableRootAccess: true,
    },
  };
}

const baseEnv = {
  PROXMOX_SSH_HOST: TEST_PUBLIC_IP,
  PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
  PROXMOX_PUBLIC_IP: TEST_PUBLIC_IP,
  PROXMOX_TEMPLATE_ID: "9000",
};

const successfulProvisionStdout = (gatewayHost: string): string =>
  `ok\nHERMES_PROXMOX_RESULT {"vmid":201,"privateIpv4":"10.250.20.51","gatewayHost":"${gatewayHost}"}`;

describe("provisionProxmoxInstance — Cloudflare DNS regressions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Module-mock defaults: anything calling these without explicit
    // overrides gets a no-op resolved Promise so `.catch()` chains in
    // the production code don't trip on a sync `undefined`.
    (mintInstanceDns as jest.Mock).mockResolvedValue({
      ok: true,
      fqdn: `${TEST_SUBDOMAIN}.${HOSTED_ZONE}`,
    });
    (removeInstanceDnsBestEffort as jest.Mock).mockResolvedValue(undefined);
  });

  it("falls back to sslip when Cloudflare mint fails — Proxmox provision still succeeds", async () => {
    // The Proxmox host wildcard already resolves any sslip URL (the IP
    // is encoded in the hostname), so a Cloudflare API hiccup should
    // NOT block provisioning. Hetzner takes the opposite stance because
    // it has no fallback resolver — Proxmox does.
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue({
      apiToken: "tok",
      zoneId: "zone",
      domain: HOSTED_ZONE,
    });
    (mintInstanceDns as jest.Mock).mockResolvedValue({
      ok: false,
      error: "dns_propagation_timeout",
    });

    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let capturedScript = "";

    const result = await provisionProxmoxInstance(buildBaseParams(), {
      env: baseEnv,
      buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
      runHostScript: async (script) => {
        capturedScript = script;
        return {
          ok: true,
          stdout: successfulProvisionStdout(`${TEST_SUBDOMAIN}.203-0-113-10.sslip.io`),
          stderr: "",
        };
      },
    });

    expect(mintInstanceDns).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      gatewayUrl: `https://${TEST_SUBDOMAIN}.203-0-113-10.sslip.io`,
    });
    // Belt-and-braces: the host script's GATEWAY_HOST shell variable
    // must be the sslip FQDN — that's what Caddy keys its vhost on. We
    // can't assert the zone string never appears anywhere in the script
    // because comments/docs reference `<instance>.agents.hermesos.cloud`
    // as an example.
    expect(capturedScript).toContain(`GATEWAY_HOST='${TEST_SUBDOMAIN}.203-0-113-10.sslip.io'`);
    expect(capturedScript).not.toContain(`GATEWAY_HOST='${TEST_SUBDOMAIN}.${HOSTED_ZONE}'`);
    // No record was successfully minted, so removeInstanceDns should not
    // be called — its job is to drop records WE created, not records
    // that never existed.
    expect(removeInstanceDnsBestEffort).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("rejects a legacy nested Hermes DNS zone before minting a record", async () => {
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue({
      apiToken: "tok",
      zoneId: "zone",
      domain: "agents.hermesos.cloud",
      proxied: true,
    });

    const result = await provisionProxmoxInstance(buildBaseParams(), {
      env: baseEnv,
      buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
      runHostScript: async () => {
        throw new Error("host script must not run");
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("not covered by the static Origin CA certificate"),
    });
    expect(mintInstanceDns).not.toHaveBeenCalled();
  });

  it("uses the hermesos.cloud gatewayUrl when Cloudflare mint succeeds", async () => {
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue({
      apiToken: "tok",
      zoneId: "zone",
      domain: HOSTED_ZONE,
    });
    (mintInstanceDns as jest.Mock).mockResolvedValue({
      ok: true,
      fqdn: `${TEST_SUBDOMAIN}.${HOSTED_ZONE}`,
      recordId: "rec_xyz",
    });

    const result = await provisionProxmoxInstance(buildBaseParams(), {
      env: baseEnv,
      buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
      runHostScript: async (script) => {
        // The host script must reference the hermesos.cloud FQDN so
        // Caddy serves the correct vhost name.
        expect(script).toContain(`${TEST_SUBDOMAIN}.${HOSTED_ZONE}`);
        return {
          ok: true,
          stdout: successfulProvisionStdout(`${TEST_SUBDOMAIN}.${HOSTED_ZONE}`),
          stderr: "",
        };
      },
    });

    expect(mintInstanceDns).toHaveBeenCalledWith(
      expect.objectContaining({ subdomain: TEST_SUBDOMAIN, ip: TEST_PUBLIC_IP, proxied: false }),
      expect.objectContaining({ domain: HOSTED_ZONE }),
    );
    expect(result).toMatchObject({
      ok: true,
      gatewayUrl: `https://${TEST_SUBDOMAIN}.${HOSTED_ZONE}`,
    });
    expect(removeInstanceDnsBestEffort).not.toHaveBeenCalled();
  });

  it("uses a target-specific gateway domain instead of Cloudflare when the domain is outside the Cloudflare zone", async () => {
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue({
      apiToken: "tok",
      zoneId: "zone",
      domain: HOSTED_ZONE,
    });

    const fixtureNode2Env = {
      ...baseEnv,
      PROXMOX_GATEWAY_DOMAIN: "198-51-100-134.sslip.io",
    };

    const result = await provisionProxmoxInstance(buildBaseParams(), {
      env: fixtureNode2Env,
      buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
      runHostScript: async (script) => {
        expect(script).toContain(`${TEST_SUBDOMAIN}.198-51-100-134.sslip.io`);
        expect(script).not.toContain(`${TEST_SUBDOMAIN}.${HOSTED_ZONE}`);
        return {
          ok: true,
          stdout: successfulProvisionStdout(`${TEST_SUBDOMAIN}.198-51-100-134.sslip.io`),
          stderr: "",
        };
      },
    });

    expect(mintInstanceDns).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      gatewayUrl: `https://${TEST_SUBDOMAIN}.198-51-100-134.sslip.io`,
    });
  });

  it("uses proxied Cloudflare DNS instead of the target sslip domain when enabled", async () => {
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue({
      apiToken: "tok",
      zoneId: "zone",
      domain: HOSTED_ZONE,
      proxied: true,
    });
    (mintInstanceDns as jest.Mock).mockResolvedValue({
      ok: true,
      fqdn: `${TEST_SUBDOMAIN}.${HOSTED_ZONE}`,
      recordId: "rec_proxy",
    });

    const fixtureNode2Env = {
      ...baseEnv,
      PROXMOX_GATEWAY_DOMAIN: "198-51-100-134.sslip.io",
    };

    const result = await provisionProxmoxInstance(buildBaseParams(), {
      env: fixtureNode2Env,
      buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
      runHostScript: async (script) => {
        expect(script).toContain(`${TEST_SUBDOMAIN}.${HOSTED_ZONE}`);
        expect(script).toContain(`GATEWAY_SITE_LABEL='${TEST_SUBDOMAIN}.${HOSTED_ZONE}'`);
        expect(script).not.toContain(`GATEWAY_SITE_LABEL='http://${TEST_SUBDOMAIN}.${HOSTED_ZONE}'`);
        expect(script).toContain("${GATEWAY_SITE_LABEL} {");
        expect(script).not.toContain(`${TEST_SUBDOMAIN}.198-51-100-134.sslip.io`);
        return {
          ok: true,
          stdout: successfulProvisionStdout(`${TEST_SUBDOMAIN}.${HOSTED_ZONE}`),
          stderr: "",
        };
      },
    });

    expect(mintInstanceDns).toHaveBeenCalledWith(
      expect.objectContaining({ subdomain: TEST_SUBDOMAIN, ip: TEST_PUBLIC_IP, proxied: true }),
      expect.objectContaining({ domain: HOSTED_ZONE, proxied: true }),
    );
    expect(result).toMatchObject({
      ok: true,
      gatewayUrl: `https://${TEST_SUBDOMAIN}.${HOSTED_ZONE}`,
    });
  });

  it("rolls back the A record when the host script fails after a successful mint", async () => {
    // Without rollback, a failed provision would leave a stale A record
    // pointing at the host but no actual VM behind it — and the next
    // provision attempt for the same subdomain would 81053-collide with
    // the stale record (or, worse, silently inherit it pointing at the
    // wrong host on a multi-host fleet).
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue({
      apiToken: "tok",
      zoneId: "zone",
      domain: HOSTED_ZONE,
    });
    (mintInstanceDns as jest.Mock).mockResolvedValue({
      ok: true,
      fqdn: `${TEST_SUBDOMAIN}.${HOSTED_ZONE}`,
      recordId: "rec_xyz",
    });

    const result = await provisionProxmoxInstance(buildBaseParams(), {
      env: baseEnv,
      buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
      runHostScript: async () => ({
        ok: false,
        stdout: "",
        stderr: "qm clone: VMID 201 already exists",
        error: "exit 1",
      }),
    });

    expect(result.ok).toBe(false);
    // After mint succeeds and the host script fails, the rollback path
    // funnels through removeInstanceDnsBestEffort with the service's
    // structured context (source, instanceId, userId). The cfConfig
    // optimization the old path passed as a 2nd arg is dropped — the
    // helper re-reads env, which is cheap.
    expect(removeInstanceDnsBestEffort).toHaveBeenCalledWith(
      TEST_SUBDOMAIN,
      expect.objectContaining({
        source: "proxmox-instance-service",
        instanceId: "inst_test_123",
        userId: "user_123",
      }),
      { dnsDomain: HOSTED_ZONE },
    );
  });

  it("does not call Cloudflare when not configured — sslip remains the safe default", async () => {
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue(null);
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await provisionProxmoxInstance(buildBaseParams(), {
      env: baseEnv,
      buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
      runHostScript: async () => ({
        ok: true,
        stdout: successfulProvisionStdout(`${TEST_SUBDOMAIN}.203-0-113-10.sslip.io`),
        stderr: "",
      }),
    });

    expect(mintInstanceDns).not.toHaveBeenCalled();
    expect(removeInstanceDnsBestEffort).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      gatewayUrl: `https://${TEST_SUBDOMAIN}.203-0-113-10.sslip.io`,
    });

    consoleErrorSpy.mockRestore();
  });
});
