/**
 * Coverage for the post-restore routing pass.
 *
 * The unit-testable surface is the caddy site template generator + the
 * Cloudflare upsert decision tree (find → patch | post). The full
 * applyRestoreRouting path drives SSH and HTTP, so we exercise the pure
 * builder and the cf-upsert flow via injected fetch.
 */

import { buildProxmoxGatewayCaddySite } from "../proxmox-gateway-caddy-site";
import {
  applyRestoreRouting,
  buildRestoreHostCaddySiteApplyScript,
} from "../cold-storage-restore-routing";

describe("buildProxmoxGatewayCaddySite restore integration", () => {
  it("pins restored current-domain routes to the static origin certificate", () => {
    const out = buildProxmoxGatewayCaddySite({
      gatewayHost: "abc123.hermesos.cloud",
      privateIp: "10.250.20.77",
      instanceId: "00000000-0000-4000-8000-000000001012",
      dashboardOrigin: "https://hermesos.cloud",
    });

    expect(out).toContain(
      "tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key",
    );
  });

  it("emits the dashboard-origin variant when DASHBOARD_ORIGIN is set", () => {
    const out = buildProxmoxGatewayCaddySite({
      gatewayHost: "abc123.hermesos.cloud",
      privateIp: "10.250.20.77",
      instanceId: "00000000-0000-4000-8000-000000001012",
      dashboardOrigin: "https://hermesos.cloud",
    });
    // Site label + private IP must be present
    expect(out).toContain("abc123.hermesos.cloud {");
    expect(out).toContain("reverse_proxy 10.250.20.77:80");
    // The retired signed-URL SSE lane must not resurface in restored vhosts.
    expect(out).not.toContain("@signedSseStream");
    expect(out).not.toContain("forward_auth");
    expect(out).toContain('header @chatCors Access-Control-Allow-Origin "https://hermesos.cloud"');
    // flush_interval is load-bearing for SSE; site config must emit it.
    expect(out).toContain("flush_interval -1");
    expect(out).toContain("tls /etc/caddy/wildcards/hermesos.cloud.crt");
  });

  it("emits the legacy bare-bearer variant when DASHBOARD_ORIGIN is empty", () => {
    const out = buildProxmoxGatewayCaddySite({
      gatewayHost: "abc.example.com",
      privateIp: "10.240.0.5",
      instanceId: "some-id",
      dashboardOrigin: "",
    });
    expect(out).toContain("reverse_proxy 10.240.0.5:80");
    expect(out).not.toContain("forward_auth");
    expect(out).not.toContain("Access-Control-Allow-Origin");
    expect(out).toContain("flush_interval -1");
  });

  it("installs a candidate transactionally and restores the previous site on failure", () => {
    const script = buildRestoreHostCaddySiteApplyScript({
      sitesDir: "/etc/caddy/hermes.d",
      gatewayHost: "abc123.hermesos.cloud",
      siteContent: "abc123.hermesos.cloud { respond 200 }\n",
    });

    expect(script).toContain('SITE_CANDIDATE="${SITE_FILE}.candidate.$$"');
    expect(script).toContain('SITE_BACKUP="${SITE_FILE}.backup.$$"');
    expect(script).toContain('cp -p "$SITE_FILE" "$SITE_BACKUP"');
    expect(script).toContain('mv -f "$SITE_CANDIDATE" "$SITE_FILE"');
    expect(script).toContain('trap finish_site_transaction EXIT');
    expect(script).toContain("trap 'exit 130' HUP INT TERM");
    expect(script).toContain('SITE_INSTALLED=1');
    expect(script).toContain('SITE_COMMITTED=1');
    expect(script).toMatch(/rollback_site\(\) \{[\s\S]+?mv -f "\$SITE_BACKUP" "\$SITE_FILE"/);
    expect(script).toMatch(/if ! VALIDATE_ERR=.*?[\s\S]+?rollback_site[\s\S]+?exit 1/);
  });

  it("restarts an active but wedged Caddy and verifies local TLS after recovery", () => {
    const script = buildRestoreHostCaddySiteApplyScript({
      sitesDir: "/etc/caddy/hermes.d",
      gatewayHost: "abc123.hermesos.cloud",
      siteContent: "abc123.hermesos.cloud { respond 200 }\n",
    });

    expect(script).toMatch(/for _ in 1 2; do[\s\S]+?timeout 15s caddy reload/);
    expect(script).toContain("timeout 15s systemctl restart caddy");
    expect(script).toContain("curl -ksS --max-time 5 --resolve");
    expect(script).toContain("caddy recovery verification failed");
    expect(script).toMatch(/rollback_site[\s\S]+?systemctl restart caddy/);
  });

  it("rejects an unsupported legacy host before DNS or old-route mutation", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");

    const result = await applyRestoreRouting({
      instanceId: "00000000-0000-4000-8000-000000001012",
      gatewayHost: "abc123.agents.hermesos.cloud",
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
