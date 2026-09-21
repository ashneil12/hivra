/**
 * Gateway auto-wake Phase 1: the per-box Caddy 502→wake-page fallback.
 *
 * Covers the block generator itself plus the two vhost generators that must
 * both emit it (initial provisioning + cold-restore rebuild), so a template
 * refactor can't silently drop the fallback from one path.
 */

import {
  buildWakeFallbackCaddyBlock,
  buildWakeRedirectUrl,
  DEFAULT_WAKE_ORIGIN,
  WAKE_FALLBACK_MARKER,
} from "../caddy-wake-fallback";
import { buildProxmoxGatewayCaddySite } from "../proxmox-gateway-caddy-site";
import { buildProxmoxProvisionScript } from "../proxmox-instance-service";

describe("buildWakeRedirectUrl", () => {
  it("prefers the dashboard origin and strips trailing slashes", () => {
    expect(buildWakeRedirectUrl("https://hermesos.cloud/", "inst-1")).toBe(
      "https://hermesos.cloud/wake/inst-1",
    );
  });

  it("falls back to the canonical prod dashboard", () => {
    expect(buildWakeRedirectUrl("", "inst-1")).toBe(`${DEFAULT_WAKE_ORIGIN}/wake/inst-1`);
    expect(buildWakeRedirectUrl(null, "inst-1")).toBe(`${DEFAULT_WAKE_ORIGIN}/wake/inst-1`);
  });
});

describe("buildWakeFallbackCaddyBlock", () => {
  const block = buildWakeFallbackCaddyBlock("https://hivra.cloud/wake/inst-1");

  it("redirects browser navigations and 503s everything else", () => {
    expect(block).toContain(WAKE_FALLBACK_MARKER);
    // Only proxy-level upstream failures are intercepted.
    expect(block).toContain("expression {http.error.status_code} in [502, 503, 504]");
    // Browsers (Accept leads with text/html on navigations) get the redirect…
    expect(block).toContain("header Accept text/html*");
    expect(block).toContain("redir https://hivra.cloud/wake/inst-1 302");
    // …probes/API clients keep a failure status code, never a 3xx.
    expect(block).toContain('header Retry-After "75"');
    expect(block).toContain("503");
  });

  it("stays heredoc-safe: no backticks (bash would command-substitute them)", () => {
    expect(block).not.toContain("`");
  });

  it("carries no warden gate — decommissioned fleet-wide (2026-07)", () => {
    // The wake fallback used to prepend a warden marker-header strip and a
    // @warden_gate_fault handle_errors branch. Both are gone; the block is now
    // purely the parked-VM wake path.
    expect(block).not.toContain("warden");
    expect(block).not.toContain("@warden_gate_fault");
    expect(block).not.toContain("X-Hermes-Warden");
    // The parked-VM path is intact.
    expect(block).toContain("redir https://hivra.cloud/wake/inst-1 302");
    expect(block).toContain('respond "Agent is parked. Wake it at https://hivra.cloud/wake/inst-1" 503');
    // The block still opens on the wake comment, not a header-strip guard.
    expect(block.trimStart().startsWith("#")).toBe(true);
  });
});

describe("vhost generators both emit the fallback", () => {
  it("cold-restore rebuild: dashboard-origin variant", () => {
    const out = buildProxmoxGatewayCaddySite({
      gatewayHost: "abc123.hermesos.cloud",
      privateIp: "10.250.20.77",
      instanceId: "inst-cold-1",
      dashboardOrigin: "https://hermesos.cloud",
    });
    expect(out).toContain(WAKE_FALLBACK_MARKER);
    expect(out).toContain("redir https://hermesos.cloud/wake/inst-cold-1 302");
  });

  it("cold-restore rebuild: legacy variant falls back to the prod origin", () => {
    const out = buildProxmoxGatewayCaddySite({
      gatewayHost: "abc.example.com",
      privateIp: "10.240.0.5",
      instanceId: "inst-cold-2",
      dashboardOrigin: "",
    });
    expect(out).toContain(WAKE_FALLBACK_MARKER);
    expect(out).toContain(`redir ${DEFAULT_WAKE_ORIGIN}/wake/inst-cold-2 302`);
  });

  it("initial provisioning: selected shared-builder variant + the bash wake URL var", () => {
    const script = buildProxmoxProvisionScript({
      instanceId: "inst-prov-1",
      vmName: "hermes-inst-prov-1",
      templateId: 9007,
      vmidStart: 200,
      vmidEnd: 399,
      ipLastOctetStart: 50,
      privateSubnetPrefix: "10.250.20",
      privateCidr: 24,
      privateGateway: "10.250.20.1",
      nameserver: "1.1.1.1",
      cores: 1,
      memoryMb: 1024,
      deployScript: "echo deploy",
      vmSshUser: "hermes",
      vmSshKeyPath: "/etc/hivra/keys/proxmox-admin",
      gatewayHost: "abc123.hermesos.cloud",
      caddySitesDir: "/etc/caddy/hermes.d",
      apiServerKey: "sk-test",
      dashboardOrigin: "https://hermesos.cloud",
    });
    // The bash-side wake URL derives from DASHBOARD_ORIGIN with the canonical
    // prod dashboard as fallback, per-instance.
    expect(script).toContain(
      `WAKE_REDIRECT_URL="\${DASHBOARD_ORIGIN:-${DEFAULT_WAKE_ORIGIN}}/wake/\${INSTANCE_ID}"`,
    );
    // The selected site-file heredoc carries the shared fallback block.
    const markerCount = script.split(WAKE_FALLBACK_MARKER).length - 1;
    expect(markerCount).toBe(1);
    expect(script).toContain("redir ${WAKE_REDIRECT_URL} 302");
  });
});
