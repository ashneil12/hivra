import { NextRequest } from "next/server";
import { spawnSync } from "node:child_process";
import { buildLegacyManagedGatewayRunPython, buildManagedGatewayStatusCommand } from "@/lib/services/managed-gateway-command";

import { DELETE, GET, PATCH, POST, isAdvancedCloudAccessEligible } from "../route";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { enableServerBackup, getServer, powerOnServer, rebuildServer, shutdownServer } from "@/lib/hetzner/client";
import { applyLiveUpdate, resolveInstanceIpv4 } from "@/lib/services/instance-orchestrator";
import { USER_LIVE_UPDATE } from "@/lib/services/live-update-initiator";
import { ensureManagedHostFingerprint, sshExec } from "@/lib/hetzner/ssh";
import { apiError } from "@/lib/api-response";
import {
  buildAdvancedInstanceConfigPayload,
  getAutoUpdateConfig,
  getPublicInstanceConfig,
} from "@/lib/instance-settings";
import {
  buildAgentDeployScript,
  buildAutoUpdateTimerProvisioningScript,
  deleteHetznerServer,
  getHetznerInstanceStatus,
  resolveGatewayConfiguration,
} from "@/lib/services/hetzner-instance-service";
import {
  deleteProxmoxInstance,
  discoverProxmoxInfrastructureForInstance,
  getProxmoxInstanceStatus,
  rebootProxmoxInstance,
  shutdownProxmoxInstance,
  startProxmoxInstance,
} from "@/lib/services/proxmox-instance-service";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { acquireHostWakeSlot, releaseHostWakeSlot } from "@/lib/proxmox/wake-admission";
import { resolveCodexDeploymentSecret } from "@/lib/codex-oauth";
import { resolveNousDeploymentSecret } from "@/lib/nous-oauth";
import { discoverContainerName } from "@/lib/services/console-helpers";
import { resolveWebUIInstanceClient } from "@/lib/webui/instance";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  deriveDnsDomainFromGatewayUrl,
  removeInstanceDnsBestEffort,
} from "@/lib/services/cloudflare-dns";
import { isProTierUser } from "@/lib/billing/pro-tier";
import { recordInstanceUserActivity } from "@/lib/instance-activity";
import { recoverProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";
import { makeJsonRequest } from "@/test-utils";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());;

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
  sanitizeOpsMetadata: jest.requireActual("@/lib/ops-events").sanitizeOpsMetadata,
}));

jest.mock("@/lib/instance-activity", () => ({
  recordInstanceUserActivity: jest.fn().mockResolvedValue({
    ok: true,
    recordedAt: "2026-05-14T20:30:00.000Z",
  }),
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  clerkClient: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/hetzner/client", () => ({
  getServer: jest.fn(),
  powerOnServer: jest.fn(),
  shutdownServer: jest.fn(),
  rebootServer: jest.fn(),
  rebuildServer: jest.fn(),
  enableServerBackup: jest.fn(),
  disableServerBackup: jest.fn(),
}));

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  getHetznerInstanceStatus: jest.fn(),
  deleteHetznerServer: jest.fn(),
  resolveGatewayConfiguration: jest.fn(),
  buildAgentDeployScript: jest.fn(),
  buildAutoUpdateTimerProvisioningScript: jest.fn(() => "#!/usr/bin/env bash\necho auto-update"),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => {
  const actual = jest.requireActual("@/lib/services/proxmox-instance-service");
  return {
    ...actual,
    deleteProxmoxInstance: jest.fn(),
    discoverProxmoxInfrastructureForInstance: jest.fn(),
    getProxmoxInstanceStatus: jest.fn(),
    startProxmoxInstance: jest.fn(),
    shutdownProxmoxInstance: jest.fn(),
    rebootProxmoxInstance: jest.fn(),
    provisionProxmoxInstance: jest.fn(),
  };
});

// Gateway auto-wake admission guard: default-admit so the existing
// power-action tests exercise the start path unchanged; the wake-admission
// tests flip it to deferred per-case. Mocked (rather than fail-opening the
// real module) because the real guard would drive runProxmoxHostScript.
jest.mock("@/lib/proxmox/wake-admission", () => ({
  acquireHostWakeSlot: jest.fn(async () => ({ admitted: true, freeMb: 8192, activeWakes: 0 })),
  releaseHostWakeSlot: jest.fn(async () => undefined),
  normalizeWakeRamMb: jest.requireActual("@/lib/proxmox/wake-admission").normalizeWakeRamMb,
}));

// Cloudflare DNS calls are wired into provision/teardown but are
// orthogonal to most route-level concerns, so default to no-op shapes
// (`ok: false, error: "cloudflare_not_configured"` matches what the
// real module returns when env vars are absent — same as the
// production fallback path). Individual tests override
// `removeInstanceDnsBestEffort` when they specifically care about
// cleanup behavior.
jest.mock("@/lib/services/cloudflare-dns", () => ({
  getCloudflareDnsConfig: jest.fn(() => null),
  isCloudflareDnsConfigured: jest.fn(() => false),
  mintInstanceDns: jest.fn().mockResolvedValue({ ok: false, error: "cloudflare_not_configured" }),
  removeInstanceDns: jest.fn().mockResolvedValue({ ok: false, error: "cloudflare_not_configured" }),
  removeInstanceDnsBestEffort: jest.fn().mockResolvedValue(undefined),
  deriveDnsDomainFromGatewayUrl: jest.fn(() => null),
}));

jest.mock("@/lib/services/instance-orchestrator", () => ({
  getHonchoSettingsFromInstance: jest.fn(),
  resolveInstanceIpv4: jest.fn(),
  applyLiveUpdate: jest.fn(),
}));

jest.mock("@/lib/services/console-helpers", () => ({
  discoverContainerName: jest.fn(),
}));

jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: jest.fn(),
  ensureManagedHostFingerprint: jest.fn(),
  SSH_WARMUP_MESSAGE: "Instance is still provisioning SSH access. Try again in a moment.",
  isSshWarmupError: jest.fn((message: string | null | undefined) => {
    const normalized = message?.toLowerCase() ?? "";
    return (
      normalized.includes("timed out capturing ssh host fingerprint") ||
      normalized.includes("ssh fingerprint capture failed:")
    );
  }),
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn((value: string) => value),
  encryptApiKey: jest.fn((value: string) => value),
}));

jest.mock("@/lib/codex-oauth", () => ({
  CODEX_DEFAULT_MODEL: "gpt-test",
  formatStoredProviderSecretPreview: jest.fn(),
  resolveCodexDeploymentSecret: jest.fn((secret: string) => ({ apiKey: secret })),
}));

jest.mock("@/lib/nous-oauth", () => ({
  resolveNousDeploymentSecret: jest.fn((secret: string) => ({ apiKey: secret })),
}));

jest.mock("@/lib/instance-settings", () => ({
  getPublicInstanceConfig: jest.fn(),
  getRuntimeAgentSettings: jest.fn(() => ({ enableRootAccess: false })),
  getAutoUpdateConfig: jest.fn(() => ({ enabled: false, time: "06:00" })),
  extractGlobalHermesSettings: jest.fn(() => ({})),
  decryptMemorySystemSecrets: jest.fn(() => undefined),
  buildAdvancedInstanceConfigPayload: jest.fn(),
}));

jest.mock("@/lib/api-response", () => {
  const actual = jest.requireActual("@/lib/api-response");
  return {
    ...actual,
    apiError: jest.fn(actual.apiError),
  };
});

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/webui/instance", () => ({
  resolveWebUIInstanceClient: jest.fn(),
}));

jest.mock("@/lib/billing/pro-tier", () => ({
  isProTierUser: jest.fn(),
}));

// Post-ready SOUL.md seed hook: the route schedules it when a webfree box is
// promoted to running (the deterministic close of the provision seed race).
// Stubbed — the route only depends on the call, not the reconcile itself.
jest.mock("@/lib/recovery/soul-seed-reconcile", () => ({
  scheduleSoulSeedReconcileAfterResponse: jest.fn(),
}));

jest.mock("@/lib/recovery/recover-orphan-provisioning", () => ({
  recoverProxmoxInstanceAcrossFleet: jest.fn(),
}));

import { scheduleSoulSeedReconcileAfterResponse } from "@/lib/recovery/soul-seed-reconcile";

const mockedScheduleSoulSeed =
  scheduleSoulSeedReconcileAfterResponse as jest.Mock;

describe("POST /api/instances/[id]", () => {
  const mockedRecordInstanceUserActivity =
    recordInstanceUserActivity as jest.MockedFunction<typeof recordInstanceUserActivity>;

  beforeEach(() => {
    jest.clearAllMocks();
    (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({
      status: "inconclusive",
    });
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (clerkClient as unknown as jest.Mock).mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }),
      },
    });
    (getServer as jest.Mock).mockResolvedValue({
      server: { id: 42, public_net: { ipv4: { ip: "203.0.113.66" } } },
    });
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({
      status: "running",
    });
    (discoverProxmoxInfrastructureForInstance as jest.Mock).mockResolvedValue(null);
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("203.0.113.66");
    (resolveGatewayConfiguration as jest.Mock).mockReturnValue({
      fqdn: "203-0-113-66.sslip.io",
      gatewayUrl: "https://203-0-113-66.sslip.io",
    });
    (resolveCodexDeploymentSecret as jest.Mock).mockImplementation((secret: string) => ({ apiKey: secret }));
    (resolveNousDeploymentSecret as jest.Mock).mockImplementation((secret: string) => ({ apiKey: secret }));
    (buildAgentDeployScript as jest.Mock).mockReturnValue("#!/usr/bin/env bash\necho ok");
    (discoverContainerName as jest.Mock).mockResolvedValue("agent-inst-123");

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: null,
                      api_key_encrypted: "encrypted",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "profiles") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                not: jest.fn().mockResolvedValue({
                  data: [
                    { name: "skodari", gateway_port: 8650, status: "running" },
                    { name: "research", gateway_port: 8651, status: "stopped" },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("attributes restart failures to the instance action route", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Restart failed. Check the instance logs and try again.");
    expect(apiError).toHaveBeenCalledWith(
      "Restart failed. Check the instance logs and try again.",
      500,
      expect.objectContaining({
        failureType: "ssh_exec_failed",
        retryable: false,
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          action: "restart",
          failureOwner: "runtime",
          failurePhase: "runtime",
          failureType: "instance_action_failed",
          recoveryAction: "open_console",
        }),
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain("docker.sock");
    const restartCommand = (sshExec as jest.Mock).mock.calls.at(-1)?.[1] as string;
    expect(restartCommand).toContain("hermes_ensure_time_sync()");
    expect(restartCommand).toContain("/var/log/hermes-time-sync.log");
    // Resolves the live container (webfree runs -gateway/-official-dashboard, not
    // a bare agent-<id>) and restarts that, instead of `docker restart agent-<id>`
    // which would fail with "No such container" on webfree and wrongly flip the
    // instance to "error".
    expect(restartCommand).toContain("agent-inst-123-gateway");
    expect(restartCommand).toContain("agent-inst-123-official-dashboard");
    expect(restartCommand).toContain('docker restart "$AGENT_CONTAINER"');
    expect(restartCommand).not.toContain("docker restart agent-inst-123");
    expect(restartCommand.indexOf("hermes_ensure_time_sync")).toBeLessThan(
      restartCommand.indexOf('docker restart "$AGENT_CONTAINER"')
    );
  });

  it("pins a Proxmox host when restarting an instance on a shared private subnet", async () => {
    const proxmoxHostConfig = {
      hostId: null,
      hostSlug: "fixturenode11",
      envPrefix: "PROXMOX_FIXTURENODE11_",
      failClosed: true,
    };
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              neq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    id: "inst-123",
                    user_id: "user_123",
                    status: "running",
                    backend: "gateway",
                    host_id: null,
                    hetzner_server_id: null,
                    infrastructure_provider: "proxmox",
                    proxmox_node: "fixturenode11",
                    proxmox_vmid: 1148,
                    ipv4_address: "10.250.20.98",
                    config: {
                      infrastructure: {
                        provider: "proxmox",
                        node: "fixturenode11",
                        vmid: 1148,
                        privateIpv4: "10.250.20.98",
                        gatewayHost: "00000000000000000000.hermesos.cloud",
                        hostEnvPrefix: "PROXMOX_FIXTURENODE11_",
                      },
                    },
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("10.250.20.98");
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "ok", stderr: "" });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(sshExec).toHaveBeenCalledWith(
      "10.250.20.98",
      expect.stringContaining('docker restart "$AGENT_CONTAINER"'),
      { proxmoxHostConfig }
    );
  });

  it("blocks manual restarts while token entitlement is suspended", async () => {
    const updateMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "stopped",
                      lifecycle_state: "suspended",
                      entitlement_state: "suspended",
                      entitlement_reason: "token_holding_below_minimum",
                      entitlement_suspended_at: "2026-05-13T12:00:00.000Z",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: null,
                      api_key_encrypted: "encrypted",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateMock,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(402);
    expect(json.error).toMatch(/compute is suspended/i);
    expect(sshExec).not.toHaveBeenCalled();
    expect(powerOnServer).not.toHaveBeenCalled();
    expect(startProxmoxInstance).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(apiError).toHaveBeenCalledWith(
      expect.stringMatching(/compute is suspended/i),
      402,
      expect.objectContaining({
        failureType: "instance_entitlement_suspended",
        entitlementReason: "token_holding_below_minimum",
      }),
      undefined,
      expect.objectContaining({
        metadata: expect.objectContaining({
          action: "restart",
          recoveryAction: "open_billing",
        }),
      })
    );
  });

  it("does not try to start a VM that has been released into dormant archive storage", async () => {
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "stopped",
                      lifecycle_state: "paused",
                      paused_reason: "dormant_reclaimed",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: null,
                      api_key_encrypted: "encrypted",
                      infrastructure_provider: null,
                      proxmox_node: null,
                      proxmox_vmid: null,
                      config: {
                        dormantArchive: {
                          archiveId: "archive_123",
                          archivePath: "/mnt/hermes-dormant/vzdump-qemu-610.vma.zst",
                        },
                      },
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toMatch(/archived/i);
    expect(startProxmoxInstance).not.toHaveBeenCalled();
    expect(powerOnServer).not.toHaveBeenCalled();
    expect(apiError).toHaveBeenCalledWith(
      expect.stringMatching(/archived/i),
      409,
      expect.objectContaining({
        failureType: "instance_dormant_reclaimed",
        retryable: false,
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        instanceId: "inst-123",
      })
    );
  });

  it("clears stale credit suspensions before start because compute credits no longer gate access", async () => {
    const clearEqUser = jest.fn().mockResolvedValue({ error: null });
    const clearEqId = jest.fn().mockReturnValue({ eq: clearEqUser });
    const finalEq = jest.fn().mockResolvedValue({ error: null });
    const updateMock = jest.fn((patch: Record<string, unknown>) => {
      if (patch.entitlement_reason === "credit_compute_gate_disabled") {
        return { eq: clearEqId };
      }

      return { eq: finalEq };
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "stopped",
                      lifecycle_state: "suspended",
                      entitlement_state: "suspended",
                      entitlement_reason: "insufficient_credits",
                      entitlement_suspended_at: "2026-05-13T12:00:00.000Z",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: null,
                      api_key_encrypted: "encrypted",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateMock,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(powerOnServer).toHaveBeenCalledWith(42);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlement_state: "ok",
        entitlement_reason: "credit_compute_gate_disabled",
        entitlement_grace_started_at: null,
        entitlement_grace_ends_at: null,
        entitlement_suspended_at: null,
        entitlement_last_resumed_at: expect.any(String),
      })
    );
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "provisioning",
        lifecycle_state: "provisioning",
      })
    );
    expect(log.info).toHaveBeenCalledWith(
      "cleared stale credit entitlement suspension before instance action",
      expect.objectContaining({
        failureType: "legacy_credit_suspension_cleared",
        action: "start",
        entitlementReason: "insufficient_credits",
      })
    );
  });

  it("restarts the gateway inside the instance container for restart_gateway", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok",
      stderr: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart_gateway" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.action).toBe("restart_gateway");
    expect(discoverContainerName).toHaveBeenCalledWith("203.0.113.66", "inst-123");
    expect(sshExec).toHaveBeenCalledWith(
      "203.0.113.66",
      expect.stringContaining('docker exec -e EXPECTED_HERMES_HOME="$EXPECTED_HERMES_HOME" "$CONTAINER_NAME" sh -lc')
    );
    expect(sshExec).toHaveBeenCalledWith(
      "203.0.113.66",
      expect.stringContaining('"$HERMES_BIN" gateway restart')
    );
    const restartCommand = (sshExec as jest.Mock).mock.calls.at(-1)?.[1] as string;
    expect(restartCommand).toContain("hermes_ensure_time_sync()");
    expect(restartCommand.indexOf("hermes_ensure_time_sync")).toBeLessThan(
      restartCommand.indexOf('"$HERMES_BIN" gateway restart')
    );
  });

  it("pins a Proxmox host when restarting a gateway on a shared private subnet", async () => {
    const proxmoxHostConfig = {
      hostId: null,
      hostSlug: "fixturenode13",
      envPrefix: "PROXMOX_FIXTURENODE13_",
      failClosed: true,
    };
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== "hermes_instances") throw new Error(`Unexpected table ${table}`);
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              neq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    id: "inst-123",
                    user_id: "user_123",
                    status: "running",
                    backend: "gateway",
                    host_id: null,
                    hetzner_server_id: null,
                    infrastructure_provider: "proxmox",
                    proxmox_node: "fixturenode13",
                    proxmox_vmid: 1302,
                    ipv4_address: "10.250.20.52",
                    config: {
                      infrastructure: {
                        provider: "proxmox",
                        node: "fixturenode13",
                        vmid: 1302,
                        privateIpv4: "10.250.20.52",
                        gatewayHost: "00000000000000000000.hermesos.cloud",
                        hostEnvPrefix: "PROXMOX_FIXTURENODE13_",
                      },
                    },
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("10.250.20.52");
    (discoverContainerName as jest.Mock).mockResolvedValue("agent-inst-123-gateway");
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "ok", stderr: "" });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart_gateway" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(discoverContainerName).not.toHaveBeenCalled();
    expect(sshExec).toHaveBeenCalledWith(
      "10.250.20.52",
      expect.stringContaining("docker compose restart gateway"),
      { timeoutMs: 300_000, proxmoxHostConfig }
    );
  });

  it("logs redacted gateway restart stdout when the launcher fails without stderr", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "Gateway failed after restart\nprovider=openrouter\ntoken=instance-action-secret",
      stderr: "",
      error: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart_gateway" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Gateway restart failed. Check the instance logs and try again.");
    expect(apiError).toHaveBeenCalledWith(
      "Gateway restart failed. Check the instance logs and try again.",
      500,
      expect.objectContaining({
        failureType: "ssh_exec_failed",
        retryable: false,
        stdout: expect.stringContaining("Gateway failed after restart"),
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          action: "restart_gateway",
        }),
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain("instance-action-secret");
  });

  it("returns actionable guidance when gateway restart fails on an instance with failed update", async () => {
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: null,
                      api_key_encrypted: "encrypted",
                      config: { lastUpdateReportStatus: "failed" },
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
    });

    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "Gateway failed after restart",
      error: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart_gateway" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe(
      "Gateway restart failed because the previous update reported a host-side failure. Please use 'Repair Runtime' to recreate the container stack."
    );
  });

  it("classifies no-route gateway restart failures as missing host instead of runtime repair", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "ssh: connect to host 10.250.0.24 port 22: No route to host",
      error: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart_gateway" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toMatch(/VM is unreachable or no longer exists/i);
    expect(apiError).toHaveBeenCalledWith(
      expect.stringMatching(/VM is unreachable or no longer exists/i),
      409,
      expect.objectContaining({
        failureType: "ssh_exec_failed",
        retryable: false,
      }),
      undefined,
      expect.objectContaining({
        metadata: expect.objectContaining({
          action: "restart_gateway",
          failureOwner: "hypervisor",
          failurePhase: "provisioning",
          failureType: "instance_host_missing",
          recoveryAction: "contact_support",
        }),
      })
    );
  });

  it("starts or replaces only the WebUI gateway process for restart_gateway on WebUI instances", async () => {
    const webuiInstance = {
      id: "inst-123",
      user_id: "user_123",
      status: "running",
      provider: "openai",
      backend: "webui",
      hetzner_server_id: 42,
      host_id: null,
      api_key_encrypted: "encrypted",
      config: {},
    };
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: webuiInstance,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok",
      stderr: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart_gateway" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.action).toBe("restart_gateway");
    expect(discoverContainerName).not.toHaveBeenCalled();
    const restartCommand = (sshExec as jest.Mock).mock.calls.at(-1)?.[1] as string;
    expect(sshExec).toHaveBeenLastCalledWith(
      "203.0.113.66",
      restartCommand,
      expect.objectContaining({ timeoutMs: 300_000 })
    );
    expect(restartCommand).toContain("docker compose exec -T --user 1024 webui sh -s");
    expect(restartCommand).toContain("docker compose config --services");
    expect(restartCommand).toContain("docker compose up -d gateway");
    expect(restartCommand).toContain('printf "%s\\n" "$BASE_HOME" > "$BASE_HOME/gateway-profiles.d/default.active"');
    expect(restartCommand).toContain("docker compose restart gateway");
    expect(restartCommand).toContain("unset HERMES_INFERENCE_PROVIDER HERMES_MODEL HERMES_SUBAGENT_MODEL MODEL PROVIDER LLM_PROVIDER HERMES_WEBUI_DEFAULT_MODEL");
    expect(restartCommand).toContain(buildLegacyManagedGatewayRunPython());
    expect(restartCommand).toContain(buildManagedGatewayStatusCommand());
    expect(restartCommand).not.toContain("uv run --extra messaging hermes gateway status");
    expect(spawnSync("bash", ["-n"], { input: restartCommand, encoding: "utf8" }).status).toBe(0);
    expect(restartCommand).not.toContain("gateway restart");
    expect(restartCommand).not.toContain("docker compose up -d --force-recreate");
    expect(restartCommand).not.toContain("dashboard-sidecar");
    expect(restartCommand).not.toContain("docker compose exec -T --user root webui python");
    expect(restartCommand).toContain("hermes_ensure_time_sync()");
    expect(restartCommand.indexOf("hermes_ensure_time_sync")).toBeLessThan(
      restartCommand.indexOf("docker compose up -d gateway")
    );
    expect(restartCommand).toContain("docker compose logs --tail=80 gateway");
    expect(restartCommand).toContain("def load_env_file(path: Path) -> None");
    expect(restartCommand).toContain('os.environ[key] = decode_quoted_env_value(value.strip())');
    expect(restartCommand).toContain('cd "$BASE_HOME/hermes-agent"\nnohup python -');
    expect(restartCommand).toContain('tail -80 "$PROFILE_HOME/logs/gateway.log"');
    expect(restartCommand).not.toContain('. "$PROFILE_HOME/.env"');
    expect(restartCommand).not.toContain("set -a");
    // The legacy-backend topology probe must neutralize the `docker compose
    // config` exit code with `{ …; || true; }` before the pipe, so a non-zero
    // `config` (deprecation/validation hiccup) under `set -euo pipefail` can't
    // fail the pipeline, flip the `if` false, and wrongly fall through to the
    // in-`webui`-container bootstrap on a row drifted to the gateway topology
    // (`service "webui" is not running`). Same bug class as hermesdeploy#470/#403.
    expect(restartCommand).toContain(
      "if { docker compose config --services 2>/dev/null || true; } | grep -qx gateway; then"
    );
    expect(restartCommand).not.toContain(
      "docker compose config --services 2>/dev/null | grep -qx gateway"
    );
  });

  it("restarts the gateway compose service directly for restart_gateway on gateway-backend (webfree) instances", async () => {
    const gatewayInstance = {
      id: "inst-123",
      user_id: "user_123",
      status: "running",
      provider: "openai",
      backend: "gateway",
      hetzner_server_id: 42,
      host_id: null,
      api_key_encrypted: "encrypted",
      config: {},
    };
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: gatewayInstance,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok",
      stderr: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart_gateway" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.action).toBe("restart_gateway");
    // gateway/webfree backend resolves the runtime container locally, not via discovery
    expect(discoverContainerName).not.toHaveBeenCalled();

    const restartCommand = (sshExec as jest.Mock).mock.calls.at(-1)?.[1] as string;
    // Restarts the `gateway` compose service…
    expect(restartCommand).toContain("docker compose up -d gateway");
    expect(restartCommand).toContain("docker compose restart gateway");
    expect(restartCommand).toContain(`docker compose exec -T gateway ${buildManagedGatewayStatusCommand()}`);
    expect(restartCommand).not.toContain("uv run");
    expect(spawnSync("bash", ["-n"], { input: restartCommand, encoding: "utf8" }).status).toBe(0);
    // …and NEVER targets the absent `webui` compose service (the 2026-06-24
    // incident: `service "webui" is not running`).
    expect(restartCommand).not.toContain("docker compose exec -T --user 1024 webui");
    expect(restartCommand).not.toContain("docker compose restart webui");
    // A gateway-backend box restarts unconditionally — no fragile `docker compose
    // config` probe that can fall through to the webui bootstrap under pipefail.
    expect(restartCommand).not.toContain("docker compose config --services");
    expect(restartCommand).not.toContain("nohup python");
    expect(restartCommand).toContain("hermes_ensure_time_sync()");
    expect(restartCommand.indexOf("hermes_ensure_time_sync")).toBeLessThan(
      restartCommand.indexOf("docker compose up -d gateway")
    );
    // A stopped gateway cannot accept `docker compose exec`. Start the service
    // first so Restart Gateway can recover the exact offline state it exists for.
    expect(restartCommand.indexOf("docker compose up -d gateway")).toBeLessThan(
      restartCommand.indexOf("docker compose exec -T --user 1024 gateway")
    );
    // Loaded hosts have taken more than 190s to expose the chat lane. Keep the
    // restart request alive long enough to distinguish slow readiness from a
    // failed restart instead of marking a healthy agent as errored after 10s.
    expect(restartCommand).toContain('while [ "$attempt" -lt 120 ]; do');
    expect(restartCommand).toContain("sleep 2");
    expect(sshExec).toHaveBeenLastCalledWith(
      "203.0.113.66",
      restartCommand,
      expect.objectContaining({ timeoutMs: 300_000 })
    );
  });

  it("falls back to the sshExec error field for redeploy failures when stderr is empty", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection error: fingerprint mismatch",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "redeploy" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Redeploy failed. Check the instance logs and try again.");
    expect(apiError).toHaveBeenCalledWith(
      "Redeploy failed. Check the instance logs and try again.",
      500,
      expect.objectContaining({
        failureType: "ssh_exec_failed",
        retryable: false,
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          action: "redeploy",
        }),
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain("fingerprint mismatch");
  });

  it.each([
    ["redeploy", undefined],
    ["redeploy", true],
    ["redeploy", "true"],
    ["repair_runtime", true],
    ["rebuild_runtime", true],
  ])("routes WebUI %s with explicit terminal apply intent %s", async (action, applyTerminalBackend) => {
    const webuiInstance = {
      id: "inst-123",
      user_id: "user_123",
      status: "running",
      provider: "custom_llm",
      backend: "webui",
      hetzner_server_id: 42,
      host_id: null,
      api_key_encrypted: "encrypted",
      api_server_key_encrypted: "server-key",
      config: {
        model: "claude-opus-4-7",
        agentSettings: {
          customLlmBaseUrl: "https://example-llm.test/v1",
        },
      },
    };
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: webuiInstance,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("10.250.20.55");
    (applyLiveUpdate as jest.Mock).mockResolvedValue({ applied: true });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action, applyTerminalBackend }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    // The owner asked for this restart: user-initiated, so no in-flight deferral.
    const expectedOptions =
      action === "redeploy" && applyTerminalBackend === true
        ? { initiator: USER_LIVE_UPDATE, applyTerminalBackend: true }
        : { initiator: USER_LIVE_UPDATE };
    expect(applyLiveUpdate).toHaveBeenCalledWith(webuiInstance, "10.250.20.55", {}, supabaseAdmin, expectedOptions);
    expect(buildAgentDeployScript).not.toHaveBeenCalled();
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("does not leak raw live update errors to the client", async () => {
    (applyLiveUpdate as jest.Mock).mockResolvedValue({
      applied: false,
      error: 'docker API leaked "sk-live-secret"',
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "update" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Update failed. Check the instance logs and try again.");
    expect(json.error).not.toContain("sk-live-secret");
    expect(apiError).toHaveBeenCalledWith(
      "Update failed. Check the instance logs and try again.",
      500,
      expect.objectContaining({
        failureType: "live_update_failed",
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          action: "update",
        }),
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain("sk-live-secret");
  });

  it("threads a stored Nous OAuth bundle into runtime redeploys without an OPENAI key", async () => {
    (resolveNousDeploymentSecret as jest.Mock).mockReturnValue({
      apiKey: "",
      authBundle: {
        portalBaseUrl: "https://portal.nousresearch.com",
        inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
        clientId: "hermes-cli",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "nous",
                      hetzner_server_id: 42,
                      host_id: null,
                      api_key_encrypted: "serialized-nous-session",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "profiles") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                not: jest.fn().mockResolvedValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "redeploy" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(buildAgentDeployScript).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "nous",
        apiKey: "",
        nousAuthBundle: expect.objectContaining({
          accessToken: "access-token",
          refreshToken: "refresh-token",
        }),
      })
    );
  });

  it("threads a stored Codex OAuth bundle into runtime redeploys for openai-codex aliases", async () => {
    (resolveCodexDeploymentSecret as jest.Mock).mockReturnValue({
      apiKey: "",
      authBundle: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        lastRefresh: "2026-04-11T12:00:00Z",
      },
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai-codex",
                      hetzner_server_id: 42,
                      host_id: null,
                      api_key_encrypted: "serialized-codex-session",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "profiles") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                not: jest.fn().mockResolvedValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "redeploy" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(resolveCodexDeploymentSecret).toHaveBeenCalledWith("serialized-codex-session");
    expect(buildAgentDeployScript).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        apiKey: "",
        codexAuthBundle: expect.objectContaining({
          accessToken: "access-token",
          refreshToken: "refresh-token",
        }),
      })
    );
  });

  it("returns a retryable provisioning response when SSH fingerprint capture is still warming up during restart", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "Timed out capturing SSH host fingerprint from 203.0.113.80 after 5355ms",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("Instance is still provisioning SSH access. Try again in a moment.");
    expect(apiError).toHaveBeenCalledWith(
      "Instance is still provisioning SSH access. Try again in a moment.",
      409,
      expect.objectContaining({
        failureType: "ssh_exec_failed",
        retryable: true,
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          action: "restart",
        }),
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain("203.0.113.80");
  });

  it("returns a retryable provisioning response when SSH to the host times out during redeploy warmup", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection error: connect ETIMEDOUT 203.0.113.185:22",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "redeploy" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("Instance is still provisioning SSH access. Try again in a moment.");
    expect(apiError).toHaveBeenCalledWith(
      "Instance is still provisioning SSH access. Try again in a moment.",
      409,
      expect.objectContaining({
        failureType: "ssh_exec_failed",
        retryable: true,
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          action: "redeploy",
        }),
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain("203.0.113.185");
  });

  it("returns a retryable provisioning response when the runtime container is still starting during redeploy patching", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: [
        'Image ghcr.io/ashneil12/vanilla-hermes-agent:latest Pulled',
        'Container agent-inst-123 Running',
        'FATAL: agent-inst-123 did not start before runtime patching',
      ].join("\n"),
      error: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "redeploy" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("Instance runtime is still starting. Try again in a moment.");
    expect(apiError).toHaveBeenCalledWith(
      "Instance runtime is still starting. Try again in a moment.",
      409,
      expect.objectContaining({
        failureType: "ssh_exec_failed",
        retryable: true,
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          action: "redeploy",
        }),
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain(
      "did not start before runtime patching"
    );
  });

  it("returns a retryable provisioning response when a live update hits the runtime-startup guard", async () => {
    (applyLiveUpdate as jest.Mock).mockResolvedValue({
      applied: false,
      error: "FATAL: agent-inst-123 did not start before runtime patching",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "update" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("Instance runtime is still starting. Try again in a moment.");
    expect(apiError).toHaveBeenCalledWith(
      "Instance runtime is still starting. Try again in a moment.",
      409,
      expect.objectContaining({
        failureType: "live_update_failed",
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          action: "update",
        }),
      })
    );
  });

  it("preserves profile routing metadata when building the redeploy script", async () => {
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok",
      stderr: "",
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "redeploy" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(buildAgentDeployScript).toHaveBeenCalledWith(
      expect.objectContaining({
        profileRoutes: [
          { name: "skodari", port: 8650 },
          { name: "research", port: 8651 },
        ],
        profilesToRestore: [
          { name: "skodari", port: 8650 },
        ],
      })
    );
  });

  it("syncs the attached host to stopped when a shared instance is stopped", async () => {
    const hostUpdateEqMock = jest.fn().mockResolvedValue({ error: null });
    const hostUpdateMock = jest.fn().mockReturnValue({
      eq: hostUpdateEqMock,
    });
    const instanceUpdateNotMock = jest.fn().mockResolvedValue({ error: null });
    const instanceUpdateEqMock = jest.fn().mockReturnValue({
      not: instanceUpdateNotMock,
    });
    const instanceUpdateMock = jest.fn().mockReturnValue({
      eq: instanceUpdateEqMock,
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-456",
                      api_key_encrypted: "encrypted",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: instanceUpdateMock,
        };
      }

      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    id: "host-456",
                    user_id: "user_123",
                    hetzner_server_id: 42,
                    ipv4_address: "203.0.113.10",
                  },
                  error: null,
                }),
              }),
            }),
          }),
          update: hostUpdateMock,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "stop" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(shutdownServer).toHaveBeenCalledWith(42);
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "stopped",
        lifecycle_state: "paused",
        last_lifecycle_transition_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
    // F055: the instance status mirror is scoped to the TARGET instance only
    // (not host_id), so a shared-host power action never flips siblings' rows.
    // The host mirror row (hermes_hosts) still syncs — asserted via hostUpdateEqMock.
    expect(instanceUpdateEqMock).toHaveBeenCalledWith("id", "inst-123");
    expect(instanceUpdateEqMock).not.toHaveBeenCalledWith("host_id", "host-456");
    expect(instanceUpdateNotMock).toHaveBeenCalledWith(
      "status",
      "in",
      '("deleted","scheduled_for_deletion")'
    );
    expect(hostUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "stopped",
        updated_at: expect.any(String),
      })
    );
    expect(hostUpdateEqMock).toHaveBeenCalledWith("id", "host-456");
  });

  it("syncs the attached host to provisioning when a shared instance is started", async () => {
    const hostUpdateEqMock = jest.fn().mockResolvedValue({ error: null });
    const hostUpdateMock = jest.fn().mockReturnValue({
      eq: hostUpdateEqMock,
    });
    const instanceUpdateNotMock = jest.fn().mockResolvedValue({ error: null });
    const instanceUpdateEqMock = jest.fn().mockReturnValue({
      not: instanceUpdateNotMock,
    });
    const instanceUpdateMock = jest.fn().mockReturnValue({
      eq: instanceUpdateEqMock,
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "stopped",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-456",
                      api_key_encrypted: "encrypted",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: instanceUpdateMock,
        };
      }

      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    id: "host-456",
                    user_id: "user_123",
                    hetzner_server_id: 42,
                    ipv4_address: "203.0.113.10",
                  },
                  error: null,
                }),
              }),
            }),
          }),
          update: hostUpdateMock,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(powerOnServer).toHaveBeenCalledWith(42);
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "provisioning",
        updated_at: expect.any(String),
      })
    );
    // F055: the instance status mirror is scoped to the TARGET instance only
    // (not host_id), so a shared-host power action never flips siblings' rows.
    // The host mirror row (hermes_hosts) still syncs — asserted via hostUpdateEqMock.
    expect(instanceUpdateEqMock).toHaveBeenCalledWith("id", "inst-123");
    expect(instanceUpdateEqMock).not.toHaveBeenCalledWith("host_id", "host-456");
    expect(instanceUpdateNotMock).toHaveBeenCalledWith(
      "status",
      "in",
      '("deleted","scheduled_for_deletion")'
    );
    expect(hostUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "provisioning",
        updated_at: expect.any(String),
      })
    );
    expect(hostUpdateEqMock).toHaveBeenCalledWith("id", "host-456");
  });

  it("keeps the attached host in provisioning while a shared instance restore is underway", async () => {
    const hostUpdateEqMock = jest.fn().mockResolvedValue({ error: null });
    const hostUpdateMock = jest.fn().mockReturnValue({
      eq: hostUpdateEqMock,
    });
    const instanceUpdateNotMock = jest.fn().mockResolvedValue({ error: null });
    const instanceUpdateEqMock = jest.fn().mockReturnValue({
      not: instanceUpdateNotMock,
    });
    const instanceUpdateMock = jest.fn().mockReturnValue({
      eq: instanceUpdateEqMock,
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-456",
                      api_key_encrypted: "encrypted",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: instanceUpdateMock,
        };
      }

      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    id: "host-456",
                    user_id: "user_123",
                    hetzner_server_id: 42,
                    ipv4_address: "203.0.113.10",
                  },
                  error: null,
                }),
              }),
            }),
          }),
          update: hostUpdateMock,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restore_backup", backupId: 99 }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(rebuildServer).toHaveBeenCalledWith(42, { image: "99" });
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "redeploying",
        updated_at: expect.any(String),
      })
    );
    // F055: the instance status mirror is scoped to the TARGET instance only
    // (not host_id), so a shared-host power action never flips siblings' rows.
    // The host mirror row (hermes_hosts) still syncs — asserted via hostUpdateEqMock.
    expect(instanceUpdateEqMock).toHaveBeenCalledWith("id", "inst-123");
    expect(instanceUpdateEqMock).not.toHaveBeenCalledWith("host_id", "host-456");
    expect(instanceUpdateNotMock).toHaveBeenCalledWith(
      "status",
      "in",
      '("deleted","scheduled_for_deletion")'
    );
    expect(hostUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "provisioning",
        updated_at: expect.any(String),
      })
    );
    expect(hostUpdateEqMock).toHaveBeenCalledWith("id", "host-456");
  });

  it("does not update the instance row if the shared host status cannot be synced", async () => {
    (log.error as jest.Mock).mockClear();
    const hostUpdateEqMock = jest
      .fn()
      .mockResolvedValueOnce({ error: { message: "host-sync-secret" } })
      .mockResolvedValueOnce({ error: { message: "host-sync-secret" } });
    const hostUpdateMock = jest.fn().mockReturnValue({
      eq: hostUpdateEqMock,
    });
    const instanceUpdateEqMock = jest.fn().mockResolvedValue({ error: null });
    const instanceUpdateMock = jest.fn().mockReturnValue({
      eq: instanceUpdateEqMock,
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-456",
                      api_key_encrypted: "encrypted",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: instanceUpdateMock,
        };
      }

      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    id: "host-456",
                    user_id: "user_123",
                    hetzner_server_id: 42,
                    ipv4_address: "203.0.113.10",
                  },
                  error: null,
                }),
              }),
            }),
          }),
          update: hostUpdateMock,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "stop" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to perform instance action.");
    expect(hostUpdateEqMock).toHaveBeenCalledTimes(2);
    expect(instanceUpdateMock).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "failed to sync host status",
      expect.anything(),
      expect.objectContaining({
        source: "instances",
        failureType: "host_status_update_failed",
        instanceId: "inst-123",
        hostId: "host-456",
      })
    );
    const errorContextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
    expect(JSON.stringify(errorContextCalls)).not.toContain("host-sync-secret");
  });

  describe("Proxmox-backed power actions", () => {
    const infrastructure = {
      provider: "proxmox" as const,
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "abc123.agents.hermesos.cloud",
    };

    function mockProxmoxInstance(overrides: Record<string, unknown> = {}) {
      const updateEq = jest.fn().mockResolvedValue({ error: null });
      const updateMock = jest.fn().mockReturnValue({ eq: updateEq });

      (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
        if (table === "hermes_instances") {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  neq: jest.fn().mockReturnValue({
                    single: jest.fn().mockResolvedValue({
                      data: {
                        id: "inst-123",
                        user_id: "user_123",
                        status: "running",
                        provider: "openai",
                        hetzner_server_id: null,
                        host_id: null,
                        api_key_encrypted: "encrypted",
                        config: { infrastructure },
                        ...overrides,
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
            update: updateMock,
          };
        }

        throw new Error(`Unexpected table ${table}`);
      });

      return { updateMock, updateEq };
    }

    it("starts the Proxmox VM and skips Hetzner power calls when starting a Proxmox instance", async () => {
      (startProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: "",
        stderr: "",
      });
      const { updateMock } = mockProxmoxInstance();

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );

      expect(response.status).toBe(200);
      // setOnboot:1 restores boot-on-host-reboot for the resumed agent (inverse
      // of the inactivity-pause onboot:0).
      expect(startProxmoxInstance).toHaveBeenCalledWith(infrastructure, {
        hostConfig: null,
        setOnboot: 1,
      });
      expect(powerOnServer).not.toHaveBeenCalled();
      expect(getServer).not.toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "running",
          lifecycle_state: "active",
          last_lifecycle_transition_at: expect.any(String),
        })
      );
      expect(mockedRecordInstanceUserActivity).toHaveBeenCalledWith({
        instanceId: "inst-123",
        userId: "user_123",
        source: "instance_lifecycle_action",
      });
    });

    it("starts a Proxmox row from stored VM metadata when config infrastructure is missing", async () => {
      (startProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: "",
        stderr: "",
      });
      const { updateMock } = mockProxmoxInstance({
        infrastructure_provider: "proxmox",
        proxmox_node: "fixturenode1",
        proxmox_vmid: 201,
        config: {},
      });

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );

      expect(response.status).toBe(200);
      expect(startProxmoxInstance).toHaveBeenCalledWith(
        { vmid: 201, node: "fixturenode1" },
        {
          hostConfig: { hostId: null, hostSlug: "fixturenode1", envPrefix: null, failClosed: true },
          setOnboot: 1,
        }
      );
      expect(powerOnServer).not.toHaveBeenCalled();
      expect(getServer).not.toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "running",
          lifecycle_state: "active",
          last_lifecycle_transition_at: expect.any(String),
        })
      );
    });

    it("repairs legacy Proxmox routing across the fleet before starting", async () => {
      const recoveredInfrastructure = {
        ...infrastructure,
        node: "fixturenode13",
      };
      (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({
        status: "recovered",
        found: {
          hostSlug: "fixturenode13",
          vmid: 201,
          privateIpv4: "10.250.20.51",
          gatewayFqdn: "abc123.agents.hermesos.cloud",
          bearer: "secret",
        },
        infrastructure: recoveredInfrastructure,
      });
      (startProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: "",
        stderr: "",
      });
      mockProxmoxInstance({
        config: {},
        infrastructure_provider: null,
        proxmox_node: "fixturenode13",
        proxmox_vmid: null,
        updated_at: "2026-08-27T00:00:00.000Z",
      });

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );

      expect(response.status).toBe(200);
      expect(recoverProxmoxInstanceAcrossFleet).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "inst-123",
          proxmox_node: "fixturenode13",
          updated_at: "2026-08-27T00:00:00.000Z",
        }),
        { allowStopped: true },
      );
      expect(startProxmoxInstance).toHaveBeenCalledWith(
        recoveredInfrastructure,
        expect.objectContaining({ setOnboot: 1 })
      );
      expect(powerOnServer).not.toHaveBeenCalled();
    });

    it("preserves an unrouted agent and exposes a retryable machine code", async () => {
      mockProxmoxInstance({
        config: {},
        infrastructure_provider: null,
        proxmox_node: null,
        proxmox_vmid: null,
        host_id: null,
        hetzner_server_id: null,
      });

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );
      const json = await response.json();

      expect(response.status).toBe(503);
      expect(json.failureType).toBe("instance_host_recovery_pending");
      expect(json.retryable).toBe(true);
      expect(json.error).toMatch(/preserved/i);
      expect(recoverProxmoxInstanceAcrossFleet).toHaveBeenCalledWith(
        expect.objectContaining({ id: "inst-123" }),
        { allowStopped: true },
      );
      expect(powerOnServer).not.toHaveBeenCalled();
    });

    it("returns a retryable 429 and never runs qm start when wake admission defers", async () => {
      (acquireHostWakeSlot as jest.Mock).mockResolvedValueOnce({
        admitted: false,
        reason: "concurrency",
        freeMb: 900,
        activeWakes: 2,
        cap: 2,
        retryAfterSeconds: 30,
      });
      mockProxmoxInstance({ status: "stopped" });

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start", wakeSource: "wake_page", wakeId: "wk-1" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );
      const json = await response.json();

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(json.retryAfterSeconds).toBe(30);
      expect(json.error).toMatch(/busy waking/i);
      expect(startProxmoxInstance).not.toHaveBeenCalled();
    });

    it("passes the instance's RAM need into the admission guard before starting", async () => {
      (startProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: "",
        stderr: "",
      });
      mockProxmoxInstance({ status: "stopped", ram_limit: 2048 });

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );

      expect(response.status).toBe(200);
      expect(acquireHostWakeSlot).toHaveBeenCalledWith(
        infrastructure,
        expect.objectContaining({ instanceId: "inst-123", neededRamMb: 2048 })
      );
      expect(startProxmoxInstance).toHaveBeenCalled();
    });

    it("releases the wake slot early when qm start fails outright", async () => {
      (startProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: false,
        stdout: "",
        stderr: "qm start blew up",
      });
      mockProxmoxInstance({ status: "stopped" });

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );

      expect(response.status).toBe(500);
      expect(releaseHostWakeSlot).toHaveBeenCalledWith(
        infrastructure,
        expect.objectContaining({ instanceId: "inst-123" })
      );
    });

    it.each([
      ["inconclusive", "instance_host_recovery_pending", true],
      ["error", "instance_host_recovery_pending", true],
      ["gone", "instance_host_missing_across_fleet", false],
    ] as const)("preserves lifecycle state after a missing-VM scan returns %s", async (status, failureType, retryable) => {
      // VM was destroyed by Phase 2 cleanup after a failed bootstrap
      // (e.g. transient apt-lock failure) but the row was left as
      // status='stopped' with proxmox_vmid set. The dashboard's "start"
      // button shouldn't keep trying qm start on a non-existent VM —
      // surface a machine-coded 409 without destructive advice. A concurrent
      // settings/lifecycle write must not be overwritten after the scan.
      (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({
        status,
        ...(status === "error" ? { error: new Error("reconcile_row_changed_concurrently") } : {}),
      });
      (startProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: false,
        stdout: "HERMES_VM_MISSING\n",
        stderr: "",
        error: "Remote bash exited with code 64",
      });
      const { updateMock } = mockProxmoxInstance({
        updated_at: "2026-08-27T00:00:00.000Z",
      });

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "start" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );
      const json = await response.json();

      expect(response.status).toBe(409);
      expect(json.error).toMatch(/preserved/i);
      expect(json.failureType).toBe(failureType);
      expect(json.retryable).toBe(retryable);
      expect(updateMock).not.toHaveBeenCalled();
      expect(recoverProxmoxInstanceAcrossFleet).toHaveBeenCalledWith(
        expect.objectContaining({ updated_at: "2026-08-27T00:00:00.000Z" }),
        { allowStopped: true },
      );
    });

    it("shuts down the Proxmox VM and skips Hetzner power calls when stopping a Proxmox instance", async () => {
      (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: "",
        stderr: "",
      });
      const { updateMock } = mockProxmoxInstance();

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "stop" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );

      expect(response.status).toBe(200);
      expect(shutdownProxmoxInstance).toHaveBeenCalledWith(infrastructure, { hostConfig: null });
      expect(shutdownServer).not.toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "stopped",
          lifecycle_state: "paused",
          last_lifecycle_transition_at: expect.any(String),
        })
      );
    });

    it("reboots the Proxmox VM and skips Hetzner power calls when rebooting a Proxmox instance", async () => {
      (rebootProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: "",
        stderr: "",
      });
      const { updateMock } = mockProxmoxInstance();

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "reboot" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );

      expect(response.status).toBe(200);
      expect(rebootProxmoxInstance).toHaveBeenCalledWith(infrastructure, { hostConfig: null });
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: "running" })
      );
    });

    it("surfaces the Proxmox error when a power action script fails", async () => {
      (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: false,
        stdout: "",
        stderr: "qm: VM 201 is locked",
        error: "host script exited with code 1",
      });
      const { updateMock } = mockProxmoxInstance();

      const response = await POST(
        makeJsonRequest("http://localhost/api/instances/inst-123", { action: "stop" }, { method: "POST" }),
        { params: Promise.resolve({ id: "inst-123" }) }
      );
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.error).toContain("host script exited with code 1");
      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});

describe("isAdvancedCloudAccessEligible", () => {
  it("allows a dedicated Hetzner server", () => {
    expect(isAdvancedCloudAccessEligible({
      config: {},
      host_id: null,
      hetzner_server_id: 42,
      infrastructure_provider: "hetzner",
      proxmox_vmid: null,
    })).toBe(true);
  });

  it("allows a Proxmox VM even when its physical fleet host is recorded", () => {
    expect(isAdvancedCloudAccessEligible({
      config: {},
      host_id: "host-fixturenode13",
      hetzner_server_id: null,
      infrastructure_provider: "proxmox",
      proxmox_vmid: 1302,
    })).toBe(true);
  });

  it("rejects an unproven legacy shared-host layout", () => {
    expect(isAdvancedCloudAccessEligible({
      config: {},
      host_id: "shared-host-1",
      hetzner_server_id: 42,
      infrastructure_provider: "hetzner",
      proxmox_vmid: null,
    })).toBe(false);
  });
});

describe("PATCH /api/instances/[id]", () => {
  let instanceUpdateMock: jest.Mock;
  let instanceRow: Record<string, unknown>;
  const mockedResolveWebUIInstanceClient = resolveWebUIInstanceClient as jest.MockedFunction<typeof resolveWebUIInstanceClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED;
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (getAutoUpdateConfig as jest.Mock).mockReturnValue({ enabled: false, time: "06:00" });
    (isProTierUser as jest.Mock).mockResolvedValue({ ok: true, tier: "operator" });
    (buildAdvancedInstanceConfigPayload as jest.Mock).mockImplementation(
      (_currentConfig: Record<string, unknown>, patchDto: Record<string, unknown>) => ({
        model: "gpt-test",
        autoUpdate: patchDto.autoUpdate,
        memorySystem: patchDto.memorySystem,
      })
    );
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: {
        setProviderKey: jest.fn().mockResolvedValue({ ok: true }),
        setDefaultModel: jest.fn().mockResolvedValue({ ok: true }),
      } as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });

    instanceRow = {
      id: "inst-123",
      user_id: "user_123",
      status: "running",
      provider: "openai",
      hetzner_server_id: 42,
      host_id: null,
      api_key_encrypted: "encrypted",
      honcho_api_key_encrypted: "legacy-honcho-key",
      config: {},
    };

    instanceUpdateMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: {
                ...instanceRow,
                config: { model: "gpt-test" },
              },
              error: null,
            }),
          }),
        }),
      }),
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: instanceRow,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: instanceUpdateMock,
        };
      }

      if (table === "user_api_keys") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: null,
                  error: null,
                }),
              }),
              maybeSingle: jest.fn().mockResolvedValue({
                data: null,
                error: null,
              }),
            }),
          }),
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: { id: "vault-key-1" },
                error: null,
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("rejects privileged Docker access on a legacy shared-host layout", async () => {
    instanceRow = {
      ...instanceRow,
      host_id: "shared-host-1",
      infrastructure_provider: "hetzner",
      config: {},
    };

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          agentSettings: { enableRootAccess: true },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error).toContain("only available on isolated customer VMs");
    expect(instanceUpdateMock).not.toHaveBeenCalled();
  });

  it("passes auto-approve chat preference through the settings save schema", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          agentSettings: {
            autoApproveToolCalls: true,
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(buildAdvancedInstanceConfigPayload).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        agentSettings: expect.objectContaining({
          autoApproveToolCalls: true,
        }),
      })
    );
  });

  it("rejects invalid OpenRouter key shapes before updating the instance or vault", async () => {
    instanceRow = {
      ...instanceRow,
      provider: "openai",
      backend: "webui",
    };

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          provider: "openrouter",
          apiKey: "github_pat_wrong_secret",
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("OpenRouter API keys must start with sk-or-.");
    expect(instanceUpdateMock).not.toHaveBeenCalled();
  });

  it("logs future agent settings keys before schema stripping can hide them", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          agentSettings: {
            futureChatPreference: true,
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(log.warn).toHaveBeenCalledWith(
      "ignored unknown instance agent settings",
      expect.objectContaining({
        failureType: "instance_settings_unknown_agent_settings",
        ignoredAgentSettings: ["futureChatPreference"],
      })
    );
  });

  it("blocks WebUI browser sidecar opt-in unless the deployment gate is enabled", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          agentSettings: {
            browserSidecarEnabled: true,
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error).toContain("Browser sidecar is only enabled for explicitly configured deployments");
    expect(isProTierUser).not.toHaveBeenCalled();
    expect(instanceUpdateMock).not.toHaveBeenCalled();
  });

  it("still requires Pro-tier for WebUI browser sidecar opt-in when the deployment gate is enabled", async () => {
    process.env.HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED = "1";
    (isProTierUser as jest.Mock).mockResolvedValue({
      ok: false,
      tier: "credit_base",
      reason: "tier_not_eligible",
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          agentSettings: {
            browserSidecarEnabled: true,
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error).toContain("Browser sidecar is a Pro-tier feature");
    expect(isProTierUser).toHaveBeenCalledWith("user_123");
    expect(instanceUpdateMock).not.toHaveBeenCalled();
  });

  it("marks WebUI browser sidecar toggles as requiring a redeploy so the service is actually provisioned", async () => {
    process.env.HERMES_BROWSER_SIDECAR_DEPLOY_ENABLED = "1";
    const nextConfig = {
      model: "gpt-test",
      agentSettings: {
        browserProvider: "local",
        browserSidecarEnabled: true,
      },
    };

    instanceRow = {
      ...instanceRow,
      backend: "webui",
      config: {
        agentSettings: {
          browserProvider: "local",
          browserSidecarEnabled: false,
        },
      },
    };

    (buildAdvancedInstanceConfigPayload as jest.Mock).mockReturnValue(nextConfig);
    instanceUpdateMock.mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: {
                ...instanceRow,
                config: nextConfig,
              },
              error: null,
            }),
          }),
        }),
      }),
    });
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          agentSettings: {
            browserSidecarEnabled: true,
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(isProTierUser).toHaveBeenCalledWith("user_123");
    expect(json.data.redeployRequired).toBe(true);
    expect(json.data.instance.config.agentSettings.browserSidecarEnabled).toBe(true);
    expect(applyLiveUpdate).not.toHaveBeenCalled();
  });

  it("mirrors a unified Honcho memory-system key into the legacy encrypted field", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          memorySystem: {
            provider: "honcho",
            honchoApiKey: "fresh-honcho-key",
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        honcho_api_key_encrypted: "fresh-honcho-key",
      })
    );
  });

  it("clears the legacy Honcho encrypted field when the unified memory-system key is cleared", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          memorySystem: {
            provider: "honcho",
            honchoApiKey: "",
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        honcho_api_key_encrypted: null,
      })
    );
  });

  it("passes a root toggle through save and live apply without dropping compatibility fields", async () => {
    const nextConfig = {
      model: "gpt-test",
      agentSettings: {
        runtimeMode: "developer",
        enableRootAccess: false,
        mountPersistentSource: true,
      },
    };

    instanceRow = {
      ...instanceRow,
      config: {
        agentSettings: {
          runtimeMode: "developer",
          enableRootAccess: true,
          mountPersistentSource: true,
        },
      },
    };

    instanceUpdateMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: {
                ...instanceRow,
                config: nextConfig,
              },
              error: null,
            }),
          }),
        }),
      }),
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: instanceRow,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: instanceUpdateMock,
        };
      }

      if (table === "user_api_keys") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: null,
                  error: null,
                }),
              }),
              maybeSingle: jest.fn().mockResolvedValue({
                data: null,
                error: null,
              }),
            }),
          }),
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: { id: "vault-key-1" },
                error: null,
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    (buildAdvancedInstanceConfigPayload as jest.Mock).mockReturnValue(nextConfig);
    (clerkClient as unknown as jest.Mock).mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }),
      },
    });
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("203.0.113.10");
    (applyLiveUpdate as jest.Mock).mockResolvedValue({
      applied: true,
    });
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          apply: true,
          agentSettings: {
            enableRootAccess: false,
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    const json = await response.json();

    expect(response.status).toBe(200);
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: nextConfig,
      })
    );
    expect(applyLiveUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: nextConfig,
      }),
      "203.0.113.10",
      {},
      supabaseAdmin,
      { initiator: USER_LIVE_UPDATE }
    );
    expect(json.data.applied).toBe(true);
    expect(json.data.instance.config).toEqual(nextConfig);
  });

  it("syncs auto-update schedules to the host when the setting is saved", async () => {
    const nextConfig = {
      model: "gpt-test",
      autoUpdate: {
        enabled: true,
        time: "07:30",
      },
    };

    (buildAdvancedInstanceConfigPayload as jest.Mock).mockReturnValue(nextConfig);
    (getAutoUpdateConfig as jest.Mock).mockReturnValue(nextConfig.autoUpdate);
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("203.0.113.10");
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "ok",
      stderr: "",
    });
    instanceUpdateMock.mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: {
                ...instanceRow,
                config: nextConfig,
              },
              error: null,
            }),
          }),
        }),
      }),
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          autoUpdate: {
            enabled: true,
            time: "07:30",
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(buildAutoUpdateTimerProvisioningScript).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst-123",
        containerName: "agent-inst-123",
        autoUpdate: {
          enabled: true,
          time: "07:30",
        },
      })
    );
    expect(sshExec).toHaveBeenCalledWith(
      "203.0.113.10",
      "#!/usr/bin/env bash\necho auto-update"
    );
    expect(json.data.autoUpdateApplied).toBe(true);
    expect(json.data.autoUpdateError).toBeNull();
    expect(json.data.instance.config.autoUpdate).toEqual({
      enabled: true,
      time: "07:30",
    });
  });

  it("installs the WEBFREE auto-update body (backend: 'webui') for a gateway-backend box (gateway ≡ webfree)", async () => {
    // Post gateway≡webfree collapse a "gateway" DB row runs the webfree stack, so
    // syncAutoUpdateSchedule must pass the webfree BUILD-MODE ("webui") to
    // buildAutoUpdateTimerProvisioningScript — the body that re-seeds the
    // agent-source volume — NOT the legacy "gateway" compose-recreate body. (The
    // backend arg is a build-mode selector, not a type coercion; pre-fix this
    // call site passed the raw DB backend → "gateway" → wrong body.)
    const nextConfig = {
      model: "gpt-test",
      autoUpdate: { enabled: true, time: "07:30" },
    };

    (buildAdvancedInstanceConfigPayload as jest.Mock).mockReturnValue(nextConfig);
    (getAutoUpdateConfig as jest.Mock).mockReturnValue(nextConfig.autoUpdate);
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("203.0.113.10");
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "ok", stderr: "" });
    instanceUpdateMock.mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: { ...instanceRow, backend: "gateway", config: nextConfig },
              error: null,
            }),
          }),
        }),
      }),
    });

    const response = await PATCH(
      makeJsonRequest("http://localhost/api/instances/inst-123", { autoUpdate: { enabled: true, time: "07:30" } }, { method: "PATCH" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(buildAutoUpdateTimerProvisioningScript).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "webui" })
    );
  });

  it("keeps auto-update settings saved even when the host is stopped", async () => {
    const nextConfig = {
      model: "gpt-test",
      autoUpdate: {
        enabled: false,
        time: "05:15",
      },
    };

    (buildAdvancedInstanceConfigPayload as jest.Mock).mockReturnValue(nextConfig);
    (getAutoUpdateConfig as jest.Mock).mockReturnValue(nextConfig.autoUpdate);
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);
    instanceUpdateMock.mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: {
                ...instanceRow,
                status: "stopped",
                config: nextConfig,
              },
              error: null,
            }),
          }),
        }),
      }),
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          autoUpdate: {
            enabled: false,
            time: "05:15",
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(sshExec).not.toHaveBeenCalled();
    expect(json.data.autoUpdateApplied).toBe(false);
    expect(json.data.autoUpdateError).toBe(
      "Settings were saved, but the instance is not running so the auto-update schedule was not installed yet."
    );
    expect(json.data.instance.config.autoUpdate).toEqual({
      enabled: false,
      time: "05:15",
    });
  });

  it("normalizes retryable runtime-startup failures returned from applyLiveUpdate", async () => {
    const nextConfig = {
      model: "gpt-test",
      memorySystem: undefined,
    };

    (buildAdvancedInstanceConfigPayload as jest.Mock).mockReturnValue(nextConfig);
    (clerkClient as unknown as jest.Mock).mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }),
      },
    });
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("203.0.113.10");
    (applyLiveUpdate as jest.Mock).mockResolvedValue({
      applied: false,
      error: "FATAL: agent-inst-123 did not start before runtime patching",
    });
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          apply: true,
          agentSettings: {
            enableRootAccess: false,
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.applied).toBe(false);
    expect(json.data.applyError).toBe("Instance runtime is still starting. Try again in a moment.");
  });

  it("does not expose raw applyLiveUpdate failures in PATCH responses", async () => {
    const nextConfig = {
      model: "gpt-test",
      memorySystem: undefined,
    };

    (buildAdvancedInstanceConfigPayload as jest.Mock).mockReturnValue(nextConfig);
    (clerkClient as unknown as jest.Mock).mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }),
      },
    });
    (resolveInstanceIpv4 as jest.Mock).mockResolvedValue("203.0.113.10");
    (applyLiveUpdate as jest.Mock).mockResolvedValue({
      applied: false,
      error: 'docker API leaked "sk-live-secret"',
    });
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          apply: true,
          agentSettings: {
            enableRootAccess: false,
          },
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.applied).toBe(false);
    expect(json.data.applyError).toBe(
      "Settings were saved, but the live update failed. Check the instance logs and try again."
    );
    expect(json.data.applyError).not.toContain("sk-live-secret");
  });

  it("does not leak unexpected instance action errors from the final POST catch", async () => {
    (auth as unknown as jest.Mock).mockRejectedValueOnce(new Error("instance-action-secret"));

    const response = await POST(
      makeJsonRequest("http://localhost/api/instances/inst-123", { action: "restart" }, { method: "POST" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to perform instance action.");
    expect(json.error).not.toContain("instance-action-secret");
    expect(apiError).toHaveBeenCalledWith(
      "Failed to perform instance action.",
      500,
      expect.objectContaining({
        failureType: "unexpected_instance_action_error",
        errorName: "Error",
      }),
      undefined,
      expect.objectContaining({
        source: "instance-actions",
        route: "/api/instances/[id]",
        metadata: expect.objectContaining({
          failureOwner: "hermes",
          failurePhase: "runtime",
          failureType: "unexpected_instance_action_error",
          recoveryAction: "open_console",
        }),
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain("instance-action-secret");
  });

  it("allows switching to Nous without a raw key and clears the stale provider secret", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          provider: "nous",
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "nous",
        api_key_encrypted: "",
      })
    );
  });

  it("does NOT live-push provider keys or models for webui-free instances (DB is the source of truth)", async () => {
    // The legacy live push is retired: the agent image serves no
    // setProviderKey/setDefaultModel endpoint (both 404), so the old push
    // silently failed while the route reported success. The key/model now
    // persist to the DB and reconcile onto the box on its next redeploy.
    const setProviderKey = jest.fn().mockResolvedValue({ ok: true });
    const setDefaultModel = jest.fn().mockResolvedValue({ ok: true });
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: {
        setProviderKey,
        setDefaultModel,
      } as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });

    instanceRow = {
      ...instanceRow,
      backend: "webui",
      provider: "openai",
    };
    instanceUpdateMock.mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: {
                ...instanceRow,
                backend: "webui",
                provider: "openai",
                config: { model: "gpt-test" },
              },
              error: null,
            }),
          }),
        }),
      }),
    });
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          provider: "openai",
          model: "gpt-test",
          apiKey: "openai-secret",
          apply: true,
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    // No live push — the box endpoints are gone.
    expect(setProviderKey).not.toHaveBeenCalled();
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect(applyLiveUpdate).not.toHaveBeenCalled();
    // Nothing applies live on webui-free; it lands on the box at next redeploy.
    expect(json.data.applied).toBe(false);
    expect(json.data.applyError).toBeNull();
    // But the key + model DID persist to the DB (the source of truth).
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        api_key_encrypted: "openai-secret",
      })
    );
  });

  it("strips managed Venice proxy config when settings save a real Venice API key", async () => {
    const setProviderKey = jest.fn().mockResolvedValue({ ok: true });
    const setDefaultModel = jest.fn().mockResolvedValue({ ok: true });
    mockedResolveWebUIInstanceClient.mockResolvedValue({
      ok: true,
      baseUrl: "https://webui.example.com",
      client: {
        setProviderKey,
        setDefaultModel,
      } as unknown as Awaited<ReturnType<typeof resolveWebUIInstanceClient>> extends { ok: true; client: infer T } ? T : never,
    });

    const managedConfig = {
      model: "llama-3.3-70b",
      managedVenice: {
        enabled: true,
        walletType: "hermesos",
        proxyBaseUrl: "https://hermesos.cloud/api/managed-venice/v1",
      },
      agentSettings: {
        runtimeMode: "managed",
        maxIterations: 60,
        customLlmBaseUrl: "https://hermesos.cloud/api/managed-venice/v1",
      },
    };
    const genericNextConfig = {
      ...managedConfig,
      model: "llama-3.3-70b",
    };

    (buildAdvancedInstanceConfigPayload as jest.Mock).mockReturnValue(genericNextConfig);
    instanceRow = {
      ...instanceRow,
      backend: "webui",
      provider: "venice",
      api_key_encrypted: "hven_live_old_managed_proxy_key",
      config: managedConfig,
    };
    instanceUpdateMock.mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({
              data: {
                ...instanceRow,
                backend: "webui",
                provider: "venice",
                config: genericNextConfig,
              },
              error: null,
            }),
          }),
        }),
      }),
    });
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          provider: "venice",
          model: "llama-3.3-70b",
          apiKey: "sk-venice-real",
          apply: true,
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(response.status).toBe(200);
    const updatePayload = instanceUpdateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updatePayload).toEqual(
      expect.objectContaining({
        provider: "venice",
        api_key_encrypted: "sk-venice-real",
      })
    );
    expect(updatePayload.config).toEqual({
      model: "llama-3.3-70b",
      agentSettings: {
        runtimeMode: "managed",
        maxIterations: 60,
      },
    });
    // The live push is retired (box endpoints 404); the BYOK key persists to
    // the DB and reconciles onto the box on redeploy.
    expect(setProviderKey).not.toHaveBeenCalled();
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "stripped managed Venice proxy config after BYOK key save",
      expect.objectContaining({
        source: "instances",
        route: "/api/instances/[id]",
        method: "PATCH",
        instanceId: "inst-123",
        userId: "user_123",
        failureType: "managed_venice_byok_patch_stripped_proxy_config",
      })
    );
  });

  it("does not leak raw Hetzner backup toggle failures", async () => {
    (log.error as jest.Mock).mockClear();
    (enableServerBackup as jest.Mock).mockRejectedValueOnce(new Error("hetzner-backup-secret"));

    const response = await PATCH(
      new NextRequest("http://localhost/api/instances/inst-123", {
        method: "PATCH",
        body: JSON.stringify({
          backupsEnabled: true,
        }),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to toggle backups on Hetzner");
    expect(log.error).toHaveBeenCalledWith(
      "failed to toggle backups on Hetzner",
      expect.anything(),
      expect.objectContaining({
        source: "instances",
        failureType: "backup_toggle_failed",
      })
    );
    const errorContextCalls = (log.error as jest.Mock).mock.calls.map((call) => call[2]);
    expect(JSON.stringify(errorContextCalls)).not.toContain("hetzner-backup-secret");
    expect(apiError).toHaveBeenCalledWith(
      "Failed to toggle backups on Hetzner",
      500,
      expect.objectContaining({
        failureType: "backup_toggle_failed",
      })
    );
    expect(JSON.stringify((apiError as jest.Mock).mock.calls.at(-1)?.[2])).not.toContain("hetzner-backup-secret");
  });
});

describe("GET /api/instances/[id]", () => {
  let instanceRow: Record<string, unknown>;
  const updateEqMock = jest.fn().mockResolvedValue({ error: null });
  const instanceUpdateMock = jest.fn().mockReturnValue({
    eq: updateEqMock,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({
      status: "inconclusive",
    });
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (getServer as jest.Mock).mockResolvedValue({
      server: { id: 42, backup_window: "22-02" },
    });
    (getHetznerInstanceStatus as jest.Mock).mockResolvedValue({
      status: "running",
      ipv4: "203.0.113.10",
    });
    (getPublicInstanceConfig as jest.Mock).mockImplementation((config) => config);
    (fetchFirstReachableGatewayResponse as jest.Mock).mockReset();
    (ensureManagedHostFingerprint as jest.Mock).mockResolvedValue(null);
    updateEqMock.mockClear();
    instanceUpdateMock.mockClear();

    instanceRow = {
      id: "inst-123",
      user_id: "user_123",
      name: "Atlas",
      status: "running",
      provider: "openai",
      host_id: "host-456",
      hetzner_server_id: null,
      gateway_url: "https://atlas.example.com",
      api_key_encrypted: "encrypted",
      api_server_key_encrypted: "gateway-secret",
      api_key_preview: "sk-...1234",
      config: { model: "gpt-test" },
      created_at: "2026-04-18T10:00:00.000Z",
      updated_at: "2026-04-18T10:05:00.000Z",
    };

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: instanceRow,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: instanceUpdateMock,
        };
      }

      if (table === "hermes_subscriptions") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: { plan: "operator" },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  hetzner_server_id: 42,
                  ipv4_address: "203.0.113.10",
                },
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("returns the canonical public IPv4 from the attached host for shared-host instances", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123?no_sync=true"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.public_ipv4).toBe("203.0.113.10");
  });

  it("recovers a stale error status when the live gateway is reachable", async () => {
    instanceRow.status = "error";
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("ok"),
      },
      url: "https://atlas.example.com/v1/models",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("running");
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://atlas.example.com",
        pathname: "/v1/models",
        instanceIpv4: "203.0.113.10",
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-secret",
        }),
      })
    );
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        lifecycle_state: "active",
        last_lifecycle_transition_at: expect.any(String),
      })
    );
  });

  it("redacts managed fingerprint priming failures while still returning the instance", async () => {
    (log.warn as jest.Mock).mockClear();
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = 42;
    instanceRow.ipv4_address = "203.0.113.10";

    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("ok"),
      },
      url: "https://atlas.example.com/v1/models",
    });
    (ensureManagedHostFingerprint as jest.Mock).mockRejectedValue(
      new Error("fingerprint capture failed: client_secret=super-secret")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    const warnContextCalls = (log.warn as jest.Mock).mock.calls.map((call) => call[1]);
    expect(JSON.stringify(warnContextCalls)).not.toContain("super-secret");
    expect(log.warn).toHaveBeenCalledWith(
      "failed to prime managed SSH fingerprint",
      expect.objectContaining({
        source: "instances",
        failureType: "ssh_fingerprint_prime_failed",
        hostIp: "203.0.113.10",
        redactedError: expect.stringContaining("[REDACTED]"),
      }),
      expect.anything(),
    );
  });

  it("keeps provisioning status when Hetzner is running but the gateway is not yet reachable", async () => {
    instanceRow.status = "provisioning";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = 42;
    instanceRow.ipv4_address = "203.0.113.10";
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("gateway still warming")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("provisioning");
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://203-0-113-66.sslip.io",
        pathname: "/v1/models",
        instanceIpv4: "203.0.113.10",
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-secret",
        }),
      })
    );
    expect(
      instanceUpdateMock.mock.calls.some(
        ([payload]) => payload && typeof payload === "object" && (payload as { status?: string }).status === "running"
      )
    ).toBe(false);
  });

  it("probes Proxmox-backed provisioning instances from the detail route without calling Hetzner", async () => {
    const infrastructure = {
      provider: "proxmox" as const,
      node: "fixturenode2",
      vmid: 201,
      privateIpv4: "10.250.21.59",
      gatewayHost: "abc123.203-0-113-10.sslip.io",
    };
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    instanceRow.gateway_url = "https://abc123.203-0-113-10.sslip.io";
    instanceRow.ipv4_address = "10.250.20.51";
    instanceRow.config = {
      model: "gpt-test",
      infrastructure,
    };
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("ok"),
      },
      url: "https://abc123.203-0-113-10.sslip.io/health",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("running");
    expect(getProxmoxInstanceStatus).toHaveBeenCalledWith(infrastructure, {
      hostConfig: { hostId: null, hostSlug: "fixturenode2", envPrefix: null, failClosed: true },
    });
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://abc123.203-0-113-10.sslip.io",
        pathname: "/health",
        instanceIpv4: "10.250.21.59",
        headers: {},
      })
    );
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        lifecycle_state: "active",
      })
    );
  });

  it("promotes gateway-backend Proxmox rows over the bearer-authed chat lane, not /health", async () => {
    // '/health' answers from the official-dashboard shell before the gateway
    // that answers chat is up (canary run fixturecase04: 8s gap; prod fixturecase05:
    // >190s) — promoting on it painted a workspace whose first message died.
    const infrastructure = {
      provider: "proxmox" as const,
      node: "fixturenode2",
      vmid: 201,
      privateIpv4: "10.250.21.59",
      gatewayHost: "abc123.203-0-113-10.sslip.io",
    };
    instanceRow.status = "provisioning";
    instanceRow.backend = "gateway";
    instanceRow.api_server_key_encrypted = "chat-lane-secret";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    instanceRow.gateway_url = "https://abc123.203-0-113-10.sslip.io";
    instanceRow.ipv4_address = "10.250.20.51";
    instanceRow.config = {
      model: "gpt-test",
      infrastructure,
    };
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("[]"),
      },
      url: "https://abc123.203-0-113-10.sslip.io/api/sessions",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.status).toBe("running");
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://abc123.203-0-113-10.sslip.io",
        pathname: "/api/sessions",
        headers: { Authorization: "Bearer chat-lane-secret" },
      })
    );
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        lifecycle_state: "active",
      })
    );
  });

  it("recovers Proxmox VM metadata for rows left stale after a provisioning timeout", async () => {
    const infrastructure = {
      provider: "proxmox" as const,
      node: "fixturenode3",
      vmid: 214,
      privateIpv4: "10.250.20.64",
      gatewayHost: "0d04200498b8983f9310.203-0-113-10.sslip.io",
    };
    instanceRow.id = "00000000-0000-4000-8000-000000001042";
    instanceRow.name = "MY_FIRST_AGENT";
    instanceRow.subdomain = "0d04200498b8983f9310";
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    instanceRow.gateway_url = null;
    instanceRow.ipv4_address = null;
    instanceRow.infrastructure_provider = "proxmox";
    instanceRow.config = {
      model: "deepseek-v4-pro",
    };
    (discoverProxmoxInfrastructureForInstance as jest.Mock).mockResolvedValue(infrastructure);
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("ok"),
      },
      url: "https://0d04200498b8983f9310.203-0-113-10.sslip.io/health",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/00000000-0000-4000-8000-000000001042"),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000001042" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("running");
    expect(json.data.gateway_url).toBe("https://0d04200498b8983f9310.203-0-113-10.sslip.io");
    expect(json.data.public_ipv4).toBe("10.250.20.64");
    expect(discoverProxmoxInfrastructureForInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "00000000-0000-4000-8000-000000001042",
        instanceName: "MY_FIRST_AGENT",
        subdomain: "0d04200498b8983f9310",
      }),
      { hostConfig: null }
    );
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://0d04200498b8983f9310.203-0-113-10.sslip.io",
        pathname: "/health",
        instanceIpv4: "10.250.20.64",
        headers: {},
      })
    );
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway_url: "https://0d04200498b8983f9310.203-0-113-10.sslip.io",
        ipv4_address: "10.250.20.64",
        infrastructure_provider: "proxmox",
        proxmox_node: "fixturenode3",
        proxmox_vmid: 214,
        config: {
          model: "deepseek-v4-pro",
          infrastructure,
        },
      })
    );
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        lifecycle_state: "active",
      })
    );
  });

  it("recovers gateway_url from subdomain + host gateway domain, NEVER the stale bridge-IP gatewayHost (2026-06-30 incident)", async () => {
    // Regression for the 2026-06-30 fixturecase06… incident: a row restored from
    // archive carried a stale config.infrastructure.gatewayHost of the host's
    // NAT bridge IP (10.250.20.1). The recovery sync used to write
    // gateway_url=https://10.250.20.1, the prober then failed 159× against the
    // unreachable bridge IP, and auto-repair paged on a perfectly healthy VM.
    // The fix derives gateway_url from <subdomain>.<PROXMOX_GATEWAY_DOMAIN> and
    // must NEVER persist the bridge IP.
    const PROXMOX_ENV_KEYS = [
      "PROXMOX_FIXTURENODE11_PUBLIC_IP",
      "PROXMOX_FIXTURENODE11_GATEWAY_DOMAIN",
      "PROXMOX_PUBLIC_IP",
      "PROXMOX_GATEWAY_DOMAIN",
      "PROXMOX_NODE",
      "PROXMOX_SSH_HOST",
      "PROXMOX_SSH_KEY_PATH",
      "PROXMOX_SSH_PRIVATE_KEY",
      "PROXMOX_SSH_PRIVATE_KEY_B64",
      "PROXMOX_ALLOW_SSH_AGENT",
      "PROXMOX_API_URL",
      "PROXMOX_API_TOKEN",
      "PROXMOX_API_TOKEN_ID",
      "PROXMOX_API_TOKEN_SECRET",
      "HERMES_PROXMOX_TARGET",
      "HERMES_PROXMOX_TARGETS",
      "HERMES_PROXMOX_TARGET_ENV_RESOLVED",
    ];
    const savedProxmoxEnv: Record<string, string | undefined> = {};
    for (const key of PROXMOX_ENV_KEYS) {
      savedProxmoxEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Only the fixturenodea host identity the row lives on — the helper resolves the
    // per-host gateway domain from these.
    process.env.PROXMOX_FIXTURENODE11_PUBLIC_IP = "203.0.113.10";
    process.env.PROXMOX_FIXTURENODE11_GATEWAY_DOMAIN = "agents.hermesos.cloud";

    try {
      const infrastructure = {
        provider: "proxmox" as const,
        node: "fixturenode11",
        vmid: 731,
        privateIpv4: "10.250.20.64",
        // The corrupt value the restore left behind — must be ignored.
        gatewayHost: "10.250.20.1",
      };
      instanceRow.id = "00000000-0000-4000-8000-000000001043";
      instanceRow.subdomain = "00000000000000000000";
      instanceRow.status = "provisioning";
      instanceRow.backend = "webui";
      instanceRow.host_id = null;
      instanceRow.hetzner_server_id = null;
      instanceRow.gateway_url = null;
      instanceRow.ipv4_address = null;
      instanceRow.infrastructure_provider = "proxmox";
      instanceRow.config = { model: "deepseek-v4-pro", infrastructure };
      (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });
      (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
        response: { ok: true, text: jest.fn().mockResolvedValue("ok") },
        url: "https://00000000000000000000.agents.hermesos.cloud/health",
      });

      const response = await GET(
        new NextRequest("http://localhost/api/instances/00000000-0000-4000-8000-000000001043"),
        { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000001043" }) }
      );
      const json = await response.json();

      expect(response.status).toBe(200);
      // Derived canonically from subdomain + the fixturenodea gateway domain.
      expect(json.data.gateway_url).toBe("https://00000000000000000000.agents.hermesos.cloud");
      // Core incident guard: the bridge IP must never reach gateway_url — this
      // holds even if the derive had returned null (gateway_url would stay null).
      expect(json.data.gateway_url).not.toContain("10.250.20.1");
      const gatewayWrites = instanceUpdateMock.mock.calls
        .map(([payload]) => (payload as { gateway_url?: unknown } | undefined)?.gateway_url)
        .filter((value): value is string => typeof value === "string");
      for (const written of gatewayWrites) {
        expect(written).not.toContain("10.250.20.1");
      }
    } finally {
      for (const key of PROXMOX_ENV_KEYS) {
        if (savedProxmoxEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedProxmoxEnv[key];
        }
      }
    }
  });

  it("flips orphan Proxmox provisioning rows to error after 25 minutes when no infrastructure can be recovered", async () => {
    instanceRow.id = "orphan-123";
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    instanceRow.gateway_url = null;
    instanceRow.ipv4_address = null;
    instanceRow.infrastructure_provider = "proxmox";
    instanceRow.config = { model: "gpt-test" };
    instanceRow.created_at = new Date(Date.now() - 26 * 60 * 1000).toISOString();
    (discoverProxmoxInfrastructureForInstance as jest.Mock).mockResolvedValue(null);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/orphan-123"),
      { params: Promise.resolve({ id: "orphan-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.status).toBe("error");
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        lifecycle_state: "failed",
      })
    );
  });

  it("leaves orphan Proxmox provisioning rows alone before the 25 minute ceiling", async () => {
    instanceRow.id = "fresh-orphan-123";
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    instanceRow.gateway_url = null;
    instanceRow.ipv4_address = null;
    instanceRow.infrastructure_provider = "proxmox";
    instanceRow.config = { model: "gpt-test" };
    instanceRow.created_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    (discoverProxmoxInfrastructureForInstance as jest.Mock).mockResolvedValue(null);

    const response = await GET(
      new NextRequest("http://localhost/api/instances/fresh-orphan-123"),
      { params: Promise.resolve({ id: "fresh-orphan-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.status).toBe("provisioning");
    expect(instanceUpdateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });

  it("marks a WebUI-backed provisioning instance running when its health endpoint is reachable", async () => {
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = 42;
    instanceRow.ipv4_address = "203.0.113.10";
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("ok"),
      },
      url: "https://203-0-113-66.sslip.io/health",
    });
    (sshExec as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("running");
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/health",
        headers: {},
      })
    );
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        lifecycle_state: "active",
        last_lifecycle_transition_at: expect.any(String),
      })
    );
    // The promotion to running must schedule the post-ready SOUL.md seed —
    // the only write guaranteed to land AFTER the agent's factory-default
    // write (the in-band provision seed races it and loses on slow boots).
    expect(mockedScheduleSoulSeed).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst-123",
        trigger: "poll_provision_promote",
      })
    );
  });

  it("marks a Proxmox-backed provisioning instance running when its health endpoint is reachable", async () => {
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    const infrastructure = {
      provider: "proxmox" as const,
      node: "fixturenode2",
      vmid: 201,
      privateIpv4: "10.250.21.59",
      gatewayHost: "abc123.203-0-113-10.sslip.io",
    };
    instanceRow.config = {
      model: "gpt-test",
      infrastructure,
    };
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: {
        ok: true,
        text: jest.fn().mockResolvedValue("ok"),
      },
      url: "https://atlas.example.com/health",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("running");
    expect(getProxmoxInstanceStatus).toHaveBeenCalledWith(infrastructure, {
      hostConfig: { hostId: null, hostSlug: "fixturenode2", envPrefix: null, failClosed: true },
    });
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/health",
        instanceIpv4: "10.250.21.59",
        headers: {},
      })
    );
    expect(ensureManagedHostFingerprint).not.toHaveBeenCalled();
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
      })
    );
    // Hetzner sync must not be attempted for a Proxmox-backed instance.
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
    // The provisioning→running promotion must schedule the post-ready SOUL.md
    // seed (deterministic close of the provision-time seed race).
    expect(mockedScheduleSoulSeed).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst-123",
        trigger: "poll_provision_promote",
      })
    );
  });

  it("preserves the Proxmox handle when a routed-host miss is not conclusive across the fleet", async () => {
    // Fixture Customer A / Fixture Customer B incident regression (2026-05-07): 15 instance rows had
    // proxmox_node="fixturelegacy" but VMIDs in fixturenodea's range, so every dashboard
    // GET probed the wrong host, got vmMissing, and silently auto-deleted
    // the row even though the VM (and the user's data) was alive on fixturenodea.
    // The old behaviour was nextStatus = "deleted" + lifecycle_state =
    // "deleted" — that destroyed the user's view of their agent without
    // any human ever confirming the VM was actually gone.
    //
    // New behaviour: fleet recovery runs before any handle is released. An
    // inconclusive scan surfaces error state but retains the target, preventing
    // DB-only deletion or duplicate reprovisioning of a still-running VM.
    instanceRow.status = "running";
    instanceRow.lifecycle_state = "active";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    instanceRow.proxmox_vmid = 201;
    instanceRow.config = {
      model: "gpt-test",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
    };
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({
      status: "stopped",
      vmMissing: true,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(getProxmoxInstanceStatus).toHaveBeenCalledWith(
      {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
      { hostConfig: null }
    );
    expect(fetchFirstReachableGatewayResponse).not.toHaveBeenCalled();

    const finalPayload = instanceUpdateMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    // Critical: we did NOT mark the row deleted. A vmMissing on the
    // routed host could be a routing-data inconsistency, not a real
    // teardown — let a human confirm before destroying the user's view.
    expect(finalPayload.status).toBe("error");
    expect(finalPayload.lifecycle_state).toBe("failed");
    expect(finalPayload.deleted_at).toBeUndefined();
    expect(finalPayload.status).not.toBe("deleted");
    expect(finalPayload.lifecycle_state).not.toBe("deleted");

    expect(finalPayload.proxmox_vmid).toBeUndefined();
    expect(finalPayload.config).toBeUndefined();
    expect(recoverProxmoxInstanceAcrossFleet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inst-123", proxmox_vmid: 201 }),
    );
  });

  it("keeps a Proxmox-backed instance provisioning when the gateway is not yet reachable", async () => {
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    // 1 minute ago — well within the 15-min stale-sweeper ceiling.
    instanceRow.created_at = new Date(Date.now() - 60 * 1000).toISOString();
    instanceRow.config = {
      model: "gpt-test",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
    };
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("gateway still warming")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("provisioning");
    expect(
      instanceUpdateMock.mock.calls.some(
        ([payload]) => payload && typeof payload === "object" && (payload as { status?: string }).status === "running"
      )
    ).toBe(false);
  });

  it("flips a Proxmox-backed instance to 'error' when it has been provisioning for more than 25 minutes (stale-row sweeper)", async () => {
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    // Created 30 minutes ago — past the 25-min ceiling. Covers the case
    // where Phase 2 silently died (host reboot mid-bootstrap etc.) so the
    // VM is still alive but the agent never came up — without this, the UI
    // would spin on "Provisioning server" forever. Threshold was tuned
    // 15min → 25min on 2026-04-30 after a real 16-min provision (slow apt
    // mirror + cold Docker pull + Caddy ACME) tripped the prior ceiling
    // by ~1min and flashed the user a spurious "Agent Offline" UI.
    instanceRow.created_at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    instanceRow.config = {
      model: "gpt-test",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
    };
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("gateway still warming")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("error");
    expect(instanceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });

  it("does NOT hard-error a long-running Proxmox instance when its readiness probe is UNREACHABLE (grey-cloud / transient — the 2026-06-28 regression)", async () => {
    instanceRow.status = "running";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    // Weeks-old, long-running box whose VM is confirmed running (qm status),
    // but the Vercel-side readiness probe can't REACH it — e.g. a grey-cloud
    // DNS record whose raw host IP Vercel can't connect to. Before the fix this
    // demoted running → provisioning → (25-min stale-sweeper) → "error",
    // flapping a perfectly healthy box "Agent Offline" on every dashboard poll.
    // An unreachable probe must never hard-error a running instance.
    instanceRow.created_at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    instanceRow.config = {
      model: "gpt-test",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
    };
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("connect ETIMEDOUT (unreachable from Vercel)")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.status).toBe("running");
    expect(
      instanceUpdateMock.mock.calls.some(
        ([payload]) =>
          payload &&
          typeof payload === "object" &&
          ["error", "provisioning"].includes((payload as { status?: string }).status as string)
      )
    ).toBe(false);
  });

  it("does NOT demote a long-running Proxmox instance when the readiness probe returns a transient non-OK response", async () => {
    instanceRow.status = "running";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    instanceRow.created_at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    instanceRow.config = {
      model: "gpt-test",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
    };
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });
    // Box answered, but with a transient 502 (e.g. gateway mid-restart). Still a
    // running box — recover-unhealthy-active owns degraded-runtime repair, not a
    // single synchronous GET reconcile that would hard-error it.
    (fetchFirstReachableGatewayResponse as jest.Mock).mockResolvedValue({
      response: { ok: false, status: 502, text: jest.fn().mockResolvedValue("bad gateway") },
      url: "https://abc123.203-0-113-10.sslip.io/health",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.status).toBe("running");
    expect(
      instanceUpdateMock.mock.calls.some(
        ([payload]) =>
          payload &&
          typeof payload === "object" &&
          ["error", "provisioning"].includes((payload as { status?: string }).status as string)
      )
    ).toBe(false);
  });

  it("does NOT flip a 20-minute-old Proxmox-backed instance to error — that's inside the 25-min threshold (slow boot, not stuck)", async () => {
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    // 20 min ago: previously past the 15-min ceiling (would have falsely
    // flipped to error), now comfortably inside the 25-min threshold.
    // Pins the threshold bump so a future "let's tighten this back" PR
    // can't silently re-introduce the spurious-Offline-flash UX.
    instanceRow.created_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    instanceRow.config = {
      model: "gpt-test",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
    };
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("gateway still warming")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.status).toBe("provisioning");
    expect(
      instanceUpdateMock.mock.calls.some(
        ([payload]) => payload && typeof payload === "object" && (payload as { status?: string }).status === "error"
      )
    ).toBe(false);
  });

  it("does NOT flip a fresh Proxmox-backed instance to error while bootstrap is still legitimately in progress", async () => {
    instanceRow.status = "provisioning";
    instanceRow.backend = "webui";
    instanceRow.host_id = null;
    instanceRow.hetzner_server_id = null;
    // Created 2 minutes ago — well within Phase 2's 3-7 min budget.
    instanceRow.created_at = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    instanceRow.config = {
      model: "gpt-test",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
    };
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({ status: "running" });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("gateway still warming")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe("provisioning");
    expect(
      instanceUpdateMock.mock.calls.some(
        ([payload]) => payload && typeof payload === "object" && (payload as { status?: string }).status === "error"
      )
    ).toBe(false);
  });

  it("preserves the public gateway url while returning tailscale metadata", async () => {
    instanceRow.config = {
      model: "gpt-test",
      privateAccess: {
        tailscale: {
          enabled: true,
          hostScoped: true,
          state: "connected",
          machineName: "atlas-agent",
        },
      },
    };

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123?no_sync=true"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.gateway_url).toBe("https://atlas.example.com");
    expect(json.data.config.privateAccess.tailscale).toEqual({
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: "atlas-agent",
    });
  });

  it("reads backups_enabled from the cached column without a blocking Hetzner fetch", async () => {
    // Perf regression guard: the single-instance GET used to make a live
    // Hetzner getServer() call (150-500ms, up to a 15s timeout) on every load
    // purely to re-derive this boolean. It now reads the authoritative
    // `backups_enabled` column (set by the backup-addon endpoint).
    instanceRow.hetzner_server_id = 42;
    instanceRow.backups_enabled = true;

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123?no_sync=true"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.backups_enabled).toBe(true);
    // No live Hetzner round-trip on the GET hot path anymore.
    expect(getServer).not.toHaveBeenCalled();
  });

  it("reports backups_enabled=false when the cached column is unset", async () => {
    instanceRow.hetzner_server_id = 42;
    // backups_enabled intentionally absent on the row.

    const response = await GET(
      new NextRequest("http://localhost/api/instances/inst-123?no_sync=true"),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.backups_enabled).toBe(false);
    expect(getServer).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/instances/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: "host-456",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "hermes_hosts") {
        return {
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });
  });

  function confirmedDeleteRequest(id = "inst-123") {
    return new NextRequest(`http://localhost/api/instances/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: id }),
    });
  }

  it("refuses to mark deleted when Hetzner delete fails (avoid orphan billable VM)", async () => {
    // Regression guard: previously, ANY Hetzner delete failure was
    // logged-and-swallowed, then the DB row was marked deleted and
    // hidden from the user's UI — leaving a billable Hetzner VM running
    // forever with no surface to find it. Now we return a 502 and DO
    // NOT update the DB, so the user can retry.
    (log.error as jest.Mock).mockClear();
    (deleteHetznerServer as jest.Mock).mockRejectedValue(
      new Error("Hetzner API DELETE /servers/42 → 503: server is starting")
    );

    const updateSpy = jest.fn();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: "host-456",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    expect(response.status).toBe(502);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteHetznerServer).toHaveBeenCalledWith(42);
    expect(log.error).toHaveBeenCalledWith(
      "hetzner delete failed; refusing to mark instance deleted (avoid orphan billable VM)",
      expect.any(Error),
      expect.objectContaining({
        failureType: "instance_delete_hetzner_failed",
        failureOwner: "provider",
        failurePhase: "delete",
        recoveryAction: "contact_support",
      })
    );
  });

  it("rejects bare delete requests without typed instance confirmation", async () => {
    const updateSpy = jest.fn();
    (deleteHetznerServer as jest.Mock).mockResolvedValue(undefined);
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      lifecycle_state: "running",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: "host-456",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/instances/inst-123", { method: "DELETE" }),
      {
        params: Promise.resolve({ id: "inst-123" }),
      }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Type the instance id to confirm deletion.");
    expect(deleteHetznerServer).not.toHaveBeenCalled();
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // A self-contained Hetzner happy-path mock (no host_id so the shared-host
  // count branch is skipped) that lets a confirmed delete run all the way to
  // the ops event. Returns the update spy for optional assertions.
  function mockHetznerDeletableInstance(id = "inst-123") {
    (deleteHetznerServer as jest.Mock).mockResolvedValue(undefined);
    const updateSpy = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    });
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id,
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: null,
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });
    return updateSpy;
  }

  it("threads the optional delete reason + free-text note into the ops event metadata", async () => {
    mockHetznerDeletableInstance();

    const request = new NextRequest("http://localhost/api/instances/inst-123", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmation: "inst-123",
        deleteReason: "other",
        deleteReasonNote: "switching to a different stack",
      }),
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ id: "inst-123" }),
    });

    expect(response.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instances.delete",
        metadata: expect.objectContaining({
          delete_reason: "other",
          delete_reason_note: "switching to a different stack",
        }),
      })
    );
  });

  it("records null delete reason when the user skips it (reason never blocks delete)", async () => {
    mockHetznerDeletableInstance();

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });

    expect(response.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instances.delete",
        metadata: expect.objectContaining({
          delete_reason: null,
          delete_reason_note: null,
        }),
      })
    );
  });

  it("ignores an unknown delete reason value without blocking a confirmed delete", async () => {
    mockHetznerDeletableInstance();

    const request = new NextRequest("http://localhost/api/instances/inst-123", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmation: "inst-123",
        deleteReason: "totally_made_up",
      }),
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ id: "inst-123" }),
    });

    // A junk reason is parsed leniently and dropped — it must NEVER turn a
    // valid (confirmed) delete into a 400. The delete proceeds and the reason
    // is recorded as null.
    expect(response.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ delete_reason: null }),
      })
    );
  });

  it("refuses to mark deleted when Proxmox destroy fails", async () => {
    const infrastructure = {
      provider: "proxmox",
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "abc123.203-0-113-10.sslip.io",
    };
    const updateSpy = jest.fn();
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: "qm destroy 201 failed",
    });
    // The post-failure check runs `getProxmoxInstanceStatus` to see if the VM
    // is already gone. Without this mock the route hits TypeError reading
    // .vmMissing on undefined and falls into the outer catch block, which
    // logs a different message than the assertion below expects.
    (getProxmoxInstanceStatus as jest.Mock).mockResolvedValue({
      status: "running",
      vmMissing: false,
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-fixturenode2",
                      config: { infrastructure: { ...infrastructure, hostSlug: "fixturenode2" } },
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe("Proxmox delete failed. Please retry — the instance has not been removed.");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining(infrastructure),
      expect.objectContaining({
        hostConfig: expect.objectContaining({ hostId: "host-fixturenode2", hostSlug: "fixturenode2" }),
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      "proxmox delete failed; refusing to mark instance deleted",
      expect.any(Error),
      expect.objectContaining({
        failureType: "instance_delete_proxmox_failed",
        failureOwner: "hypervisor",
        failurePhase: "delete",
        recoveryAction: "contact_support",
      })
    );
  });

  it("marks deleted only after a routed-host miss is confirmed absent across the fleet", async () => {
    const infrastructure = {
      provider: "proxmox",
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "abc123.203-0-113-10.sslip.io",
    };
    const updateEqSpy = jest.fn().mockResolvedValue({ error: null });
    const updateSpy = jest.fn().mockReturnValue({ eq: updateEqSpy });
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "HERMES_PROXMOX_DELETE_VM_MISSING 201\n",
      stderr: "caddy.service is not active, cannot reload\n",
      error: "Remote bash exited with code 1",
    });
    (recoverProxmoxInstanceAcrossFleet as jest.Mock).mockResolvedValue({ status: "gone" });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-fixturenode2",
                      config: { infrastructure: { ...infrastructure, hostSlug: "fixturenode2" } },
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(deleteProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining(infrastructure),
      expect.objectContaining({
        hostConfig: expect.objectContaining({ hostId: "host-fixturenode2", hostSlug: "fixturenode2" }),
      })
    );
    expect(recoverProxmoxInstanceAcrossFleet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inst-123" }),
    );
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
      })
    );
    // Reclassified warn -> info (canary issue #146): the VM was already gone,
    // so the row is successfully marked deleted — a benign teardown outcome,
    // not a warn-level event. It must log at info and NOT at warn.
    expect(log.info).toHaveBeenCalledWith(
      "proxmox delete reported failure after VM was already gone; marking row deleted",
      expect.objectContaining({
        failureType: "instance_delete_proxmox_vm_missing_after_failure",
        proxmoxVmid: 201,
      })
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      "proxmox delete reported failure after VM was already gone; marking row deleted",
      expect.anything()
    );
  });

  it("preserves the row when Proxmox delete fails due to transient SSH unreachability", async () => {
    const infrastructure = {
      provider: "proxmox",
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "abc123.203-0-113-10.sslip.io",
    };
    const updateEqSpy = jest.fn().mockResolvedValue({ error: null });
    const updateSpy = jest.fn().mockReturnValue({ eq: updateEqSpy });
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "ssh: connect to host 10.250.20.1 port 22: Connection refused\n",
      error: "ssh: connect to host 10.250.20.1 port 22: Connection refused",
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-fixturenode2",
                      config: { infrastructure: { ...infrastructure, hostSlug: "fixturenode2" } },
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.success).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("still requires identity-locked provider teardown when the host row says deleted", async () => {
    const infrastructure = {
      provider: "proxmox",
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "abc123.203-0-113-10.sslip.io",
    };
    const updateEqSpy = jest.fn().mockResolvedValue({ error: null });
    const updateSpy = jest.fn().mockReturnValue({ eq: updateEqSpy });
    (deleteProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "HERMES_PROXMOX_DELETE_VM_DESTROYED 201\n",
      stderr: "",
    });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-fixturenode2",
                      config: { infrastructure: { ...infrastructure, hostSlug: "fixturenode2" } },
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      if (table === "hermes_hosts") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: { status: "deleted" },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(deleteProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining(infrastructure),
      expect.objectContaining({ expectedInstanceId: "inst-123" }),
    );
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
      })
    );
  });

  it("DB-only deletes a Proxmox row only after conclusive fleet-wide absence", async () => {
    // 2026-05-12 follow-up to the kairo/ari + ghost-row guard: after a
    // vmMissing event we now strip config.infrastructure AND record a
    // `config.infrastructureReleased` marker. The user is then expected to
    // be able to remove the resulting error-state row from their dashboard.
    // Without this branch the DELETE handler refused — isProxmoxBackedInstanceRow
    // still returned true (the row's infrastructure_provider column is
    // unchanged), resolveProxmoxLifecycleTarget returned null, and the
    // guard fired a 502 ("no infrastructure handle"). The release marker
    // tells the guard the VM is confirmed gone, so a DB-only delete is
    // correct.
    const updateEqSpy = jest.fn().mockResolvedValue({ error: null });
    const updateSpy = jest.fn().mockReturnValue({ eq: updateEqSpy });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "error",
                      lifecycle_state: "failed",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-fixturenode4",
                      infrastructure_provider: "proxmox",
                      proxmox_node: "fixturenode4",
                      proxmox_vmid: null,
                      config: {
                        infrastructureReleased: {
                          at: "2026-05-12T01:57:00.000Z",
                          reason: "vm_missing_across_fleet",
                        },
                      },
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
    expect(deleteHetznerServer).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deleted",
        lifecycle_state: "deleted",
      })
    );
    // Reclassified warn -> info (canary issue #146): nothing to teardown and
    // the DB-only delete succeeds — benign, not a warn-level event.
    expect(log.info).toHaveBeenCalledWith(
      "proxmox handle previously released; proceeding with DB-only delete (no provider teardown needed)",
      expect.objectContaining({
        releaseReason: "vm_missing_across_fleet",
      })
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      "proxmox handle previously released; proceeding with DB-only delete (no provider teardown needed)",
      expect.anything()
    );
  });

  it("does not let terminal status bypass Proxmox teardown verification", async () => {
    // 2026-05-17 follow-up: 9 production rows ended up with
    // `lifecycle_state='deleted'` AND `deleted_at` set, but `status`
    // remaining at 'error' (i.e. they were soft-deleted by a cleanup
    // pass that didn't sync the status column). Those rows had
    // `infrastructure_provider='proxmox'` from row creation but no
    // proxmox_vmid / host_id / hetzner_server_id — so `isProxmoxBackedInstanceRow`
    // returns true, `resolveProxmoxLifecycleTarget` returns null,
    // `getReleasedProxmoxInfrastructure` returns null, and the legacy
    // guard refused the DELETE. Users couldn't self-clear the ghost.
    // Now: if the row is already terminal AND has no live infra columns
    // (no vmid, no host_id, no hetzner_server_id), the handler treats
    // the DELETE as idempotent — there is no possible VM to zombify, so
    // the "refuse to avoid zombies" guard's premise doesn't apply.
    const updateEqSpy = jest.fn().mockResolvedValue({ error: null });
    const updateSpy = jest.fn().mockReturnValue({ eq: updateEqSpy });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-zombie",
                      user_id: "user_123",
                      status: "error",
                      lifecycle_state: "deleted",
                      deleted_at: "2026-05-10T05:23:51.000Z",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: null,
                      infrastructure_provider: "proxmox",
                      proxmox_node: null,
                      proxmox_vmid: null,
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest("inst-zombie"), {
      params: Promise.resolve({ id: "inst-zombie" }),
    });
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.success).toBe(false);
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
    expect(deleteHetznerServer).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses to delete an active running Proxmox-backed row with no routing handle AND no release marker (legacy guard)", async () => {
    // Without the release marker a running row could be a legacy inconsistency
    // where a real VM is still running on a host we no longer have
    // routing data for. Refusing delete prevents zombie-VM leaks.
    const updateSpy = jest.fn();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      lifecycle_state: "running",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-fixturenode4",
                      infrastructure_provider: "proxmox",
                      proxmox_node: "fixturenode4",
                      proxmox_vmid: 201,
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe(
      "This runtime could not be verified as removed. Its record was preserved while routing recovery runs.",
    );
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteProxmoxInstance).not.toHaveBeenCalled();
  });

  it("refuses DB-only deletion for failed/error rows without teardown evidence", async () => {
    const updateSpy = jest.fn();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "failed",
                      lifecycle_state: "failed",
                      provider: "openai",
                      hetzner_server_id: null,
                      host_id: "host-fixturenode4",
                      infrastructure_provider: "proxmox",
                      proxmox_node: "fixturenode4",
                      proxmox_vmid: null,
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockImplementation((payload) => {
            updateSpy(payload);
            return { eq: jest.fn().mockResolvedValue({ error: null }) };
          }),
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.success).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("does not let a Cloudflare DNS cleanup failure block the instance delete", async () => {
    // Regression: a stale A record pointing at a deleted instance is a
    // cosmetic problem (the next provision adopts or replaces it). A
    // stuck-in-deleting row that the user can't get rid of is much
    // worse — and an outage on Cloudflare's side shouldn't be allowed
    // to wedge the unrelated Hetzner delete path. The helper itself
    // swallows DNS errors (see cloudflare-dns.test.ts); here we just
    // assert the call site reaches it and the destroy path completes.
    (deleteHetznerServer as jest.Mock).mockResolvedValue(undefined);

    const updateSpy = jest
      .fn()
      .mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) });
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: null,
                      subdomain: "abc123",
                      gateway_url: "https://abc123.hermesos.cloud",
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: updateSpy,
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    (deriveDnsDomainFromGatewayUrl as jest.Mock).mockReturnValueOnce(
      "hermesos.cloud",
    );
    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.deleted).toBe(true);
    expect(removeInstanceDnsBestEffort).toHaveBeenCalledWith(
      "abc123",
      expect.objectContaining({
        source: "instances",
        route: "/api/instances/[id]",
        instanceId: "inst-123",
        userId: "user_123",
      }),
      { dnsDomain: "hermesos.cloud" },
    );
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted", lifecycle_state: "deleted" })
    );
  });

  it("treats a Hetzner 404 as 'already gone' and proceeds to mark the row deleted", async () => {
    (deleteHetznerServer as jest.Mock).mockRejectedValue(
      new Error("Hetzner API DELETE /servers/42 → 404: not_found")
    );

    // host_id=null so the secondary host-count query (which uses a
    // different chain shape than the default mock provides) is skipped.
    // The point of THIS test is the 404 → already-gone codepath, not
    // host bookkeeping.
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                neq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: "inst-123",
                      user_id: "user_123",
                      status: "running",
                      provider: "openai",
                      hetzner_server_id: 42,
                      host_id: null,
                      config: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      return {
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      };
    });

    const response = await DELETE(confirmedDeleteRequest(), {
      params: Promise.resolve({ id: "inst-123" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.deleted).toBe(true);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instances.delete",
        severity: "warn",
        title: "User instance delete",
        route: "/api/instances/[id]",
        userId: "user_123",
        instanceId: "inst-123",
        metadata: expect.objectContaining({
          actor_user_id: "user_123",
          previous_status: "running",
          previous_lifecycle_state: null,
          hetzner_server_id: 42,
        }),
      })
    );
    // Reclassified warn -> info (canary issue #146): a 404 means the server was
    // already gone, the delete still succeeds — a benign teardown outcome.
    expect(log.info).toHaveBeenCalledWith(
      "hetzner server already gone (404) — proceeding with DB delete",
      expect.objectContaining({ hetznerServerId: 42 })
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      "hetzner server already gone (404) — proceeding with DB delete",
      expect.anything()
    );
  });
});
