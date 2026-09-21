/**
 * Regression tests for the Cloudflare DNS integration in
 * provisionHetznerInstance. The wiring lives at
 * `src/lib/services/hetzner-instance-service.ts`.
 *
 * The tests below pin the three properties that prevent the bug class
 * that took the Hetzner fleet down on 2026-04-30 — i.e. minting
 * `<sub>.hermesos.cloud` URLs without an A record and shipping a
 * billable VM that resolves to NXDOMAIN forever:
 *
 *  1. New-host DNS-mint failure must roll back the just-created Hetzner
 *     server. No orphan billable VMs.
 *  2. Successful DNS mint must surface a hermesos.cloud `gatewayUrl`
 *     (not sslip) so the dashboard hands clients the canonical URL.
 *  3. When Cloudflare is not configured, the integration must NOT call
 *     the Cloudflare API at all — sslip remains the safe default.
 */

import { createServer, deleteServer, waitForAction } from "@/lib/hetzner/client";
import { provisionHetznerInstance } from "../hetzner-instance-service";
import {
  getCloudflareDnsConfig,
  mintInstanceDns,
  removeInstanceDnsBestEffort,
} from "../cloudflare-dns";

jest.mock("@/lib/hetzner/client", () => ({
  createServer: jest.fn(),
  deleteServer: jest.fn(),
  getServer: jest.fn(),
  mapHetznerStatus: jest.fn(),
  waitForAction: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
  captureHostFingerprint: jest.fn().mockResolvedValue("fingerprint"),
}));

// Keep the real `resolveGatewayConfiguration` so the dnsDomain branch is
// actually exercised end-to-end. Stub the heavy script builders so the
// test runs in milliseconds without the real Caddyfile / docker-compose
// rendering.
jest.mock("@/lib/services/hetzner-instance-builders", () => {
  const actual = jest.requireActual("@/lib/services/hetzner-instance-builders");
  return {
    ...actual,
    buildAgentDeployScript: jest.fn(() => "#!/bin/bash\necho ok\n"),
    pickServerType: jest.fn(() => "cx22"),
    renderCompressedAgentBootstrapForUserData: jest.fn(() => "compressed-bootstrap"),
    renderHostUserData: jest.fn(() => "#!/usr/bin/env bash"),
  };
});

jest.mock("../cloudflare-dns", () => ({
  getCloudflareDnsConfig: jest.fn(),
  mintInstanceDns: jest.fn(),
  // Provisioning rollback paths call the helper directly. removeInstanceDns
  // is still exported but no longer reached from this service.
  removeInstanceDnsBestEffort: jest.fn().mockResolvedValue(undefined),
}));

const HOSTED_ZONE = "agents.hermesos.cloud";
const TEST_IPV4 = "203.0.113.4";
const TEST_SERVER_ID = 9001;

function buildBaseParams() {
  return {
    userId: "user-123",
    instanceId: "inst-123",
    cpuLimit: 2,
    ramLimit: 4096,
    name: "Agent 1",
    provider: "openai",
    apiKey: "provider-key",
    model: "gpt-5.4-mini",
    subdomain: "agent-1",
  };
}

describe("provisionHetznerInstance — Cloudflare DNS regressions", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (createServer as jest.Mock).mockResolvedValue({
      server: {
        id: TEST_SERVER_ID,
        public_net: { ipv4: { ip: TEST_IPV4 } },
      },
      action: { id: 42 },
    });
    (deleteServer as jest.Mock).mockResolvedValue(undefined);
    (waitForAction as jest.Mock).mockResolvedValue(undefined);
    // Cloudflare-dns is mocked at module scope; default to safe Promise
    // returns so callers' `.catch()` chains don't trip on `undefined`.
    (mintInstanceDns as jest.Mock).mockResolvedValue({ ok: true, fqdn: "stub.example.com" });
    (removeInstanceDnsBestEffort as jest.Mock).mockResolvedValue(undefined);
  });

  it("rolls back the just-created Hetzner server when DNS minting fails (no orphan billable VMs)", async () => {
    // This is the 2026-04-30 bug class: if we minted hermesos.cloud URLs
    // but the A record never appeared, the VM lived forever billing $$ to
    // a URL that resolved to NXDOMAIN. The contract is: mint failure →
    // delete the server, do not return ok=true with a broken URL.
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

    const result = await provisionHetznerInstance(buildBaseParams());

    expect(result.ok).toBe(false);
    expect(deleteServer).toHaveBeenCalledWith(TEST_SERVER_ID);
    // Best-effort cleanup: drop the (potentially partially-created) record
    // so the next provision attempt starts from a clean slate. Routes
    // through removeInstanceDnsBestEffort with the service's structured
    // context.
    expect(removeInstanceDnsBestEffort).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "hetzner-instance-service",
        instanceId: "inst-123",
        userId: "user-123",
      }),
    );

    consoleErrorSpy.mockRestore();
  });

  it("surfaces the hermesos.cloud gatewayUrl when DNS minting succeeds", async () => {
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue({
      apiToken: "tok",
      zoneId: "zone",
      domain: HOSTED_ZONE,
    });
    (mintInstanceDns as jest.Mock).mockResolvedValue({
      ok: true,
      fqdn: `agent-1.${HOSTED_ZONE}`,
      recordId: "rec_xyz",
    });

    const result = await provisionHetznerInstance(buildBaseParams());

    expect(result).toMatchObject({
      ok: true,
      ipv4: TEST_IPV4,
      gatewayUrl: `https://agent-1.${HOSTED_ZONE}`,
    });
    // Mint should be invoked exactly once with the real IP that came back
    // from createServer — not the 0.0.0.0 placeholder used for the
    // pre-createServer agent script template.
    expect(mintInstanceDns).toHaveBeenCalledTimes(1);
    expect(mintInstanceDns).toHaveBeenCalledWith(
      expect.objectContaining({ subdomain: "agent-1", ip: TEST_IPV4 })
    );
    // No rollback when the happy path lands.
    expect(deleteServer).not.toHaveBeenCalled();
    expect(removeInstanceDnsBestEffort).not.toHaveBeenCalled();
  });

  it("does not call Cloudflare when not configured — sslip remains the safe default", async () => {
    // Belt-and-braces: if the API token is missing, the wiring must
    // short-circuit BEFORE attempting any API call. Otherwise a half-
    // configured environment would surface confusing CF auth errors
    // that mask the simpler "not configured" reality.
    (getCloudflareDnsConfig as jest.Mock).mockReturnValue(null);

    const result = await provisionHetznerInstance(buildBaseParams());

    expect(mintInstanceDns).not.toHaveBeenCalled();
    expect(removeInstanceDnsBestEffort).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // sslip URL: <dashed-ipv4>.sslip.io
      expect(result.gatewayUrl).toBe("https://203-0-113-4.sslip.io");
    }
  });
});
