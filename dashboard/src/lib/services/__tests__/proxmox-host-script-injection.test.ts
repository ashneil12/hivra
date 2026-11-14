/**
 * SEC-03 regression: Proxmox host-script builders and the cold-restore
 * routing path must reject hostile gateway hostnames and VMIDs at build
 * time, instead of emitting them into host-side bash or Caddyfile text
 * where `$(...)`, backticks, newlines or block braces become command /
 * directive injection.
 */

import {
  assertSupportedProxmoxGatewayHost,
  buildProxmoxGatewayCaddySite,
  isSafeGatewayHostname,
} from "../proxmox-gateway-caddy-site";
import {
  applyRestoreRouting,
  buildRestoreHostCaddySiteApplyScript,
} from "../cold-storage-restore-routing";
import {
  assertValidProxmoxVmid,
  buildProxmoxCaddySiteCleanupScript,
  buildProxmoxDeleteScript,
  buildProxmoxDormantArchiveScript,
  buildProxmoxMetricsScript,
  buildProxmoxOrphanCleanupScript,
  buildProxmoxPowerScript,
  buildProxmoxResizeScript,
  buildProxmoxStatusScript,
  buildProxmoxVmOwnedByInstanceCheck,
} from "../proxmox/script-builders";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

const INSTANCE_ID = "00000000-0000-4000-8000-000000001012";

// Hostnames that would inject commands (into the unquoted provisioning
// heredoc or the restore apply-script) or Caddy directives (into the site
// file) if they were emitted verbatim.
const HOSTILE_HOSTNAMES = [
  "$(id).example.com",
  "`id`.example.com",
  "abc.example.com\nrespond 200",
  "abc.example.com}\nreverse_proxy 10.250.20.99:1\n{",
  "a b.example.com",
  "abc'.example.com",
  'abc".example.com',
  "abc;rm.example.com",
  "abc|sh.example.com",
  "abc\\example.com",
  "../escape.example.com",
  "abc.example..com",
  "-abc.example.com",
  "abc-.example.com",
  "abc.example.com/#comment",
];

describe("isSafeGatewayHostname", () => {
  it.each([
    "abc123.hermesos.cloud",
    "abc123.agents.hermesos.cloud",
    "inst-test.203-0-113-10.sslip.io",
    "abc.example.com",
    "UPPER.EXAMPLE.COM",
    "a.b",
  ])("accepts valid hostname %s", (host) => {
    expect(isSafeGatewayHostname(host)).toBe(true);
  });

  it.each(HOSTILE_HOSTNAMES)("rejects hostile hostname %s", (host) => {
    expect(isSafeGatewayHostname(host)).toBe(false);
  });
});

describe("assertSupportedProxmoxGatewayHost", () => {
  it.each(HOSTILE_HOSTNAMES)(
    "rejects hostname with injection payload %s",
    (host) => {
      expect(() => assertSupportedProxmoxGatewayHost(host)).toThrow(
        "not a valid DNS hostname",
      );
    },
  );

  it("still accepts ordinary literal gateway hosts", () => {
    expect(() =>
      assertSupportedProxmoxGatewayHost("abc123.hermesos.cloud"),
    ).not.toThrow();
    expect(() =>
      assertSupportedProxmoxGatewayHost("inst-test.203-0-113-10.sslip.io"),
    ).not.toThrow();
  });

  it("still accepts the provisioning heredoc placeholder", () => {
    expect(() =>
      assertSupportedProxmoxGatewayHost("${GATEWAY_SITE_LABEL}"),
    ).not.toThrow();
  });

  it("still rejects legacy nested hosts on cert policy, not charset", () => {
    expect(() =>
      assertSupportedProxmoxGatewayHost("abc123.agents.hermesos.cloud"),
    ).toThrow("not covered by the static Origin CA certificate");
  });
});

describe("buildProxmoxGatewayCaddySite injection guards", () => {
  const base = {
    privateIp: "10.250.20.77",
    instanceId: INSTANCE_ID,
    dashboardOrigin: "https://hermesos.cloud",
  };

  it.each(HOSTILE_HOSTNAMES)("rejects gatewayHost %s", (gatewayHost) => {
    expect(() =>
      buildProxmoxGatewayCaddySite({ ...base, gatewayHost }),
    ).toThrow();
  });

  it.each([
    "10.250.20.1\nreverse_proxy 10.250.20.99:1",
    "10.250.20.1}",
    "10.250.20.1 $(id)",
    "`id`",
  ])("rejects privateIp %s", (privateIp) => {
    expect(() =>
      buildProxmoxGatewayCaddySite({
        ...base,
        gatewayHost: "abc123.hermesos.cloud",
        privateIp,
      }),
    ).toThrow("not safe to embed");
  });

  it.each([
    'https://example.com"\nheader X-Evil yes',
    "https://example.com\nheader X-Evil yes",
    "https://example.com${HOME}",
    "https://example.com#frag",
  ])("rejects dashboardOrigin %s", (dashboardOrigin) => {
    expect(() =>
      buildProxmoxGatewayCaddySite({
        ...base,
        gatewayHost: "abc123.hermesos.cloud",
        dashboardOrigin,
      }),
    ).toThrow("not safe to embed");
  });

  it("rejects an instanceId carrying a directive injection", () => {
    expect(() =>
      buildProxmoxGatewayCaddySite({
        ...base,
        gatewayHost: "abc123.hermesos.cloud",
        instanceId: `${INSTANCE_ID}\nrespond 200`,
      }),
    ).toThrow("not safe to embed");
  });

  it("still accepts the provisioning heredoc placeholders", () => {
    const out = buildProxmoxGatewayCaddySite({
      ...base,
      gatewayHost: "${GATEWAY_SITE_LABEL}",
      privateIp: "${PRIVATE_IP}",
      dashboardOrigin: "${DASHBOARD_ORIGIN}",
      wakeRedirectUrl: "${WAKE_REDIRECT_URL}",
      useStaticOriginTls: true,
    });
    expect(out).toContain("${GATEWAY_SITE_LABEL} {");
    expect(out).toContain("redir ${WAKE_REDIRECT_URL} 302");
    expect(out).not.toContain("`");
  });
});

describe("buildRestoreHostCaddySiteApplyScript", () => {
  const applyInput = {
    sitesDir: "/etc/caddy/hermes.d",
    gatewayHost: "abc123.hermesos.cloud",
    siteContent: "abc123.hermesos.cloud { respond 200 }\n",
  };

  it("quotes the site filename instead of interpolating it raw", () => {
    const script = buildRestoreHostCaddySiteApplyScript(applyInput);
    expect(script).toContain(
      `SITE_FILE="$SITES_DIR/"'abc123.hermesos.cloud.caddy'`,
    );
  });

  it.each(HOSTILE_HOSTNAMES)("rejects gatewayHost %s", (gatewayHost) => {
    expect(() =>
      buildRestoreHostCaddySiteApplyScript({ ...applyInput, gatewayHost }),
    ).toThrow("unsafe gateway hostname");
  });

  it("rejects the provisioning shell placeholder — restore needs a literal", () => {
    expect(() =>
      buildRestoreHostCaddySiteApplyScript({
        ...applyInput,
        gatewayHost: "${GATEWAY_SITE_LABEL}",
      }),
    ).toThrow("unsafe gateway hostname");
  });
});

describe("applyRestoreRouting", () => {
  it("rejects a hostname carrying a command-injection payload before any mutation", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    const result = await applyRestoreRouting({
      instanceId: INSTANCE_ID,
      gatewayHost: "$(id).hermesos.cloud",
      newPrivateIp: "10.250.20.77",
      newHostSlug: "fixturenode21",
      oldHostSlug: "fixturenode19",
      env: {},
    });

    expect(result.hostCaddy.ok).toBe(false);
    expect(result.cloudflareDns.outcome).toBe("skipped_unsupported_gateway_host");
    expect(result.oldHostCaddyCleanup).toEqual(
      expect.objectContaining({ ok: true, skipped: true }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("buildProxmoxCaddySiteCleanupScript", () => {
  it.each(HOSTILE_HOSTNAMES)(
    "refuses to emit a cleanup script for hostname %s",
    (host) => {
      expect(() =>
        buildProxmoxCaddySiteCleanupScript({
          gatewayHosts: ["abc.hermesos.cloud", host],
          caddySitesDir: "/etc/caddy/hermes.d",
        }),
      ).toThrow("unsafe gateway hostname");
    },
  );

  it("emits single-quoted echo markers for accepted hosts", () => {
    const script = buildProxmoxCaddySiteCleanupScript({
      gatewayHosts: ["abc.hermesos.cloud"],
      caddySitesDir: "/etc/caddy/hermes.d",
    });
    expect(script).toContain(
      "echo 'HERMES_CADDY_SITE_REMOVED abc.hermesos.cloud'",
    );
    expect(script).toContain(
      "echo 'HERMES_CADDY_SITE_ABSENT abc.hermesos.cloud'",
    );
  });
});

describe("assertValidProxmoxVmid", () => {
  it.each([0, 1, 99, -5, 1.5, NaN, Infinity, -Infinity, 2 ** 53])(
    "rejects %s",
    (vmid) => {
      expect(() => assertValidProxmoxVmid(vmid)).toThrow(
        "Invalid Proxmox VMID",
      );
    },
  );

  it("rejects a non-numeric VMID smuggled past the type checker", () => {
    expect(() =>
      assertValidProxmoxVmid("201; rm -rf /" as unknown as number),
    ).toThrow("Invalid Proxmox VMID");
    expect(() =>
      assertValidProxmoxVmid("$(id)" as unknown as number),
    ).toThrow("Invalid Proxmox VMID");
  });

  it.each([100, 201, 1108, 999999999])("accepts %s", (vmid) => {
    expect(() => assertValidProxmoxVmid(vmid)).not.toThrow();
  });
});

describe("vmid interpolation guards on lifecycle builders", () => {
  it.each([0, 99, 1.5, NaN, "201; rm -rf /", 2 ** 53])(
    "buildProxmoxPowerScript rejects vmid %s",
    (vmid) => {
      expect(() =>
        buildProxmoxPowerScript({
          vmid: vmid as number,
          expectedInstanceId: INSTANCE_ID,
          action: "shutdown",
        }),
      ).toThrow("Invalid Proxmox VMID");
    },
  );

  it.each([0, 99, 1.5, NaN])(
    "buildProxmoxDeleteScript rejects vmid %s",
    (vmid) => {
      expect(() =>
        buildProxmoxDeleteScript({
          vmid: vmid as number,
          expectedInstanceId: INSTANCE_ID,
          gatewayHost: "abc.example.com",
          caddySitesDir: "/etc/caddy/hermes.d",
        }),
      ).toThrow("Invalid Proxmox VMID");
    },
  );

  it.each([0, 99, 1.5, NaN])(
    "buildProxmoxOrphanCleanupScript rejects vmid %s",
    (vmid) => {
      expect(() =>
        buildProxmoxOrphanCleanupScript({
          vmid: vmid as number,
          instanceId: INSTANCE_ID,
          gatewayHost: "abc.example.com",
          caddySitesDir: "/etc/caddy/hermes.d",
        }),
      ).toThrow("Invalid Proxmox VMID");
    },
  );

  it.each<[string, () => string]>([
    ["buildProxmoxVmOwnedByInstanceCheck", () => buildProxmoxVmOwnedByInstanceCheck(1.5, INSTANCE_ID)],
    ["buildProxmoxStatusScript", () => buildProxmoxStatusScript(NaN)],
    ["buildProxmoxMetricsScript", () => buildProxmoxMetricsScript(99)],
    ["buildProxmoxDormantArchiveScript", () =>
      buildProxmoxDormantArchiveScript({ vmid: 1.5, archiveDir: "/mnt/hermes-dormant", instanceId: INSTANCE_ID })],
    ["buildProxmoxResizeScript", () =>
      buildProxmoxResizeScript({ vmid: NaN, expectedInstanceId: INSTANCE_ID, cores: 1, memoryMb: 1024 })],
  ])("%s rejects an invalid vmid", (_label, build) => {
    expect(build).toThrow("Invalid Proxmox VMID");
  });
});

describe("gateway-host interpolation guards on rm-emitting builders", () => {
  it.each(HOSTILE_HOSTNAMES)(
    "buildProxmoxDeleteScript rejects gatewayHost %s",
    (gatewayHost) => {
      expect(() =>
        buildProxmoxDeleteScript({
          vmid: 201,
          expectedInstanceId: INSTANCE_ID,
          gatewayHost,
          caddySitesDir: "/etc/caddy/hermes.d",
        }),
      ).toThrow("unsafe gateway hostname");
    },
  );

  it.each(HOSTILE_HOSTNAMES)(
    "buildProxmoxOrphanCleanupScript rejects gatewayHost %s",
    (gatewayHost) => {
      expect(() =>
        buildProxmoxOrphanCleanupScript({
          vmid: 201,
          instanceId: INSTANCE_ID,
          gatewayHost,
          caddySitesDir: "/etc/caddy/hermes.d",
        }),
      ).toThrow("unsafe gateway hostname");
    },
  );

  it("still emits the normal delete script for a valid host and vmid", () => {
    const script = buildProxmoxDeleteScript({
      vmid: 201,
      expectedInstanceId: INSTANCE_ID,
      gatewayHost: "abc.example.com",
      caddySitesDir: "/etc/caddy/hermes.d",
    });
    expect(script).toContain("qm destroy 201 --purge 1");
    expect(script).toContain(
      "rm -f '/etc/caddy/hermes.d/abc.example.com.caddy'",
    );
  });
});
