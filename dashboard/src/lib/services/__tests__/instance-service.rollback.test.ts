import { CreateInstanceSchema, InstanceService } from "../instance-service";
import { clerkClient } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { deleteHetznerServer, provisionHetznerInstance } from "@/lib/services/hetzner-instance-service";
import { deleteProxmoxInstance } from "@/lib/services/proxmox-instance-service";
import {
  getProxmoxTemplateAvailability,
  getProxmoxVmidAvailability,
  isProxmoxProvisioningConfigured,
  provisionProxmoxInstance,
  resolveProxmoxHostEnv,
} from "@/lib/services/proxmox-instance-service";
import { resolveNousDeploymentSecret } from "@/lib/nous-oauth";
import { buildInstanceInsertPayload } from "@/lib/instance-record";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { isVeniceBoostEligible } from "@/lib/billing/venice-compute-boost";
import { validateProviderApiKey } from "@/lib/services/provider-validation";
import { guardProxmoxHostPlacementReadiness } from "@/lib/services/proxmox-host-guards";

// The DB CHECK vocabulary for hermes_instances.lifecycle_state, verified against
// prod's catalog (pg_constraint hermes_instances_lifecycle_state_check). Writing
// anything outside this set raises 23514 and — because an UPDATE is atomic —
// silently discards every other column in the same statement.
const LIFECYCLE_CHECK_STATES = [
  "pending", "provisioning", "active", "paused", "suspended", "deleting",
  "deleted", "failed", "archiving", "cold_archived", "restoring", "pending_deletion",
];

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

/**
 * A `proxmox_hosts` registry that reads successfully and holds zero rows — the
 * one state in which the legacy env-order fallback is legitimate.
 *
 * `loadProxmoxHostRegistry` issues exactly ONE read: a whole-table select, no
 * `status` filter and no count probe, partitioned in memory. The resolved value
 * is produced fresh per `select()` call, so a provision that re-selects a target
 * (VMID-exhaustion failover) reads the same registry.
 *
 * These fixtures previously just threw `Unexpected table lookup: proxmox_hosts`
 * and the loader swallowed the throw into a silent env-order fallback. It no
 * longer swallows: an unreadable registry halts provisioning.
 */
function createEmptyProxmoxHostsRegistry(): () => unknown {
  return () => ({
    select: jest.fn().mockResolvedValue({ data: [], error: null }),
  });
}

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(),
    storage: {
      from: jest.fn(),
    },
  },
}));

jest.mock("@/lib/crypto", () => ({
  encryptApiKey: jest.fn((value: string) => `enc:${value}`),
  decryptApiKey: jest.fn(),
}));

jest.mock("@/lib/codex-oauth", () => ({
  CODEX_DEFAULT_MODEL: "gpt-5.4",
  formatStoredProviderSecretPreview: jest.fn(() => "preview"),
  resolveCodexDeploymentSecret: jest.fn((apiKey: string) => ({ apiKey })),
}));

jest.mock("@/lib/nous-oauth", () => ({
  resolveNousDeploymentSecret: jest.fn((apiKey: string) => ({ apiKey })),
}));

jest.mock("@/lib/services/hetzner-instance-service", () => ({
  provisionHetznerInstance: jest.fn(),
  getServerSpecs: jest.fn(() => ({ cpu: 2, ram: 4096 })),
  getHetznerInstanceStatus: jest.fn(),
  deleteHetznerServer: jest.fn().mockResolvedValue(undefined),
}));

// Host readiness behavior has dedicated coverage. Rollback tests need a
// deterministic healthy host so they reach the post-provision failure paths
// they are designed to exercise.
jest.mock("@/lib/services/proxmox-host-guards", () => ({
  guardProxmoxHostPlacementReadiness: jest.fn(async () => ({ skip: false })),
  reportProxmoxVmidRangeUtilization: jest.fn(async () => "ok"),
  reportCorrelatedProxmoxHostFailure: jest.fn(async () => ({ correlated: false, hosts: [] })),
  reportProxmoxHostRegistryUnavailable: jest.fn(async () => undefined),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  DEFAULT_PROXMOX_VM_DISK_GB: 30,
  resolveProxmoxVmDiskGb: jest.fn((env: NodeJS.ProcessEnv = process.env) => {
    const parsed = Number.parseInt(env.PROXMOX_VM_DISK_GB || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }),
  provisionProxmoxInstance: jest.fn(),
  deleteProxmoxInstance: jest.fn().mockResolvedValue({ ok: true, stdout: "", stderr: "" }),
  getProxmoxTemplateAvailability: jest.fn(() => ({
    ok: true,
    targetId: "fixturenode1_node",
    templateId: 9000,
  })),
  getProxmoxVmidAvailability: jest.fn(() => ({
    ok: true,
    targetId: "fixturenode1_node",
    vmidStart: 200,
    vmidEnd: 219,
    occupiedVmids: [],
    freeVmids: [200],
  })),
  isProxmoxProvisioningConfigured: jest.fn(() => true),
  resolveProxmoxHostEnv: jest.fn((hostConfig: { hostId?: string | null; hostSlug?: string | null } | null | undefined, env: NodeJS.ProcessEnv = process.env) => ({
    ...env,
    PROXMOX_NODE: hostConfig?.hostId === "host_fixturenode2" || hostConfig?.hostSlug === "fixturenode2" ? "fixturenode2-node" : "fixturenode1-node",
  })),
  resolveProxmoxTargetConfiguration: jest.fn((env: NodeJS.ProcessEnv = process.env, requestedTargetId?: string | null) => {
    const raw = requestedTargetId || env.HERMES_PROXMOX_TARGET || env.PROXMOX_TARGET || env.PROXMOX_NODE || "";
    const id = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || null;
    return {
      id,
      env: {
        ...env,
        ...(id ? { PROXMOX_NODE: id } : {}),
      },
    };
  }),
  resolveProxmoxTargetCandidateIds: jest.fn((env: NodeJS.ProcessEnv = process.env) => {
    const raw = env.HERMES_PROXMOX_TARGET || env.PROXMOX_TARGET || env.PROXMOX_NODE || "";
    const id = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || null;
    return id ? [id] : [];
  }),
  resolveProxmoxMaxTenantInstances: jest.fn(() => null),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/services/provider-validation", () => ({
  validateProviderApiKey: jest.fn(),
}));

jest.mock("@/lib/instance-record", () => ({
  buildInstanceInsertPayload: jest.fn((payload: Record<string, unknown>) => payload),
}));

jest.mock("@/lib/instance-settings", () => ({
  buildStoredInstanceConfig: jest.fn(() => ({})),
  extractGlobalHermesSettings: jest.fn(() => ({})),
  getAutoUpdateConfig: jest.fn(() => ({ enabled: true, time: "06:00" })),
}));

jest.mock("@/lib/subscription", () => ({
  getPlan: jest.fn(() => ({
    name: "Operator",
    maxCpuPerAgent: 8,
    maxRamPerAgent: 16384,
  })),
}));

// PLANS-free boost primitives instance-service imports. Mocked so the real
// tier-specs (which needs PLANS at module load) is never pulled in.
jest.mock("@/lib/services/tier-boost", () => ({
  isPaidTier: (tier: string) => ["operator", "fleet", "command"].includes(tier),
  VENICE_BOOST_CPU: 1,
  VENICE_BOOST_RAM_MB: 2048,
}));

// Default: nobody is VVV-boost eligible. Individual tests opt in.
jest.mock("@/lib/billing/venice-compute-boost", () => ({
  isVeniceBoostEligible: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/lib/models", () => ({
  normalizeModelValue: jest.fn((model: string) => model),
  // PROVIDERS is consumed lazily by reconcileModelForProvider (the new
  // provider/model compatibility check inside InstanceService.createInstance).
  // Empty array keeps the reconciler permissive for unknown-provider
  // tests so we don't have to thread a real catalog through every
  // rollback scenario.
  PROVIDERS: [],
}));

describe("InstanceService.createInstance rollback handling", () => {
  const originalHetznerToken = process.env.HETZNER_API_TOKEN;
  const originalInstanceBackend = process.env.INSTANCE_BACKEND;
  const originalInfraProvider = process.env.HERMES_INFRA_PROVIDER;
  const originalProxmoxEnabledUserIds = process.env.HERMES_PROXMOX_ENABLED_USER_IDS;
  const originalProxmoxDisabledUserIds = process.env.HERMES_PROXMOX_DISABLED_USER_IDS;
  const originalProxmoxVmCores = process.env.PROXMOX_VM_CORES;
  const originalProxmoxVmMemoryMb = process.env.PROXMOX_VM_MEMORY_MB;
  const hostAwareProxmoxEnvKeys = [
    "PROXMOX_PUBLIC_IP",
    "PROXMOX_SSH_HOST",
    "PROXMOX_SSH_KEY_PATH",
    "PROXMOX_SSH_PRIVATE_KEY",
    "PROXMOX_SSH_PRIVATE_KEY_B64",
    "PROXMOX_ALLOW_SSH_AGENT",
    "PROXMOX_VM_MAX_CORES",
    "PROXMOX_VM_MAX_MEMORY_MB",
    "PROXMOX_HOST_FIXTURENODE2_PUBLIC_IP",
    "PROXMOX_HOST_FIXTURENODE2_SSH_HOST",
    "PROXMOX_HOST_FIXTURENODE2_SSH_PRIVATE_KEY_B64",
    "PROXMOX_HOST_FIXTURENODE2_VM_MAX_CORES",
    "PROXMOX_HOST_FIXTURENODE2_VM_MAX_MEMORY_MB",
    "PROXMOX_HOST_FIXTURENODE2_NODE",
  ] as const;
  const originalHostAwareProxmoxEnv = Object.fromEntries(
    hostAwareProxmoxEnvKeys.map((key) => [key, process.env[key]])
  ) as Record<(typeof hostAwareProxmoxEnvKeys)[number], string | undefined>;

  beforeEach(() => {
    jest.clearAllMocks();
    (guardProxmoxHostPlacementReadiness as jest.Mock).mockResolvedValue({ skip: false });
    // clearAllMocks resets calls but NOT implementations; re-assert the
    // default so a test that opts into the boost doesn't leak into the next.
    (isVeniceBoostEligible as jest.Mock).mockResolvedValue(false);
    for (const key of hostAwareProxmoxEnvKeys) {
      delete process.env[key];
    }
    (isProxmoxProvisioningConfigured as jest.Mock).mockReturnValue(true);
    (getProxmoxTemplateAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode1_node",
      templateId: 9000,
    });
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode1_node",
      vmidStart: 200,
      vmidEnd: 219,
      occupiedVmids: [],
      freeVmids: [200],
    });
    (resolveProxmoxHostEnv as jest.Mock).mockImplementation(
      (
        hostConfig: { hostId?: string | null; hostSlug?: string | null } | null | undefined,
        env: NodeJS.ProcessEnv = process.env
      ) => ({
        ...env,
        PROXMOX_NODE: hostConfig?.hostId === "host_fixturenode2" || hostConfig?.hostSlug === "fixturenode2" ? "fixturenode2-node" : "fixturenode1-node",
      })
    );
    process.env.HETZNER_API_TOKEN = "test-token";
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("agent gateway unavailable in test")
    );
    (validateProviderApiKey as jest.Mock).mockResolvedValue({ valid: true });
    delete process.env.INSTANCE_BACKEND;
    delete process.env.HERMES_INFRA_PROVIDER;
    delete process.env.HERMES_PROXMOX_ENABLED_USER_IDS;
    delete process.env.HERMES_PROXMOX_DISABLED_USER_IDS;
    delete process.env.PROXMOX_VM_CORES;
    delete process.env.PROXMOX_VM_MEMORY_MB;

    (clerkClient as jest.Mock).mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }),
      },
    });
  });

  afterAll(() => {
    process.env.HETZNER_API_TOKEN = originalHetznerToken;
    if (originalInstanceBackend === undefined) {
      delete process.env.INSTANCE_BACKEND;
    } else {
      process.env.INSTANCE_BACKEND = originalInstanceBackend;
    }
    process.env.HERMES_INFRA_PROVIDER = originalInfraProvider;
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = originalProxmoxEnabledUserIds;
    if (originalProxmoxDisabledUserIds === undefined) {
      delete process.env.HERMES_PROXMOX_DISABLED_USER_IDS;
    } else {
      process.env.HERMES_PROXMOX_DISABLED_USER_IDS = originalProxmoxDisabledUserIds;
    }
    process.env.PROXMOX_VM_CORES = originalProxmoxVmCores;
    process.env.PROXMOX_VM_MEMORY_MB = originalProxmoxVmMemoryMb;
    for (const key of hostAwareProxmoxEnvKeys) {
      const originalValue = originalHostAwareProxmoxEnv[key];
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  });

  function installFixtureNode2HostEnvOverlayMock() {
    (resolveProxmoxHostEnv as jest.Mock).mockImplementation(
      (
        hostConfig: { hostId?: string | null; hostSlug?: string | null } | null | undefined,
        env: NodeJS.ProcessEnv = process.env
      ) => {
        const merged: NodeJS.ProcessEnv = { ...env };
        if (hostConfig?.hostId === "host_fixturenode2" || hostConfig?.hostSlug === "fixturenode2") {
          merged.PROXMOX_PUBLIC_IP = env.PROXMOX_HOST_FIXTURENODE2_PUBLIC_IP;
          merged.PROXMOX_SSH_HOST = env.PROXMOX_HOST_FIXTURENODE2_SSH_HOST;
          merged.PROXMOX_SSH_PRIVATE_KEY_B64 = env.PROXMOX_HOST_FIXTURENODE2_SSH_PRIVATE_KEY_B64;
          merged.PROXMOX_VM_MAX_CORES = env.PROXMOX_HOST_FIXTURENODE2_VM_MAX_CORES;
          merged.PROXMOX_VM_MAX_MEMORY_MB = env.PROXMOX_HOST_FIXTURENODE2_VM_MAX_MEMORY_MB;
          merged.PROXMOX_NODE = env.PROXMOX_HOST_FIXTURENODE2_NODE;
        }
        return merged;
      }
    );
  }

  function installRealisticProxmoxConfigGateMock() {
    (isProxmoxProvisioningConfigured as jest.Mock).mockImplementation(
      (env: NodeJS.ProcessEnv = process.env) =>
        Boolean(
          env.PROXMOX_PUBLIC_IP?.trim() &&
            env.PROXMOX_SSH_HOST?.trim() &&
            (env.PROXMOX_SSH_KEY_PATH?.trim() ||
              env.PROXMOX_SSH_PRIVATE_KEY_B64?.trim() ||
              env.PROXMOX_ALLOW_SSH_AGENT === "true")
        )
    );
  }

  it("defaults new instance launches to server admin mode off when the request omits the flag", () => {
    const parsed = CreateInstanceSchema.parse({
      name: "My Agent",
      provider: "openrouter",
      apiKey: "sk-or-test",
    });

    expect(parsed.agentSettings?.enableRootAccess).toBe(false);
  });

  it("rejects invalid Gemini keys before creating a VM", async () => {
    (validateProviderApiKey as jest.Mock).mockResolvedValue({
      valid: false,
      error: "API key not valid. Please pass a valid API key.",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "Gemini Agent",
        provider: "gemini",
        apiKey: "AIzaSyBadSecret",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual({
      success: false,
      status: 400,
      message:
        "Google AI Studio rejected this Gemini API key: API key not valid. Please pass a valid API key. Create a fresh key at aistudio.google.com/app/apikey, make sure the Generative Language API is enabled for that project, then try again.",
      error: {
        code: "provider_api_key_validation_failed",
        provider: "gemini",
      },
    });
    expect(validateProviderApiKey).toHaveBeenCalledWith("gemini", "AIzaSyBadSecret");
    expect(provisionHetznerInstance).not.toHaveBeenCalled();
  });

  it("returns a rollback failure when deployment cleanup cannot delete the instance row", async () => {
    (provisionHetznerInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: "ssh bootstrap failed",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };

    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };

    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_123" },
        error: null,
      }),
    };

    const rollbackDeleteEq = jest.fn().mockResolvedValue({
      error: { message: "db unavailable" },
    });
    const rollbackDeleteQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: rollbackDeleteEq,
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") {
        return subscriptionQuery;
      }

      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return rollbackDeleteQuery;
      }

      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance("user_123", CreateInstanceSchema.parse({
      name: "My Agent",
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: "",
      cpuLimit: 2,
      ramLimit: 4096,
    }));

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 500,
        message: "Deployment failed: ssh bootstrap failed. Rollback failed to delete the instance record.",
        error: { message: "db unavailable" },
      })
    );
    expect(rollbackDeleteEq).toHaveBeenCalledWith("id", "inst_123");
  });

  it("provisions a paid VVV holder's instance born-boosted (+1 vCPU / +2 GB) and excludes the boost from the budget gate", async () => {
    // VVV-eligible + paid → the new VM is created at base + boost. The boost
    // is bonus capacity, so it must NOT be counted against total_cpu_budget.
    (isVeniceBoostEligible as jest.Mock).mockResolvedValue(true);
    // Fail provisioning so we stop right after the insert — the insert payload
    // (captured below) is all we need to assert the born-boosted caps.
    (provisionHetznerInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: "stop after insert",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          // Tight budget: base request is exactly 2 vCPU / 4 GB. If the boost
          // (+1/+2) were counted against this, the provision would be rejected.
          total_cpu_budget: 2,
          total_ram_budget: 4096,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    let capturedInsertPayload: Record<string, unknown> | null = null;
    const insertQuery = {
      insert: jest.fn((payload: Record<string, unknown>) => {
        capturedInsertPayload = payload;
        return {
          select: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: { id: "inst_boost" }, error: null }),
        };
      }),
    };
    const rollbackDeleteQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return rollbackDeleteQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    await InstanceService.createInstance("user_boost", CreateInstanceSchema.parse({
      name: "Boosted Agent",
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: "",
      cpuLimit: 2,
      ramLimit: 4096,
    }));

    // Born boosted: base 2/4096 + boost 1/2048.
    expect(capturedInsertPayload).not.toBeNull();
    expect(capturedInsertPayload!.cpuLimit).toBe(3);
    expect(capturedInsertPayload!.ramLimit).toBe(6144);
  });

  it("treats Hetzner user_data overflow as a deployment configuration error after rollback succeeds", async () => {
    (provisionHetznerInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: "Hetzner user_data length 33457 exceeds 32768 bytes before request",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };

    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };

    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_123" },
        error: null,
      }),
    };

    const rollbackDeleteEq = jest.fn().mockResolvedValue({
      error: null,
    });
    const rollbackDeleteQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: rollbackDeleteEq,
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") {
        return subscriptionQuery;
      }

      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return rollbackDeleteQuery;
      }

      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance("user_123", CreateInstanceSchema.parse({
      name: "My Agent",
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: "",
      cpuLimit: 2,
      ramLimit: 4096,
    }));

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 422,
        message: "Deployment failed: Hetzner user_data length 33457 exceeds 32768 bytes before request",
      })
    );
    expect(rollbackDeleteEq).toHaveBeenCalledWith("id", "inst_123");
  });

  it("passes a stored Nous OAuth bundle through to provisioning without requiring a raw API key", async () => {
    const nousBundle = {
      portalBaseUrl: "https://portal.nousresearch.com",
      inferenceBaseUrl: "https://inference-api.nousresearch.com/v1",
      clientId: "hermes-cli",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      agentKey: "agent-key",
    };

    (resolveNousDeploymentSecret as jest.Mock).mockReturnValue({
      apiKey: "",
      authBundle: nousBundle,
    });
    (provisionHetznerInstance as jest.Mock).mockResolvedValue({
      ok: true,
      serverId: 77,
      ipv4: "203.0.113.10",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://agent.example.com",
      serverType: "cx23",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };

    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };

    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_123",
          name: "My Agent",
          subdomain: "agent-subdomain",
        },
        error: null,
      }),
    };

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: updateEq,
    };

    const hostInsertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "host_123" },
        error: null,
      }),
    };

    const vaultKeyQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "vault-nous",
          encrypted_key: "enc-nous-bundle",
        },
        error: null,
      }),
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") {
        return subscriptionQuery;
      }

      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return updateQuery;
      }

      if (tableName === "user_api_keys") {
        return vaultKeyQuery;
      }

      if (tableName === "hermes_hosts") {
        return hostInsertQuery;
      }

      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const crypto = await import("@/lib/crypto");
    (crypto.decryptApiKey as jest.Mock).mockImplementation((value: string) =>
      value === "enc-nous-bundle" ? "serialized-nous-bundle" : value
    );

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "My Agent",
        provider: "nous",
        apiKey: "",
        vaultKeyId: "vault-nous",
        model: "nousresearch/hermes-4-70b",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
      })
    );
    expect(provisionHetznerInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "nous",
        apiKey: "",
        nousAuthBundle: nousBundle,
        // Default backend is now "gateway" (Phase-2 collapse: gateway ≡ webfree).
        backend: "gateway",
      })
    );
    expect(buildInstanceInsertPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "gateway",
      })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "inst_123");
  });

  it("keeps emergency-disabled accounts on Hetzner even when Proxmox is the default", async () => {
    // Policy as of 2026-04-30: HERMES_INFRA_PROVIDER=proxmox makes
    // Proxmox the default for ALL accounts (self-serve, gated by tier
    // limits at provision time, not by user-id allowlists). The only
    // way back to Hetzner is the emergency opt-out env
    // HERMES_PROXMOX_DISABLED_USER_IDS — this test pins that escape
    // hatch so we can pull a customer back to Hetzner without code
    // changes if Proxmox provisioning breaks for them mid-rollout.
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HETZNER_API_TOKEN = "test-token";
    process.env.HERMES_PROXMOX_DISABLED_USER_IDS = "user_123";
    delete process.env.HERMES_PROXMOX_ENABLED_USER_IDS;

    (provisionHetznerInstance as jest.Mock).mockResolvedValue({
      ok: true,
      serverId: 77,
      ipv4: "203.0.113.10",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://agent.example.com",
      serverType: "cx23",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };

    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };

    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_123",
          name: "My Agent",
          subdomain: "agent-subdomain",
        },
        error: null,
      }),
    };

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: updateEq,
    };

    const hostInsertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "host_123" },
        error: null,
      }),
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") {
        return subscriptionQuery;
      }

      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return updateQuery;
      }

      if (tableName === "hermes_hosts") {
        return hostInsertQuery;
      }

      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "My Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: "anthropic/claude-opus-4.1",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(provisionHetznerInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        instanceId: "inst_123",
      })
    );
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        hetzner_server_id: 77,
        host_id: "host_123",
        gateway_url: "https://agent.example.com",
        ipv4_address: "203.0.113.10",
      })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "inst_123");
  });

  it("provisions Proxmox by default for any user when HERMES_INFRA_PROVIDER=proxmox and no whitelist is set — open self-serve mode", async () => {
    // Pins the 2026-04-30 policy flip: Proxmox becomes the default for
    // ALL accounts the moment the production env is in proxmox mode,
    // without per-user gating. Tier-based caps (plan.maxCpuPerAgent /
    // sub.total_cpu_budget) keep usage bounded; the whitelist env is
    // only consulted when explicitly set, for transitional rollouts.
    // If a future refactor accidentally re-introduces a user-id gate,
    // this test fails first.
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    delete process.env.HERMES_PROXMOX_ENABLED_USER_IDS;
    delete process.env.HERMES_PROXMOX_DISABLED_USER_IDS;
    delete process.env.HETZNER_API_TOKEN;

    const infrastructure = {
      provider: "proxmox" as const,
      vmid: 202,
      vmName: "hermes-inst-default-self-serve",
      privateIp: "10.250.20.51",
      caddySitesDir: "/etc/caddy/hermes.d",
      gatewayHost: "default-self.example.com",
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://default-self.example.com",
      infrastructure,
      sshHostFingerprint: null,
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };

    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };

    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_default", name: "Open Self Serve" },
        error: null,
      }),
    };

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateQuery = { update: jest.fn().mockReturnThis(), eq: updateEq };

    const hostInsertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "host_default" },
        error: null,
      }),
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return updateQuery;
      }
      if (tableName === "hermes_hosts") return hostInsertQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_brand_new_customer",
      CreateInstanceSchema.parse({
        name: "Open Self Serve",
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: "anthropic/claude-opus-4.1",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_brand_new_customer",
        instanceId: "inst_default",
      }),
      expect.objectContaining({ hostConfig: null })
    );
    expect(provisionHetznerInstance).not.toHaveBeenCalled();
  });

  it("uses Proxmox provisioning and stores Proxmox metadata when the account is enabled for Proxmox", async () => {
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_123";
    // Note: PROXMOX_VM_CORES / PROXMOX_VM_MEMORY_MB env vars used to cap
    // Proxmox cpuLimit/ramLimit down to "1"/"2048" regardless of plan
    // — that hardcoded debug cap was removed from instance-service.ts
    // since plan.maxCpuPerAgent already provides the legitimate ceiling.
    // The env vars are now ignored; the user's requested specs flow
    // through (within plan limits).
    delete process.env.HETZNER_API_TOKEN;

    const infrastructure = {
      provider: "proxmox" as const,
      vmid: 201,
      privateIpv4: "10.250.20.51",
      gatewayHost: "abc123.203-0-113-10.sslip.io",
    };
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 201,
      ipv4: "10.250.20.51",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://abc123.203-0-113-10.sslip.io",
      serverType: "proxmox-kvm",
      infrastructure,
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };

    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };

    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_123",
          name: "My Agent",
          subdomain: "agent-subdomain",
        },
        error: null,
      }),
    };

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: updateEq,
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") {
        return subscriptionQuery;
      }

      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return updateQuery;
      }

      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "My Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: "anthropic/claude-opus-4.1",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        instanceId: "inst_123",
        // Plan-based passthrough: input was cpuLimit=2, ramLimit=4096 →
        // operator-tier max is 2/4096 → no cap applies → forwarded as-is.
        // Previously env-var cap forced these to 1/2048; that bug is fixed.
        cpuLimit: 2,
        ramLimit: 4096,
      }),
      expect.objectContaining({ hostConfig: null })
    );
    expect(provisionHetznerInstance).not.toHaveBeenCalled();
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        hetzner_server_id: null,
        gateway_url: "https://abc123.203-0-113-10.sslip.io",
        ipv4_address: "10.250.20.51",
        infrastructure_provider: "proxmox",
        proxmox_vmid: 201,
        config: { infrastructure },
      })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "inst_123");
  });

  it("routes selected Proxmox hosts through prefixed env before rejecting as unconfigured", async () => {
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_123";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    delete process.env.HETZNER_API_TOKEN;
    process.env.PROXMOX_HOST_FIXTURENODE2_PUBLIC_IP = "203.0.113.2";
    process.env.PROXMOX_HOST_FIXTURENODE2_SSH_HOST = "fixturenode2.example.invalid";
    process.env.PROXMOX_HOST_FIXTURENODE2_SSH_PRIVATE_KEY_B64 = "dGVzdC1rZXk=";
    process.env.PROXMOX_HOST_FIXTURENODE2_NODE = "fixturenode2-node";
    installFixtureNode2HostEnvOverlayMock();
    installRealisticProxmoxConfigGateMock();

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 302,
      ipv4: "10.250.30.52",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://fixturenode2-prefixed.example.invalid",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        vmid: 302,
        privateIpv4: "10.250.30.52",
        gatewayHost: "fixturenode2-prefixed.example.invalid",
        hostId: "host_fixturenode2",
        hostSlug: "fixturenode2",
        hostEnvPrefix: "PROXMOX_HOST_FIXTURENODE2_",
      },
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const selectedHostQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "host_fixturenode2",
          user_id: "user_123",
          name: "FixtureNode2 Prefixed",
          total_cpu: 24,
          total_ram: 98304,
          infrastructure_provider: "proxmox",
          proxmox_host_slug: "fixturenode2",
          proxmox_env_prefix: "PROXMOX_HOST_FIXTURENODE2_",
        },
        error: null,
      }),
    };
    const siblingCapacityQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ data: [] }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_fixturenode2_prefixed", name: "FixtureNode2 Prefixed", subdomain: "fixturenode2-prefixed" },
        error: null,
      }),
    };
    const updateQuery = { update: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({ error: null }) };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_hosts") return selectedHostQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return siblingCapacityQuery;
        if (hermesInstancesCall === 3) return resourceUsageQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "FixtureNode2 Prefixed",
        provider: "openrouter",
        apiKey: "sk-or-test",
        hostId: "host_fixturenode2",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(isProxmoxProvisioningConfigured).toHaveBeenCalledWith(
      expect.objectContaining({
        PROXMOX_PUBLIC_IP: "203.0.113.2",
        PROXMOX_SSH_HOST: "fixturenode2.example.invalid",
      })
    );
    expect(result).not.toEqual(expect.objectContaining({ status: 503 }));
    expect(provisionProxmoxInstance).toHaveBeenCalled();
  });

  it("clamps selected Proxmox host requests before selected-host DB capacity validation and provisioning", async () => {
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_123";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    delete process.env.HETZNER_API_TOKEN;
    process.env.PROXMOX_HOST_FIXTURENODE2_VM_MAX_CORES = "2";
    process.env.PROXMOX_HOST_FIXTURENODE2_VM_MAX_MEMORY_MB = "4096";
    process.env.PROXMOX_HOST_FIXTURENODE2_NODE = "fixturenode2-node";
    installFixtureNode2HostEnvOverlayMock();

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 303,
      ipv4: "10.250.30.53",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://fixturenode2-clamped.example.invalid",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        vmid: 303,
        privateIpv4: "10.250.30.53",
        gatewayHost: "fixturenode2-clamped.example.invalid",
        hostId: "host_fixturenode2",
        hostSlug: "fixturenode2",
        hostEnvPrefix: "PROXMOX_HOST_FIXTURENODE2_",
      },
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const selectedHostQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "host_fixturenode2",
          user_id: "user_123",
          name: "FixtureNode2 Capped",
          total_cpu: 2,
          total_ram: 4096,
          infrastructure_provider: "proxmox",
          proxmox_host_slug: "fixturenode2",
          proxmox_env_prefix: "PROXMOX_HOST_FIXTURENODE2_",
        },
        error: null,
      }),
    };
    const siblingCapacityQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ data: [] }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_fixturenode2_clamped", name: "FixtureNode2 Clamped", subdomain: "fixturenode2-clamped" },
        error: null,
      }),
    };
    const updateQuery = { update: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({ error: null }) };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_hosts") return selectedHostQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return siblingCapacityQuery;
        if (hermesInstancesCall === 3) return resourceUsageQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "FixtureNode2 Clamped",
        provider: "openrouter",
        apiKey: "sk-or-test",
        hostId: "host_fixturenode2",
        cpuLimit: 8,
        ramLimit: 16384,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(insertQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({ cpuLimit: 2, ramLimit: 4096 })
    );
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ cpuLimit: 2, ramLimit: 4096 }),
      expect.objectContaining({
        hostConfig: expect.objectContaining({ hostId: "host_fixturenode2", hostSlug: "fixturenode2" }),
      })
    );
  });

  it("routes selected Proxmox host provisioning through the same hostConfig that is persisted", async () => {
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_123";
    delete process.env.HETZNER_API_TOKEN;

    const selectedHostConfig = {
      hostId: "host_fixturenode2",
      hostSlug: "fixturenode2",
      envPrefix: "PROXMOX_HOST_FIXTURENODE2_",
      failClosed: true,
    };
    const infrastructure = {
      provider: "proxmox" as const,
      vmid: 301,
      privateIpv4: "10.250.30.51",
      gatewayHost: "fixturenode2-agent.example.invalid",
      hostId: selectedHostConfig.hostId,
      hostSlug: selectedHostConfig.hostSlug,
      hostEnvPrefix: selectedHostConfig.envPrefix,
    };
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 301,
      ipv4: "10.250.30.51",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://fixturenode2-agent.example.invalid",
      serverType: "proxmox-kvm",
      infrastructure,
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    const selectedHostQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: selectedHostConfig.hostId,
          user_id: "user_123",
          name: "FixtureNode2 Hotbox",
          total_cpu: 24,
          total_ram: 98304,
          infrastructure_provider: "proxmox",
          proxmox_host_slug: selectedHostConfig.hostSlug,
          proxmox_env_prefix: selectedHostConfig.envPrefix,
        },
        error: null,
      }),
    };
    const siblingCapacityQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ data: [] }),
    };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_fixturenode2", name: "FixtureNode2 Agent", subdomain: "fixturenode2-agent" },
        error: null,
      }),
    };
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateQuery = { update: jest.fn().mockReturnThis(), eq: updateEq };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_hosts") return selectedHostQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return siblingCapacityQuery;
        if (hermesInstancesCall === 3) return resourceUsageQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "FixtureNode2 Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: "anthropic/claude-opus-4.1",
        hostId: selectedHostConfig.hostId,
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(resolveProxmoxHostEnv).toHaveBeenCalledWith(
      expect.objectContaining(selectedHostConfig),
      process.env
    );
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "inst_fixturenode2", userId: "user_123" }),
      expect.objectContaining({ hostConfig: expect.objectContaining(selectedHostConfig) })
    );
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: selectedHostConfig.hostId,
        proxmox_node: "fixturenode2-node",
        config: { infrastructure },
      })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "inst_fixturenode2");
  });

  it("returns 500 when the post-provision metadata update silently fails (no more orphan rows masquerading as 200)", async () => {
    // Earlier orphans (fixturecase14, fixturecase15, fixturecase16) all had this signature:
    // POST /api/instances returned 200, but gateway_url / proxmox_vmid /
    // config.infrastructure stayed null with created_at == updated_at.
    // Root cause: the post-provision .update() call wasn't checking the
    // Supabase error response, so a silent constraint/RLS rejection was
    // dropped on the floor. Surface it as 500 instead.
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_123";
    delete process.env.HETZNER_API_TOKEN;

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 201,
      ipv4: "10.250.20.51",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://abc123.203-0-113-10.sslip.io",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc123.203-0-113-10.sslip.io",
      },
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_orphan", name: "My Agent", subdomain: "agent-sub" },
        error: null,
      }),
    };
    // Simulate the Supabase update returning an error (constraint violation,
    // RLS denial, schema mismatch — anything that previously got dropped).
    const updateError = { message: "permission denied for table hermes_instances" };
    const updateEq = jest.fn().mockResolvedValue({ error: updateError });
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: updateEq,
    };
    // After the rollback VM destroy succeeds, the service writes
    // `config.infrastructureReleased = { reason: "post_provision_rollback", at }`
    // and nulls the proxmox_* columns so a future DELETE can proceed via
    // the existing "previously released" branch in /api/instances/[id].
    // Capture the payload so we can assert on the marker shape.
    const markerUpdateMock = jest.fn().mockReturnThis();
    const markerEqMock = jest.fn().mockResolvedValue({ error: null });
    const markerWriteQuery = { update: markerUpdateMock, eq: markerEqMock };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return updateQuery;
        if (hermesInstancesCall === 5) return markerWriteQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "My Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 500,
        error: updateError,
      })
    );
    // Generic public message — the raw Supabase error is intentionally
    // NOT echoed (would leak schema/constraint hints to clients). The
    // structured log line below carries the failure detail server-side.
    expect((result as { message: string }).message).toContain("could not record metadata");
    expect((result as { message: string }).message).not.toContain(updateError.message);
    // Proxmox now rolls back via deleteProxmoxInstance when the
    // post-provision metadata update fails, so the message becomes the
    // "rolled back" variant instead of "may still be running".
    expect((result as { message: string }).message).toContain("was rolled back");
    // hostConfig may be null in this test scenario (no HERMES_PROXMOX_TARGET
    // set), which deleteProxmoxInstance handles by falling back to
    // resolveProxmoxOperationEnv. The important bits are the right infra
    // identifies the VMID + node so the destroy script targets the
    // freshly-cloned VM, not some other tenant's.
    expect(deleteProxmoxInstance).toHaveBeenCalledTimes(1);
    expect((deleteProxmoxInstance as jest.Mock).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        provider: "proxmox",
        vmid: 201,
        privateIpv4: "10.250.20.51",
      }),
    );
    expect((deleteProxmoxInstance as jest.Mock).mock.calls[0][1]).toHaveProperty(
      "hostConfig"
    );

    // Verify the release marker write: the row gets `config.infrastructureReleased`
    // stamped so subsequent DELETE attempts proceed via the released-branch
    // instead of the "no infrastructure handle" refusal. Pre-2026-05-17,
    // 9 production rows hit this exact stuck shape.
    expect(markerUpdateMock).toHaveBeenCalledTimes(1);
    const markerPayload = markerUpdateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(markerPayload.proxmox_vmid).toBeNull();
    expect(markerPayload.proxmox_node).toBeNull();
    expect(markerPayload.gateway_url).toBeNull();
    expect(markerPayload.ipv4_address).toBeNull();
    const markerConfig = markerPayload.config as Record<string, unknown>;
    expect(markerConfig).toHaveProperty("infrastructureReleased");
    const releaseMarker = markerConfig.infrastructureReleased as { reason: string };
    expect(releaseMarker.reason).toBe("post_provision_rollback");
    expect(markerEqMock).toHaveBeenCalledWith("id", "inst_orphan");

    const consoleOutput = consoleErrorSpy.mock.calls
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(consoleOutput).toContain("failed to persist post-provision metadata");
    expect(consoleOutput).toContain("inst_orphan");
    expect(consoleOutput).toContain("proxmox");

    consoleErrorSpy.mockRestore();
  });

  it("logs a post_provision_rollback_failed event and stays with 'may still be running' message when the Proxmox rollback itself errors", async () => {
    // Regression guard for the new Proxmox rollback path: when the
    // freshly-cloned VM can't be destroyed (SSH down, host gone),
    // the orphan stays. We surface the failure clearly via ops log so
    // the operator can hand-clean instead of silently leaking VMIDs.
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_123";
    delete process.env.HETZNER_API_TOKEN;

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 555,
      ipv4: "10.250.20.52",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://orphan.example/",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox",
        vmid: 555,
        privateIpv4: "10.250.20.52",
        gatewayHost: "orphan.example",
      },
    });
    (deleteProxmoxInstance as jest.Mock).mockRejectedValueOnce(
      new Error("ssh: connect to host port 22: Connection timed out"),
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { plan: "operator", status: "active", instance_limit: 5, total_cpu_budget: 16, total_ram_budget: 32768 },
      }),
    };
    const agentCountQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }) };
    const resourceUsageQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }) };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { id: "inst_orphan_2", name: "My Agent", subdomain: "agent-sub" }, error: null }),
    };
    const updateEq = jest.fn().mockResolvedValue({ error: { message: "permission denied for table hermes_instances" } });
    const updateQuery = { update: jest.fn().mockReturnThis(), eq: updateEq };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return updateQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({ name: "My Agent", provider: "openrouter", apiKey: "sk-or-test", cpuLimit: 2, ramLimit: 4096 }),
    );

    expect((result as { success: boolean; message: string }).success).toBe(false);
    // Rollback failed → keep the "may still be running" caveat so the
    // operator knows manual cleanup might be needed.
    expect((result as { message: string }).message).toContain("may still be running");
    expect((result as { message: string }).message).not.toContain("was rolled back");

    const consoleOutput = consoleErrorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(consoleOutput).toContain("post_provision_rollback_failed");
    expect(consoleOutput).toContain("555");

    consoleErrorSpy.mockRestore();
  });

  it("clears stale failed Proxmox metadata and retries the current post-provision update", async () => {
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_123";
    delete process.env.HETZNER_API_TOKEN;

    const infrastructure = {
      provider: "proxmox" as const,
      node: "fixturenode3",
      vmid: 332,
      privateIpv4: "10.250.20.112",
      gatewayHost: "fresh.example.invalid",
      templateVmid: 9004,
    };
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 332,
      ipv4: "10.250.20.112",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://fresh.example.invalid",
      serverType: "proxmox-kvm",
      infrastructure,
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_fresh", name: "Fresh Agent", subdomain: "fresh-agent" },
        error: null,
      }),
    };

    const duplicateError = {
      code: "23505",
      message:
        "duplicate key value violates unique constraint hermes_instances_proxmox_node_vmid_key",
    };
    const firstUpdateEq = jest.fn().mockResolvedValue({ error: duplicateError });
    const firstUpdateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: firstUpdateEq,
    };
    const conflictLookupQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          {
            id: "inst_old_failed",
            status: "error",
            lifecycle_state: null,
            proxmox_node: "fixturenode3",
            proxmox_vmid: 332,
            config: {
              infrastructure: {
                provider: "proxmox",
                node: "fixturenode3",
                vmid: 332,
                privateIpv4: "10.250.20.112",
                gatewayHost: "old.example.invalid",
              },
              retainedSetting: true,
            },
          },
        ],
        error: null,
      }),
    };
    const clearStaleQuery: {
      update: jest.Mock;
      eq: jest.Mock;
    } = {
      update: jest.fn(),
      eq: jest.fn(),
    };
    clearStaleQuery.update.mockReturnValue(clearStaleQuery);
    clearStaleQuery.eq
      .mockReturnValueOnce(clearStaleQuery)
      .mockReturnValueOnce(clearStaleQuery)
      .mockResolvedValueOnce({ error: null });

    const retryUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const retryUpdateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: retryUpdateEq,
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return firstUpdateQuery;
        if (hermesInstancesCall === 5) return conflictLookupQuery;
        if (hermesInstancesCall === 6) return clearStaleQuery;
        if (hermesInstancesCall === 7) return retryUpdateQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "Fresh Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(conflictLookupQuery.eq).toHaveBeenCalledWith("proxmox_node", "fixturenode3");
    expect(conflictLookupQuery.eq).toHaveBeenCalledWith("proxmox_vmid", 332);
    expect(conflictLookupQuery.neq).toHaveBeenCalledWith("id", "inst_fresh");
    expect(clearStaleQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway_url: null,
        ipv4_address: null,
        proxmox_node: null,
        proxmox_vmid: null,
        proxmox_template_vmid: null,
        // The strip stamps `config.infrastructureReleased` so the DELETE
        // guard knows this row's Proxmox handle was deliberately cleared
        // (vmid was reclaimed by `inst_fresh`) — without it the stale row
        // would become undeletable for the user.
        config: expect.objectContaining({
          retainedSetting: true,
          infrastructureReleased: expect.objectContaining({
            reason: "post_provision_stale_conflict",
            at: expect.any(String),
          }),
        }),
      })
    );
    expect(clearStaleQuery.eq).toHaveBeenCalledWith("id", "inst_old_failed");
    expect(clearStaleQuery.eq).toHaveBeenCalledWith("proxmox_node", "fixturenode3");
    expect(clearStaleQuery.eq).toHaveBeenCalledWith("proxmox_vmid", 332);
    expect(retryUpdateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway_url: "https://fresh.example.invalid",
        ipv4_address: "10.250.20.112",
        proxmox_node: "fixturenode3",
        proxmox_vmid: 332,
        proxmox_template_vmid: 9004,
        config: { infrastructure },
      })
    );
    expect(retryUpdateEq).toHaveBeenCalledWith("id", "inst_fresh");
    expect(consoleWarnSpy.mock.calls.flat().join(" ")).toContain(
      "cleared stale Proxmox metadata conflict"
    );

    consoleWarnSpy.mockRestore();
  });

  // Regression test for 2026-05-12 incident: user Bijan deleted his agent
  // (VM destroyed on Proxmox), but the row stayed in DB with status='stopped'
  // and lifecycle_state='paused'. When user Ash's fresh provision allocated
  // the same VMID, the post-provision UPDATE hit the unique-key conflict and
  // the recovery path REFUSED to clear Bijan's row because the predicate only
  // matched 'error'/'failed'/'deleted'. Ash saw "Provisioning succeeded but
  // the dashboard could not record metadata". Widening the predicate to
  // "anything not actively in-flight" covers paused/stopped too.
  it("clears a stale paused/stopped Proxmox row whose VMID got re-allocated", async () => {
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_123";
    delete process.env.HETZNER_API_TOKEN;

    const infrastructure = {
      provider: "proxmox" as const,
      node: "fixturenode4",
      vmid: 425,
      privateIpv4: "10.250.20.75",
      gatewayHost: "fresh.example.invalid",
      templateVmid: 9005,
    };
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 425,
      ipv4: "10.250.20.75",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://fresh.example.invalid",
      serverType: "proxmox-kvm",
      infrastructure,
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_ash_fresh", name: "Fresh Agent", subdomain: "fresh-agent" },
        error: null,
      }),
    };

    const duplicateError = {
      code: "23505",
      message:
        "duplicate key value violates unique constraint hermes_instances_active_proxmox_node_vmid_idx",
    };
    const firstUpdateEq = jest.fn().mockResolvedValue({ error: duplicateError });
    const firstUpdateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: firstUpdateEq,
    };
    // The conflicting row is the orphan stopped/paused entry. Predicate
    // must accept this row as clearable (the actual Proxmox VM at vmid 425
    // is now Ash's, so the prior owner's claim is stale by construction).
    const conflictLookupQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          {
            id: "inst_bijan_stopped",
            status: "stopped",
            lifecycle_state: "paused",
            proxmox_node: "fixturenode4",
            proxmox_vmid: 425,
            config: { infrastructure: { provider: "proxmox", node: "fixturenode4", vmid: 425 } },
          },
        ],
        error: null,
      }),
    };
    const clearStaleQuery: { update: jest.Mock; eq: jest.Mock } = {
      update: jest.fn(),
      eq: jest.fn(),
    };
    clearStaleQuery.update.mockReturnValue(clearStaleQuery);
    clearStaleQuery.eq
      .mockReturnValueOnce(clearStaleQuery)
      .mockReturnValueOnce(clearStaleQuery)
      .mockResolvedValueOnce({ error: null });

    const retryUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const retryUpdateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: retryUpdateEq,
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return firstUpdateQuery;
        if (hermesInstancesCall === 5) return conflictLookupQuery;
        if (hermesInstancesCall === 6) return clearStaleQuery;
        if (hermesInstancesCall === 7) return retryUpdateQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "Fresh Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(clearStaleQuery.eq).toHaveBeenCalledWith("id", "inst_bijan_stopped");
    expect(retryUpdateEq).toHaveBeenCalledWith("id", "inst_ash_fresh");
    expect(consoleWarnSpy.mock.calls.flat().join(" ")).toContain(
      "cleared stale Proxmox metadata conflict"
    );

    consoleWarnSpy.mockRestore();
  });

  it("rolls back the freshly-created Hetzner server when the post-provision update fails", async () => {
    // Hetzner provision returns OK with a fresh serverId. The DB update
    // that follows fails. Without rollback the server keeps running and
    // billing forever — we delete it via deleteHetznerServer.
    (provisionHetznerInstance as jest.Mock).mockResolvedValue({
      ok: true,
      serverId: 314159,
      ipv4: "203.0.113.42",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://agent.example.com",
      serverType: "cx23",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_orphan_hz", name: "My Agent", subdomain: "agent-sub" },
        error: null,
      }),
    };
    const hostInsertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "host_h1" },
        error: null,
      }),
    };
    const updateError = { message: "RLS denial: hermes_instances" };
    const updateEq = jest.fn().mockResolvedValue({ error: updateError });
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: updateEq,
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_hosts") return hostInsertQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return updateQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (deleteHetznerServer as jest.Mock).mockClear();

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "My Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    // Server got rolled back — passes the freshly-created serverId, not 0.
    expect(deleteHetznerServer).toHaveBeenCalledWith(314159);
    expect(deleteHetznerServer).toHaveBeenCalledTimes(1);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 500,
        error: updateError,
      })
    );
    // Public message confirms rollback ran.
    expect((result as { message: string }).message).toContain("rolled back");

    consoleErrorSpy.mockRestore();
  });

  it("marks the row terminal with the orphan server id when the Hetzner rollback also fails", async () => {
    // Double-failure: post-provision UPDATE fails AND deleteHetznerServer
    // throws. Without a marker the row stays 'provisioning' with an orphan
    // billable server and no DB pointer. Best-effort: record the server id +
    // flip to a terminal error state so it's recoverable.
    (provisionHetznerInstance as jest.Mock).mockResolvedValue({
      ok: true,
      serverId: 271828,
      ipv4: "203.0.113.99",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://agent2.example.com",
      serverType: "cx23",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 5,
          total_cpu_budget: 16,
          total_ram_budget: 32768,
        },
      }),
    };
    const agentCountQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
    };
    const resourceUsageQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
    };
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_dblfail", name: "My Agent", subdomain: "agent-sub2" },
        error: null,
      }),
    };
    const hostInsertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { id: "host_h2" }, error: null }),
    };
    const updateError = { message: "RLS denial: hermes_instances" };
    const updateEq = jest.fn().mockResolvedValue({ error: updateError });
    const updateQuery = { update: jest.fn().mockReturnThis(), eq: updateEq };

    // 5th hermes_instances call = the terminal-error marker write.
    const markerUpdate = jest.fn().mockReturnThis();
    const markerEq = jest.fn().mockResolvedValue({ error: null });
    const markerQuery = { update: markerUpdate, eq: markerEq };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_hosts") return hostInsertQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return updateQuery;
        if (hermesInstancesCall === 5) return markerQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (deleteHetznerServer as jest.Mock).mockClear();
    (deleteHetznerServer as jest.Mock).mockRejectedValueOnce(new Error("hetzner 500"));

    const result = await InstanceService.createInstance(
      "user_123",
      CreateInstanceSchema.parse({
        name: "My Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(deleteHetznerServer).toHaveBeenCalledWith(271828);
    // The terminal-error marker recorded the orphan server id so it can be reaped.
    expect(markerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        hetzner_server_id: 271828,
        infrastructure_provider: "hetzner",
        status: "error",
        // 'failed', not 'error'. This assertion previously pinned 'error', which
        // the lifecycle_state CHECK rejects — so the write 23514'd every time and
        // the orphan server id was never recorded. The mocked Supabase chain does
        // not enforce the constraint, which is exactly how a write that ALWAYS
        // fails kept a green test. Hence the vocabulary guard below.
        lifecycle_state: "failed",
      })
    );
    // Guard the whole class, not just this line: whatever lifecycle_state this
    // marker writes must be a value the DB will actually accept. `status` words
    // ('error', 'running', 'stopped') are the trap — they read naturally and the
    // mock swallows them.
    const markerPayload = markerUpdate.mock.calls[0][0] as { lifecycle_state?: string };
    expect(LIFECYCLE_CHECK_STATES).toContain(markerPayload.lifecycle_state);
    expect(markerEq).toHaveBeenCalledWith("id", "inst_dblfail");
    expect(result).toEqual(expect.objectContaining({ success: false, status: 500 }));
    // Rollback failed → message warns the VM may still be running.
    expect((result as { message: string }).message).toContain("may still be running");

    consoleErrorSpy.mockRestore();
  });

});
