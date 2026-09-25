import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildAgentContainerCgroupScript,
  buildProxmoxCaddySiteCleanupScript,
  buildProxmoxDeleteScript,
  buildProxmoxDormantArchiveScript,
  buildProxmoxGuestBootstrapScript,
  buildProxmoxInfrastructureDiscoveryScript,
  buildProxmoxMetricsScript,
  buildProxmoxPowerScript,
  buildProxmoxProvisionScript,
  buildProxmoxResizeScript,
  buildProxmoxStatusScript,
  buildProxmoxTemplateAuditScript,
  buildProxmoxTemplatePruneScript,
  buildProxmoxTenantIsolationGuard,
  discoverProxmoxInfrastructureForInstance,
  getProxmoxInfrastructure,
  getProxmoxInstanceStatus,
  getProxmoxInstanceStatusBatch,
  getProxmoxTemplateAvailability,
  getProxmoxVmidAvailability,
  getReservedProxmoxVmidsForNode,
  isProxmoxProvisioningConfigured,
  isProxmoxVmMissingResult,
  isProxmoxVmStillRunningResult,
  PROXMOX_VM_MISSING_MARKER,
  PROXMOX_VM_STILL_RUNNING_MARKER,
  parseProxmoxMetricsOutput,
  parseProxmoxTemplateAuditOutput,
  parseProxmoxProvisionOutput,
  provisionProxmoxInstance,
  rebootProxmoxInstance,
  resizeProxmoxInstance,
  resizeProxmoxVm,
  resolveProxmoxTargetCandidateIds,
  resolveProxmoxTargetConfiguration,
  resolveProxmoxGatewayConfiguration,
  resolveProxmoxGatewayUrlFromSubdomain,
  resolveProxmoxHostEnv,
  resolveProxmoxMaxTenantInstances,
  resolveProxmoxVmDiskGb,
  resolveProxmoxVmidEnd,
  resolveProxmoxBalloonFloorMb,
  runProxmoxHostScript,
  shouldForceWebUIProvisionImagePull,
  shutdownProxmoxInstance,
  startProxmoxInstance,
} from "@/lib/services/proxmox-instance-service";

const mockSupabaseFrom = jest.fn();

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const TEST_INSTANCE_ID = "00000000-0000-4000-8000-0000000c0201";

describe("proxmox-instance-service", () => {
  it("resolves a positive VM disk override and rejects invalid values", () => {
    expect(resolveProxmoxVmDiskGb({ PROXMOX_VM_DISK_GB: "800" })).toBe(800);
    expect(resolveProxmoxVmDiskGb({ PROXMOX_VM_DISK_GB: "0" })).toBe(30);
    expect(resolveProxmoxVmDiskGb({ PROXMOX_VM_DISK_GB: "invalid" })).toBe(30);
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabaseFrom.mockImplementation(() => {
    const query: Record<string, unknown> = {};
    query.select = jest.fn().mockReturnValue(query);
    query.eq = jest.fn().mockReturnValue(query);
    query.not = jest.fn().mockReturnValue(query);
    query.neq = jest.fn().mockReturnValue(query);
    query.then = (resolve: (value: { data: unknown[]; error: null }) => void) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return query;
  });
});

describe("tenant bridge isolation guard", () => {
  it("fails closed unless the active and persistent tap-to-tap drop boundary exists", () => {
    const script = buildProxmoxTenantIsolationGuard();

    expect(script).toContain("nft list chain bridge hermes_vm_isolation forward");
    expect(script).toContain("type[[:space:]]+filter[[:space:]]+hook[[:space:]]+forward");
    expect(script).toContain("unshare --net");
    expect(script).toContain('iifname "tap*" oifname "tap*" drop');
    expect(script).toContain('iifname "fwln*" oifname "fwln*" drop');
    expect(script).toContain('iifname "tap*" oifname "fwln*" drop');
    expect(script).toContain('iifname "fwln*" oifname "tap*" drop');
    expect(script).toContain("systemctl is-enabled --quiet nftables");
    expect(script).toContain("/etc/nftables.conf");
    expect(script).toContain("HERMES_TENANT_ISOLATION_READY");
  });
});

describe("WebUI provision image pull canary", () => {
  it("force-pulls fresh WebUI images on all Proxmox targets by default", () => {
    expect(shouldForceWebUIProvisionImagePull("fixturenode5", {})).toBe(true);
    expect(shouldForceWebUIProvisionImagePull("fixturenode1", {})).toBe(true);
    expect(shouldForceWebUIProvisionImagePull(null, {})).toBe(false);
  });

  it("lets operators override the canary target list explicitly", () => {
    expect(
      shouldForceWebUIProvisionImagePull("fixturenode2", {
        HERMES_WEBUI_PROVISION_FORCE_PULL_TARGETS: "fixturenode2,fixturenode6",
      })
    ).toBe(true);
    expect(
      shouldForceWebUIProvisionImagePull("fixturenode5", {
        HERMES_WEBUI_PROVISION_FORCE_PULL_TARGETS: "fixturenode2,fixturenode6",
      })
    ).toBe(false);
    expect(
      shouldForceWebUIProvisionImagePull("fixturenode1", {
        HERMES_WEBUI_PROVISION_FORCE_PULL_TARGETS: "*",
      })
    ).toBe(true);
    expect(
      shouldForceWebUIProvisionImagePull("fixturenode5", {
        HERMES_WEBUI_PROVISION_FORCE_PULL_TARGETS: "off",
      })
    ).toBe(false);
  });
});

describe("proxmox host-aware env routing", () => {
  it("overlays host slug-prefixed Proxmox env values onto canonical keys", () => {
    const env = resolveProxmoxHostEnv(
      { hostSlug: "fixturenode2", failClosed: true },
      {
        PROXMOX_NODE: "fixturenode1-global",
        PROXMOX_HOST_FIXTURENODE2_NODE: "fixturenode2-node",
        PROXMOX_HOST_FIXTURENODE2_API_URL: "https://fixturenode2.example.invalid:8006/api2/json",
      }
    );

    expect(env.PROXMOX_NODE).toBe("fixturenode2-node");
    expect(env.PROXMOX_API_URL).toBe("https://fixturenode2.example.invalid:8006/api2/json");
    expect(env.PROXMOX_HOST_SLUG).toBe("fixturenode2");
  });

  it("uses persisted host_id-prefixed env values when no slug is stored", () => {
    const env = resolveProxmoxHostEnv(
      { hostId: "host-123", failClosed: true },
      {
        PROXMOX_NODE: "fixturenode1-global",
        PROXMOX_HOST_ID_HOST_123_NODE: "fixturenode2-by-id",
      }
    );

    expect(env.PROXMOX_NODE).toBe("fixturenode2-by-id");
  });

  it("pins legacy rows to the explicit FixtureNode1 prefix before ambient global Proxmox env", () => {
    const env = resolveProxmoxHostEnv(null, {
      PROXMOX_NODE: "fixturenode2-global",
      PROXMOX_HOST_FIXTURENODE1_NODE: "fixturenode1-pinned",
    });

    expect(env.PROXMOX_NODE).toBe("fixturenode1-pinned");
    expect(env.PROXMOX_HOST_SLUG).toBe("fixturenode1");
  });

  it("fails closed for an explicit host config with no matching host env", () => {
    expect(() =>
      resolveProxmoxHostEnv(
        { hostSlug: "fixturenode2", failClosed: true },
        { PROXMOX_NODE: "fixturenode1-global" }
      )
    ).toThrow(/no matching environment overrides/);
  });

  it("fails closed instead of mixing partial host-prefixed env with ambient global Proxmox keys", () => {
    expect(() =>
      resolveProxmoxHostEnv(
        { hostSlug: "fixturenode2", failClosed: true },
        {
          PROXMOX_NODE: "fixturenode1-node",
          PROXMOX_PUBLIC_IP: "192.0.2.10",
          PROXMOX_SSH_HOST: "fixturenode1.example.invalid",
          PROXMOX_SSH_KEY_PATH: "/secrets/fixturenode1-key",
          PROXMOX_HOST_FIXTURENODE2_NODE: "fixturenode2-node",
        }
      )
    ).toThrow(/refusing to inherit ambient Proxmox env/);
  });

  it("skips the legacy-slug overlay when env is already resolved against a per-target identity", () => {
    // Regression: an env produced by resolveProxmoxTargetConfiguration (e.g. a
    // placement candidate for fixturenodea) has HERMES_PROXMOX_TARGET_ENV_RESOLVED=true
    // and canonical PROXMOX_PUBLIC_IP/SSH_HOST/API_URL already populated from
    // PROXMOX_FIXTURENODE6_*. If resolveProxmoxHostEnv(null, env) then runs and falls
    // into the legacy-slug branch (default "fixturenodea"), it would overlay
    // PROXMOX_FIXTURENODE1_PUBLIC_IP onto PROXMOX_PUBLIC_IP — clobbering fixturenodea's IP
    // with fixturenodea's and routing the downstream SSH call to the wrong host.
    // Diagnosed 2026-05-16 from prod 503s: template availability checks for
    // fixturenodea candidates returned "nodes/fixturenodea/qemu-server/9006.conf does not
    // exist" because the actual SSH target was fixturenodea.
    const env = resolveProxmoxHostEnv(null, {
      HERMES_PROXMOX_TARGET_ENV_RESOLVED: "true",
      PROXMOX_NODE: "fixturenode6",
      PROXMOX_PUBLIC_IP: "198.51.100.151",
      PROXMOX_SSH_HOST: "198.51.100.151",
      // The ambient PROXMOX_FIXTURENODE1_* values are still in env (they always are
      // — Vercel keeps per-host vars side-by-side), but they MUST NOT be
      // overlaid onto the canonical keys.
      PROXMOX_FIXTURENODE1_PUBLIC_IP: "203.0.113.10",
      PROXMOX_FIXTURENODE1_SSH_HOST: "203.0.113.10",
    });

    expect(env.PROXMOX_NODE).toBe("fixturenode6");
    expect(env.PROXMOX_PUBLIC_IP).toBe("198.51.100.151");
    expect(env.PROXMOX_SSH_HOST).toBe("198.51.100.151");
  });
});

  it("uses a public gateway hostname while keeping the guest deploy in local HTTP mode", () => {
    const gateway = resolveProxmoxGatewayConfiguration({
      subdomain: "agent-123",
      publicIp: "203.0.113.10",
      dnsDomain: "",
    });

    expect(gateway).toEqual({
      deployFqdn: "localhost",
      fqdn: "agent-123.203-0-113-10.sslip.io",
      gatewayUrl: "https://agent-123.203-0-113-10.sslip.io",
    });
  });

  it("prefers the configured gateway domain when one is available", () => {
    const gateway = resolveProxmoxGatewayConfiguration({
      subdomain: "agent-123",
      publicIp: "203.0.113.10",
      dnsDomain: "agents.hermesos.cloud",
    });

    expect(gateway.gatewayUrl).toBe("https://agent-123.agents.hermesos.cloud");
    expect(gateway.deployFqdn).toBe("localhost");
  });

describe("resolveProxmoxGatewayUrlFromSubdomain (recovery gateway_url)", () => {
  it("derives the canonical gateway_url from subdomain + the host's gateway domain, NEVER the bridge IP", () => {
    // 2026-06-30 incident shape: the host's private/bridge gateway is
    // 10.250.20.1 (PROXMOX_FIXTURENODE11_PRIVATE_GATEWAY). The recovery writer must
    // ignore that entirely and build <subdomain>.<PROXMOX_GATEWAY_DOMAIN>.
    const url = resolveProxmoxGatewayUrlFromSubdomain({
      subdomain: "00000000000000000000",
      hostConfig: { hostSlug: "fixturenode11", failClosed: true },
      env: {
        PROXMOX_FIXTURENODE11_PUBLIC_IP: "203.0.113.10",
        PROXMOX_FIXTURENODE11_GATEWAY_DOMAIN: "agents.hermesos.cloud",
        PROXMOX_FIXTURENODE11_PRIVATE_GATEWAY: "10.250.20.1",
      },
    });

    expect(url).toBe("https://00000000000000000000.agents.hermesos.cloud");
    expect(url).not.toContain("10.250.20.1");
  });

  it("prefers the Cloudflare zone domain over the per-host sslip PROXMOX_GATEWAY_DOMAIN (prod shape)", () => {
    // Prod reality: the box was provisioned behind Cloudflare and serves on
    // <subdomain>.hermesos.cloud, while PROXMOX_PVEn_GATEWAY_DOMAIN is the
    // <dashedIP>.sslip.io ACME fallback. Recovery must reproduce the Cloudflare
    // FQDN the box actually answers on — deriving the sslip host would leave the
    // box false-unhealthy (its Caddy vhost doesn't serve sslip). Mirrors
    // provisionProxmoxInstance's useCloudflareDns precedence.
    const url = resolveProxmoxGatewayUrlFromSubdomain({
      subdomain: "00000000000000000000",
      hostConfig: { hostSlug: "fixturenode11", failClosed: true },
      env: {
        PROXMOX_FIXTURENODE11_PUBLIC_IP: "203.0.113.10",
        PROXMOX_FIXTURENODE11_GATEWAY_DOMAIN: "203-0-113-10.sslip.io",
        PROXMOX_FIXTURENODE11_PRIVATE_GATEWAY: "10.250.20.1",
        CLOUDFLARE_API_TOKEN: "cf-token",
        CLOUDFLARE_ZONE_ID: "zone-123",
        CLOUDFLARE_DNS_DOMAIN: "hermesos.cloud",
        CLOUDFLARE_DNS_PROXIED: "true",
      },
    });

    expect(url).toBe("https://00000000000000000000.hermesos.cloud");
    expect(url).not.toContain("sslip.io");
    expect(url).not.toContain("10.250.20.1");
  });

  it("falls back to the host's sslip domain when no gateway domain is configured", () => {
    const url = resolveProxmoxGatewayUrlFromSubdomain({
      subdomain: "agent-xyz",
      hostConfig: { hostSlug: "fixturenode11", failClosed: true },
      env: {
        PROXMOX_FIXTURENODE11_PUBLIC_IP: "203.0.113.10",
        PROXMOX_FIXTURENODE11_PRIVATE_GATEWAY: "10.250.20.1",
      },
    });

    expect(url).toBe("https://agent-xyz.203-0-113-10.sslip.io");
    expect(url).not.toContain("10.250.20.1");
  });

  it("returns null when the instance has no subdomain (nothing safe to derive)", () => {
    expect(
      resolveProxmoxGatewayUrlFromSubdomain({
        subdomain: null,
        hostConfig: { hostSlug: "fixturenode11", failClosed: true },
        env: {
          PROXMOX_FIXTURENODE11_PUBLIC_IP: "203.0.113.10",
          PROXMOX_FIXTURENODE11_GATEWAY_DOMAIN: "agents.hermesos.cloud",
        },
      }),
    ).toBeNull();
  });

  it("returns null (keeps caller's stored value) when the host env fails to resolve", () => {
    // failClosed host routing with no matching per-host overrides throws inside
    // resolveProxmoxHostEnv — the helper swallows it and returns null so the
    // caller never overwrites gateway_url with a guess.
    expect(
      resolveProxmoxGatewayUrlFromSubdomain({
        subdomain: "agent-x",
        hostConfig: { hostSlug: "fixturenode9", failClosed: true },
        env: { PROXMOX_NODE: "fixturenode1-global" },
      }),
    ).toBeNull();
  });

  it("returns null when the host has neither a gateway domain nor a public IP", () => {
    // Would otherwise build "<label>..sslip.io" (dashedIpv4("") throws). Bail
    // instead of persisting garbage.
    expect(
      resolveProxmoxGatewayUrlFromSubdomain({
        subdomain: "agent-x",
        hostConfig: { hostSlug: "fixturenode9", failClosed: true },
        env: { PROXMOX_FIXTURENODE9_SSH_HOST: "203.0.113.4" },
      }),
    ).toBeNull();
  });
});

  it("resolves a named FixtureLegacy Proxmox target by overlaying target-specific env onto the shared defaults", () => {
    const target = resolveProxmoxTargetConfiguration({
      HERMES_PROXMOX_TARGET: "fixturelegacy",
      PROXMOX_PUBLIC_IP: "203.0.113.10",
      PROXMOX_SSH_HOST: "203.0.113.10",
      PROXMOX_SSH_KEY_PATH: "/etc/hivra/keys/proxmox-admin",
      PROXMOX_TEMPLATE_ID: "9000",
      PROXMOX_GATEWAY_DOMAIN: "agents.hermesos.cloud",
      PROXMOX_FIXTURELEGACY_PUBLIC_IP: "203.0.113.10",
      PROXMOX_FIXTURELEGACY_SSH_HOST: "203.0.113.10",
      PROXMOX_FIXTURELEGACY_TEMPLATE_ID: "9003",
      PROXMOX_FIXTURELEGACY_VMID_START: "300",
      PROXMOX_FIXTURELEGACY_IP_LAST_OCTET_START: "80",
      PROXMOX_FIXTURELEGACY_PRIVATE_SUBNET_PREFIX: "10.250.30",
      PROXMOX_FIXTURELEGACY_PRIVATE_GATEWAY: "10.250.30.1",
    });

    expect(target.id).toBe("fixturelegacy");
    expect(target.env.PROXMOX_PUBLIC_IP).toBe("203.0.113.10");
    expect(target.env.PROXMOX_SSH_HOST).toBe("203.0.113.10");
    expect(target.env.PROXMOX_TEMPLATE_ID).toBe("9003");
    expect(target.env.PROXMOX_VMID_START).toBe("300");
    expect(target.env.PROXMOX_IP_LAST_OCTET_START).toBe("80");
    expect(target.env.PROXMOX_PRIVATE_SUBNET_PREFIX).toBe("10.250.30");
    expect(target.env.PROXMOX_PRIVATE_GATEWAY).toBe("10.250.30.1");
    expect(target.env.PROXMOX_GATEWAY_DOMAIN).toBe("agents.hermesos.cloud");
  });

  it("resolves named Proxmox targets from PROXMOX_HOST_<target> env prefixes", () => {
    const target = resolveProxmoxTargetConfiguration({
      HERMES_PROXMOX_TARGET: "fixturenode3",
      PROXMOX_PUBLIC_IP: "203.0.113.10",
      PROXMOX_SSH_HOST: "203.0.113.10",
      PROXMOX_SSH_PRIVATE_KEY_B64: "shared-key",
      PROXMOX_TEMPLATE_ID: "9004",
      PROXMOX_GATEWAY_DOMAIN: "agents.hermesos.cloud",
      PROXMOX_HOST_FIXTURENODE3_PUBLIC_IP: "198.51.100.52",
      PROXMOX_HOST_FIXTURENODE3_SSH_HOST: "198.51.100.52",
      PROXMOX_HOST_FIXTURENODE3_SSH_PRIVATE_KEY_B64: "fixturenode3-key",
      PROXMOX_HOST_FIXTURENODE3_TEMPLATE_ID: "9005",
      PROXMOX_HOST_FIXTURENODE3_VMID_START: "300",
      PROXMOX_HOST_FIXTURENODE3_IP_LAST_OCTET_START: "80",
      PROXMOX_HOST_FIXTURENODE3_PRIVATE_SUBNET_PREFIX: "10.250.30",
      PROXMOX_HOST_FIXTURENODE3_PRIVATE_GATEWAY: "10.250.30.1",
    });

    expect(target.id).toBe("fixturenode3");
    expect(target.env.PROXMOX_PUBLIC_IP).toBe("198.51.100.52");
    expect(target.env.PROXMOX_SSH_HOST).toBe("198.51.100.52");
    expect(target.env.PROXMOX_SSH_PRIVATE_KEY_B64).toBe("fixturenode3-key");
    expect(target.env.PROXMOX_TEMPLATE_ID).toBe("9005");
    expect(target.env.PROXMOX_VMID_START).toBe("300");
    expect(target.env.PROXMOX_IP_LAST_OCTET_START).toBe("80");
    expect(target.env.PROXMOX_PRIVATE_SUBNET_PREFIX).toBe("10.250.30");
    expect(target.env.PROXMOX_PRIVATE_GATEWAY).toBe("10.250.30.1");
    expect(target.env.PROXMOX_GATEWAY_DOMAIN).toBe("agents.hermesos.cloud");
  });

  it("keeps a resolved target pinned through template checks even when the global target points elsewhere", async () => {
    const target = resolveProxmoxTargetConfiguration(
      {
        HERMES_PROXMOX_TARGET: "fixturenode6",
        PROXMOX_TEMPLATE_ID: "9006",
        PROXMOX_HOST_FIXTURENODE1_PUBLIC_IP: "203.0.113.11",
        PROXMOX_HOST_FIXTURENODE1_SSH_HOST: "203.0.113.11",
        PROXMOX_HOST_FIXTURENODE1_ALLOW_SSH_AGENT: "true",
        PROXMOX_HOST_FIXTURENODE1_TEMPLATE_ID: "9001",
        PROXMOX_HOST_FIXTURENODE6_PUBLIC_IP: "203.0.113.16",
        PROXMOX_HOST_FIXTURENODE6_SSH_HOST: "203.0.113.16",
        PROXMOX_HOST_FIXTURENODE6_ALLOW_SSH_AGENT: "true",
        PROXMOX_HOST_FIXTURENODE6_TEMPLATE_ID: "9006",
      },
      "fixturenode1"
    );

    const result = await getProxmoxTemplateAvailability({
      env: target.env,
      runHostScript: async (script: string) => {
        expect(script).toContain("TEMPLATE_ID='9001'");
        return {
          ok: true,
          stdout: [
            "HERMES_PROXMOX_TEMPLATE_CHECK 9001",
            "HERMES_PROXMOX_TEMPLATE_READY 9001",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    expect(result).toEqual({
      ok: true,
      targetId: "fixturenode1",
      templateId: 9001,
    });
  });

  it("does not treat an explicit target as configured when it would inherit another host's SSH address", () => {
    const target = resolveProxmoxTargetConfiguration({
      HERMES_PROXMOX_TARGET: "fixturenode3",
      PROXMOX_NODE: "fixturenode1",
      PROXMOX_PUBLIC_IP: "203.0.113.10",
      PROXMOX_SSH_HOST: "203.0.113.10",
      PROXMOX_SSH_PRIVATE_KEY_B64: "shared-key",
      PROXMOX_TEMPLATE_ID: "9004",
    });

    expect(target.id).toBe("fixturenode3");
    expect(target.env.PROXMOX_NODE).toBe("fixturenode3");
    expect(target.env.PROXMOX_PUBLIC_IP).toBeUndefined();
    expect(target.env.PROXMOX_SSH_HOST).toBeUndefined();
    expect(target.env.HERMES_PROXMOX_TARGET_ENV_ERROR).toMatch(/fixturenode3/);
    expect(isProxmoxProvisioningConfigured(target.env)).toBe(false);
  });

  it("does not treat an explicit target as configured when it would inherit another host's SSH private key", () => {
    const target = resolveProxmoxTargetConfiguration({
      HERMES_PROXMOX_TARGET: "fixturenode2",
      PROXMOX_PUBLIC_IP: "203.0.113.10",
      PROXMOX_SSH_HOST: "203.0.113.10",
      PROXMOX_SSH_PRIVATE_KEY_B64: "ambient-fixturenode1-key",
      PROXMOX_FIXTURENODE2_PUBLIC_IP: "198.51.100.134",
      PROXMOX_FIXTURENODE2_SSH_HOST: "198.51.100.134",
      PROXMOX_FIXTURENODE2_TEMPLATE_ID: "9004",
      PROXMOX_FIXTURENODE2_VMID_START: "200",
      PROXMOX_FIXTURENODE2_PRIVATE_SUBNET_PREFIX: "10.250.21",
    });

    expect(target.id).toBe("fixturenode2");
    expect(target.env.PROXMOX_PUBLIC_IP).toBe("198.51.100.134");
    expect(target.env.PROXMOX_SSH_HOST).toBe("198.51.100.134");
    expect(target.env.PROXMOX_SSH_PRIVATE_KEY_B64).toBeUndefined();
    expect(target.env.HERMES_PROXMOX_TARGET_ENV_ERROR).toMatch(/PROXMOX_SSH_PRIVATE_KEY_B64/);
    expect(isProxmoxProvisioningConfigured(target.env)).toBe(false);
  });

  it("does not let a selected target inherit another host's pinned SSH fingerprint", () => {
    const target = resolveProxmoxTargetConfiguration({
      HERMES_PROXMOX_TARGET: "fixturenode2",
      PROXMOX_NODE: "fixturenode1",
      PROXMOX_SSH_HOST: "203.0.113.10",
      PROXMOX_SSH_PRIVATE_KEY_B64: "ambient-fixturenode1-key",
      PROXMOX_SSH_HOST_FINGERPRINT: "aa".repeat(32),
      PROXMOX_FIXTURENODE2_SSH_HOST: "198.51.100.134",
      PROXMOX_FIXTURENODE2_SSH_PRIVATE_KEY_B64: "fixturenode2-key",
      PROXMOX_FIXTURENODE2_TEMPLATE_ID: "9004",
    });

    expect(target.id).toBe("fixturenode2");
    expect(target.env.PROXMOX_SSH_HOST).toBe("198.51.100.134");
    expect(target.env.PROXMOX_SSH_PRIVATE_KEY_B64).toBe("fixturenode2-key");
    expect(target.env.PROXMOX_SSH_HOST_FINGERPRINT).toBeUndefined();
    expect(target.env.HERMES_PROXMOX_TARGET_ENV_ERROR).toMatch(
      /PROXMOX_SSH_HOST_FINGERPRINT/,
    );
    expect(isProxmoxProvisioningConfigured(target.env)).toBe(false);
  });

  it("orders Proxmox failover targets with the explicit primary first", () => {
    expect(
      resolveProxmoxTargetCandidateIds({
        HERMES_PROXMOX_TARGET: "fixturenode3",
        HERMES_PROXMOX_TARGETS: "fixturenode3,fixturenode2 fixturelegacy",
      })
    ).toEqual(["fixturenode3", "fixturenode2", "fixturelegacy"]);
  });

  it("keeps fixturenode2 first when production is switched to the fixturenode2 pool", () => {
    expect(
      resolveProxmoxTargetCandidateIds({
        HERMES_PROXMOX_TARGET: "fixturenode2",
        HERMES_PROXMOX_TARGETS: "fixturenode2,fixturenode3",
      })
    ).toEqual(["fixturenode2", "fixturenode3"]);
  });

  it("uses the multi-target list order even when HERMES_PROXMOX_TARGET points elsewhere", () => {
    // Regression: prior to 2026-05-12 the singular was pushed first in
    // resolveProxmoxTargetCandidateIds, so a forgotten-but-set
    // HERMES_PROXMOX_TARGET could pin every env-order-fallback placement
    // to one host even though the operator's intent (encoded in
    // HERMES_PROXMOX_TARGETS) had moved on. The actual 2026-05-12 prod
    // configuration was HERMES_PROXMOX_TARGET=fixturenodea +
    // HERMES_PROXMOX_TARGETS=fixturenodea,fixturenodea,fixturenodea,fixturenodea,fixturenodea,fixturenodea — and fixturenodea
    // won every placement for a week. The list now wins.
    expect(
      resolveProxmoxTargetCandidateIds({
        HERMES_PROXMOX_TARGET: "fixturenode4",
        HERMES_PROXMOX_TARGETS: "fixturenode5,fixturenode6,fixturenode2,fixturenode1,fixturenode3,fixturenode4",
      })
    ).toEqual(["fixturenode5", "fixturenode6", "fixturenode2", "fixturenode1", "fixturenode3", "fixturenode4"]);
  });

  it("falls back to HERMES_PROXMOX_TARGET only when no multi-target list is configured", () => {
    expect(
      resolveProxmoxTargetCandidateIds({
        HERMES_PROXMOX_TARGET: "fixturenode5",
      })
    ).toEqual(["fixturenode5"]);
  });

  it("builds a locked Proxmox host script that clones, isolates routing through Caddy, deploys via guest SSH, and emits metadata", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 2,
      cpuLimit: 0.5,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    expect(script).toContain('mkdir "$HERMES_PROXMOX_LOCK_DIR"');
    expect(script).toContain("HERMES_PROXMOX_LOCK_DIR=/run/lock/hermes-proxmox-provision.lock.d");
    expect(script).not.toContain("flock /var/lock/hermes-proxmox-provision.lock");
    // Regression: bridge guard. When a host reboots without
    // /etc/network/interfaces.d/vmbr1 persisted, every provision 500'd
    // with an opaque "bridge 'vmbr1' does not exist" deep inside qm
    // start. Phase 1 must fail fast with the hostname so ops sees which
    // host to fix (incident 2026-05-17, fixturenodea+fixturenodea).
    expect(script).toContain("ip link show vmbr1");
    expect(script).toContain("missing private bridge vmbr1");
    expect(script).toContain('qm clone "$TEMPLATE_ID" "$VMID" --name "$VM_NAME" --full 0');
    expect(script).toContain("DISK_SIZE_GB='30'");
    expect(script).toContain('qm resize "$VMID" scsi0 "${DISK_SIZE_GB}G"');
    expect(script).toContain('qm set "$VMID" --scsi0 "$SCSI0_DISK,discard=on,aio=threads"');
    // Regression: aio=threads is required for UNMAP to reach the LVM thin
    // pool. Default aio=io_uring silently drops UNMAP and tenant disks
    // never reclaim deleted blocks (verified on a disposable template-bake VM).
    expect(script).toContain("aio=threads");
    expect(script).toContain("CPU_LIMIT='0.5'");
    expect(script).toContain('qm set "$VMID" --cores "$CORES" --cpulimit "$CPU_LIMIT" --memory "$MEMORY_MB" --balloon "$BALLOON_FLOOR_MB"');
    // Default (no balloonFloorMb provided): floor equals memory → legacy
    // fully-pinned allocation, no behavior change for hosts that haven't
    // opted in to elastic memory.
    expect(script).toContain("BALLOON_FLOOR_MB='2048'");
    expect(script).toContain('ip=${PRIVATE_IP}/${PRIVATE_CIDR},gw=${PRIVATE_GATEWAY}');
    expect(script).toContain('reverse_proxy ${PRIVATE_IP}:80');
    // Regression: SSE streaming requires flush_interval -1 on the OUTER
    // host Caddy too, not just inside the VM. Without this the host Caddy
    // buffers chat tokens and delivers them as one block on stream close
    // — looks like "no streaming" in the dashboard. Also: removed gzip
    // because it interacts badly with chunked SSE flushing.
    expect(script).toContain("flush_interval -1");
    expect(script).toContain("read_timeout 0s");
    expect(script).not.toMatch(/^\s*encode gzip\s*$/m);
    expect(script).toContain('GUEST_SSH_OPTS=(-i "$VM_SSH_KEY_PATH"');
    expect(script).toContain("sudo bash -s");
    expect(script).toContain("HERMES_PROXMOX_RESULT");
  });

  it("threads DB-claimed VMIDs into the in-VM picker so concurrent provisions can't race for the same slot", () => {
    // Regression: ~25 users since 2026-05-07 hit
    // `post_provision_proxmox_metadata_conflict_active` because the
    // legacy picker scanned `qm list` only. When a previous tenant's VM
    // was destroyed on Proxmox but its (proxmox_node, proxmox_vmid)
    // columns still held a unique-key lock, the picker reused that
    // VMID, qm clone succeeded, and the post-provision UPDATE 23505'd.
    // Kwarakwante (2026-05-18 16:38 UTC on fixturenodea:301) was the surfacing
    // incident.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_reserved",
      vmName: "hermes-inst-test-reserved",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 1024,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
      reservedVmids: [201, 215, 220],
    });

    expect(script).toContain("RESERVED_VMIDS='201\n215\n220'");
    // Picker merges qm-list + RESERVED_VMIDS into one stream before the
    // grep so a single pass covers both sources.
    expect(script).toContain('claimed_vmids="$existing_vmids"');
    expect(script).toContain('if [ -n "$RESERVED_VMIDS" ]; then');
    expect(script).toContain('claimed_vmids="$(printf');
    expect(script).toContain('| grep -qx "$candidate"');
    expect(script).toContain("used_octets=");
    expect(script).toContain("/etc/pve/qemu-server/*.conf");
    expect(script).toContain("already assigned");
  });

  it("leaves RESERVED_VMIDS empty when the caller has no DB-claimed VMIDs to skip (legacy qm-list-only fallback)", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_reserved_empty",
      vmName: "hermes-inst-test-reserved-empty",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 1024,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // Empty string => the `if [ -n "$RESERVED_VMIDS" ]` branch skips the
    // merge and the picker scans `qm list` exactly as before. This keeps
    // the fail-open behaviour we promise on DB-lookup failure intact.
    expect(script).toContain("RESERVED_VMIDS=''");
  });

  it("folds orphaned-LV VMIDs into the allocator's claimed set so a crashed clone can't doom-loop signups", () => {
    // Regression: a `qm clone` that dies mid-way leaves vm-<vmid>-cloudinit /
    // vm-<vmid>-disk-* LVs with no /etc/pve config. `qm list` can't see those,
    // so the picker kept re-selecting that VMID and every clone failed
    // "lvcreate 'vg0/vm-<vmid>-cloudinit' ... already exists" — silently
    // breaking ~5 fresh signups on 2026-06-13 (vmid 1246, fixturenodea) until the LVs
    // were lvremove'd by hand. The picker must treat LV-owning VMIDs as claimed.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_orphan_lv",
      vmName: "hermes-inst-test-orphan-lv",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 1024,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // Scans every VG for vm-<vmid>-* LVs and reduces them to a VMID list.
    expect(script).toContain("orphan_lv_vmids=");
    expect(script).toContain("lvs --noheadings -o lv_name");
    expect(script).toContain("sed -n 's/^[[:space:]]*vm-\\([0-9][0-9]*\\)-.*/\\1/p'");
    // The orphan-LV VMIDs are merged into claimed_vmids (the same set the
    // `seq | grep -qx` picker skips) alongside qm-list + RESERVED_VMIDS.
    // (Assert the merge tail rather than the printf format string, whose `\n`
    // renders as a real newline in the template literal — matching the style
    // of the RESERVED_VMIDS test above.)
    expect(script).toContain('if [ -n "$orphan_lv_vmids" ]; then');
    expect(script).toContain('"$claimed_vmids" "$orphan_lv_vmids")"');
    // Best-effort: an lvs failure must not abort the provision.
    expect(script).toContain("|| true)");
  });

  it("runs guest disk cleanup from Phase 2 after WebUI readiness", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 1024,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
      backend: "webui",
    });

    const readinessIdx = script.indexOf('if [ "$backend_ready" != "1" ]; then');
    const cleanupIdx = script.indexOf("[phase2] running Hermes disk cleanup after WebUI readiness");
    expect(readinessIdx).toBeGreaterThan(0);
    expect(cleanupIdx).toBeGreaterThan(readinessIdx);
    expect(script).toContain("sudo -n /usr/local/bin/hermes-disk-cleanup");
    expect(script).toContain("PHASE2_DISK_AFTER_CLEANUP");
  });

  it("defaults the emergency Proxmox tenant cap to 40 and derives the VMID range from it", () => {
    expect(resolveProxmoxMaxTenantInstances({})).toBe(40);
    expect(resolveProxmoxVmidEnd({}, 200)).toBe(239);
    expect(resolveProxmoxVmidEnd({ PROXMOX_VMID_END: "250" }, 200)).toBe(250);
    expect(resolveProxmoxMaxTenantInstances({ HERMES_PROXMOX_MAX_TENANT_INSTANCES: "0" })).toBeNull();
  });

  it("checks actual Proxmox host VMID availability in the configured range", async () => {
    const result = await getProxmoxVmidAvailability({
      env: {
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
        PROXMOX_TEMPLATE_ID: "9003",
        PROXMOX_VMID_START: "200",
        HERMES_PROXMOX_MAX_TENANT_INSTANCES: "3",
      },
      runHostScript: async (script: string) => {
        expect(script).toContain("VMID_START='200'");
        expect(script).toContain("VMID_END='202'");
        expect(script).toContain("HERMES_PROXMOX_VMID_RANGE $VMID_START $VMID_END");
        // The preflight must also fold LV-landmined VMIDs (crashed-clone
        // orphans qm list can't see) into the occupied set so it never reports
        // a doom-looped slot as free (incident 2026-06-13).
        expect(script).toContain("orphan_lv_vmids=");
        expect(script).toContain("lvs --noheadings -o lv_name");
        expect(script).toContain('occupied_vmids="$(printf');
        return {
          ok: true,
          stdout: [
            "HERMES_PROXMOX_VMID_RANGE 200 202",
            "HERMES_PROXMOX_VMID_OCCUPIED 200",
            "HERMES_PROXMOX_VMID_OCCUPIED 201",
            "HERMES_PROXMOX_VMID_FREE 202",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    expect(result).toEqual({
      ok: true,
      targetId: null,
      vmidStart: 200,
      vmidEnd: 202,
      occupiedVmids: [200, 201],
      freeVmids: [202],
    });
  });

  it("treats database-reserved VMIDs as occupied during availability preflight", async () => {
    mockSupabaseFrom.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      query.select = jest.fn().mockReturnValue(query);
      query.eq = jest.fn().mockReturnValue(query);
      query.not = jest.fn().mockReturnValue(query);
      query.neq = jest.fn().mockReturnValue(query);
      query.then = (resolve: (value: { data: unknown[]; error: null }) => void) => {
        const data =
          table === "hermes_instances"
            ? [{ proxmox_vmid: 202 }]
            : table === "hivra_agents"
              ? [{ vmid: 203 }]
              : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      };
      return query;
    });

    const result = await getProxmoxVmidAvailability({
      env: {
        PROXMOX_NODE: "fixturenode21",
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
        PROXMOX_TEMPLATE_ID: "9003",
        PROXMOX_VMID_START: "202",
        PROXMOX_VMID_END: "203",
      },
      runHostScript: async () => ({
        ok: true,
        stdout: [
          "HERMES_PROXMOX_VMID_RANGE 202 203",
          "HERMES_PROXMOX_VMID_FREE 202",
          "HERMES_PROXMOX_VMID_FREE 203",
        ].join("\n"),
        stderr: "",
      }),
    });

    expect(result).toEqual({
      ok: true,
      targetId: "fixturenode21",
      vmidStart: 202,
      vmidEnd: 203,
      occupiedVmids: [202, 203],
      freeVmids: [],
    });
    expect(mockSupabaseFrom).toHaveBeenCalledWith("hermes_instances");
    expect(mockSupabaseFrom).toHaveBeenCalledWith("hivra_agents");
  });

  it("only excludes a real uuid instance id from the reserved-vmid lookup (preflight sentinel must not touch the uuid column)", async () => {
    const neqByTable: Record<string, Array<[string, unknown]>> = {};
    mockSupabaseFrom.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      query.select = jest.fn().mockReturnValue(query);
      query.eq = jest.fn().mockReturnValue(query);
      query.not = jest.fn().mockReturnValue(query);
      query.neq = jest.fn((column: string, value: unknown) => {
        (neqByTable[table] ??= []).push([column, value]);
        return query;
      });
      query.then = (resolve: (value: { data: unknown[]; error: null }) => void) => {
        const data =
          table === "hermes_instances"
            ? [{ proxmox_vmid: 250 }]
            : table === "hivra_agents"
              ? [{ vmid: 251 }]
              : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      };
      return query;
    });

    // Sentinel (non-uuid) excludeInstanceId: the uuid `id` column must NOT be
    // filtered, otherwise Postgres throws "invalid input syntax for type uuid"
    // and the whole reserved-vmid lookup is discarded (DB + hivra reservations
    // silently dropped, picker degraded to qm-list-only).
    const sentinel = await getReservedProxmoxVmidsForNode({
      proxmoxNode: "fixturenode10",
      excludeInstanceId: "__vmid_availability_preflight__",
    });
    expect(sentinel).toEqual([250, 251]);
    expect(
      (neqByTable.hermes_instances ?? []).some(([column]) => column === "id")
    ).toBe(false);

    // A real uuid still excludes the owning row.
    neqByTable.hermes_instances = [];
    const uuid = "00000000-0000-4000-8000-000000001004";
    await getReservedProxmoxVmidsForNode({
      proxmoxNode: "fixturenode10",
      excludeInstanceId: uuid,
    });
    expect(
      (neqByTable.hermes_instances ?? []).some(
        ([column, value]) => column === "id" && value === uuid
      )
    ).toBe(true);
  });

  it("checks that the configured Proxmox template exists and is marked as a template", async () => {
    const result = await getProxmoxTemplateAvailability({
      env: {
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
        PROXMOX_TEMPLATE_ID: "9004",
      },
      runHostScript: async (script: string) => {
        expect(script).toContain("TEMPLATE_ID='9004'");
        expect(script).toContain("qm config \"$TEMPLATE_ID\"");
        return {
          ok: true,
          stdout: [
            "HERMES_PROXMOX_TEMPLATE_CHECK 9004",
            "HERMES_PROXMOX_TEMPLATE_READY 9004",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    expect(result).toEqual({
      ok: true,
      targetId: null,
      templateId: 9004,
    });
  });

  it("reports a missing Proxmox template before the clone script can fail", async () => {
    const result = await getProxmoxTemplateAvailability({
      env: {
        HERMES_PROXMOX_TARGET: "fixturelegacy",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/global-proxmox",
        PROXMOX_TEMPLATE_ID: "9000",
        PROXMOX_FIXTURELEGACY_PUBLIC_IP: "203.0.113.10",
        PROXMOX_FIXTURELEGACY_SSH_HOST: "203.0.113.10",
        PROXMOX_FIXTURELEGACY_SSH_KEY_PATH: "/Users/example/.ssh/hivra-secondary-admin",
        PROXMOX_FIXTURELEGACY_TEMPLATE_ID: "9003",
      },
      runHostScript: async (script: string) => {
        expect(script).toContain("TEMPLATE_ID='9003'");
        return {
          ok: true,
          stdout: [
            "HERMES_PROXMOX_TEMPLATE_CHECK 9003",
            "HERMES_PROXMOX_TEMPLATE_MISSING 9003",
            "HERMES_PROXMOX_TEMPLATE_ERROR Configuration file 'nodes/fixturenode1/qemu-server/9003.conf' does not exist",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    expect(result).toEqual({
      ok: false,
      targetId: "fixturelegacy",
      templateId: 9003,
      reason: "missing",
      error: "Configuration file 'nodes/fixturenode1/qemu-server/9003.conf' does not exist",
    });
  });

  it("uses an isolated known_hosts file for guest SSH so reused private IPs do not block provisioning", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    expect(script).toContain('SSH_KNOWN_HOSTS_FILE="/tmp/hermes-proxmox-known-hosts-${VMID}"');
    expect(script).toContain('rm -f "$SSH_KNOWN_HOSTS_FILE"');
    expect(script).toContain('-o UserKnownHostsFile="$SSH_KNOWN_HOSTS_FILE"');
  });

  it("hermes_caddy_reload pulls caddy's systemd env before `caddy validate` (so {env.X} TLS secrets resolve)", () => {
    // Regression: hosts configured with `acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}`
    // were failing every reload with "hermes_caddy_reload: invalid Caddyfile,
    // refusing to reload" because `caddy validate` is a one-shot CLI and
    // doesn't inherit systemd's Environment= drop-in. The running daemon
    // had the token and was issuing certs fine; only the pre-flight
    // validate was broken, which gated provisioning. Fix is to source
    // the daemon's resolved env via `systemctl show caddy -p Environment`
    // before validating.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // The systemctl-show + export loop must appear inside hermes_caddy_reload
    // and BEFORE the `caddy validate` call. Using regex anchored on the
    // function header so we only check this function's body.
    const reloadFnMatch = script.match(/hermes_caddy_reload\(\)\s*\{([\s\S]*?)^\}/m);
    expect(reloadFnMatch).not.toBeNull();
    const body = reloadFnMatch![1];
    const sysctlShowIdx = body.indexOf("systemctl show caddy -p Environment");
    const validateIdx = body.indexOf("caddy validate --config /etc/caddy/Caddyfile");
    expect(sysctlShowIdx).toBeGreaterThanOrEqual(0);
    expect(validateIdx).toBeGreaterThan(sysctlShowIdx);
    // The exported KV pairs must be re-exported in the current shell so
    // the subsequent `caddy validate` child process inherits them.
    expect(body).toContain('export "$kv"');
  });

  it("hermes_caddy_reload surfaces caddy validate stderr instead of swallowing it (so the dashboard banner names the actual broken file)", () => {
    // Regression: the helper used to run `caddy validate ... >/dev/null 2>&1`,
    // discarding the actual reason for validation failure. When fixturenodea's
    // /etc/caddy/wildcards/* symlinks went dangling after storage cleanup
    // on 2026-05-17, every welcome-flow deploy failed for ~6h with only
    // "hermes_caddy_reload: invalid Caddyfile, refusing to reload" visible
    // to the user — the real cause (file-not-found on the cert) required
    // SSH'ing to the host to recover. The helper must:
    //   1) capture validate output (stderr merged) into a variable, AND
    //   2) emit it through the script's stderr on the failure branch
    // so the orchestrator → dashboard banner → ops_events feed chain
    // surfaces the underlying error automatically.
    //
    // Second regression on top of that fix: the LOCKED block runs under
    // `set -euo pipefail`. The original shape was
    //   VALIDATE_ERR=$(caddy validate ... 2>&1)
    //   VALIDATE_RC=$?
    //   if [ "$VALIDATE_RC" -ne 0 ]; then ... fi
    // — a bare assignment whose command substitution exits non-zero is a
    // failing simple command, so errexit kills the script BEFORE
    // `VALIDATE_RC=$?` and the echo run. That left the banner showing the
    // opaque "Remote bash exited with code 1" again from ~16:17 UTC on
    // 2026-05-17 until the fix below. The assignment must live inside an
    // `if` condition (or otherwise errexit-suppressed context) so the
    // failure branch is actually reached.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_validate_stderr",
      vmName: "hermes-inst-test-validate-stderr",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    const reloadFnMatch = script.match(/hermes_caddy_reload\(\)\s*\{([\s\S]*?)^\}/m);
    expect(reloadFnMatch).not.toBeNull();
    const body = reloadFnMatch![1];

    // (1) Validate output must be captured, NOT redirected to /dev/null.
    expect(body).toMatch(/VALIDATE_ERR=\$\(timeout 20s caddy validate --config \/etc\/caddy\/Caddyfile 2>&1\)/);
    expect(body).not.toMatch(/caddy validate --config \/etc\/caddy\/Caddyfile >\/dev\/null 2>&1/);

    // (2) The assignment must live inside an `if !` condition so errexit
    //     is suppressed and the failure branch is actually reached under
    //     `set -e`. A bare `VALIDATE_ERR=$(...)` followed by `VALIDATE_RC=$?`
    //     is the load-bearing regression that ate the 2026-05-17 banner.
    expect(body).toMatch(
      /if ! VALIDATE_ERR=\$\(timeout 20s caddy validate --config \/etc\/caddy\/Caddyfile 2>&1\); then/
    );
    expect(body).not.toMatch(/VALIDATE_RC=\$\?/);

    // (3) On the refusal branch, the captured output must be echoed to
    //     stderr so it propagates through SSH back to the dashboard. Order
    //     matters: the generic refusal header first, then the captured
    //     reason, so the banner reads as a structured failure.
    const refuseIdx = body.indexOf('echo "hermes_caddy_reload: invalid Caddyfile, refusing to reload" >&2');
    const surfaceIdx = body.indexOf('"$VALIDATE_ERR"');
    expect(refuseIdx).toBeGreaterThanOrEqual(0);
    expect(surfaceIdx).toBeGreaterThan(refuseIdx);
    // The captured output is emitted to stderr (tail -10 caps banner size).
    expect(body).toContain('"$VALIDATE_ERR" | tail -n 10 >&2');
  });

  it("fails closed when a Proxmox host is missing the static Origin CA wildcard cert", () => {
    // Regression: after moving fleet origins to Cloudflare Origin CA, fresh
    // provisions must not fall back to Caddy-managed Let's Encrypt wildcard
    // minting. If a host is missing the seeded cert/key, provisioning should
    // stop with a clear operator error before writing a broken tenant route.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_wildcard_bootstrap",
      vmName: "hermes-inst-test-wildcard-bootstrap",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.hermesos.cloud",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    expect(script).toContain('if [ ! -r "$CADDY_WILDCARD_CERT" ] || [ ! -r "$CADDY_WILDCARD_KEY" ]; then');
    expect(script).toContain("missing Cloudflare Origin CA cert/key");
    expect(script).toContain("seed the host before provisioning");
    expect(script).toContain(
      "tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key",
    );
    expect(script).not.toContain("wildcard cert files not readable yet");
  });

  it("never emits literal backticks inside the unquoted <<CADDY heredoc body (bash would treat them as command substitution)", () => {
    // Regression: the per-tenant outer Caddyfile is written via
    //   cat > "$SITE_FILE" <<CADDY ... CADDY
    // The terminator is UNQUOTED so we can interpolate ${PRIVATE_IP} /
    // ${DASHBOARD_ORIGIN} / etc. at runtime — but that also makes bash
    // treat any backticks in the body as command substitution. Comments
    // like  `header X "value"`  caused bash to actually run "header" as
    // a command, producing "Deployment failed: bash: line N: header:
    // command not found" and "hermes_caddy_reload: invalid Caddyfile,
    // refusing to reload" in production. Keep the heredoc body
    // backtick-free.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // Walk every <<CADDY...CADDY block and assert no backticks. The
    // global flag plus the [\\s\\S]*? non-greedy match handles the two
    // separate blocks (the chat-server branch + the bare reverse_proxy
    // fallback) independently.
    const heredocPattern = /<<CADDY\n([\s\S]*?)\nCADDY/g;
    const matches = Array.from(script.matchAll(heredocPattern));
    expect(matches.length).toBeGreaterThan(0); // sanity: the heredoc is still there
    for (const match of matches) {
      const body = match[1];
      expect(body).not.toContain("`");
    }
  });

  it("emits hermesos.cloud Caddy sites with the shared wildcard cert directive", () => {
    // Regression: 2026-05-11 hit the Let's Encrypt 50-certs/week rate
    // limit on hermesos.cloud because every tenant minted its own cert.
    // The per-tenant heredoc body MUST point at the shared wildcard
    // cert symlinks so Caddy disables auto_https for that site (Caddy
    // skips management when a site's tls directive specifies explicit
    // cert+key files).
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_wildcard",
      vmName: "hermes-inst-wildcard",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-wildcard.hermesos.cloud",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    const heredocPattern = /<<CADDY\n([\s\S]*?)\nCADDY/g;
    const matches = Array.from(script.matchAll(heredocPattern));
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const body = match[1];
      expect(body).toContain(
        "tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key",
      );
      // Belt-and-suspenders: make sure we didn't accidentally leave a
      // per-tenant `dns cloudflare` block that would re-trigger ACME.
      expect(body).not.toMatch(/tls\s*\{\s*dns cloudflare/);
    }
  });

  it("rejects legacy nested Hermes gateway hosts before provisioning", () => {
    expect(() =>
      buildProxmoxProvisionScript({
        instanceId: "inst_legacy_nested",
        vmName: "hermes-inst-legacy-nested",
        templateId: 9000,
        vmidStart: 200,
        vmidEnd: 250,
        ipLastOctetStart: 50,
        privateSubnetPrefix: "10.250.20",
        privateCidr: 24,
        privateGateway: "10.250.20.1",
        nameserver: "1.1.1.1",
        cores: 1,
        memoryMb: 2048,
        deployScript: "#!/usr/bin/env bash\necho deploy\n",
        vmSshUser: "hermes",
        vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
        gatewayHost: "inst-legacy.agents.hermesos.cloud",
        caddySitesDir: "/etc/caddy/hermes.d",
        apiServerKey: "a".repeat(64),
      }),
    ).toThrow("not covered by the static Origin CA certificate");
  });

  it("does not pin the hermesos.cloud wildcard cert onto sslip fallback Caddy sites", () => {
    // Regression: sslip fallback routes were serving the hermesos.cloud
    // wildcard cert, so HTTPS clients rejected otherwise-healthy
    // Proxmox deployments before the request ever reached the guest.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_sslip",
      vmName: "hermes-inst-sslip",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-sslip.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    const heredocPattern = /<<CADDY\n([\s\S]*?)\nCADDY/g;
    const matches = Array.from(script.matchAll(heredocPattern));
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const body = match[1];
      expect(body).not.toContain(
        "tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key"
      );
    }
  });

  it("seeds the host Caddyfile with static Cloudflare Origin CA wildcard TLS", () => {
    // Regression: after migrating the live fleet to Cloudflare Origin CA,
    // fresh provisions must not regenerate the old Let's Encrypt DNS-01
    // wildcard minter. `caddy validate` should pass in a plain shell with
    // no CLOUDFLARE_API_TOKEN, and tenant sites should pin the static
    // /etc/caddy/wildcards cert/key paths.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_wildcard_host",
      vmName: "hermes-inst-wildcard-host",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-wildcard-host.hermesos.cloud",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    expect(script).toContain("*.hermesos.cloud, hermesos.cloud {");
    expect(script).toContain("tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key");
    expect(script).not.toMatch(/tls\s*\{\s*dns cloudflare/);
    expect(script).not.toContain("acme_dns cloudflare");
    expect(script).not.toContain("acme-v02.api.letsencrypt.org-directory/wildcard_.hermesos.cloud");
    expect(script).toContain("mkdir -p /etc/caddy/wildcards");
    expect(script).toContain("/etc/caddy/wildcards/hermesos.cloud.crt");
    expect(script).toContain("/etc/caddy/wildcards/hermesos.cloud.key");
    expect(script).toContain("<<MAINCADDY");
  });

  it("prevents readiness SSH probes from consuming the remaining host script stdin", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    expect(script).toContain('ssh -n "${UNATTESTED_GUEST_SSH_OPTS[@]}" -o ConnectTimeout=5');
    // The guest bootstrap + deploy now run through a bounded retry helper so
    // a single transient failure (apt-lock / mirror blip) doesn't trip set -e
    // and immediately destroy a fresh-signup VM. Only a persistent failure
    // exhausts the attempts and falls through to the teardown trap.
    expect(script).toContain('run_guest_script bootstrap "$BOOTSTRAP_B64_FILE"');
    expect(script).toContain('run_guest_script deploy "$DEPLOY_B64_FILE"');
    // The payload still streams from the staged FILE (not the orchestrator's
    // remaining stdin) — the property this test originally guarded — over the
    // connection each call site names (the deploy's is the VMID-pinned one).
    expect(script).toContain('base64 -d < "$b64_file" | "$@" "sudo bash -s"');
    expect(script).toContain('run_guest_script deploy "$DEPLOY_B64_FILE" "${GUEST_SSH[@]}"');
    // Bounded, not infinite: 3 attempts then give up and tear down.
    expect(script).toContain('while [ "$attempt" -le 3 ];');
  });

  it("readiness probe follows redirects and accepts auth-gated /health (no bare-200 self-destruct)", () => {
    // Regression: post the Jun-2026 auth-hardening the webfree /health sits
    // behind the login gate and 302-redirects to /login?next=/health, so a bare
    // GET never returns 200. The old probe (`curl -sS` + `[ "$code" = "200" ]`)
    // therefore failed readiness for the full 600s budget and the Phase 2 trap
    // tore down EVERY new, perfectly-healthy webfree box. Readiness must mirror
    // isHandoffProbeReachable: follow the redirect and accept any 2xx/3xx/401/403.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // Follows redirects (-L) so a 302→/login→200 resolves, and is bounded.
    expect(script).toContain('curl -sSL --max-time 5 -o "/tmp/hermes-proxmox-${VMID}.health"');
    // Ready = any 2xx/3xx/401/403 (server up + routing), not a bare 200.
    expect(script).toContain("2[0-9][0-9]|3[0-9][0-9]|401|403)");
    // The brittle exact-200 gate is gone.
    expect(script).not.toContain('if [ "$code" = "200" ]; then');
  });

  it("bootstraps Docker and the guest Caddy container before deploying Hermes", () => {
    const bootstrap = buildProxmoxGuestBootstrapScript();
    // First-boot race: the template has `package_upgrade: true`, so
    // cloud-init holds /var/lib/apt/lists/lock for minutes after VM
    // start. DPkg::Lock::Timeout doesn't cover the apt-lists lock — the
    // robust fix is to block until cloud-init is done before touching
    // apt at all.
    expect(bootstrap).toContain("timeout 600 cloud-init status --wait");
    // Regression: `cloud-init status --wait` returns exit 2 when cloud-init
    // finished with recoverable errors ("degraded done"). Treating that as
    // fatal aborts every freshly-cloned VM the moment cloud-init's own
    // apt-update returned non-zero on a flaky mirror. Exit 0 AND 2 must be
    // accepted; only 1 / 124 (timeout) abort.
    expect(bootstrap).toContain("0|2)");
    // Lock contention: apt-get's own DPkg::Lock::Timeout is the durable
    // mechanism — works on minimal cloud images that don't ship psmisc/fuser.
    // The previous fuser-based wait silently no-op'd when fuser was absent
    // and let apt-get race unattended-upgrades on freshly-cloned VMs.
    expect(bootstrap).toContain('apt-get -o DPkg::Lock::Timeout="$APT_LOCK_WAIT_SECONDS"');
    // No fuser invocations — only the explanatory comment may mention it.
    const fuserCalls = bootstrap
      .split("\n")
      .filter((line) => /\bfuser\b/.test(line) && !line.trim().startsWith("#"));
    expect(fuserCalls).toEqual([]);
    // DPkg::Lock::Timeout does NOT cover /var/lib/apt/lists/lock — the lock
    // `apt-get update` needs and that apt-daily/unattended-upgrades holds
    // after cloud-init finishes. Three added layers close that gap:
    // (1) stop the apt-daily timers for the duration of bootstrap so no NEW
    //     auto-apt run starts, and restore them on exit.
    expect(bootstrap).toContain("systemctl stop apt-daily.timer apt-daily-upgrade.timer");
    expect(bootstrap).toContain("trap resume_apt_periodic EXIT");
    expect(bootstrap).toContain("systemctl start apt-daily.timer apt-daily-upgrade.timer");
    // (2) wait out a run already in flight before touching apt, polling the
    //     lists/dpkg locks via lslocks (util-linux, always present — NOT fuser).
    expect(bootstrap).toContain("lslocks -no PATH");
    expect(bootstrap).toContain("/var/lib/apt/lists/lock");
    expect(bootstrap).toContain("/var/lib/dpkg/lock-frontend");
    expect(bootstrap).toContain("wait_for_apt_locks");
    // (3) run_apt_get retries on lock failure instead of dying once and
    //     aborting the whole bootstrap under set -euo pipefail.
    expect(bootstrap).toContain("waiting for apt locks before retry");
    // The proactive lock wait runs before the first apt-get update so we
    // don't burn a failed attempt on the obvious first-boot race.
    expect(bootstrap.indexOf("wait_for_apt_locks\nrun_apt_get update -qq")).toBeGreaterThan(-1);
    expect(bootstrap).toContain("curl -fsSL https://get.docker.com | sh");
    expect(bootstrap).toContain("qemu-guest-agent");
    expect(bootstrap).toContain("hermes_ensure_time_sync()");
    expect(bootstrap).toContain("/var/log/hermes-time-sync.log");
    expect(bootstrap).toContain("timedatectl set-timezone UTC");
    expect(bootstrap).toContain("timedatectl set-ntp true");
    expect(bootstrap).toContain("run_apt_get install -y --no-install-recommends systemd-timesyncd");
    expect(bootstrap).toContain("hwclock --systohc --utc");
    expect(bootstrap.indexOf("hermes_ensure_time_sync")).toBeLessThan(
      bootstrap.indexOf("curl -fsSL https://get.docker.com | sh")
    );
    expect(bootstrap).toContain("/etc/docker/daemon.json");
    expect(bootstrap).toContain('"max-size": "20m"');
    expect(bootstrap).toContain('"max-file": "3"');
    expect(bootstrap).toContain("SystemMaxUse=50M");
    expect(bootstrap).toContain("systemctl enable --now fstrim.timer");
    expect(bootstrap).toContain("docker compose pull caddy");
    expect(bootstrap).toContain("docker compose up -d caddy");
    expect(bootstrap).toContain("prune_dangling_docker_images");
    expect(bootstrap).toContain('docker image ls -a --filter dangling=true -q');
    expect(bootstrap).not.toContain('docker image prune -af --filter "until=24h"');
    expect(bootstrap).toContain("prune_old_unused_hermes_agent_images");
    expect(bootstrap).toContain('docker image rm "$image_ref"');
    expect(bootstrap).toContain("--format '{{.ID}} {{.Repository}}:{{.Tag}}'");
    expect(bootstrap).toContain('docker image rm "$image_id"');
    // The case statement also excludes the LKG rollback tag so the
    // host-side cleanup doesn't prune a VM's prior-good image.
    expect(bootstrap).toContain('*:hermes-last-known-good) continue');
    expect(bootstrap).toContain('*:"<none>"|"<none>":*) docker image rm "$image_id"');
    expect(bootstrap).toContain('docker builder prune -f --filter "until=24h"');
    expect(bootstrap).toContain("ctr -n moby content prune references");
    expect(bootstrap).toContain("find /tmp /var/tmp");
    expect(bootstrap).toContain("fstrim -av");
    expect(bootstrap).toContain("hermes-disk-pressure.warn");
    // The 6-hourly hermes-disk-cleanup defines the browser-sidecar Chrome cache
    // prune and fires it as a relief valve once the disk crosses 85% — the usual
    // culprit at that level. Cache-only (cookies/logins/profile preserved).
    expect(bootstrap).toContain("prune_browser_sidecar_cache() {");
    const aggressiveIdx = bootstrap.indexOf("running aggressive (still volume-safe) prune");
    const browserPruneCallIdx = bootstrap.indexOf("\n  prune_browser_sidecar_cache\n");
    expect(aggressiveIdx).toBeGreaterThan(0);
    expect(browserPruneCallIdx).toBeGreaterThan(aggressiveIdx);
    expect(bootstrap).toContain("cat > /usr/local/bin/hermes-memory-guard");
    expect(bootstrap).toContain("modprobe zram");
    expect(bootstrap).toContain("swapon -p 100 /dev/zram0");
    expect(bootstrap).toContain("Before=docker.service");

    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    const bootstrapIndex = script.indexOf('printf \'%s\' "$BOOTSTRAP_B64"');
    const deployIndex = script.indexOf('printf \'%s\' "$DEPLOY_B64"');
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(deployIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeLessThan(deployIndex);
  });

  it("preserves the failing exit code when Phase 1 / Phase 2 cleanup runs", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_test_123",
      vmName: "hermes-inst-test-123",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-test.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // Phase 1 trap fires only if VMID alloc / qm clone / qm start / Caddy
    // site write fails before Phase 2 is forked. PHASE1_OK=0 means Phase 2
    // never started, so we tear the partially-built VM down.
    expect(script).toContain('trap \'cleanup_phase1 "$?"\' EXIT');
    expect(script).toContain('cleanup_phase1() {');
    expect(script).toContain('PHASE1_OK=0');
    expect(script).toContain('PHASE1_OK=1');
    // Phase 2 trap fires if SSH-ready wait / guest bootstrap / deploy /
    // backend-ready wait fails. It destroys the VM so qm status returns
    // "missing" and the dashboard's Proxmox sync flips status to 'stopped'
    // — making the dead row visible instead of forever-spinning.
    expect(script).toContain('trap \'cleanup_phase2 "$?"\' EXIT');
    expect(script).toContain('cleanup_phase2() {');
    expect(script).toContain('exit "$exit_code"');
  });

  it("gates `qm destroy` on a per-VMID claim file so a stale Phase 2 cleanup can't wipe a freshly-recycled tenant VM", () => {
    // Bug surfaced 2026-05-01: failed Phase 2 takes ~6 min to time out
    // (72×5s SSH-ready wait), and by then VMIDs may have been recycled
    // by a fresh provision. Without the claim check, the stale cleanup
    // calls `qm destroy $VMID` and obliterates the new tenant's healthy
    // VM. We saw this destroy two consecutive fresh provisions in
    // sequence before the zombie pids were killed by hand.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_claim_001",
      vmName: "hermes-claim-001",
      templateId: 9002,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-claim.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // Claim dir is created up-front and the claim is written right after VMID
    // allocation — BEFORE `qm clone` — so a clone/start that dies mid-way is
    // owned by the Phase 1 cleanup trap (writing it only after `qm start`, as
    // it was, left a failed clone with an empty claim → no teardown → orphaned
    // vm-<vmid>-* LVs that doom-loop the allocator; incident 2026-06-13).
    expect(script).toContain("mkdir -p /run/hermes-vm-claims");
    expect(script).toContain('printf \'%s\' "$INSTANCE_ID" > "/run/hermes-vm-claims/$VMID.claim"');
    const claimWriteIdx = script.indexOf('printf \'%s\' "$INSTANCE_ID" > "/run/hermes-vm-claims/$VMID.claim"');
    const cloneIdx = script.indexOf('qm clone "$TEMPLATE_ID" "$VMID"');
    expect(claimWriteIdx).toBeGreaterThan(0);
    expect(cloneIdx).toBeGreaterThan(claimWriteIdx);
    // The claim must be stamped exactly once (we MOVED it, didn't duplicate).
    expect(
      script.split('printf \'%s\' "$INSTANCE_ID" > "/run/hermes-vm-claims/$VMID.claim"').length - 1,
    ).toBe(1);

    // Both cleanup traps must guard `qm destroy` on `claim == INSTANCE_ID`
    // so a stale phase-2-cleanup from a prior run that recycled this
    // VMID exits without touching the new VM. They must ALSO lvremove any
    // leftover vm-<vmid>-* LVs that `qm destroy --purge` couldn't map from a
    // missing config, or a crashed clone leaves an allocator-blocking orphan.
    const phase1Cleanup = script.match(/cleanup_phase1\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(phase1Cleanup).toContain('claim=$(cat "/run/hermes-vm-claims/$VMID.claim"');
    expect(phase1Cleanup).toContain('if [ "$claim" = "$INSTANCE_ID" ]; then');
    expect(phase1Cleanup).toContain('qm destroy "$VMID" --purge 1');
    expect(phase1Cleanup).toContain('hermes_remove_vmid_lvs "$VMID"');

    const phase2Cleanup = script.match(/cleanup_phase2\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(phase2Cleanup).toContain('claim=$(cat "/run/hermes-vm-claims/$VMID.claim"');
    expect(phase2Cleanup).toContain('if [ "$claim" = "$INSTANCE_ID" ]; then');
    expect(phase2Cleanup).toContain('qm destroy "$VMID" --purge 1');
    expect(phase2Cleanup).toContain('hermes_remove_vmid_lvs "$VMID"');

    // The LV-removal helper is defined for both phases (Phase 2 is a separate
    // shell, so it gets its own copy) and scopes lvremove to vm-<vmid>-*.
    expect(script).toContain("hermes_remove_vmid_lvs() {");
    expect(script).toContain('lvremove -f "$_hrvl_lvpath"');

    // Phase 2 runs in a separate `bash -c` shell, so INSTANCE_ID must
    // be exported through the nohup env line — without it, the claim
    // comparison reads "" inside Phase 2 and the guard never matches.
    expect(script).toContain('nohup env INSTANCE_ID="$INSTANCE_ID"');
  });

  it("claim-gates malformed-output orphan cleanup before destroying a recovered VMID", async () => {
    const scripts: string[] = [];
    const runHostScript = jest.fn(async (script: string) => {
      scripts.push(script);
      if (scripts.length === 1) {
        return {
          ok: true,
          stdout: 'noise before metadata\nHERMES_PROXMOX_RESULT {"vmid":504\n',
          stderr: "",
        };
      }
      return { ok: true, stdout: "cleanup complete", stderr: "" };
    });

    const result = await provisionProxmoxInstance(
      {
        userId: "user_claim_cleanup",
        instanceId: "inst_claim_cleanup",
        cpuLimit: 1,
        ramLimit: 1024,
        name: "Claim Cleanup",
        provider: "openai",
        apiKey: "sk-test",
        model: "gpt-test",
        subdomain: "claim-cleanup",
      },
      {
        env: {
          PROXMOX_EXEC_MODE: "local",
          PROXMOX_PUBLIC_IP: "198.51.100.246",
          PROXMOX_GATEWAY_DOMAIN: "hermesos.cloud",
          PROXMOX_CADDY_SITES_DIR: "/etc/caddy/hermes.d",
        },
        runHostScript,
        buildDeployScript: () => "#!/usr/bin/env bash\necho deploy\n",
      },
    );

    expect(result.ok).toBe(false);
    expect(runHostScript).toHaveBeenCalledTimes(2);
    const cleanupScript = scripts[1] ?? "";
    expect(cleanupScript).toContain("CLAIM_FILE=/run/hermes-vm-claims/504.claim");
    expect(cleanupScript).toContain("EXPECTED_INSTANCE_ID='inst_claim_cleanup'");
    expect(cleanupScript).toContain('if [ "$claim" != "$EXPECTED_INSTANCE_ID" ]; then');
    expect(cleanupScript).toContain("HERMES_PROXMOX_ORPHAN_CLEANUP_SKIPPED_CLAIM_MISMATCH");
    expect(cleanupScript).toContain("qm destroy 504 --purge");
    // After --purge, sweep any leftover vm-504-* LVs that a missing config
    // would otherwise strand as an allocator-blocking orphan.
    expect(cleanupScript).toContain("awk -v id=504");
    expect(cleanupScript).toContain('lvremove -f "$lvpath"');
    expect(cleanupScript).toContain("rm -f '/etc/caddy/hermes.d/claim-cleanup.hermesos.cloud.caddy'");
  });

  it("stages large Phase 2 payloads in files instead of exporting them through nohup env", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_phase2_payloads",
      vmName: "hermes-phase2-payloads",
      templateId: 9002,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: `#!/usr/bin/env bash\n${"echo large-payload\n".repeat(10_000)}`,
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-phase2.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    const nohupLine = script
      .split("\n")
      .find((line) => line.startsWith("nohup env "));

    expect(nohupLine).toBeTruthy();
    expect(nohupLine).toContain('DEPLOY_B64_FILE="$PHASE2_DEPLOY_B64_FILE"');
    expect(nohupLine).toContain('BOOTSTRAP_B64_FILE="$PHASE2_BOOTSTRAP_B64_FILE"');
    expect(nohupLine).not.toContain('DEPLOY_B64="$DEPLOY_B64"');
    expect(nohupLine).not.toContain('BOOTSTRAP_B64="$BOOTSTRAP_B64"');
    expect(script).toContain('printf \'%s\' "$DEPLOY_B64" > "$PHASE2_DEPLOY_B64_FILE"');
    expect(script).toContain('printf \'%s\' "$BOOTSTRAP_B64" > "$PHASE2_BOOTSTRAP_B64_FILE"');
    // Payloads are decoded from the staged FILES (via the retry helper),
    // never inlined onto the nohup argv.
    expect(script).toContain('run_guest_script bootstrap "$BOOTSTRAP_B64_FILE"');
    expect(script).toContain('run_guest_script deploy "$DEPLOY_B64_FILE"');
    expect(script).toContain('base64 -d < "$b64_file"');
  });

  it("uses a reload helper that recovers from the rare admin-API panic that crashed Caddy under back-to-back reload churn", () => {
    // Bug surfaced 2026-05-01: Caddy 2.x `caddy reload` admin endpoint has
    // a goroutine race ("panic: context: internal error: missing cancel
    // error") that crashed the host service after several rapid reloads.
    // The systemd unit then refused subsequent reloads with "caddy.service
    // is not active, cannot reload" — taking down every public ingress
    // until someone manually `systemctl start caddy`'d the box.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_reload_002",
      vmName: "hermes-reload-002",
      templateId: 9002,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-reload.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // Outer (Phase 1) shell defines a hermes_caddy_reload helper that
    // validates first, retries reload, and falls back to start when the
    // daemon has died. Phase 1 must call the helper instead of a bare
    // `systemctl reload caddy`.
    expect(script).toContain("hermes_caddy_reload() {");
    expect(script).toContain("caddy validate --config /etc/caddy/Caddyfile");
    expect(script).toContain("systemctl reset-failed caddy");
    expect(script).toContain("systemctl start caddy");
    expect(script).toMatch(
      /for _ in 1 2 3; do[\s\S]+?timeout 20s caddy reload --config \/etc\/caddy\/Caddyfile --force/,
    );
    expect(script).toContain("systemctl restart caddy");
    expect(script).toContain("curl -ksS --max-time 5 --resolve");
    expect(script).toContain("hermes_caddy_reload: recovery verification failed");

    // Phase 1's post-Caddy-site-write reload must go through the helper,
    // not bare `systemctl reload caddy`, so a transient panic doesn't
    // poison the host for every subsequent provision.
    const phase1Body = script.split("# Phase 2:")[0] ?? "";
    expect(phase1Body).toMatch(/^hermes_caddy_reload$/m);
    // No bare reload should remain in Phase 1 (the helper now wraps it).
    expect(phase1Body).not.toMatch(/^systemctl reload caddy$/m);
  });

  it("emits HERMES_PROXMOX_RESULT before forking the long-running bootstrap (so Vercel's 300s budget never wraps the SSH-ready / docker-pull / backend-ready loops)", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_async_777",
      vmName: "hermes-inst-async-777",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-async.203-0-113-10.sslip.io",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
    });

    // The kickoff printf must run under `stdbuf -oL` so coreutils printf
    // gets line-buffered stdio. Without this, bash's builtin printf would
    // park the marker line in libc's 4KB pipe buffer until LOCKED exits,
    // and Vercel's lambda would die at the 300s timeout with the orphan
    // signature (status='provisioning', null vmid/gateway_url).
    expect(script).toContain("stdbuf -oL printf 'HERMES_PROXMOX_RESULT");

    const resultLine = "stdbuf -oL printf 'HERMES_PROXMOX_RESULT";
    const sshReadyLoop = "for _attempt in $(seq 1 72)";
    const phase2Heredoc = "<<'PHASE2_BOOTSTRAP'";
    const nohupDetach = "nohup env";
    const disown = "disown";

    const resultIdx = script.indexOf(resultLine);
    const sshReadyIdx = script.indexOf(sshReadyLoop);
    const phase2HeredocIdx = script.indexOf(phase2Heredoc);
    const nohupIdx = script.indexOf(nohupDetach);
    const disownIdx = script.indexOf(disown);

    expect(resultIdx).toBeGreaterThan(-1);
    expect(sshReadyIdx).toBeGreaterThan(-1);
    expect(phase2HeredocIdx).toBeGreaterThan(-1);
    expect(nohupIdx).toBeGreaterThan(-1);
    expect(disownIdx).toBeGreaterThan(-1);

    // The kickoff line MUST land before the SSH-ready loop (which lives in
    // Phase 2). If this regression fires, we're back to the 7-hour stuck
    // rows from 2026-04-28: provisioning takes longer than 300s, Vercel
    // kills the function, and the orphan row never gets a vmid/gateway_url.
    expect(resultIdx).toBeLessThan(sshReadyIdx);

    // Phase 2 must be wrapped in `nohup ... &` + `disown` so it survives the
    // SSH session close. Both are required: nohup blocks SIGHUP, disown
    // detaches from the shell's job table. The runner is written to a file
    // before nohup starts so large deploy payloads do not travel through argv.
    expect(phase2HeredocIdx).toBeLessThan(nohupIdx);
    expect(nohupIdx).toBeLessThan(disownIdx);
    expect(script).toContain('bash "$PHASE2_SCRIPT_FILE" >> "$PHASE2_LOG"');
    expect(script).toContain('< /dev/null &');

    // PHASE1_OK must flip to 1 AFTER the nohup line so the LOCKED EXIT
    // trap doesn't tear the (now Phase-2-owned) VM down.
    const phase1OkSetIdx = script.lastIndexOf("PHASE1_OK=1");
    expect(phase1OkSetIdx).toBeGreaterThan(disownIdx);
  });

  it("emits the CORS Caddy site when dashboardOrigin is provided and omits the retired signed-URL SSE lane", () => {
    // The signed-URL direct-browser SSE lane (@chatStart / @signedSseStream
    // matchers + forward_auth to /api/internal/agent-stream-auth) was
    // retired 2026-07-10: chat runs over the sidecar WS bridge, and the
    // box-side /api/chat/start + /api/chat/stream endpoints the lane
    // fronted answer 405/404 on current images. The dashboardOrigin branch
    // now only layers CORS headers on top of the bearer-auth catch-all.
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_direct_stream_001",
      vmName: "hermes-inst-direct-stream-001",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-direct.example.com",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
      dashboardOrigin: "https://hermesos.cloud",
    });

    // The bash script should bake DASHBOARD_ORIGIN as a literal so the
    // site config picks the correct branch at run time.
    expect(script).toContain("DASHBOARD_ORIGIN='https://hermesos.cloud'");

    // The retired signed-URL lane must not resurface in the template.
    expect(script).not.toContain("@chatStart");
    expect(script).not.toContain("@signedSseStream");
    expect(script).not.toContain("forward_auth");
    expect(script).not.toContain("agent-stream-auth");

    // hermes-warden (the per-box daily-compute-cap gate) was decommissioned
    // fleet-wide (2026-07); its snippet and fail-open sink must not
    // resurface either.
    expect(script).not.toContain("warden");
    expect(script).not.toContain(":7071");
    expect(script).not.toContain("uri /verdict");

    // CORS preflight handler must permit x-hermes-trace-id. The
    // dashboard stamps that header on every cross-origin chat fetch
    // (added with the trace-id propagation work); a preflight OPTIONS
    // response that doesn't list it makes the browser reject the
    // actual request with "Request header field x-hermes-trace-id is
    // not allowed by Access-Control-Allow-Headers in preflight
    // response" and chat fails 100% on every freshly-provisioned
    // agent. Pin both the directive shape AND the trace-id token so a
    // future Caddyfile edit can't drop it silently.
    expect(script).toContain(
      'header Access-Control-Allow-Headers "Content-Type, Authorization, x-hermes-trace-id"',
    );

    // Replace the upstream agent's Access-Control-Allow-Origin with
    // the dashboard origin. hermes-webui sets `Access-Control-Allow-
    // Origin: *` on chat-jobs responses; without overriding it the
    // browser sees TWO values ("https://hermesos.cloud, *") and CORS
    // forbids that. The fix that survived the 2026-04-30 regressions:
    // site-level bare set (`header @chatCors X "value"` — no strip
    // prefix) replaces upstream's value atomically and runs on every
    // response, while the reverse_proxy header_down strips peel off
    // the upstream's appended values on proxied responses. Both
    // directives must coexist.
    expect(script).toContain("@chatCors path /api/chat/* /api/chat-jobs/*");
    expect(script).toContain('header @chatCors Access-Control-Allow-Origin "${DASHBOARD_ORIGIN}"');
    expect(script).toContain('header @chatCors Access-Control-Allow-Credentials "true"');
    expect(script).toContain('header @chatCors Access-Control-Expose-Headers "X-Stream-Id, X-Session-Id"');
    expect(script).toContain("header_down -Access-Control-Allow-Origin");
    expect(script).toContain("header_down -Access-Control-Allow-Credentials");
    expect(script).toContain("header_down -Access-Control-Expose-Headers");
    // WS permessage-deflate fix (2026-06-26 fleet outage): strip the Sec-WebSocket-
    // Extensions offer so uvicorn never sends RSV1-compressed frames the browser
    // cannot decode -> "reserved bits are on" -> gateway WS dies.
    expect(script).toContain("header_up -Sec-WebSocket-Extensions");
    // Must NOT have the prior failing patterns:
    expect(script).not.toContain('header_down Access-Control-Allow-Origin "');
    expect(script).not.toContain("header @dashboardCors -Access-Control-Allow-Origin");

    // The hermes_caddy_reload helper MUST validate before reloading. The
    // host script runs under `set -e`, so a validate failure inside the
    // helper aborts before the reload — which means an invalid Caddyfile
    // template never gets swapped into the live config and never breaks
    // the OTHER agents already served by this Caddy. The cleanup_phase1 /
    // cleanup_phase2 traps also reload Caddy but those run AFTER they've
    // removed the per-instance site file (recovery from a failed
    // provision), so they don't need a separate validate.
    expect(script).toMatch(
      /hermes_caddy_reload\(\) \{[\s\S]+?caddy validate --config \/etc\/caddy\/Caddyfile[\s\S]+?timeout 20s caddy reload --config \/etc\/caddy\/Caddyfile --force/,
    );
  });

  it("falls back to the legacy bearer-only Caddy site when dashboardOrigin is empty so existing/un-migrated deployments keep working unchanged", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst_legacy_002",
      vmName: "hermes-inst-legacy-002",
      templateId: 9000,
      vmidStart: 200,
      vmidEnd: 250,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 2048,
      deployScript: "#!/usr/bin/env bash\necho deploy\n",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      gatewayHost: "inst-legacy.example.com",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "a".repeat(64),
      // dashboardOrigin intentionally omitted
    });

    expect(script).toContain("DASHBOARD_ORIGIN=''");
    // The shared builder chooses the variant at generation time.
    expect(script).not.toContain("Access-Control-Allow-Origin");
    // The legacy block must still have flush_interval -1 + read_timeout 0s
    // so streaming through the bearer-auth proxy keeps working.
    expect(script).toContain("flush_interval -1");
    expect(script).toContain("read_timeout 0s");
  });

  it("parses the metadata line from noisy host output", () => {
    const parsed = parseProxmoxProvisionOutput(
      'noise\nHERMES_PROXMOX_RESULT {"vmid":201,"privateIpv4":"10.250.20.51","gatewayHost":"abc.example.com"}\nmore noise'
    );

    expect(parsed).toEqual({
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "abc.example.com",
    });
  });

  it("extracts Proxmox infrastructure metadata from stored instance config", () => {
    const metadata = getProxmoxInfrastructure({
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc.example.com",
        templateVmid: 9007,
      },
    });

    expect(metadata).toEqual({
      provider: "proxmox",
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "abc.example.com",
      templateVmid: 9007,
    });
  });

  it("builds and parses a Proxmox template audit that protects linked-clone parents", () => {
    const hostScript = buildProxmoxTemplateAuditScript();
    expect(hostScript).toContain("qm list");
    expect(hostScript).toContain("QMCONFIG|");
    expect(hostScript).toContain("LVM|");
    expect(hostScript).toContain("ZFS|");

    const templateConfig = Buffer.from("name: hermes-template-old\ntemplate: 1\n").toString("base64");
    const currentTemplateConfig = Buffer.from("name: hermes-template-current\ntemplate: 1\n").toString("base64");
    const childConfig = Buffer.from(
      "name: hermes-live-agent\nscsi0: local-lvm:base-9000-disk-0/vm-201-disk-0,size=30G\n"
    ).toString("base64");
    const standaloneTemplateConfig = Buffer.from("name: hermes-template-unused\ntemplate: 1\n").toString("base64");

    const report = parseProxmoxTemplateAuditOutput(
      [
        "QMLIST|9000|hermes-template-old|stopped",
        "QMLIST|9001|hermes-template-current|stopped",
        "QMLIST|9002|hermes-template-unused|stopped",
        "QMLIST|201|hermes-live-agent|running",
        `QMCONFIG|9000|${templateConfig}`,
        `QMCONFIG|9001|${currentTemplateConfig}`,
        `QMCONFIG|9002|${standaloneTemplateConfig}`,
        `QMCONFIG|201|${childConfig}`,
        "LVM|pve|vm-202-disk-0|base-9000-disk-0|Vwi-aotz--",
      ].join("\n"),
      {
        currentTemplateVmid: 9001,
        dbTemplateVmids: [9000],
        generatedAt: "2026-05-02T19:45:00.000Z",
      }
    );

    expect(report.templates).toEqual([
      expect.objectContaining({
        vmid: 9000,
        decision: "KEEP_LINKED_PARENT",
        dependentVmids: [201, 202],
      }),
      expect.objectContaining({
        vmid: 9001,
        decision: "KEEP_CURRENT",
      }),
      expect.objectContaining({
        vmid: 9002,
        decision: "SAFE_TO_DELETE",
      }),
    ]);
  });

  it("builds a guarded Proxmox template prune script", () => {
    const script = buildProxmoxTemplatePruneScript([9002, 9002, 9003]);

    expect(script).toContain("TEMPLATE_VMIDS=(9002 9003)");
    expect(script).toContain("qm config \"$vmid\"");
    expect(script).toContain("grep -q '^template: 1$'");
    expect(script).toContain("qm destroy \"$vmid\" --purge 1");
    expect(script).toContain("HERMES_TEMPLATE_PRUNED");
  });

  it("builds a Proxmox infrastructure discovery script keyed by the deterministic VM name", () => {
    const script = buildProxmoxInfrastructureDiscoveryScript({
      vmName: "hermes-my-first-agent-fixturecase16",
    });

    expect(script).toContain("VM_NAME='hermes-my-first-agent-fixturecase16'");
    expect(script).toContain("qm list");
    expect(script).toContain("qm config \"$VMID\"");
    expect(script).toContain("HERMES_PROXMOX_DISCOVERY");
  });

  it("discovers Proxmox infrastructure for an orphaned provisioning row", async () => {
    const result = await discoverProxmoxInfrastructureForInstance(
      {
        instanceId: "00000000-0000-4000-8000-000000001042",
        instanceName: "MY_FIRST_AGENT",
        subdomain: "0d04200498b8983f9310",
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
        },
        runHostScript: async (script) => {
          expect(script).toContain("VM_NAME='hermes-my-first-agent-00000000'");
          return {
            ok: true,
            stdout:
              'noise\nHERMES_PROXMOX_DISCOVERY {"vmid":214,"privateIpv4":"10.250.20.64"}\n',
            stderr: "",
          };
        },
      }
    );

    expect(result).toEqual({
      provider: "proxmox",
      vmid: 214,
      privateIpv4: "10.250.20.64",
      gatewayHost: "0d04200498b8983f9310.203-0-113-10.sslip.io",
    });
  });

  it("recovers infrastructure with the right node slug when PROXMOX_NODE is unset and only HERMES_PROXMOX_TARGET points at the host", async () => {
    // Fixture Customer A / Fixture Customer B incident regression (2026-05-07): production sets
    // HERMES_PROXMOX_TARGET="fixturenodea" but leaves PROXMOX_NODE unset. The
    // recovery path used to read PROXMOX_NODE directly, get null, and
    // return a discovered infrastructure with NO `node` field. The post-
    // recovery DB write would persist proxmox_node = null for a row
    // whose VM actually lived on fixturenodea, and the next dashboard probe
    // routed via legacy NULL → fixturenodea, hit qm status missing, and auto-
    // deleted the row. Four rows (MY_FIRST_AGENT/fixturecase09, hhh_1995,
    // Demetra, Architect) ended up on this path before the fix.
    const result = await discoverProxmoxInfrastructureForInstance(
      {
        instanceId: "00000000-0000-4000-8000-000000001047",
        instanceName: "MY_FIRST_AGENT",
        subdomain: "stuck-prov-row",
      },
      {
        env: {
          // Simulates production: HERMES_PROXMOX_TARGET drives target
          // selection, PROXMOX_NODE is intentionally unset, PROXMOX_FIXTURENODE3_*
          // overrides supply the host config.
          HERMES_PROXMOX_TARGET: "fixturenode3",
          HERMES_PROXMOX_TARGETS: "fixturenode3,fixturenode2",
          PROXMOX_FIXTURENODE3_SSH_HOST: "198.51.100.52",
          PROXMOX_FIXTURENODE3_PUBLIC_IP: "198.51.100.52",
          PROXMOX_FIXTURENODE3_SSH_KEY_PATH: "/etc/hivra/keys/proxmox-admin",
        },
        runHostScript: async () => ({
          ok: true,
          stdout:
            'HERMES_PROXMOX_DISCOVERY {"vmid":318,"privateIpv4":"10.250.20.98"}\n',
          stderr: "",
        }),
      }
    );

    // Must include node="fixturenodea" so the DB row records the slug for the
    // host where the VM actually lives. If this regresses, the row will
    // get proxmox_node=null and the next GET probe will auto-delete it.
    expect(result).not.toBeNull();
    expect(result?.node).toBe("fixturenode3");
    expect(result?.vmid).toBe(318);
    expect(result?.privateIpv4).toBe("10.250.20.98");
  });

  it("builds a status script that returns STATUS <value> from qm output", () => {
    const script = buildProxmoxStatusScript(201);
    expect(script).toContain("qm status '201'");
    expect(script).toContain("STATUS");
  });

  it("builds a metrics script that samples real guest filesystem usage when SSH is available", () => {
    const script = buildProxmoxMetricsScript(201, {
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
    });

    expect(script).toContain("VMID='201'");
    expect(script).toContain("VM_SSH_USER='hermes'");
    expect(script).toContain("VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
    expect(script).toContain("qm config \"$VMID\"");
    expect(script).toContain("df -B1 /");
    expect(script).toContain("METRIC guest_disk_used_bytes=");
    expect(script).toContain("METRIC guest_disk_total_bytes=");
    expect(script).toContain("METRIC guest_disk_used_pct=");
    expect(script).toContain("METRIC cleanup_timer=");
  });

  it("reads cumulative CPU from the kvm process on PVE 9, where qm status prints no cpu", () => {
    // Real `buildProxmoxMetricsScript` output captured read-only on a
    // pve-manager 9.2.2 Hermes host on 2026-09-24. Scrubbed for the public
    // tree: VM name, vmid, pid and the machine-type suffix.
    const captured = readFileSync(
      join(__dirname, "fixtures", "proxmox-9-qm-metrics.capture.txt"),
      "utf8"
    );
    // PVE 9's one-shot `qm status --verbose` has no cpu/cputime line at all.
    expect(captured).not.toMatch(/^METRIC (cpu|cputime)=/m);

    const metrics = parseProxmoxMetricsOutput(captured);
    expect(metrics?.cpu_seconds_total).toBeCloseTo(228359.06, 2);
    expect(metrics?.cpu_seconds_source).toBe("kvm_proc");
    expect(metrics?.runtime_seconds).toBe(4773538);

    // Without the kvm lines (the old script) the same host yields 0 CPU —
    // every prod metering row since 2026-04-29 recorded exactly this.
    const legacy = parseProxmoxMetricsOutput(
      captured.replace(/^METRIC (proc_cpu_ticks|clk_tck)=.*$/gm, "")
    );
    expect(legacy?.cpu_seconds_total).toBe(0);
    expect(legacy?.cpu_seconds_source).toBe("none");
  });

  it("keeps qm cputime and the uptime*cpu estimate as fallbacks", () => {
    const withCputime = parseProxmoxMetricsOutput(
      ["METRIC status=running", "METRIC uptime=3600", "METRIC cputime=55.5", "METRIC cpu=0.5"].join("\n")
    );
    expect(withCputime?.cpu_seconds_total).toBe(55.5);
    expect(withCputime?.cpu_seconds_source).toBe("qm_cputime");

    const estimate = parseProxmoxMetricsOutput(
      ["METRIC status=running", "METRIC uptime=3600", "METRIC cpu=0.5"].join("\n")
    );
    expect(estimate?.cpu_seconds_total).toBe(1800);
    expect(estimate?.cpu_seconds_source).toBe("qm_cpu_estimate");
  });

  it("builds a metrics script that reads kvm CPU ticks from /proc for the right VM", () => {
    const script = buildProxmoxMetricsScript(201);
    expect(script).toContain('pid_file="/var/run/qemu-server/$VMID.pid"');
    expect(script).toContain('/proc/$kvm_pid/cmdline');
    expect(script).toContain("-id $VMID");
    expect(script).toContain("getconf CLK_TCK");
    expect(script).toContain("METRIC proc_cpu_ticks=");
    expect(script).toContain("METRIC clk_tck=");
  });

  it("prefers guest filesystem usage over Proxmox maxdisk fallback when parsing metrics", () => {
    const metrics = parseProxmoxMetricsOutput(
      [
        "METRIC status=running",
        "METRIC mem=2147483648",
        "METRIC maxmem=4294967296",
        "METRIC disk=0",
        "METRIC maxdisk=32212254720",
        "METRIC guest_disk_used_bytes=10737418240",
        "METRIC guest_disk_total_bytes=31138512896",
        "METRIC guest_disk_used_pct=37",
        "METRIC uptime=3600",
        "METRIC netout=1234",
        "METRIC cputime=55.5",
      ].join("\n")
    );

    expect(metrics?.disk_used_bytes).toBe(10737418240);
    expect(metrics?.disk_total_bytes).toBe(31138512896);
    expect(metrics?.raw.guest_disk_used_pct).toBe("37");
    // The real guest '/' total is surfaced for the disk-usage banner denominator.
    expect(metrics?.disk_total_bytes).toBe(31138512896);
    // A real df reading is NOT a capacity fallback.
    expect(metrics?.disk_used_is_capacity_fallback).toBe(false);
  });

  it("flags disk_used as a capacity fallback when only maxdisk is available", () => {
    const metrics = parseProxmoxMetricsOutput(
      [
        "METRIC status=running",
        "METRIC mem=2147483648",
        "METRIC maxmem=4294967296",
        "METRIC disk=0",
        "METRIC maxdisk=42949672960",
        // No guest df reading available (qemu-guest-agent / SSH unavailable).
        "METRIC uptime=3600",
        "METRIC netout=1234",
        "METRIC cputime=55.5",
      ].join("\n")
    );

    // disk_used falls back to maxdisk so the metering column is never empty...
    expect(metrics?.disk_used_bytes).toBe(42949672960);
    // ...but it's flagged as capacity, not a real usage reading...
    expect(metrics?.disk_used_is_capacity_fallback).toBe(true);
    // ...and there is no real measured total.
    expect(metrics?.disk_total_bytes).toBe(0);
  });

  it("leaves disk_total_bytes at 0 when no guest df total is available (maxdisk fallback)", () => {
    const metrics = parseProxmoxMetricsOutput(
      [
        "METRIC status=running",
        "METRIC mem=2147483648",
        "METRIC maxmem=4294967296",
        "METRIC disk=0",
        "METRIC maxdisk=32212254720",
        "METRIC uptime=3600",
        "METRIC netout=1234",
        "METRIC cputime=55.5",
      ].join("\n")
    );

    // disk_used_bytes still falls back to maxdisk for billing continuity, but
    // disk_total_bytes must NOT — pairing maxdisk-as-used with maxdisk-as-total
    // would read as 100% full. 0 => the storage banner shows nothing.
    expect(metrics?.disk_used_bytes).toBe(32212254720);
    expect(metrics?.disk_total_bytes).toBe(0);
  });

  it("getProxmoxInstanceStatus returns 'running' when qm reports status: running", async () => {
    const result = await getProxmoxInstanceStatus(201, {
      env: {
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
      },
      runHostScript: async () => ({
        ok: true,
        stdout: "STATUS running\n",
        stderr: "",
      }),
    });
    expect(result.status).toBe("running");
  });

  it("getProxmoxInstanceStatus returns 'stopped' + vmMissing=true when qm reports the VM is missing", async () => {
    const result = await getProxmoxInstanceStatus(201, {
      env: {
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
      },
      runHostScript: async () => ({
        ok: true,
        stdout: "STATUS missing\n",
        stderr: "",
      }),
    });
    expect(result.status).toBe("stopped");
    // Distinguishing the destroyed-VM case from a deliberately stopped VM
    // is what lets the route release the proxmox_vmid claim. Without this
    // flag, the next provision can't reuse the freed slot — it hits the
    // partial unique index and the post-provision UPDATE fails atomically,
    // leaving the new row with null vmid / null api_server_key /
    // null config.infrastructure (the regression from 2026-04-30).
    expect(result.vmMissing).toBe(true);
  });

  it("getProxmoxInstanceStatus does NOT set vmMissing when the VM is intentionally stopped (paused)", async () => {
    const result = await getProxmoxInstanceStatus(201, {
      env: {
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
      },
      runHostScript: async () => ({
        ok: true,
        stdout: "STATUS stopped\n",
        stderr: "",
      }),
    });
    expect(result.status).toBe("stopped");
    expect(result.vmMissing).toBeUndefined();
  });

  it("getProxmoxInstanceStatus returns 'error' when the host script itself fails", async () => {
    const result = await getProxmoxInstanceStatus(201, {
      env: {
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
      },
      runHostScript: async () => ({
        ok: false,
        stdout: "",
        stderr: "ssh failed",
      }),
    });
    expect(result.status).toBe("error");
  });

  it("classifies VMID range exhaustion from the provision script as retryable capacity", async () => {
    const result = await provisionProxmoxInstance(
      {
        userId: "user_vmid_race",
        instanceId: "inst_vmid_race",
        cpuLimit: 1,
        ramLimit: 1024,
        name: "VMID Race",
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: "openai/gpt-4o-mini",
        subdomain: null,
        backend: "gateway",
      },
      {
        env: {
          HERMES_PROXMOX_TARGET: "fixturenode13",
          PROXMOX_NODE: "fixturenode13",
          PROXMOX_PUBLIC_IP: "203.0.113.13",
          PROXMOX_SSH_HOST: "203.0.113.13",
          PROXMOX_SSH_KEY_PATH: "/tmp/hermes-proxmox-key",
          PROXMOX_VMID_START: "1300",
          PROXMOX_VMID_END: "1349",
        },
        buildDeployScript: () => "#!/usr/bin/env bash\necho ready\n",
        getReservedVmidsForNode: async () => [],
        runHostScript: async () => ({
          ok: false,
          stdout: "",
          stderr: "No free Proxmox VMID in range 1300-1349\n",
        }),
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        failureType: "proxmox_vmid_range_exhausted",
        targetId: "fixturenode13",
        vmidStart: 1300,
        vmidEnd: 1349,
      })
    );
  });

  it("falls back to the pinned hostConfig slug for the exhaustion result targetId", async () => {
    // Pinned host routing (explicit hostConfig) resolves env via prefixed
    // PROXMOX_HOST_<SLUG>_* keys and may leave PROXMOX_NODE unset — target
    // resolution then yields no id. The exhaustion result must still name
    // the host so createInstance's failover loop can identify (and exclude)
    // it instead of surfacing the raw allocator error to the user.
    const result = await provisionProxmoxInstance(
      {
        userId: "user_vmid_pinned",
        instanceId: "inst_vmid_pinned",
        cpuLimit: 1,
        ramLimit: 1024,
        name: "VMID Pinned",
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: "openai/gpt-4o-mini",
        subdomain: null,
        backend: "gateway",
      },
      {
        env: {
          PROXMOX_HOST_FIXTURENODE13_PUBLIC_IP: "203.0.113.13",
          PROXMOX_HOST_FIXTURENODE13_SSH_HOST: "203.0.113.13",
          PROXMOX_HOST_FIXTURENODE13_SSH_KEY_PATH: "/tmp/hermes-proxmox-key",
          PROXMOX_HOST_FIXTURENODE13_VMID_START: "1300",
          PROXMOX_HOST_FIXTURENODE13_VMID_END: "1349",
        },
        hostConfig: {
          hostSlug: "fixturenode13",
          failClosed: true,
        },
        buildDeployScript: () => "#!/usr/bin/env bash\necho ready\n",
        getReservedVmidsForNode: async () => [],
        runHostScript: async () => ({
          ok: false,
          stdout: "",
          stderr: "No free Proxmox VMID in range 1300-1349\n",
        }),
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        failureType: "proxmox_vmid_range_exhausted",
        targetId: "fixturenode13",
        vmidStart: 1300,
        vmidEnd: 1349,
      })
    );
  });

  it("getProxmoxInstanceStatus returns 'error' when Proxmox env is unconfigured (no silent success)", async () => {
    const result = await getProxmoxInstanceStatus(201, {
      env: {},
    });
    expect(result.status).toBe("error");
  });

  it("getProxmoxInstanceStatusBatch does ONE qm-list SSH for many vmids on the same host", async () => {
    // Regression guard: the dashboard instance-list endpoint used to do
    // one `qm status <vmid>` SSH per row. With this batched helper, a
    // 25-VM fleet on one host pays a single SSH round-trip.
    // buildProxmoxStatusBatchScript wraps `qm list` in awk so the SSH
    // stdout is already `<vmid> <status>` pairs by the time the parser
    // sees it. vmid 999 intentionally absent — caller should see
    // vmMissing=true via the absent-vmid branch.
    const runHostScript = jest.fn(async () => ({
      ok: true,
      stdout: [
        "201 running",
        "202 stopped",
        "203 paused",
      ].join("\n") + "\n",
      stderr: "",
    }));

    const results = await getProxmoxInstanceStatusBatch([201, 202, 203, 999], {
      env: {
        // Host-prefixed env vars matching hostSlug="fixturenodea" so
        // resolveProxmoxHostEnv finds matching overrides.
        PROXMOX_FIXTURENODE1_SSH_HOST: "203.0.113.10",
        PROXMOX_FIXTURENODE1_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
        PROXMOX_FIXTURENODE1_PUBLIC_IP: "203.0.113.10",
      },
      hostConfig: { hostSlug: "fixturenode1" },
      runHostScript,
    });

    expect(runHostScript).toHaveBeenCalledTimes(1);
    expect(results.get(201)).toEqual({ status: "running" });
    expect(results.get(202)).toEqual({ status: "stopped" });
    expect(results.get(203)).toEqual({ status: "stopped" });
    expect(results.get(999)).toEqual({ status: "stopped", vmMissing: true });
  });

  it("getProxmoxInstanceStatusBatch returns empty map for empty input (no SSH)", async () => {
    const runHostScript = jest.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const results = await getProxmoxInstanceStatusBatch([], {
      env: {
        PROXMOX_FIXTURENODE1_SSH_HOST: "h",
        PROXMOX_FIXTURENODE1_SSH_KEY_PATH: "/k",
        PROXMOX_FIXTURENODE1_PUBLIC_IP: "h",
      },
      hostConfig: { hostSlug: "fixturenode1" },
      runHostScript,
    });
    expect(runHostScript).not.toHaveBeenCalled();
    expect(results.size).toBe(0);
  });

  it("getProxmoxInstanceStatusBatch reports error per-vmid when the qm-list SSH itself fails", async () => {
    const runHostScript = jest.fn(async () => ({
      ok: false,
      stdout: "",
      stderr: "ssh: connect to host port 22: Connection timed out",
    }));
    const results = await getProxmoxInstanceStatusBatch([201, 202], {
      env: {
        PROXMOX_FIXTURENODE1_SSH_HOST: "h",
        PROXMOX_FIXTURENODE1_SSH_KEY_PATH: "/k",
        PROXMOX_FIXTURENODE1_PUBLIC_IP: "h",
      },
      hostConfig: { hostSlug: "fixturenode1" },
      runHostScript,
    });
    expect(results.get(201)).toEqual({ status: "error" });
    expect(results.get(202)).toEqual({ status: "error" });
  });

  it("builds a delete script that destroys only the recorded VM and removes its Caddy route", () => {
    const script = buildProxmoxDeleteScript({
      vmid: 201,
      expectedInstanceId: "00000000-0000-4000-8000-000000001036",
      gatewayHost: "abc.example.com",
      caddySitesDir: "/etc/caddy/hermes.d",
    });

    expect(script).toContain("qm stop 201");
    expect(script).toContain("HERMES_PROXMOX_DELETE_IDENTITY_MISMATCH 201");
    expect(script).toContain("-00000000");
    expect(script).toContain("qm destroy 201 --purge 1");
    expect(script).toContain("rm -f '/etc/caddy/hermes.d/abc.example.com.caddy'");
    expect(script).toContain("timeout 20s caddy reload --config /etc/caddy/Caddyfile --force");
    expect(script).not.toMatch(/^\s*systemctl reload caddy/m);
    expect(script).toContain("systemctl reset-failed caddy");
    expect(script).toContain("systemctl start caddy");
  });

  it("tries graceful qm shutdown before falling back to qm stop", () => {
    // Two-phase stop: webui / sidecar / Caddy inside the VM get a chance to
    // flush state. Hard-stop is only the fallback when ACPI shutdown times out.
    const script = buildProxmoxDeleteScript({
      vmid: 201,
      expectedInstanceId: "00000000-0000-4000-8000-000000001036",
      gatewayHost: "abc.example.com",
      caddySitesDir: "/etc/caddy/hermes.d",
      gracefulShutdownTimeoutSeconds: 45,
    });

    expect(script).toMatch(/qm shutdown 201 --timeout 45/);
    expect(script).toContain("HERMES_PROXMOX_DELETE_VM_GRACEFUL_SHUTDOWN 201");
    expect(script).toContain("HERMES_PROXMOX_DELETE_VM_GRACEFUL_TIMEOUT 201");
    // Fallback to hard stop is only invoked in the timeout branch.
    expect(script).toContain("qm stop 201 --skiplock 1");
    // Default timeout if not provided is 30s.
    const defaultScript = buildProxmoxDeleteScript({
      vmid: 201,
      expectedInstanceId: "00000000-0000-4000-8000-000000001036",
      gatewayHost: "abc.example.com",
      caddySitesDir: "/etc/caddy/hermes.d",
    });
    expect(defaultScript).toMatch(/qm shutdown 201 --timeout 30/);
  });

  it("builds an idempotent delete script that still succeeds after the VM is already gone", () => {
    const script = buildProxmoxDeleteScript({
      vmid: 201,
      expectedInstanceId: "00000000-0000-4000-8000-000000001036",
      gatewayHost: "abc.example.com",
      caddySitesDir: "/etc/caddy/hermes.d",
    });

    expect(script).toContain("if qm status 201 >/dev/null 2>&1");
    expect(script).toContain("HERMES_PROXMOX_DELETE_VM_MISSING 201");
    expect(script).toContain("HERMES_PROXMOX_DELETE_VM_DESTROYED 201");
    expect(script).toContain("HERMES_PROXMOX_DELETE_CADDY_RELOAD_FAILED");
    expect(script).not.toMatch(/^qm destroy 201 --purge 1$/m);
  });

  it("builds a caddy-site cleanup script that removes the site file and validate-then-reloads", () => {
    const script = buildProxmoxCaddySiteCleanupScript({
      gatewayHosts: ["abc.hermesos.cloud"],
      caddySitesDir: "/etc/caddy/hermes.d",
    });

    // Removes the exact per-instance site file (the cross-tenant-leak source).
    expect(script).toContain("rm -f '/etc/caddy/hermes.d/abc.hermesos.cloud.caddy'");
    expect(script).toContain("HERMES_CADDY_SITE_REMOVED abc.hermesos.cloud");
    // Validate BEFORE reload (mirrors hermes_caddy_reload) so a broken
    // neighbour file can't get reloaded into the running daemon.
    const validateIdx = script.indexOf("caddy validate --config /etc/caddy/Caddyfile");
    const reloadIdx = script.indexOf("caddy reload --config /etc/caddy/Caddyfile --force");
    expect(validateIdx).toBeGreaterThan(-1);
    expect(reloadIdx).toBeGreaterThan(validateIdx);
    // Recovery path when the daemon died under reload churn.
    expect(script).toContain("systemctl reset-failed caddy");
    expect(script).toContain("systemctl start caddy");
    expect(script).toContain("HERMES_CADDY_CLEANUP_RELOADED");
    // Removing a reverse_proxy site never invalidates the config, so a failed
    // validate must refuse the reload rather than push a broken config live.
    expect(script).toContain("HERMES_CADDY_CLEANUP_INVALID_CONFIG");
  });

  it("removes every requested site file in one batched cleanup script", () => {
    const script = buildProxmoxCaddySiteCleanupScript({
      gatewayHosts: ["one.hermesos.cloud", "two.hermesos.cloud"],
      caddySitesDir: "/etc/caddy/hermes.d/",
    });
    // Trailing slash on caddySitesDir is normalised (no double slash).
    expect(script).toContain("rm -f '/etc/caddy/hermes.d/one.hermesos.cloud.caddy'");
    expect(script).toContain("rm -f '/etc/caddy/hermes.d/two.hermesos.cloud.caddy'");
    expect(script).not.toContain("//one.hermesos.cloud");
    // One reload covers all removals.
    expect((script.match(/caddy reload --config/g) ?? []).length).toBe(1);
  });

  it("builds a dormant archive script that backs up without destroying the VM", () => {
    const script = buildProxmoxDormantArchiveScript({
      vmid: 610,
      archiveDir: "/mnt/hermes-dormant",
      instanceId: "inst_610",
    });

    expect(script).toContain("vzdump \"$VMID\"");
    expect(script).toContain("--mode stop");
    expect(script).toContain("--compress zstd");
    expect(script).toContain("--dumpdir \"$ARCHIVE_DIR\"");
    expect(script).toContain("HERMES_DORMANT_ARCHIVE_PATH=");
    expect(script).toContain("HERMES_DORMANT_ARCHIVE_SIZE_BYTES=");
    expect(script).not.toContain("qm destroy");
    expect(script).not.toContain("rm -f /run/hermes-vm-claims");
  });

  it("builds idempotent Proxmox power scripts for pause and resume", () => {
    const shutdown = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID,
      vmid: 201,
      action: "shutdown",
      shutdownTimeoutSeconds: 45,
    });
    const start = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, action: "start" });

    expect(shutdown).toContain('qm status 201 | grep -q "status: stopped"');
    expect(shutdown).toContain("qm shutdown 201 --timeout 45 || qm stop 201 --skiplock 1");
    expect(start).toContain('qm status 201 | grep -q "status: running"');
    expect(start).toContain("qm start 201");
  });

  it("verifies the guest is actually DOWN before reporting shutdown success", () => {
    // `qm shutdown`/`qm stop` exiting 0 means "accepted", not "powered off". The
    // shutdown script must poll until `qm status` says stopped, force-stop each
    // round, and FAIL with HERMES_STILL_RUNNING if the guest never dies — so the
    // caller never records paused/stopped for a VM that is still running.
    const shutdown = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, action: "shutdown" });
    expect(shutdown).toContain("for _ in $(seq 1 8); do");
    expect(shutdown).toContain('qm status 201 | grep -q "status: stopped"');
    expect(shutdown).toContain("qm stop 201 --skiplock 1 >/dev/null 2>&1 || true");
    expect(shutdown).toContain(PROXMOX_VM_STILL_RUNNING_MARKER);
    expect(shutdown).toContain("exit 65");

    // The verify-down loop is shutdown-only: start never force-stops, and reboot
    // must still come back up (it is allowed to leave the VM running).
    const start = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, action: "start" });
    const reboot = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, action: "reboot" });
    expect(start).not.toContain(PROXMOX_VM_STILL_RUNNING_MARKER);
    expect(reboot).not.toContain(PROXMOX_VM_STILL_RUNNING_MARKER);
  });

  it("isProxmoxVmStillRunningResult detects the marker only on a failed result", () => {
    expect(
      isProxmoxVmStillRunningResult({
        ok: false,
        stdout: `noise\n${PROXMOX_VM_STILL_RUNNING_MARKER}\n`,
        stderr: "",
      }),
    ).toBe(true);
    // A success that happens to echo the token is NOT a still-running failure.
    expect(
      isProxmoxVmStillRunningResult({
        ok: true,
        stdout: PROXMOX_VM_STILL_RUNNING_MARKER,
        stderr: "",
      }),
    ).toBe(false);
    expect(
      isProxmoxVmStillRunningResult({ ok: false, stdout: "", stderr: "" }),
    ).toBe(false);
  });

  it("leaves onboot untouched by default (no qm set) for every action", () => {
    for (const action of ["start", "shutdown", "reboot"] as const) {
      const script = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, action });
      expect(script).not.toContain("--onboot");
    }
  });

  it("clears onboot on pause (setOnboot:0) BEFORE the power action and best-effort", () => {
    const shutdown = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID,
      vmid: 201,
      action: "shutdown",
      setOnboot: 0,
    });
    // Best-effort: never fails the pause even if `qm set` errors.
    expect(shutdown).toContain("qm set 201 --onboot 0 >/dev/null 2>&1 || true");
    // Must run BEFORE the shutdown's early `exit 0` so onboot is cleared even
    // when the VM is already (auto-booted-then-)stopped or already up.
    const onbootIdx = shutdown.indexOf("--onboot 0");
    const earlyExitIdx = shutdown.indexOf('grep -q "status: stopped"');
    expect(onbootIdx).toBeGreaterThan(-1);
    expect(onbootIdx).toBeLessThan(earlyExitIdx);
  });

  it("restores onboot on resume (setOnboot:1) so a resumed agent survives host reboots", () => {
    const start = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID,
      vmid: 201,
      action: "start",
      setOnboot: 1,
    });
    expect(start).toContain("qm set 201 --onboot 1 >/dev/null 2>&1 || true");
    const onbootIdx = start.indexOf("--onboot 1");
    const startIdx = start.indexOf("qm start 201");
    expect(onbootIdx).toBeLessThan(startIdx);
  });

  it("threads setOnboot through shutdownProxmoxInstance / startProxmoxInstance", async () => {
    const scripts: string[] = [];
    const runner = async (script: string) => {
      scripts.push(script);
      return { ok: true, stdout: "", stderr: "" };
    };

    await shutdownProxmoxInstance(
      { vmid: 201 },
      { expectedInstanceId: TEST_INSTANCE_ID, runHostScript: runner, setOnboot: 0 },
    );
    await startProxmoxInstance(
      { vmid: 201 },
      { expectedInstanceId: TEST_INSTANCE_ID, runHostScript: runner, setOnboot: 1 },
    );

    expect(scripts[0]).toContain("qm set 201 --onboot 0");
    expect(scripts[1]).toContain("qm set 201 --onboot 1");
  });

  it("emits a missing-VM marker before any qm action so callers can flip the row to error", () => {
    // Regression: when Phase 2 bootstrap cleanup destroys a VM after a
    // transient apt-lock failure, the row was left at status='stopped'
    // with proxmox_vmid still populated. The next `qm start <vmid>` exits
    // 255 ("config does not exist") and surfaced as "Remote bash exited
    // with code 255" with no actionable hint. The pre-flight check makes
    // the destroyed-VM case detectable up front.
    for (const action of ["start", "shutdown", "reboot"] as const) {
      const script = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, action });
      expect(script).toContain(`if ! qm status 201 >/dev/null 2>&1`);
      expect(script).toContain(PROXMOX_VM_MISSING_MARKER);
      expect(script).toContain("exit 64");
    }
  });

  it("classifies a HostScriptResult as VM-missing when the marker is on stdout", () => {
    expect(
      isProxmoxVmMissingResult({
        ok: false,
        stdout: `${PROXMOX_VM_MISSING_MARKER}\n`,
        stderr: "",
        error: "Remote bash exited with code 64",
      })
    ).toBe(true);

    // Successful runs that happen to mention the marker (e.g. a Caddyfile
    // comment that reuses the constant) are NOT classified as missing.
    expect(
      isProxmoxVmMissingResult({
        ok: true,
        stdout: PROXMOX_VM_MISSING_MARKER,
        stderr: "",
      })
    ).toBe(false);

    // The default exit-255 case (e.g. SSH connect failure) is not a
    // missing-VM signal — keep the existing error path.
    expect(
      isProxmoxVmMissingResult({
        ok: false,
        stdout: "",
        stderr: "qm: VM 201 is locked",
        error: "Remote bash exited with code 1",
      })
    ).toBe(false);
  });

  it("runs Proxmox pause and resume scripts against the recorded VMID", async () => {
    const scripts: string[] = [];
    const runner = async (script: string) => {
      scripts.push(script);
      return { ok: true, stdout: "", stderr: "" };
    };

    await shutdownProxmoxInstance({ vmid: 201 }, { expectedInstanceId: TEST_INSTANCE_ID, runHostScript: runner });
    await startProxmoxInstance({ vmid: 201 }, { expectedInstanceId: TEST_INSTANCE_ID, runHostScript: runner });

    expect(scripts[0]).toContain("qm shutdown 201");
    expect(scripts[1]).toContain("qm start 201");
  });

  it("builds a reboot script that recovers stopped VMs and falls back through stop+start", () => {
    const reboot = buildProxmoxPowerScript({ expectedInstanceId: TEST_INSTANCE_ID,
      vmid: 201,
      action: "reboot",
      shutdownTimeoutSeconds: 60,
    });

    expect(reboot).toContain('qm status 201 | grep -q "status: stopped"');
    expect(reboot).toContain("qm reboot 201 --timeout 60");
    expect(reboot).toContain("qm shutdown 201 --timeout 60 || qm stop 201 --skiplock 1");
    expect(reboot).toContain("qm start 201");
  });

  it("runs the reboot script against the recorded VMID", async () => {
    const scripts: string[] = [];
    const runner = async (script: string) => {
      scripts.push(script);
      return { ok: true, stdout: "", stderr: "" };
    };

    await rebootProxmoxInstance({ vmid: 201 }, { expectedInstanceId: TEST_INSTANCE_ID, runHostScript: runner });

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("qm reboot 201");
  });

  it("builds and runs Proxmox resize scripts without touching disk size", async () => {
    const resizeScript = buildProxmoxResizeScript({ expectedInstanceId: TEST_INSTANCE_ID,
      vmid: 201,
      cores: 2,
      memoryMb: 4096,
    });

    expect(resizeScript).toContain("CPU_LIMIT='2'");
    expect(resizeScript).toContain('qm set "$VMID" --cores "$CORES" --cpulimit "$CPU_LIMIT" --memory "$MEMORY_MB" --balloon "$BALLOON_FLOOR_MB"');
    // No balloonFloorMb passed → floor matches memory (legacy fully-pinned).
    expect(resizeScript).toContain("BALLOON_FLOOR_MB='4096'");
    expect(resizeScript).not.toContain("--scsi0");
    expect(resizeScript).not.toContain("qm resize");

    const scripts: string[] = [];
    const runner = async (script: string) => {
      scripts.push(script);
      return { ok: true, stdout: "", stderr: "" };
    };

    await resizeProxmoxInstance(
      { vmid: 201 },
      { cpuLimit: 2, ramLimit: 4096 },
      { expectedInstanceId: TEST_INSTANCE_ID, runHostScript: runner }
    );

    expect(scripts[0]).toContain("VMID='201'");
    expect(scripts[0]).toContain("CORES='2'");
    expect(scripts[0]).toContain("MEMORY_MB='4096'");
  });

  it("resizeProxmoxVm sets --cores (delivers tier vCPUs) and reboots only on core increase", async () => {
    // The old "hot, no --cores" path was COSMETIC: --cpulimit 2 on a 1-vCPU VM
    // can't actually use 2 cores (a single vCPU caps at 1 core of compute), so
    // Stripe upgrades never delivered capacity AND broke `docker compose up`
    // (deploy.resources.limits.cpus = cpuLimit exceeded the VM's 1 available
    // CPU → "range of CPUs is from 0.01 to 1.00"). We now set --cores too.
    // Cores only take effect after a restart, so we reboot ONLY when the count
    // increases (an upgrade); downgrades stay hot (lower cores apply on the next
    // natural restart and a VM with extra cores runs the lower limit fine).
    const scripts: string[] = [];
    const runner = async (script: string) => {
      scripts.push(script);
      return { ok: true, stdout: "cores: 2\ncpulimit: 2\nmemory: 4096", stderr: "" };
    };

    await resizeProxmoxVm(
      { expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, cpuLimit: 2, memoryMb: 4096 },
      { runHostScript: runner }
    );

    expect(scripts[0]).toContain("VMID='201'");
    expect(scripts[0]).toContain("CPU_LIMIT='2'");
    expect(scripts[0]).toContain("CORES='2'");
    expect(scripts[0]).toContain("MEMORY_MB='4096'");
    // Live caps still applied (hot)
    expect(scripts[0]).toContain("--cpulimit");
    expect(scripts[0]).toContain("--memory");
    expect(scripts[0]).toContain("--balloon");
    // Now also sets the guest-visible vCPU topology so nproc matches the tier
    expect(scripts[0]).toContain("--cores");
    // Reboots only when cores increase (delivers the upgrade); downgrades stay hot
    expect(scripts[0]).toContain('[ "$CORES" -gt "$CUR_CORES" ]');
    expect(scripts[0]).toContain("qm reboot");
  });

  describe("resizeProxmoxVm container cgroup reapply", () => {
    // Regression: a paid upgrade resized the VM 1024 -> 4096 MB
    // (guest `free -m` showed 3915, load fell 11.57 -> 0.28) but `docker
    // inspect` still reported Memory=1073741824 / NanoCpus=500000000 on both
    // `-gateway` and `-official-dashboard`. Node reads the CGROUP, not
    // /proc/meminfo, so v8 heap_size_limit stayed at 524 MB on a 4 GB box and
    // the customer's `next build` still died — now with "Ineffective
    // mark-compacts near heap limit"/SIGABRT instead of the earlier kernel-OOM
    // SIGKILL. `qm set` alone can never fix that; the container limit is a
    // separate ceiling that has to be moved too.
    const decodeGuestScript = (hostScript: string): string => {
      const match = hostScript.match(/GUEST_CGROUP_B64='([^']+)'/);
      if (!match) throw new Error("host script carries no GUEST_CGROUP_B64 payload");
      return Buffer.from(match[1], "base64").toString("utf8");
    };

    const runResize = async (
      params: { vmid: number; cpuLimit: number; memoryMb: number },
      env?: Record<string, string>
    ) => {
      const scripts: string[] = [];
      await resizeProxmoxVm({ ...params, expectedInstanceId: TEST_INSTANCE_ID }, {
        runHostScript: async (script) => {
          scripts.push(script);
          return { ok: true, stdout: "", stderr: "" };
        },
        ...(env ? { env } : {}),
      });
      return scripts[0];
    };

    it("docker updates the agent containers onto the new ceiling on an upgrade", async () => {
      const script = await runResize({ vmid: 1148, cpuLimit: 2, memoryMb: 4096 });
      const guest = decodeGuestScript(script);

      // The VM ceiling and the container ceiling are the SAME number.
      expect(script).toContain("MEMORY_MB='4096'");
      expect(guest).toContain("MEM_MB='4096'");
      expect(guest).toContain("CPUS='2'");
      // memory-swap must ride along: docker rejects a --memory raise that
      // exceeds the container's existing swap limit, and 2x mirrors what
      // compose's `limits.memory` produces so a later recreate agrees.
      expect(guest).toContain("SWAP_MB=$(( MEM_MB * 2 ))");
      expect(guest).toContain(
        'docker update --memory "${MEM_MB}m" --memory-swap "${SWAP_MB}m" --cpus "$CPUS_EFF" "$name"'
      );
      // Both agent-bearing containers; the fixed-size system sidecars are not
      // tier-scaled and must be left alone.
      expect(guest).toContain("'^agent-.+-(gateway|official-dashboard)$'");
      expect(guest).not.toContain("browser-sidecar");
      expect(guest).not.toContain("autoheal");
    });

    it("reapplies the ceiling before the reboot, then again after it", async () => {
      const script = await runResize({ vmid: 1148, cpuLimit: 2, memoryMb: 4096 });
      const preIndex = script.indexOf("reapply_container_caps pre-reboot");
      const rebootIndex = script.indexOf("qm reboot");
      const postIndex = script.indexOf("reapply_container_caps post-reboot");

      // Pre-reboot is the load-bearing one: docker update persists into
      // hostconfig.json, so the RAM ceiling survives the restart even if the
      // function's budget runs out before the guest is back.
      expect(preIndex).toBeGreaterThan(-1);
      expect(preIndex).toBeLessThan(rebootIndex);
      // Post-reboot only exists to raise --cpus once the new vCPUs are visible.
      expect(postIndex).toBeGreaterThan(rebootIndex);
    });

    it("clamps --cpus to the guest's nproc so a stale core count can't block the RAM fix", async () => {
      // Pre-reboot the guest still reports the OLD nproc. `docker update --cpus 2`
      // on a 1-vCPU guest errors ("range of CPUs is from 0.01 to 1.00") and would
      // take the memory limit down with it, which is the cap that actually
      // breaks builds. Clamp, and let the post-reboot pass raise it.
      const guest = decodeGuestScript(await runResize({ vmid: 1148, cpuLimit: 2, memoryMb: 4096 }));
      expect(guest).toContain('NPROC="$(nproc 2>/dev/null || echo 1)"');
      expect(guest).toContain('printf "%.2f", (c < n ? c : n)');
      // …and a memory-only retry if docker still refuses the cpus value.
      expect(guest).toContain(
        '|| docker update --memory "${MEM_MB}m" --memory-swap "${SWAP_MB}m" "$name"'
      );
    });

    it("never fails the resize when the guest is unreachable", async () => {
      const script = await runResize({ vmid: 1148, cpuLimit: 2, memoryMb: 4096 });
      // Missing IP / key → skip, don't abort the (already-applied) qm set.
      expect(script).toContain("no guest SSH route available; skipped");
      expect(script).toContain("return 0");
      // The durable backstop is still the recreate sweep, so say so.
      expect(script).toContain("tier_change_pending recreate remains the backstop");
      // Guest script is best-effort: no `set -e`.
      expect(decodeGuestScript(script)).toContain("set -uo pipefail");
    });

    it("uses the RAM-burst ceiling — not the baseline — when burst is on", async () => {
      // resolveRamBurst puts the VM's boot memory at the ceiling; the container
      // cgroup has to match or the burst headroom is unreachable from the agent.
      const script = await runResize(
        { vmid: 1148, cpuLimit: 2, memoryMb: 4096 },
        {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/etc/hivra/keys/proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          HERMES_RAM_BURST_ENABLED: "true",
        }
      );
      expect(script).toContain("MEMORY_MB='8192'");
      // Balloon floor stays at the paid baseline; the container gets the ceiling.
      expect(script).toContain("BALLOON_FLOOR_MB='4096'");
      expect(decodeGuestScript(script)).toContain("MEM_MB='8192'");
    });

    it("routes guest SSH through the host's configured VM key/user", async () => {
      const script = await runResize(
        { vmid: 1148, cpuLimit: 2, memoryMb: 4096 },
        {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/etc/hivra/keys/proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_VM_SSH_USER: "hermes",
          PROXMOX_VM_SSH_KEY_PATH: "/etc/hivra/keys/vm-orchestrator",
        }
      );
      expect(script).toContain("VM_SSH_USER='hermes'");
      expect(script).toContain("VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
      // Private IP comes from this VM's own ipconfig0 — guest IPs collide
      // across pve hosts, so it must never be guessed or reused.
      expect(script).toContain('PRIVATE_IP="$(qm config "$VMID"');
    });

    // Executable checks: string assertions can't catch a shell bug, and this is
    // generated bash that only ever runs on a box we can't reach from CI. These
    // run the real scripts against shimmed `docker`/`nproc` binaries.
    describe("executed against a shimmed guest", () => {
      // This suite mocks child_process down to `spawn` (see the top of the
      // file), so reach past the mock for the real one — otherwise every check
      // below silently skips.
      const { execFileSync } = jest.requireActual("child_process") as typeof import("child_process");
      const bashAvailable = (() => {
        try {
          execFileSync("bash", ["-c", "true"], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })();
      const maybeIt = bashAvailable ? it : it.skip;

      /**
       * Run the guest script with fake `docker`/`nproc` on PATH. Returns every
       * `docker update` argv the script issued.
       */
      const runGuest = (
        opts: { memoryMb: number; cpus: number },
        guest: { nproc: number; containers: string[]; rejectCpus?: boolean }
      ): { updates: string[]; stdout: string } => {
        const dir = mkdtempSync(join(tmpdir(), "hermes-cgroup-test-"));
        const log = join(dir, "updates.log");
        writeFileSync(
          join(dir, "docker"),
          `#!/usr/bin/env bash
case "$1" in
  ps) printf '%s\\n' ${guest.containers.map((c) => `'${c}'`).join(" ")} ;;
  inspect) echo 1073741824 ;;
  update)
    shift
    echo "$*" >> ${JSON.stringify(log)}
    ${guest.rejectCpus ? 'case "$*" in *--cpus*) exit 125 ;; esac' : ""}
    exit 0 ;;
esac
`,
          { mode: 0o755 }
        );
        writeFileSync(join(dir, "nproc"), `#!/usr/bin/env bash\necho ${guest.nproc}\n`, { mode: 0o755 });
        chmodSync(join(dir, "docker"), 0o755);
        chmodSync(join(dir, "nproc"), 0o755);

        const stdout = execFileSync("bash", ["-s"], {
          input: buildAgentContainerCgroupScript(opts),
          env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
          encoding: "utf8",
        });
        const updates = existsSync(log)
          ? readFileSync(log, "utf8").split("\n").filter(Boolean)
          : [];
        return { updates, stdout };
      };

      maybeIt("raises the cgroup ceiling on exactly the two agent containers", () => {
        // THE regression: pre-fix, nothing ever issued this command and the
        // container stayed at the old tier's 1 GB on a 4 GB VM.
        const { updates } = runGuest(
          { memoryMb: 4096, cpus: 2 },
          {
            nproc: 2,
            containers: [
              "agent-fixturecase23-gateway",
              "agent-fixturecase23-official-dashboard",
              "agent-fixturecase23-browser-sidecar",
              "agent-fixturecase23-autoheal",
              "agent-fixturecase23-dashboard-sidecar",
            ],
          }
        );

        expect(updates).toEqual([
          "--memory 4096m --memory-swap 8192m --cpus 2.00 agent-fixturecase23-gateway",
          "--memory 4096m --memory-swap 8192m --cpus 2.00 agent-fixturecase23-official-dashboard",
        ]);
      });

      maybeIt("clamps cpus to nproc but still delivers the full memory ceiling", () => {
        // Pre-reboot shape: VM already grown to 4 GB, guest still at 1 vCPU.
        const { updates } = runGuest(
          { memoryMb: 4096, cpus: 2 },
          { nproc: 1, containers: ["agent-fixturecase23-gateway"] }
        );
        expect(updates).toEqual([
          "--memory 4096m --memory-swap 8192m --cpus 1.00 agent-fixturecase23-gateway",
        ]);
      });

      maybeIt("falls back to a memory-only update when docker rejects the cpus value", () => {
        const { updates, stdout } = runGuest(
          { memoryMb: 4096, cpus: 2 },
          { nproc: 2, containers: ["agent-fixturecase23-gateway"], rejectCpus: true }
        );
        expect(updates).toEqual([
          "--memory 4096m --memory-swap 8192m --cpus 2.00 agent-fixturecase23-gateway",
          "--memory 4096m --memory-swap 8192m agent-fixturecase23-gateway",
        ]);
        expect(stdout).toContain("1 container(s) set to 4096M");
      });

      maybeIt("exits clean on a guest with no matching containers", () => {
        const { updates, stdout } = runGuest(
          { memoryMb: 4096, cpus: 2 },
          { nproc: 2, containers: ["some-other-container"] }
        );
        expect(updates).toEqual([]);
        expect(stdout).toContain("0 container(s)");
      });

      maybeIt("emits syntactically valid bash for both the host and guest halves", async () => {
        // Generated shell is only exercised on a Proxmox host; a syntax error
        // ships silently and turns every tier upgrade into a failed resize.
        let host = "";
        await resizeProxmoxVm(
          { expectedInstanceId: TEST_INSTANCE_ID, vmid: 1148, cpuLimit: 2, memoryMb: 4096 },
          {
            runHostScript: async (s) => {
              host = s;
              return { ok: true, stdout: "", stderr: "" };
            },
          }
        );
        expect(() => execFileSync("bash", ["-n"], { input: host, stdio: "pipe" })).not.toThrow();
        expect(() =>
          execFileSync("bash", ["-n"], {
            input: buildAgentContainerCgroupScript({ memoryMb: 4096, cpus: 0.5 }),
            stdio: "pipe",
          })
        ).not.toThrow();
      });
    });
  });

  it("resolveProxmoxBalloonFloorMb never starves a sidecar-sized ceiling", () => {
    expect(resolveProxmoxBalloonFloorMb(4096, 1024)).toBe(2560);
    expect(resolveProxmoxBalloonFloorMb(8192, 1024)).toBe(2560);
    expect(resolveProxmoxBalloonFloorMb(4096)).toBe(4096);
    expect(resolveProxmoxBalloonFloorMb(2048, 1024)).toBe(1024);
    expect(resolveProxmoxBalloonFloorMb(1024, 1024)).toBe(1024);
  });

  it("buildProxmoxResizeScript honours balloonFloorMb when set lower than memoryMb", () => {
    // fixturenodea incident 2026-05-07: 126 GB committed across 45 VMs on a 62 GB
    // host. With balloon = memory the host can never reclaim unused guest
    // RAM, so VMs hang under sustained pressure. Setting balloon < memory
    // lets Proxmox shrink/grow guest RAM dynamically — but a sidecar-sized
    // ceiling (Jarvis fixturenodea/1200) must never drop below 2560 or the
    // browser sidecar exits 0 forever.
    const script = buildProxmoxResizeScript({ expectedInstanceId: TEST_INSTANCE_ID,
      vmid: 201,
      cores: 2,
      memoryMb: 8192,
      balloonFloorMb: 1024,
    });
    expect(script).toContain("MEMORY_MB='8192'");
    expect(script).toContain("BALLOON_FLOOR_MB='2560'");
    expect(script).toContain('--memory "$MEMORY_MB" --balloon "$BALLOON_FLOOR_MB"');
  });

  it("buildProxmoxResizeScript clamps balloonFloorMb to [64, memoryMb]", () => {
    const tooLow = buildProxmoxResizeScript({ expectedInstanceId: TEST_INSTANCE_ID, vmid: 1, cores: 1, memoryMb: 2048, balloonFloorMb: 8 });
    expect(tooLow).toContain("BALLOON_FLOOR_MB='64'");

    const tooHigh = buildProxmoxResizeScript({ expectedInstanceId: TEST_INSTANCE_ID, vmid: 1, cores: 1, memoryMb: 2048, balloonFloorMb: 9999 });
    expect(tooHigh).toContain("BALLOON_FLOOR_MB='2048'");
  });

  it("resizeProxmoxVm reads PROXMOX_VM_BALLOON_FLOOR_MB from env to enable elastic memory", async () => {
    const scripts: string[] = [];
    const runner = async (script: string) => {
      scripts.push(script);
      return { ok: true, stdout: "", stderr: "" };
    };

    await resizeProxmoxVm(
      { expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, cpuLimit: 2, memoryMb: 8192 },
      {
        runHostScript: runner,
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/etc/hivra/keys/proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_VM_BALLOON_FLOOR_MB: "1024",
        },
      }
    );
    expect(scripts[0]).toContain("MEMORY_MB='8192'");
    expect(scripts[0]).toContain("BALLOON_FLOOR_MB='2560'");
  });

  it("resizeProxmoxVm preserves legacy fully-pinned allocation when env is unset", async () => {
    const scripts: string[] = [];
    const runner = async (script: string) => {
      scripts.push(script);
      return { ok: true, stdout: "", stderr: "" };
    };
    await resizeProxmoxVm(
      { expectedInstanceId: TEST_INSTANCE_ID, vmid: 201, cpuLimit: 2, memoryMb: 4096 },
      {
        runHostScript: runner,
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/etc/hivra/keys/proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
        },
      }
    );
    // floor defaults to memory → existing pinned-allocation behaviour intact
    expect(scripts[0]).toContain("MEMORY_MB='4096'");
    expect(scripts[0]).toContain("BALLOON_FLOOR_MB='4096'");
  });

  it("resizeProxmoxVm clamps fractional CPU + small RAM safely", async () => {
    // Regression: free-tier sets cpuLimit=0.5 which is a valid Proxmox
    // value but a number<1 must survive the integer-floor in the script.
    const scripts: string[] = [];
    await resizeProxmoxVm(
      { expectedInstanceId: TEST_INSTANCE_ID, vmid: 100, cpuLimit: 0.5, memoryMb: 1024 },
      { runHostScript: async (s) => { scripts.push(s); return { ok: true, stdout: "", stderr: "" }; } }
    );
    expect(scripts[0]).toContain("CPU_LIMIT='0.5'");
    expect(scripts[0]).toContain("MEMORY_MB='1024'");
  });

  it("reports whether the Proxmox provider has the minimum environment it needs", () => {
    expect(
      isProxmoxProvisioningConfigured({
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_KEY_PATH: "/etc/hivra/keys/proxmox-admin",
        PROXMOX_PUBLIC_IP: "203.0.113.10",
      })
    ).toBe(true);

    expect(
      isProxmoxProvisioningConfigured({
        PROXMOX_SSH_HOST: "203.0.113.10",
        PROXMOX_SSH_PRIVATE_KEY_B64: Buffer.from("private-key").toString("base64"),
        PROXMOX_PUBLIC_IP: "203.0.113.10",
      })
    ).toBe(true);

    expect(isProxmoxProvisioningConfigured({ PROXMOX_PUBLIC_IP: "203.0.113.10" })).toBe(false);
  });

  it("reads the Proxmox node identity from persisted infrastructure metadata", () => {
    expect(
      getProxmoxInfrastructure({
        infrastructure: {
          provider: "proxmox",
          node: "fixturelegacy",
          vmid: 300,
          privateIpv4: "10.250.30.80",
          gatewayHost: "rz-agent.203-0-113-10.sslip.io",
          templateVmid: 9003,
        },
      })
    ).toEqual({
      provider: "proxmox",
      node: "fixturelegacy",
      vmid: 300,
      privateIpv4: "10.250.30.80",
      gatewayHost: "rz-agent.203-0-113-10.sslip.io",
      templateVmid: 9003,
    });
  });

  it("returns a clear error when PROXMOX_SSH_HOST is not configured", async () => {
    // Regression: warden + provisioning rely on this to fail loudly with
    // a useful message rather than crash. Previously this path also tested
    // that the legacy spawn("ssh", ...) wrote a temp keyfile — that whole
    // path was migrated to pure-JS ssh2 (so it works on Vercel serverless,
    // which has no `ssh` binary). The contract that survives the rewrite
    // is "no host configured → not-ok with a readable error string".
    const result = await runProxmoxHostScript("echo ok", {
      PROXMOX_PUBLIC_IP: "203.0.113.10",
      PROXMOX_SSH_KEY_PATH: "/tmp/key",
      // PROXMOX_SSH_HOST intentionally missing
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PROXMOX_SSH_HOST/);
  });

  it("returns a clear error when no SSH key is configured and ssh-agent is disabled", async () => {
    // Same shape — explicit early return rather than a confusing ssh2
    // connection error deep inside the connect path.
    const result = await runProxmoxHostScript("echo ok", {
      PROXMOX_PUBLIC_IP: "203.0.113.10",
      PROXMOX_SSH_HOST: "203.0.113.10",
      // No KEY_PATH, no PRIVATE_KEY_B64, no ALLOW_SSH_AGENT
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PROXMOX_SSH_KEY_PATH|PROXMOX_SSH_PRIVATE_KEY_B64/);
  });

  it("runs the host script and returns public gateway plus private VM metadata", async () => {
    const result = await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_test_123",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 2048,
        name: "Proxmox Smoke",
        provider: "openai",
        apiKey: "provider-key",
        model: "gpt-5.4-mini",
        subdomain: "abc123",
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          enableRootAccess: true,
        },
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
        },
        // gateway≡webfree collapse: an omitted backend defaults to "gateway",
        // which is now treated as webfree — so the deploy script is the WebUI
        // bootstrap and the caller's buildDeployScript is bypassed entirely.
        buildDeployScript: (() => {
          throw new Error("webfree branch must NOT call buildAgentDeployScript");
        }) as never,
        runHostScript: async (script) => {
          expect(script).toContain("abc123.203-0-113-10.sslip.io");
          expect(script).toContain("HERMES_TENANT_ISOLATION_READY");
          const encodedDeploy = script.match(/DEPLOY_B64='([^']+)'/)?.[1];
          expect(encodedDeploy).toBeTruthy();
          const decodedDeploy = Buffer.from(encodedDeploy!, "base64").toString("utf8");
          // The webfree deploy is the WebUI bootstrap (official Hermes dashboard
          // surface), not the legacy gateway deploy. TLS terminates upstream on
          // the Proxmox host, so the inner Caddyfile uses a `:80` site label.
          expect(decodedDeploy).toContain("hermes-webui:stable");
          expect(decodedDeploy).toContain(
            "container_name: agent-inst_test_123-official-dashboard"
          );
          expect(decodedDeploy).toMatch(/cat > Caddyfile <<.*\n:80 \{/s);
          const gatewayServiceBlock = decodedDeploy.slice(
            decodedDeploy.indexOf("  gateway:"),
            decodedDeploy.indexOf("  official-dashboard:")
          );
          const officialDashboardServiceBlock = decodedDeploy.slice(
            decodedDeploy.indexOf("  official-dashboard:"),
            decodedDeploy.indexOf("  dashboard-sidecar:")
          );
          expect(gatewayServiceBlock).toContain('user: "1024:1024"');
          expect(gatewayServiceBlock).toContain("group_add:");
          expect(gatewayServiceBlock).toContain(
            '- "${HERMES_GUEST_DOCKER_GID:?guest Docker socket GID is required}"'
          );
          expect(gatewayServiceBlock).not.toContain("HERMES_ALLOW_ROOT_GATEWAY=1");
          expect(gatewayServiceBlock).toContain(
            "- /var/run/docker.sock:/var/run/docker.sock"
          );
          expect(gatewayServiceBlock).not.toContain("privileged: true");
          expect(officialDashboardServiceBlock).toContain('user: "1024:1024"');
          expect(officialDashboardServiceBlock).toContain("group_add:");
          expect(officialDashboardServiceBlock).toContain(
            '- "${HERMES_GUEST_DOCKER_GID:?guest Docker socket GID is required}"'
          );
          expect(officialDashboardServiceBlock).toContain(
            "- /var/run/docker.sock:/var/run/docker.sock"
          );
          expect(officialDashboardServiceBlock).not.toContain("privileged: true");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":201,"privateIpv4":"10.250.20.51","gatewayHost":"abc123.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
    );

    expect(result).toMatchObject({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      templateId: 9000,
      ipv4: "10.250.20.51",
      gatewayUrl: "https://abc123.203-0-113-10.sslip.io",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
        templateVmid: 9000,
      },
    });
  });

  it("uses an sslip gateway when Cloudflare DNS minting fails", async () => {
    const result = await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_dns_fallback",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 2048,
        name: "DNS Fallback",
        provider: "openai",
        apiKey: "provider-key",
        model: "gpt-5.4-mini",
        subdomain: "fallback-agent",
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_GATEWAY_DOMAIN: "hermesos.cloud",
          CLOUDFLARE_API_TOKEN: "test-token",
          CLOUDFLARE_ZONE_ID: "test-zone",
          CLOUDFLARE_DNS_DOMAIN: "hermesos.cloud",
          CLOUDFLARE_DNS_PROXIED: "false",
        },
        mintInstanceDns: async () => ({
          ok: false,
          error: "simulated DNS provider failure",
        }),
        runHostScript: async (script) => {
          expect(script).toContain("fallback-agent.203-0-113-10.sslip.io");
          expect(script).not.toContain("fallback-agent.hermesos.cloud");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":202,"privateIpv4":"10.250.20.52","gatewayHost":"fallback-agent.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      gatewayUrl: "https://fallback-agent.203-0-113-10.sslip.io",
      infrastructure: {
        gatewayHost: "fallback-agent.203-0-113-10.sslip.io",
      },
    });
  });

  it("mints the exact static-origin gateway through Cloudflare when canary's general DNS namespace is nested", async () => {
    const mintInstanceDns = jest.fn(async (
      params: { subdomain: string; ip: string },
      config: { domain: string } | null | undefined,
    ) => ({
      ok: true,
      fqdn: `${params.subdomain}.${config?.domain}`,
      recordId: "record-static-origin",
    }));

    const result = await provisionProxmoxInstance(
      {
        userId: "user_static_origin_dns",
        instanceId: "inst_static_origin_dns",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 2048,
        name: "Static Origin DNS",
        provider: "openai",
        apiKey: "provider-key",
        model: "gpt-5.4-mini",
        subdomain: "static-origin-agent",
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_GATEWAY_DOMAIN: "hermesos.cloud",
          CLOUDFLARE_API_TOKEN: "test-token",
          CLOUDFLARE_ZONE_ID: "test-zone",
          CLOUDFLARE_DNS_DOMAIN: "agents.canary.hermesos.cloud",
          CLOUDFLARE_DNS_PROXIED: "false",
        },
        mintInstanceDns,
        runHostScript: async (script) => {
          expect(script).toContain("static-origin-agent.hermesos.cloud");
          expect(script).not.toContain("static-origin-agent.agents.canary.hermesos.cloud");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":203,"privateIpv4":"10.250.20.53","gatewayHost":"static-origin-agent.hermesos.cloud"}',
            stderr: "",
          };
        },
      },
    );

    expect(mintInstanceDns).toHaveBeenCalledWith(
      expect.objectContaining({
        subdomain: "static-origin-agent",
        ip: "203.0.113.10",
        proxied: true,
      }),
      expect.objectContaining({ domain: "hermesos.cloud" }),
    );
    expect(result).toMatchObject({
      ok: true,
      gatewayUrl: "https://static-origin-agent.hermesos.cloud",
      infrastructure: {
        gatewayHost: "static-origin-agent.hermesos.cloud",
      },
    });
  });

  it("provisions on the selected FixtureLegacy target and persists the target identity in infrastructure metadata", async () => {
    const result = await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_fixturelegacy_123",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 2048,
        name: "FixtureLegacy Agent",
        provider: "openai",
        apiKey: "provider-key",
        model: "gpt-5.4-mini",
        subdomain: "rz-agent",
      },
      {
        env: {
          HERMES_PROXMOX_TARGET: "fixturelegacy",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/global-proxmox",
          PROXMOX_TEMPLATE_ID: "9000",
          PROXMOX_FIXTURELEGACY_PUBLIC_IP: "203.0.113.10",
          PROXMOX_FIXTURELEGACY_SSH_HOST: "203.0.113.10",
          PROXMOX_FIXTURELEGACY_SSH_KEY_PATH: "/Users/example/.ssh/hivra-secondary-admin",
          PROXMOX_FIXTURELEGACY_TEMPLATE_ID: "9003",
          PROXMOX_FIXTURELEGACY_VMID_START: "300",
          PROXMOX_FIXTURELEGACY_IP_LAST_OCTET_START: "80",
          PROXMOX_FIXTURELEGACY_PRIVATE_SUBNET_PREFIX: "10.250.30",
          PROXMOX_FIXTURELEGACY_PRIVATE_GATEWAY: "10.250.30.1",
        },
        buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
        runHostScript: async (script) => {
          expect(script).toContain("TEMPLATE_ID='9003'");
          expect(script).toContain("VMID_START='300'");
          expect(script).toContain("IP_LAST_OCTET_START='80'");
          expect(script).toContain("PRIVATE_SUBNET_PREFIX='10.250.30'");
          expect(script).toContain("PRIVATE_GATEWAY='10.250.30.1'");
          expect(script).toContain("rz-agent.203-0-113-10.sslip.io");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":300,"privateIpv4":"10.250.30.80","gatewayHost":"rz-agent.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
    );

    expect(result).toMatchObject({
      ok: true,
      templateId: 9003,
      vmid: 300,
      ipv4: "10.250.30.80",
      gatewayUrl: "https://rz-agent.203-0-113-10.sslip.io",
      infrastructure: {
        provider: "proxmox",
        node: "fixturelegacy",
        hostSlug: "fixturelegacy",
        hostEnvPrefix: "PROXMOX_FIXTURELEGACY_",
        vmid: 300,
        privateIpv4: "10.250.30.80",
        gatewayHost: "rz-agent.203-0-113-10.sslip.io",
        templateVmid: 9003,
      },
    });
  });

  it("provisions a WebUI-backed Proxmox VM with hermes-webui artifacts and a /health readiness probe", async () => {
    const result = await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_webui_456",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 4096,
        name: "Proxmox WebUI",
        provider: "openrouter",
        apiKey: "or-key-1",
        model: "kimi-k2.5",
        subdomain: "webui1",
        backend: "webui",
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
        },
        // No buildDeployScript override: the WebUI branch should bypass it
        // entirely and call buildWebUIBootstrapScript instead.
        buildDeployScript: (() => {
          throw new Error("WebUI branch must NOT call buildAgentDeployScript");
        }) as never,
        runHostScript: async (script) => {
          // Readiness probe must hit /health, not /v1/models — WebUI has no
          // /v1/models route and using the gateway probe would fail every
          // healthy WebUI deploy.
          expect(script).toContain("/health");
          expect(script).not.toMatch(/curl[^\n]*\/v1\/models/);
          // WebUI cold starts install the runtime and Python deps on the
          // first boot; two minutes was not enough on fixturenodea and caused healthy
          // first boots to be destroyed by Phase 2 cleanup.
          expect(script).toContain("READINESS_ATTEMPTS='300'");
          expect(script).toContain('READINESS_ATTEMPTS="$READINESS_ATTEMPTS"');
          expect(script).toContain('READINESS_INTERVAL_SECONDS="$READINESS_INTERVAL_SECONDS"');
          expect(script).toContain("last HTTP status:");
          // The deploy script embedded into DEPLOY_B64 should be the WebUI
          // bootstrap (references the hermes-webui image + writes the webui-free
          // compose whose surface is the official Hermes dashboard) — not the
          // bare gateway bootstrap.
          const encodedDeploy = script.match(/DEPLOY_B64='([^']+)'/)?.[1];
          expect(encodedDeploy).toBeTruthy();
          const decodedDeploy = Buffer.from(encodedDeploy!, "base64").toString("utf8");
          expect(decodedDeploy).toContain("hermes-webui:stable");
          // webui-free cutover: the running surface is the official Hermes
          // dashboard container, not the legacy webui app on HERMES_WEBUI_PORT=8787.
          expect(decodedDeploy).toContain("container_name: agent-inst_webui_456-official-dashboard");
          expect(decodedDeploy).not.toContain("HERMES_WEBUI_PORT=8787");
          // The proxmox path provisions webui-free instances, so it installs the
          // IDLE-GATED update stack (sampler+roll+refresh) and tears down the
          // legacy daily auto-update — it must NOT install/enable the daily timer.
          expect(decodedDeploy).toContain(
            "systemctl disable --now hermes-auto-update-inst_webui_456.timer"
          );
          expect(decodedDeploy).not.toContain(
            "systemctl enable hermes-auto-update-inst_webui_456.timer"
          );
          // The three idle-gated executables are embedded as base64(+gzip)
          // payloads decoded on the guest into /usr/local/bin/hermes-<kind>-<INST>.
          expect(decodedDeploy).toMatch(
            /base64 -d[^\n]*> \/usr\/local\/bin\/hermes-idle-sampler-inst_webui_456/
          );
          expect(decodedDeploy).toMatch(
            /base64 -d[^\n]*> \/usr\/local\/bin\/hermes-roll-inst_webui_456/
          );
          expect(decodedDeploy).toMatch(
            /base64 -d[^\n]*> \/usr\/local\/bin\/hermes-refresh-inst_webui_456/
          );
          expect(decodedDeploy).toContain(
            "systemctl enable --now hermes-idle-sampler-inst_webui_456.timer hermes-roll-inst_webui_456.timer hermes-refresh-inst_webui_456.timer"
          );
          expect(
            decodedDeploy.indexOf("/usr/local/bin/hermes-roll-inst_webui_456")
          ).toBeLessThan(decodedDeploy.indexOf("# Wait for health"));
          // The inner Caddyfile site label must be ":80" because TLS is
          // terminated upstream on the Proxmox host — the guest VM cannot
          // get a Let's Encrypt cert on its private IP.
          expect(decodedDeploy).toMatch(/cat > Caddyfile <<.*\n:80 \{/s);
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":210,"privateIpv4":"10.250.20.60","gatewayHost":"webui1.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
    );

    expect(result).toMatchObject({
      ok: true,
      provider: "proxmox",
      vmid: 210,
      ipv4: "10.250.20.60",
      gatewayUrl: "https://webui1.203-0-113-10.sslip.io",
    });
  });

  it("passes browser-sidecar opt-in through fresh WebUI Proxmox provisioning for pro-tier users", async () => {
    await withEnv(
      {
        HERMES_BROWSER_SIDECAR_IMAGE: undefined,
        HERMES_DEPLOY_CHANNEL: "prod",
        NEXT_PUBLIC_HERMES_DEPLOY_CHANNEL: undefined,
        VERCEL_GIT_REPO_SLUG: "hermesdeploy",
        GITHUB_REPOSITORY: "ashneil12/hermesdeploy",
      },
      async () => provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_webui_sidecar",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 4096,
        name: "Proxmox WebUI Sidecar",
        provider: "openrouter",
        apiKey: "or-key-1",
        model: "kimi-k2.5",
        subdomain: "webui-sidecar",
        backend: "webui",
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          browserSidecarEnabled: true,
        },
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
          HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED: "1",
        },
        buildDeployScript: (() => {
          throw new Error("WebUI branch must NOT call buildAgentDeployScript");
        }) as never,
        runHostScript: async (script) => {
          const encodedDeploy = script.match(/DEPLOY_B64='([^']+)'/)?.[1];
          expect(encodedDeploy).toBeTruthy();
          const decodedDeploy = Buffer.from(encodedDeploy!, "base64").toString("utf8");
          expect(decodedDeploy).toContain("browser-sidecar:");
          expect(decodedDeploy).toContain("container_name: agent-inst_webui_sidecar-browser-sidecar");
          // Safe prod fallback: the webui builder reads HERMES_BROWSER_SIDECAR_IMAGE
          // from process.env; absent there, it must NOT leak the canary package into
          // prod provisioning.
          expect(decodedDeploy).toContain("ghcr.io/ashneil12/hermes-browser-sidecar:stable");
          expect(decodedDeploy).not.toContain("hermes-browser-sidecar-canary");
          // The sidecar's live browser view is served same-origin via /vnc/* →
          // the sidecar's noVNC on :6080 (VNC-password gated), replacing the old
          // forward_auth :8789 signed-URL handoff.
          expect(decodedDeploy).toContain("reverse_proxy agent-inst_webui_sidecar-browser-sidecar:6080");
          // The Vex `browser_sidecar` deterministic toolset is NOT surfaced — the
          // agent drives the one CDP Chrome instead (CDP wiring itself is gated by
          // HERMES_AGENT_BROWSER_CDP_ENABLED and unit-tested in webui-instance-builder).
          expect(decodedDeploy).not.toContain("- browser_sidecar");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":212,"privateIpv4":"10.250.20.62","gatewayHost":"webui-sidecar.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
      )
    );
  });

  it("does not emit browser-sidecar on fresh WebUI Proxmox provisioning unless the deployment gate is enabled", async () => {
    await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_webui_sidecar_gate",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 4096,
        name: "Proxmox WebUI Sidecar Gate",
        provider: "openrouter",
        apiKey: "or-key-1",
        model: "kimi-k2.5",
        subdomain: "webui-sidecar-gate",
        backend: "webui",
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          browserSidecarEnabled: true,
        },
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
          HERMES_BROWSER_SIDECAR_IMAGE: "ghcr.io/ashneil12/hermes-browser-sidecar:stable",
        },
        buildDeployScript: (() => {
          throw new Error("WebUI branch must NOT call buildAgentDeployScript");
        }) as never,
        runHostScript: async (script) => {
          const encodedDeploy = script.match(/DEPLOY_B64='([^']+)'/)?.[1];
          expect(encodedDeploy).toBeTruthy();
          const decodedDeploy = Buffer.from(encodedDeploy!, "base64").toString("utf8");
          expect(decodedDeploy).not.toContain("browser-sidecar:");
          expect(decodedDeploy).not.toContain("ghcr.io/ashneil12/hermes-browser-sidecar:stable");
          expect(decodedDeploy).not.toContain("- browser_sidecar");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":214,"privateIpv4":"10.250.20.64","gatewayHost":"webui-sidecar-gate.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
    );
  });

  it("does not emit browser-sidecar on fresh WebUI Proxmox provisioning for base-tier users", async () => {
    await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_webui_base_sidecar",
        tier: "credit_base",
        cpuLimit: 0.5,
        ramLimit: 1024,
        name: "Proxmox WebUI Base",
        provider: "openrouter",
        apiKey: "or-key-1",
        model: "kimi-k2.5",
        subdomain: "webui-base",
        backend: "webui",
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          browserSidecarEnabled: true,
        },
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
          HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED: "1",
          HERMES_BROWSER_SIDECAR_IMAGE: "ghcr.io/ashneil12/hermes-browser-sidecar:stable",
        },
        buildDeployScript: (() => {
          throw new Error("WebUI branch must NOT call buildAgentDeployScript");
        }) as never,
        runHostScript: async (script) => {
          const encodedDeploy = script.match(/DEPLOY_B64='([^']+)'/)?.[1];
          expect(encodedDeploy).toBeTruthy();
          const decodedDeploy = Buffer.from(encodedDeploy!, "base64").toString("utf8");
          expect(decodedDeploy).not.toContain("browser-sidecar:");
          expect(decodedDeploy).not.toContain("ghcr.io/ashneil12/hermes-browser-sidecar:stable");
          expect(decodedDeploy).not.toContain("- browser_sidecar");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":213,"privateIpv4":"10.250.20.63","gatewayHost":"webui-base.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
    );
  });

  it("emits browser-sidecar by DEFAULT for Pro+ users (no explicit opt-in)", async () => {
    await withEnv(
      {
        HERMES_BROWSER_SIDECAR_IMAGE: undefined,
        HERMES_DEPLOY_CHANNEL: "prod",
        NEXT_PUBLIC_HERMES_DEPLOY_CHANNEL: undefined,
        VERCEL_GIT_REPO_SLUG: "hermesdeploy",
        GITHUB_REPOSITORY: "ashneil12/hermesdeploy",
      },
      async () => provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_webui_sidecar_default",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 4096,
        name: "Proxmox WebUI Sidecar Default",
        provider: "openrouter",
        apiKey: "or-key-1",
        model: "kimi-k2.5",
        subdomain: "webui-sidecar-default",
        backend: "webui",
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          // browserSidecarEnabled intentionally UNSET → defaults ON for Pro+.
        },
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
          HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED: "1",
        },
        buildDeployScript: (() => {
          throw new Error("WebUI branch must NOT call buildAgentDeployScript");
        }) as never,
        runHostScript: async (script) => {
          const encodedDeploy = script.match(/DEPLOY_B64='([^']+)'/)?.[1];
          expect(encodedDeploy).toBeTruthy();
          const decodedDeploy = Buffer.from(encodedDeploy!, "base64").toString("utf8");
          expect(decodedDeploy).toContain("browser-sidecar:");
          expect(decodedDeploy).toContain("container_name: agent-inst_webui_sidecar_default-browser-sidecar");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":215,"privateIpv4":"10.250.20.65","gatewayHost":"webui-sidecar-default.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
      )
    );
  });

  it("honors an explicit opt-out (browserSidecarEnabled: false) for a Pro+ user", async () => {
    await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_webui_sidecar_optout",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 4096,
        name: "Proxmox WebUI Sidecar OptOut",
        provider: "openrouter",
        apiKey: "or-key-1",
        model: "kimi-k2.5",
        subdomain: "webui-sidecar-optout",
        backend: "webui",
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          browserSidecarEnabled: false,
        },
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
          HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED: "1",
          HERMES_BROWSER_SIDECAR_IMAGE: "ghcr.io/ashneil12/hermes-browser-sidecar:stable",
        },
        buildDeployScript: (() => {
          throw new Error("WebUI branch must NOT call buildAgentDeployScript");
        }) as never,
        runHostScript: async (script) => {
          const encodedDeploy = script.match(/DEPLOY_B64='([^']+)'/)?.[1];
          expect(encodedDeploy).toBeTruthy();
          const decodedDeploy = Buffer.from(encodedDeploy!, "base64").toString("utf8");
          expect(decodedDeploy).not.toContain("browser-sidecar:");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":216,"privateIpv4":"10.250.20.66","gatewayHost":"webui-sidecar-optout.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
    );
  });

  it("uses the webfree /health readiness probe when backend is omitted (gateway≡webfree collapse)", async () => {
    await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_gw_789",
        tier: "operator",
        cpuLimit: 1,
        ramLimit: 2048,
        name: "Proxmox Gateway Default",
        provider: "openai",
        apiKey: "k",
        model: "gpt-5.4-mini",
        subdomain: "gw1",
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
        },
        // gateway≡webfree collapse: an omitted backend defaults to "gateway",
        // which is now webfree, so the caller's buildDeployScript is bypassed.
        buildDeployScript: (() => {
          throw new Error("webfree branch must NOT call buildAgentDeployScript");
        }) as never,
        runHostScript: async (script) => {
          // No backend specified → defaults to "gateway", now treated as
          // webfree → /health probe with the heavy 300-attempt boot budget,
          // not the legacy /v1/models bearer probe.
          expect(script).toContain("/health");
          expect(script).not.toMatch(/curl[^\n]*\/v1\/models/);
          expect(script).toContain("READINESS_ATTEMPTS='300'");
          expect(script).toContain('READINESS_ATTEMPTS="$READINESS_ATTEMPTS"');
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":211,"privateIpv4":"10.250.20.61","gatewayHost":"gw1.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
    );
  });

  it("provisions with the user's plan-based cpuLimit/ramLimit (env vars no longer override)", async () => {
    // Regression: PROXMOX_VM_CORES / PROXMOX_VM_MEMORY_MB used to take
    // precedence over the dashboard slider's value. Result: every VM
    // provisioned at the env var size (e.g. 1 vCPU / 2GB) regardless of
    // whether the user was on operator/fleet/command. Tier upgrades had
    // no visible effect on new VMs. The fix removes the env-var path so
    // the cpuLimit / ramLimit passed in by instance-service.ts (which
    // already caps to plan.maxCpuPerAgent) drives provisioning.
    await provisionProxmoxInstance(
      {
        userId: "user_123",
        instanceId: "inst_test_123",
        tier: "operator",
        cpuLimit: 2,
        ramLimit: 4096,
        name: "Pilot Agent",
        provider: "openai",
        apiKey: "provider-key",
        model: "gpt-5.4-mini",
        subdomain: "pilot",
        agentSettings: {
          maxIterations: 60,
          toolProgressMode: "all",
          compressionThreshold: 0.85,
          sessionResetMode: "both",
          enableRootAccess: true,
        },
      },
      {
        env: {
          PROXMOX_SSH_HOST: "203.0.113.10",
          PROXMOX_SSH_KEY_PATH: "/Users/example/.ssh/hivra-proxmox-admin",
          PROXMOX_PUBLIC_IP: "203.0.113.10",
          PROXMOX_TEMPLATE_ID: "9000",
          // These env vars are now IGNORED — the test verifies the user's
          // requested cpuLimit (2) wins over the env-var pin (1).
          PROXMOX_VM_CORES: "1",
          PROXMOX_VM_MEMORY_MB: "2048",
        },
        buildDeployScript: () => "HERMES_SUBDOMAIN=localhost",
        runHostScript: async (script) => {
          expect(script).toContain("CORES='2'");
          expect(script).toContain("MEMORY_MB='4096'");
          return {
            ok: true,
            stdout:
              'ok\nHERMES_PROXMOX_RESULT {"vmid":201,"privateIpv4":"10.250.20.51","gatewayHost":"pilot.203-0-113-10.sslip.io"}',
            stderr: "",
          };
        },
      }
    );
  });
});
