import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync as readFixtureFile, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { NextRequest } from "next/server";

import { GET, POST } from "../route";
import { providerVmTarget } from "@/lib/infrastructure/__tests__/provider-vm-target.fixtures";
import { ProviderAgentLaunchError } from "@/lib/hivra/provider-agent-launch";
import { BoxTunnelProvisionError } from "@/lib/services/cloudflare-tunnel";
import { LaunchModelRequestError } from "@/lib/hivra/launch-model-store";
import { ModelKeyStoreError } from "@/lib/hivra/model-key-store";
import { HivraLaunchOperationRequestError } from "@/lib/hivra/launch-operation-store";
import {
  PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  provisionerSupportsActivityTelemetry,
} from "@/lib/infrastructure/portable-provisioner-contract";
import { verifyActivityCollectorToken } from "@/lib/activity-observability/auth";
import { ACTIVITY_COLLECTOR_TTL_SECONDS } from "@/lib/activity-observability/collectors";

const mockAuth = jest.fn();
let mockLocalAuthMode = false;
jest.mock("@/lib/self-host/config", () => ({
  ...jest.requireActual("@/lib/self-host/config"),
  isLocalAuthMode: () => mockLocalAuthMode,
}));
const mockGetInfrastructureTarget = jest.fn();
const mockLaunchProviderAgent = jest.fn();
const mockLaunchGvisorComputer = jest.fn();
const mockLaunchRateLimit = jest.fn();
const mockLaunchExisting = jest.fn(), mockLaunchByRequest = jest.fn(), mockLaunchReserve = jest.fn(), mockLaunchAgent = jest.fn();
const mockOperationLookup = jest.fn(), mockOperationPrepare = jest.fn(), mockOperationReserve = jest.fn();
const mockOperationBindAgent = jest.fn(), mockOperationAccept = jest.fn(), mockOperationMarkReconciling = jest.fn(), mockOperationFail = jest.fn();
const LAUNCH_REQUEST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MODEL_SELECTION = { provider: "venice", mode: "byok", apiKey: "synthetic-launch-key", model: "test-model" };
jest.mock("@/lib/hivra/launch-model-admission", () => ({
  createLaunchModelAdmissionService: () => jest.requireActual("@/lib/hivra/launch-model-admission").createLaunchModelAdmissionService({
    store: { existing: mockLaunchExisting, byRequest: mockLaunchByRequest, reserve: mockLaunchReserve }, agent: mockLaunchAgent,
    fingerprints: () => [{ version: 1, keyTag: "a".repeat(64), digest: "b".repeat(64) }],
  }),
}));
jest.mock("@/lib/hivra/launch-operation-store", () => ({
  ...jest.requireActual("@/lib/hivra/launch-operation-store"),
  createHivraLaunchOperationService: () => ({
    lookup: (...args: unknown[]) => mockOperationLookup(...args),
    prepare: (...args: unknown[]) => mockOperationPrepare(...args),
    reserve: (...args: unknown[]) => mockOperationReserve(...args),
    bindAgent: (...args: unknown[]) => mockOperationBindAgent(...args),
    accept: (...args: unknown[]) => mockOperationAccept(...args),
    markReconciling: (...args: unknown[]) => mockOperationMarkReconciling(...args),
    fail: (...args: unknown[]) => mockOperationFail(...args),
  }),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  ...jest.requireActual("@/lib/authenticated-rate-limit"),
  enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockLaunchRateLimit(...args),
}));
jest.mock("@/lib/infrastructure/connection-store", () => ({
  ...jest.requireActual("@/lib/infrastructure/connection-store"),
  getInfrastructureDeploymentTarget: (...args: unknown[]) => mockGetInfrastructureTarget(...args),
}));
jest.mock("@/lib/hivra/provider-agent-launch", () => ({
  ...jest.requireActual("@/lib/hivra/provider-agent-launch"),
  launchProviderAgent: (...args: unknown[]) => mockLaunchProviderAgent(...args),
}));
jest.mock("@/lib/hivra/gvisor-computer-service", () => ({
  ...jest.requireActual("@/lib/hivra/gvisor-computer-service"),
  launchGvisorComputer: (...args: unknown[]) => mockLaunchGvisorComputer(...args),
}));
const mockSupabaseFrom = jest.fn();
const mockPosthogCapture = jest.fn();
const mockPosthogFlush = jest.fn(async () => undefined);

jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: (...args: unknown[]) => mockPosthogCapture(...args),
    flush: () => mockPosthogFlush(),
  },
}));
const mockRunProxmoxHostScript = jest.fn();
const mockResolveProxmoxTargetConfiguration = jest.fn();
const mockSelectAvailableProxmoxProvisionTarget = jest.fn();
const mockGetReservedProxmoxVmidsForNode = jest.fn();
const mockAgentInsert = jest.fn();
const mockCreateManagedVeniceProxyKey = jest.fn();
const mockRevokeManagedVeniceProxyKey = jest.fn();
const mockGetOrCreatePoolId = jest.fn(async () => "pool-free");
const mockResolveSelfManagedProxmoxExecutionContext = jest.fn();
const mockCheckpointHivraAgentOperation = jest.fn();
const mockPersistHivraAgentProvisionIdentity = jest.fn();
const mockCompleteHivraAgentDelete = jest.fn();
const mockBeginHivraAgentVmAllocation = jest.fn();
const mockFailHivraAgentBeforeAllocation = jest.fn();
const mockReleaseHivraAgentOperation = jest.fn();
const mockRecordHivraAgentOperationFailure = jest.fn();
let mockAgentInsertError: unknown;
let mockAgentInsertThrows: unknown;
const mockHivraAgentEqCalls: Array<[string, unknown]> = [];
const mockAgentUpdates: Array<Record<string, unknown>> = [];
let mockSubscriptionRow: Record<string, unknown> | null;
let mockExistingAgents: Array<Record<string, unknown>>;
let mockVmIdentityUpdateError: unknown;
let mockInsertedAgentId = "agent-1";
const mockCollectorUpsert = jest.fn();

function selfManagedExecutionContext(overrides: {
  totalCores?: number | null;
  availableMemoryBytes?: number | null;
  availableStorageBytes?: number | null;
  supportedCatalogRuntimeIds?: Array<"claude-code" | "codex" | "aeon" | "openclaw" | "agent-zero" | "deepseek-harness" | "linux-desktop">;
  omitRuntimeCompatibility?: boolean;
  provisionerVersion?: string;
} = {}) {
  const provisionerVersion = overrides.provisionerVersion
    ?? PORTABLE_HIVRA_PROVISIONER_VERSION;
  const runtimeCompatibility = overrides.omitRuntimeCompatibility
    ? {}
    : {
        runtimeCompatibility: {
          contractVersion: 1,
          provisionerVersion,
          supportedCatalogRuntimeIds: overrides.supportedCatalogRuntimeIds ?? [
            "claude-code",
            "codex",
            "aeon",
            "openclaw",
            "agent-zero",
            "deepseek-harness",
            "linux-desktop",
          ],
        },
      };
  return {
    kind: "self-managed" as const,
    connectionId: "11111111-1111-4111-8111-111111111111",
    targetId: "22222222-2222-4222-8222-222222222222",
    connectionRevision: 3,
    target: {
      capabilities: {
        provisioner: {
          configured: true,
          ready: true,
          version: provisionerVersion,
        },
        ...runtimeCompatibility,
      },
      capacity: {
        cpu: { totalCores: overrides.totalCores ?? 8, utilizationRatio: 0.1 },
        memoryBytes: {
          total: 16 * 1024 ** 3,
          available: overrides.availableMemoryBytes ?? 12 * 1024 ** 3,
        },
        storageBytes: {
          total: 200 * 1024 ** 3,
          available: overrides.availableStorageBytes ?? 160 * 1024 ** 3,
        },
      },
    },
    env: {
      PROXMOX_NODE: "pve-personal",
      PROXMOX_VMID_START: "200",
      PROXMOX_VMID_END: "399",
      PROXMOX_IP_LAST_OCTET_START: "50",
      PROXMOX_PRIVATE_SUBNET_PREFIX: "10.251.20",
      PROXMOX_PRIVATE_GATEWAY: "10.251.20.1",
    },
    runtime: {
      node: "pve-personal",
      bridge: "hivra0",
      storage: "local-lvm",
      vmidStart: 200,
      vmidEnd: 399,
      ipLastOctetStart: 50,
      subnetPrefix: "10.251.20",
      gateway: "10.251.20.1",
      provisionerDirectory: "/opt/hivra/provisioner",
      provisionerVersion,
      ubuntuImage: "/var/lib/vz/template/iso/hivra-ubuntu-jammy.img",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      logDirectory: "/var/log/hivra",
    },
  };
}

jest.mock("@clerk/nextjs/server", () => ({
  auth: () => mockAuth(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/lib/hivra/hivra-flag", () => ({
  isHivraApiAllowed: () => true,
}));

jest.mock("@/lib/hivra/agent-operation-store", () => ({
  beginHivraAgentVmAllocation: (...args: unknown[]) => mockBeginHivraAgentVmAllocation(...args),
  failHivraAgentBeforeAllocation: (...args: unknown[]) => mockFailHivraAgentBeforeAllocation(...args),
  checkpointHivraAgentOperation: (...args: unknown[]) => mockCheckpointHivraAgentOperation(...args),
  completeHivraAgentDelete: (...args: unknown[]) => mockCompleteHivraAgentDelete(...args),
  isHivraAgentAuthorityConflict: (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error && ["23514", "55000", "55006"].includes(String((error as { code?: unknown }).code))),
  persistHivraAgentProvisionIdentity: (...args: unknown[]) => mockPersistHivraAgentProvisionIdentity(...args),
  recordHivraAgentOperationFailure: (...args: unknown[]) => mockRecordHivraAgentOperationFailure(...args),
  releaseHivraAgentOperation: (...args: unknown[]) => mockReleaseHivraAgentOperation(...args),
}));

jest.mock("@/lib/pools/pool-service", () => ({
  getOrCreatePoolId: () => mockGetOrCreatePoolId(),
}));

jest.mock("@/lib/infrastructure/proxmox-execution-context", () => {
  class MockProxmoxExecutionContextError extends Error {
    constructor(public readonly code: string) {
      super(`Portable Proxmox execution context unavailable: ${code}`);
    }
  }
  return {
    ProxmoxExecutionContextError: MockProxmoxExecutionContextError,
    resolveSelfManagedProxmoxExecutionContext: (...args: unknown[]) =>
      mockResolveSelfManagedProxmoxExecutionContext(...args),
  };
});

const mockCreateBoxTunnel = jest.fn();
const mockDeleteBoxTunnel = jest.fn();
let mockTunnelConfigured = false;

jest.mock("@/lib/services/cloudflare-tunnel", () => ({
  BoxTunnelProvisionError: jest.requireActual("@/lib/services/cloudflare-tunnel").BoxTunnelProvisionError,
  createBoxTunnel: (...args: unknown[]) => mockCreateBoxTunnel(...args),
  deleteBoxTunnel: (...args: unknown[]) => mockDeleteBoxTunnel(...args),
  isTunnelConfigured: () => mockTunnelConfigured,
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  DEFAULT_PROXMOX_VM_DISK_GB: 30,
  getReservedProxmoxVmidsForNode: (...args: unknown[]) => mockGetReservedProxmoxVmidsForNode(...args),
  resolveProxmoxTargetConfiguration: (...args: unknown[]) => mockResolveProxmoxTargetConfiguration(...args),
  runProxmoxHostScript: (...args: unknown[]) => mockRunProxmoxHostScript(...args),
}));

jest.mock("@/lib/services/instance-service", () => ({
  selectAvailableProxmoxProvisionTarget: (...args: unknown[]) => mockSelectAvailableProxmoxProvisionTarget(...args),
}));

const mockCheckHostWakeCapacity = jest.fn();
jest.mock("@/lib/proxmox/wake-admission", () => ({
  checkHostWakeCapacity: (...args: unknown[]) => mockCheckHostWakeCapacity(...args),
}));

jest.mock("@/lib/hivra/agent-events", () => ({
  logHivraAgentEvent: jest.fn(async () => undefined),
}));

const mockGetTemplateForLaunch = jest.fn();
jest.mock("@/lib/hivra/agent-templates", () => ({
  getTemplateForLaunch: (...args: unknown[]) => mockGetTemplateForLaunch(...args),
}));
jest.mock("@/lib/venice/proxy-keys", () => ({
  createManagedVeniceProxyKey: (...args: unknown[]) => mockCreateManagedVeniceProxyKey(...args),
  revokeManagedVeniceProxyKey: (...args: unknown[]) => mockRevokeManagedVeniceProxyKey(...args),
}));
jest.mock("@/lib/crypto", () => ({
  encryptApiKey: (s: string) => `enc:${s}`,
  decryptApiKey: (s: string) => String(s).replace(/^enc:/, ""),
}));

function makeRequest(body: Record<string, unknown>) {
  const launchBody = { ...body };
  if (["codex", "linux-desktop"].includes(String(body.type))
    && !Object.prototype.hasOwnProperty.call(body, "launchRequestId")) {
    launchBody.launchRequestId = LAUNCH_REQUEST_ID;
  }
  return new NextRequest("https://hivra.cloud/api/hivra/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ deployment: { mode: "hivra-managed" }, ...launchBody }),
  });
}

function makeGetRequest() {
  return new Request("https://hivra.cloud/api/hivra/agents", {
    method: "GET",
    headers: { Host: "hivra.cloud" },
  });
}

const SELF_MANAGED_DEPLOYMENT = {
  mode: "self-managed" as const,
  connectionId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  expectedConnectionRevision: 3,
};

type ManagedReadinessResult =
  | { ok: true }
  | {
      ok: false;
      status?: number;
      message: string;
      error?: Record<string, unknown>;
    };

type ManagedPlacementOptions = {
  readinessCheck?: (candidate: {
    targetId: string | null;
    env: NodeJS.ProcessEnv;
  }) => Promise<ManagedReadinessResult>;
};

describe("POST /api/hivra/agents", () => {
  const originalHivraProxmoxHost = process.env.HIVRA_PROXMOX_HOST;
  const originalHivraClaudeCodeProxmoxHost = process.env.HIVRA_CLAUDE_CODE_PROXMOX_HOST;
  const originalNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalVercelTargetEnvironment = process.env.VERCEL_TARGET_ENV;

  afterEach(() => {
    if (originalHivraProxmoxHost === undefined) {
      delete process.env.HIVRA_PROXMOX_HOST;
    } else {
      process.env.HIVRA_PROXMOX_HOST = originalHivraProxmoxHost;
    }
    if (originalHivraClaudeCodeProxmoxHost === undefined) {
      delete process.env.HIVRA_CLAUDE_CODE_PROXMOX_HOST;
    } else {
      process.env.HIVRA_CLAUDE_CODE_PROXMOX_HOST = originalHivraClaudeCodeProxmoxHost;
    }
    if (originalNextPublicAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalNextPublicAppUrl;
    }
    if (originalVercelTargetEnvironment === undefined) {
      delete process.env.VERCEL_TARGET_ENV;
    } else {
      process.env.VERCEL_TARGET_ENV = originalVercelTargetEnvironment;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLaunchRateLimit.mockReset().mockReturnValue(null);
    mockGetInfrastructureTarget.mockReset().mockResolvedValue(selfManagedExecutionContext().target);
    mockLaunchProviderAgent.mockReset();
    mockLaunchGvisorComputer.mockReset();
    mockLaunchExisting.mockReset().mockResolvedValue(null);
    mockLaunchByRequest.mockReset().mockResolvedValue(null);
    mockLaunchAgent.mockReset();
    mockOperationLookup.mockReset().mockImplementation(async (_userId, requestId) => {
      if (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) {
        throw new HivraLaunchOperationRequestError("invalid_request");
      }
      return { existing: null };
    });
    mockOperationPrepare.mockReset().mockImplementation(async (userId, requestId, requestIntent, launchIntent) => {
      if (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) {
        throw new HivraLaunchOperationRequestError("invalid_request");
      }
      return { existing: null, admission: { userId, requestId,
        operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", requestIntent, intent: launchIntent,
        requestDigest: "d".repeat(64), intentDigest: "e".repeat(64),
        resourceKind: launchIntent.resourceKind, runtimeId: launchIntent.runtimeId } };
    });
    mockOperationReserve.mockReset().mockImplementation(async admission => ({ created: true, existing: null, operation: {
      user_id: admission.userId, request_id: admission.requestId, operation_id: admission.operationId,
      request_digest: admission.requestDigest, intent_digest: admission.intentDigest,
      resource_kind: admission.intent.resourceKind, runtime_id: admission.intent.runtimeId,
      phase: "reserved", agent_id: null, response_status: null, created_at: "2026-09-04T10:00:00.000Z",
      failure_status: null, failure_code: null, bound_at: null, accepted_at: null, failed_at: null,
    } }));
    mockOperationBindAgent.mockReset().mockResolvedValue({ phase: "bound" });
    mockOperationAccept.mockReset().mockImplementation(async (admission, agentId, responseStatus) => ({
      state: "accepted", requestId: admission.requestId, phase: "accepted", responseStatus,
      agent: { id: agentId, user_id: admission.userId, type: admission.intent.runtimeId,
        computer_profile: admission.intent.computerProfile, status: "provisioning" },
    }));
    mockOperationMarkReconciling.mockReset().mockImplementation(async admission => ({
      state: "reconciling", requestId: admission.requestId, phase: "reconciling", responseStatus: null, agent: null,
    }));
    mockOperationFail.mockReset().mockImplementation(async (admission, failureStatus, failureCode) => ({
      state: "failed", requestId: admission.requestId, phase: "failed", responseStatus: null,
      failureStatus, failureCode, agent: null,
    }));
    mockLaunchReserve.mockReset().mockImplementation(async input => {
      const agent = { ...input.agent, user_id: input.userId, status: "provisioning", desired_state: "running",
        allocation_operation_id: input.agent.operation_id, operation_kind: "provision", llm_config: null, llm_api_key_encrypted: null };
      mockLaunchByRequest.mockResolvedValue({ request_id: input.requestId, agent_id: agent.id, phase: "waiting" });
      mockLaunchAgent.mockResolvedValue(agent);
      return { created: true, agentId: agent.id, phase: "waiting" };
    });
    mockAgentUpdates.length = 0;
    mockHivraAgentEqCalls.length = 0;
    delete process.env.HIVRA_PROXMOX_HOST;
    delete process.env.HIVRA_CLAUDE_CODE_PROXMOX_HOST;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_TARGET_ENV;
    mockSubscriptionRow = {
      plan: "free",
      status: "active",
      instance_limit: 1,
      total_cpu_budget: 0.5,
      total_ram_budget: 1024,
      current_period_end: null,
    };
    mockVmIdentityUpdateError = null;
    mockInsertedAgentId = "agent-1";
    mockCollectorUpsert.mockReset().mockResolvedValue({ error: null });
    mockAgentInsertError = null;
    mockAgentInsertThrows = null;
    mockExistingAgents = [];
    mockAuth.mockResolvedValue({ userId: "user-free" });
    mockTunnelConfigured = false;
    mockLocalAuthMode = false;
    mockCreateBoxTunnel.mockResolvedValue(null);
    mockDeleteBoxTunnel.mockResolvedValue(undefined);
    mockCheckpointHivraAgentOperation.mockResolvedValue(true);
    mockPersistHivraAgentProvisionIdentity.mockResolvedValue(true);
    mockCompleteHivraAgentDelete.mockResolvedValue(true);
    mockBeginHivraAgentVmAllocation.mockResolvedValue(true);
    mockFailHivraAgentBeforeAllocation.mockResolvedValue(true);
    mockRevokeManagedVeniceProxyKey.mockReset().mockResolvedValue(undefined);
    mockReleaseHivraAgentOperation.mockResolvedValue(true);
    mockRecordHivraAgentOperationFailure.mockResolvedValue(true);
    mockResolveProxmoxTargetConfiguration.mockReturnValue({
      env: {
        PROXMOX_NODE: "fixturenode7",
        PROXMOX_VMID_START: "200",
        PROXMOX_VMID_END: "249",
        PROXMOX_IP_LAST_OCTET_START: "50",
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
        PROXMOX_PRIVATE_GATEWAY: "10.250.21.1",
      },
    });
    mockGetReservedProxmoxVmidsForNode.mockResolvedValue([]);
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValue(
      selfManagedExecutionContext(),
    );
    mockCheckHostWakeCapacity.mockResolvedValue({ ok: true, freeMb: 8000 });
    mockSelectAvailableProxmoxProvisionTarget.mockResolvedValue({
      ok: true,
      targetId: "fixturenode7",
      env: {
        PROXMOX_NODE: "fixturenode7",
        PROXMOX_VMID_START: "200",
        PROXMOX_VMID_END: "249",
        PROXMOX_IP_LAST_OCTET_START: "50",
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
        PROXMOX_PRIVATE_GATEWAY: "10.250.21.1",
      },
    });
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.250.21.50"}\n',
      })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(async () => ({ data: mockSubscriptionRow, error: null })),
        };
      }

      // resolveEffectiveSubscription checks the Apple IAP lane (2026-07-16)
      // between the Stripe row and the token entitlements — return empty so
      // these fixtures keep exercising their original entitlement source.
      if (table === "apple_iap_subscriptions") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(async () => ({ data: null, error: null })),
        };
      }

      if (table === "yearly_token_subscriptions") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(async () => ({ data: null, error: null })),
        };
      }

      if (table === "token_tier_qualifications") {
        const chain: {
          select: jest.Mock;
          eq: jest.Mock;
          then: (resolve: (value: { data: unknown[]; error: null }) => void) => void;
        } = {
          select: jest.fn(),
          eq: jest.fn(),
          then: (resolve) => resolve({ data: [], error: null }),
        };
        chain.select.mockReturnValue(chain);
        chain.eq.mockReturnValue(chain);
        return chain;
      }

      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          // loadCurrentComputeUsage now chains a second .not() for the
          // lifecycle exclusion, so the first .not() must stay chainable.
          not: jest.fn().mockReturnValue({ not: jest.fn(async () => ({ data: [], error: null })) }),
        };
      }

      if (table === "pools") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn(async () => ({ data: { priority: 0 }, error: null })),
        };
      }

      // Error-path API logging persists an ops event. Keep that observability
      // side effect separate from the hivra_agents insert spy used by the
      // capacity/no-provider-side-effect assertions below.
      if (table === "ops_events") {
        return {
          insert: jest.fn(async () => ({ error: null })),
        };
      }

      if (table === "hivra_activity_collectors") {
        return { upsert: (...args: unknown[]) => mockCollectorUpsert(...args) };
      }

      const state: { insertPayload?: Record<string, unknown>; updatePayloads: Record<string, unknown>[] } = {
        updatePayloads: [],
      };
      const eqFilters: Array<[string, unknown]> = [];
      const agentQuery: Record<string, unknown> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn((column: string, value: unknown) => {
          eqFilters.push([column, value]);
          mockHivraAgentEqCalls.push([column, value]);
          return agentQuery;
        }),
        neq: jest.fn(async () => ({
          count: mockExistingAgents.filter((row) => eqFilters.every(([column, value]) => {
            if (column === "deployment_mode") {
              return (row.deployment_mode ?? "hivra-managed") === value;
            }
            return true;
          })).length,
          data: mockExistingAgents.filter((row) => eqFilters.every(([column, value]) => {
            if (column === "deployment_mode") {
              return (row.deployment_mode ?? "hivra-managed") === value;
            }
            return true;
          })),
          error: null,
        })),
        maybeSingle: jest.fn(async () => ({
          data: state.insertPayload ? { id: mockInsertedAgentId, ...state.insertPayload } : null,
          error: null,
        })),
        insert: jest.fn((payload: Record<string, unknown>) => {
          mockAgentInsert(payload);
          state.insertPayload = payload;
          return {
            select: jest.fn().mockReturnThis(),
            single: jest.fn(async () => {
              if (mockAgentInsertThrows) throw mockAgentInsertThrows;
              if (mockAgentInsertError) return { data: null, error: mockAgentInsertError };
              return { data: { id: mockInsertedAgentId, ...payload }, error: null };
            }),
          };
        }),
        update: jest.fn((payload: Record<string, unknown>) => {
          mockAgentUpdates.push(payload);
          state.updatePayloads.push(payload);
          const isIdentityReservation =
            Object.keys(payload).length === 2 && "vmid" in payload && "ip" in payload;
          const chain = {
            error: isIdentityReservation ? mockVmIdentityUpdateError : null,
            eq: jest.fn(),
            select: jest.fn(),
            single: jest.fn(async () => ({
              data: { id: mockInsertedAgentId, ...(state.insertPayload ?? {}), ...payload },
              error: null,
            })),
          };
          chain.eq.mockReturnValue(chain);
          chain.select.mockReturnValue(chain);
          return chain;
        }),
      };
      return agentQuery;
    });
  });

  it.each([undefined, null, "bad-id"])("rejects a model launch without a valid stable request ID: %s", async launchRequestId => {
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId }));
    expect(response.status).toBe(400);
    expect(mockLaunchExisting).not.toHaveBeenCalled(); expect(mockLaunchReserve).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled(); expect(mockGetInfrastructureTarget).not.toHaveBeenCalled();
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", undefined], ["codex", null], ["codex", "bad-id"],
    ["linux-desktop", undefined], ["linux-desktop", null], ["linux-desktop", "bad-id"],
  ])("requires a valid generic launch request ID for %s: %s", async (type, launchRequestId) => {
    const response = await POST(makeRequest({ type, launchRequestId }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: expect.stringMatching(/valid stable launch request ID/i),
    }));
    expect(mockOperationReserve).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockLaunchExisting).not.toHaveBeenCalled();
    expect(mockGetTemplateForLaunch).not.toHaveBeenCalled();
  });

  it("returns an accepted native Codex launch before target, capacity, pool, or provider work", async () => {
    process.env.VERCEL_TARGET_ENV = "staging";
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mockOperationLookup.mockResolvedValue({ existing: {
      state: "accepted", requestId: LAUNCH_REQUEST_ID, phase: "accepted", responseStatus: 201,
      agent: { id: agentId, user_id: "user-free", type: "codex", status: "provisioning",
        infrastructure_binding_token_hash: "private-binding", operation_id: "private-operation" },
    } });
    const response = await POST(makeRequest({ type: "codex", name: "Native Codex" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.data).toMatchObject({ launchRequestId: LAUNCH_REQUEST_ID, agent: { id: agentId },
      launch: { state: "accepted", phase: "accepted" } });
    expect(JSON.stringify(payload)).not.toMatch(/private-binding|private-operation|intent_digest/);
    expect(mockOperationReserve).not.toHaveBeenCalled();
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
    expect(mockGetInfrastructureTarget).not.toHaveBeenCalled();
    expect(mockGetOrCreatePoolId).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockLaunchProviderAgent).not.toHaveBeenCalled();
  });

  it("returns truthful in-progress state for an uncertain native Codex launch without re-driving creation", async () => {
    mockOperationLookup.mockResolvedValue({ existing: {
      state: "reconciling", requestId: LAUNCH_REQUEST_ID, phase: "reserved", responseStatus: null, agent: null,
    } });
    const response = await POST(makeRequest({ type: "codex" }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ data: {
      launchRequestId: LAUNCH_REQUEST_ID,
      launch: { state: "reconciling", phase: "reserved" },
    } }));
    expect(mockOperationReserve).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockLaunchProviderAgent).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("replays accepted Ubuntu before a removed template or mutable ingress configuration is consulted", async () => {
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mockOperationLookup.mockResolvedValue({ existing: {
      state: "accepted", requestId: LAUNCH_REQUEST_ID, phase: "accepted", responseStatus: 202,
      agent: { id: agentId, user_id: "user-free", type: "linux-desktop",
        computer_profile: "ubuntu-desktop", status: "provisioning" },
    } });
    const response = await POST(makeRequest({
      type: "linux-desktop",
      computerProfile: "ubuntu-desktop",
      templateId: "33333333-3333-4333-8333-333333333333",
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ data: expect.objectContaining({
      agent: expect.objectContaining({ id: agentId }),
      launch: { state: "accepted", phase: "accepted" },
    }) }));
    expect(mockGetTemplateForLaunch).not.toHaveBeenCalled();
    expect(mockOperationPrepare).not.toHaveBeenCalled();
    expect(mockOperationReserve).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it("replays a terminal pre-row failure without re-driving creation", async () => {
    mockOperationLookup.mockResolvedValue({ existing: {
      state: "failed", requestId: LAUNCH_REQUEST_ID, phase: "failed", responseStatus: null,
      failureStatus: 500, failureCode: "agent_insert_failed", agent: null,
    } });
    const response = await POST(makeRequest({ type: "codex" }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: false,
      code: "agent_insert_failed",
      launchRequestId: LAUNCH_REQUEST_ID,
      launch: { state: "failed", phase: "failed" },
    }));
    expect(mockOperationReserve).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it("rejects conflicting native launch ID reuse before target or capacity work", async () => {
    mockOperationLookup.mockRejectedValue(new HivraLaunchOperationRequestError("request_conflict"));
    const response = await POST(makeRequest({ type: "codex", cpu: 4 }));
    expect(response.status).toBe(409);
    expect(mockOperationReserve).not.toHaveBeenCalled();
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it("keeps explicit-model Codex on its existing precursor without double reservation", async () => {
    mockTunnelConfigured = true;
    mockSubscriptionRow = {
      plan: "operator", status: "active", instance_limit: 4,
      total_cpu_budget: 4, total_ram_budget: 8192, current_period_end: null,
    };
    mockRunProxmoxHostScript.mockReset()
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_RESOURCE_MAXIMUM_FITS 16 65536\n" })
      .mockResolvedValueOnce({ ok: true, stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.250.21.50"}\n' })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
    mockCreateBoxTunnel.mockResolvedValue({ token: "synthetic-tunnel", url: "https://fixture.example.test",
      tunnelId: "fixture-tunnel", hostname: "fixture.example.test" });
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION,
      cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4,
      launchRequestId: LAUNCH_REQUEST_ID }));
    expect(response.status).toBe(201);
    expect(mockLaunchReserve).toHaveBeenCalledTimes(1);
    expect(mockLaunchReserve).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ cpu: 1.5, ram: 3, cpu_max: 2, ram_max: 4 }),
    }));
    expect(mockOperationPrepare).not.toHaveBeenCalled();
    expect(mockOperationReserve).not.toHaveBeenCalled();
  });

  it("rejects an explicit launch maximum below the reserved allocation", async () => {
    const response = await POST(makeRequest({
      type: "codex", cpu: 2, ram: 4, maximumCpu: 1, maximumRam: 2,
      launchRequestId: LAUNCH_REQUEST_ID,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/maximum/i) });
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it.each(["waiting", "promoted", "cancelled", "deleted"])("returns the original %s model launch before target, access or allocation checks", async phase => {
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mockLaunchExisting.mockResolvedValue({ agent_id: agentId });
    mockLaunchByRequest.mockResolvedValue({ request_id: LAUNCH_REQUEST_ID, agent_id: agentId, phase });
    mockLaunchAgent.mockResolvedValue({ id: agentId, user_id: "user-free", type: "codex", status: phase === "deleted" ? "deleted" : "provisioning",
      llm_api_key_encrypted: "private-ciphertext", infrastructure_binding_token_hash: "private-binding" });
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID, deployment: SELF_MANAGED_DEPLOYMENT }));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = await response.json();
    expect(result.data).toMatchObject({ launchRequestId: LAUNCH_REQUEST_ID, agent: { id: agentId } });
    expect(JSON.stringify(result)).not.toMatch(/private-|synthetic-launch-key/);
    expect(mockGetInfrastructureTarget).not.toHaveBeenCalled(); expect(mockLaunchReserve).not.toHaveBeenCalled();
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled(); expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockCreateManagedVeniceProxyKey).not.toHaveBeenCalled(); expect(mockCreateBoxTunnel).not.toHaveBeenCalled();
  });

  it.each([[new LaunchModelRequestError("request_conflict"), 409], [new ModelKeyStoreError(), 503]] as const)(
    "does not fall through an unreadable or conflicting saved model request", async (error, status) => {
      mockLaunchExisting.mockRejectedValue(error);
      const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID }));
      expect(response.status).toBe(status); expect(mockLaunchReserve).not.toHaveBeenCalled();
      expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled(); expect(mockAgentInsert).not.toHaveBeenCalled();
    });

  it("requires named model-settings access before new target work or reservation", async () => {
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID }));
    expect(response.status).toBe(503); expect((await response.json()).error).toMatch(/Secure model-settings access/);
    expect(mockLaunchReserve).not.toHaveBeenCalled(); expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
  });

  it("rejects a native-compatible self-managed host without model support before allocating", async () => {
    mockTunnelConfigured = true;
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValue(selfManagedExecutionContext({ provisionerVersion: "2026.08.28.1" }));
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID, deployment: SELF_MANAGED_DEPLOYMENT }));
    expect(response.status).toBe(409); expect((await response.json()).error).toMatch(/model-settings provisioner update/);
    expect(mockLaunchReserve).not.toHaveBeenCalled(); expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled(); expect(mockCheckHostWakeCapacity).not.toHaveBeenCalled();
  });

  it("adds the actual model contract to managed admission before pool, keys or reservation", async () => {
    mockTunnelConfigured = true;
    mockRunProxmoxHostScript.mockReset().mockResolvedValue({ ok: false, stdout: "", stderr: "version mismatch" });
    mockSelectAvailableProxmoxProvisionTarget.mockImplementationOnce(async (options: ManagedPlacementOptions) => {
      const readiness = await options.readinessCheck!({ targetId: "fixturenode7", env: { NODE_ENV: "test", PROXMOX_NODE: "fixturenode7" } });
      return readiness.ok ? { ok: true, targetId: "fixturenode7" } : { ok: false, status: readiness.status, message: readiness.message };
    });
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID }));
    expect(response.status).toBe(503); expect((await response.json()).error).toMatch(/model-settings support/);
    const script = mockRunProxmoxHostScript.mock.calls[0][0];
    expect(script).toContain('need_file "$PROVISIONER_DIR/hivra-chat/llm-application.js"');
    expect(script).not.toContain("'2026.08.26.10'|");
    expect(mockLaunchReserve).not.toHaveBeenCalled(); expect(mockGetOrCreatePoolId).not.toHaveBeenCalled();
    expect(mockCreateManagedVeniceProxyKey).not.toHaveBeenCalled(); expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it.each(["byok", "managed"])("reserves %s model intent without active key metadata or installer credentials", async mode => {
    mockTunnelConfigured = true;
    mockCreateBoxTunnel.mockResolvedValue({ token: "synthetic-tunnel", url: "https://fixture.example.test", tunnelId: "fixture-tunnel", hostname: "fixture.example.test" });
    const llm = mode === "byok" ? MODEL_SELECTION : { provider: "venice", mode: "managed", model: "test-model", walletType: "card" };
    const response = await POST(makeRequest({ type: "codex", name: "Saved model", llm, launchRequestId: LAUNCH_REQUEST_ID }));
    expect(response.status).toBe(201);
    expect(mockLaunchReserve).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-free", requestId: LAUNCH_REQUEST_ID,
      llm, agent: expect.objectContaining({ type: "codex", name: "Saved model", computer_substrate: "proxmox-kvm",
        managed_provisioner_channel: "default", cpu: 0.5, ram: 1 }) }));
    expect(mockAgentInsert).not.toHaveBeenCalled(); expect(mockCreateManagedVeniceProxyKey).not.toHaveBeenCalled();
    const row = mockLaunchReserve.mock.calls[0][0].agent;
    expect(row).not.toHaveProperty("llm_config"); expect(row).not.toHaveProperty("llm_api_key_encrypted");
    expect(JSON.stringify(mockRunProxmoxHostScript.mock.calls)).not.toMatch(/synthetic-launch-key|test-model|api\.venice\.ai/);
    expect(mockLaunchReserve.mock.invocationCallOrder[0]).toBeLessThan(mockRunProxmoxHostScript.mock.invocationCallOrder[0]);
    const result = await response.json();
    expect(result.data).toMatchObject({ launchRequestId: LAUNCH_REQUEST_ID, agent: { id: row.id, llm_config: null } });
    expect(result.data.agent).not.toHaveProperty("managed_provisioner_channel");
    expect(JSON.stringify(result)).not.toMatch(/synthetic-launch-key|binding_token|operation_id/);
  });

  it("returns a reservation race winner without a second tunnel or allocation", async () => {
    mockTunnelConfigured = true;
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mockLaunchReserve.mockImplementation(async () => {
      mockLaunchByRequest.mockResolvedValue({ request_id: LAUNCH_REQUEST_ID, agent_id: agentId, phase: "waiting" });
      mockLaunchAgent.mockResolvedValue({ id: agentId, type: "codex", user_id: "user-free", status: "provisioning" });
      return { created: false, agentId, phase: "waiting" };
    });
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID }));
    expect(response.status).toBe(200); expect((await response.json()).data.agent.id).toBe(agentId);
    expect(mockLaunchReserve).toHaveBeenCalledTimes(1); expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockCreateBoxTunnel).not.toHaveBeenCalled(); expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("stops allocation if named access disappears after a model reservation", async () => {
    mockTunnelConfigured = true; mockCreateBoxTunnel.mockResolvedValue(null);
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID }));
    expect(response.status).toBe(502); expect(mockLaunchReserve).toHaveBeenCalledTimes(1);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled(); expect(mockCreateManagedVeniceProxyKey).not.toHaveBeenCalled();
  });

  it("passes the saved request to the provider adapter without managed fallback", async () => {
    mockTunnelConfigured = true; mockGetInfrastructureTarget.mockResolvedValue(providerVmTarget());
    mockLaunchProviderAgent.mockResolvedValue({ agent: { id: "fixture-agent", status: "provisioning" }, launchRequestId: LAUNCH_REQUEST_ID });
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID, deployment: SELF_MANAGED_DEPLOYMENT }));
    expect(response.status).toBe(202);
    expect(mockLaunchProviderAgent).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-free", type: "codex" }), undefined,
      expect.objectContaining({ service: expect.objectContaining({ reserve: expect.any(Function) }), admission: expect.objectContaining({
        userId: "user-free", requestId: LAUNCH_REQUEST_ID, intent: expect.objectContaining({ llm: MODEL_SELECTION, deployment: SELF_MANAGED_DEPLOYMENT }) }) }));
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled(); expect(mockLaunchReserve).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled(); expect(mockGetOrCreatePoolId).not.toHaveBeenCalled();
  });

  it("passes a standalone model-key launch to the provider's direct-HTTPS admission without Cloudflare credentials", async () => {
    mockLocalAuthMode = true;
    mockGetInfrastructureTarget.mockResolvedValue(providerVmTarget());
    mockLaunchProviderAgent.mockResolvedValue({ agent: { id: "fixture-agent", status: "provisioning" }, launchRequestId: LAUNCH_REQUEST_ID });
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION,
      launchRequestId: LAUNCH_REQUEST_ID, deployment: SELF_MANAGED_DEPLOYMENT }));
    expect(response.status).toBe(202);
    expect(mockLaunchProviderAgent).toHaveBeenCalledWith(expect.objectContaining({ llm: MODEL_SELECTION }), undefined,
      expect.objectContaining({ admission: expect.objectContaining({ userId: "user-free", requestId: LAUNCH_REQUEST_ID }) }));
    expect(mockCreateBoxTunnel).not.toHaveBeenCalled(); expect(mockLaunchReserve).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled(); expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
  });

  it.each(["provider", "proxmox", "managed"])("does not extend standalone direct-HTTPS admission to an unqualified %s model-key launch", async lane => {
    mockLocalAuthMode = lane !== "provider";
    if (lane === "provider") mockGetInfrastructureTarget.mockResolvedValue(providerVmTarget());
    const response = await POST(makeRequest({ type: "codex", llm: MODEL_SELECTION, launchRequestId: LAUNCH_REQUEST_ID,
      ...(lane === "managed" ? {} : { deployment: SELF_MANAGED_DEPLOYMENT }) }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/Secure model-settings access/);
    expect(mockLaunchProviderAgent).not.toHaveBeenCalled(); expect(mockLaunchReserve).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled(); expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects a stale managed provisioner before creating launch side effects", async () => {
    const candidateEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PROXMOX_NODE: "fixturenode7",
      PROXMOX_VMID_START: "200",
      PROXMOX_VMID_END: "249",
      PROXMOX_IP_LAST_OCTET_START: "50",
      PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
      PROXMOX_PRIVATE_GATEWAY: "10.250.21.1",
    };
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        stdout: "",
        stderr: "Hivra provisioner version mismatch",
        error: "Remote bash exited with code 1",
      });
    mockSelectAvailableProxmoxProvisionTarget.mockImplementationOnce(
      async (options: ManagedPlacementOptions) => {
        expect(options.readinessCheck).toEqual(expect.any(Function));
        const readiness = await options.readinessCheck!({
          targetId: "fixturenode7",
          env: candidateEnv,
        });
        if (!readiness.ok) {
          return {
            ok: false as const,
            status: readiness.status ?? 503,
            message: readiness.message,
            error: readiness.error,
          };
        }
        return { ok: true as const, targetId: "fixturenode7", env: candidateEnv };
      },
    );

    const response = await POST(makeRequest({
      type: "codex",
      name: "STALE_MANAGED_CODEX",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringMatching(/provisioner is being prepared/i),
    }));
    expect(mockRunProxmoxHostScript).toHaveBeenCalledTimes(1);
    const readinessScript = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(readinessScript).toContain(PORTABLE_HIVRA_PROVISIONER_VERSION);
    expect(readinessScript).toContain("sha256sum -c --status BUNDLE.sha256");
    expect(readinessScript).toContain('BINDING_TAG="${HIVRA_BINDING_TAG:-}"');
    expect(readinessScript).toContain('--tags "${BINDING_TAG};${OPERATION_TAG}"');
    expect(readinessScript).toContain('ALLOCATION_RECEIPT_FILE="/run/hivra-provision/${VMID}.allocated"');
    expect(readinessScript).toContain(
      'RESULT_LOG_PATH="${HIVRA_RESULT_LOG_PATH:-${LOG_DIR}/provision-${VMID}.log}"',
    );
    expect(readinessScript).toContain("printf 'HIVRA_OPERATION_ID %s\\n'");
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockGetOrCreatePoolId).not.toHaveBeenCalled();
    expect(mockCreateManagedVeniceProxyKey).not.toHaveBeenCalled();
    expect(mockCreateBoxTunnel).not.toHaveBeenCalled();
    expect(mockCheckpointHivraAgentOperation).not.toHaveBeenCalled();
    expect(mockPosthogCapture).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown managed deployment channel before placement or persistence", async () => {
    process.env.VERCEL_TARGET_ENV = "staging";

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "INVALID_CHANNEL_AGENT",
      cpu: 0.5,
      ram: 1,
    }));

    expect(response.status).toBe(503);
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("passes the reviewed managed runtime paths to the current provisioner", async () => {
    const candidateEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PROXMOX_NODE: "fixturenode7",
      PROXMOX_VMID_START: "200",
      PROXMOX_VMID_END: "249",
      PROXMOX_IP_LAST_OCTET_START: "50",
      PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
      PROXMOX_PRIVATE_GATEWAY: "10.250.21.1",
    };
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_HOST_READY\n" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.250.21.50"}\n',
      })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
    mockSelectAvailableProxmoxProvisionTarget.mockImplementationOnce(
      async (options: ManagedPlacementOptions) => {
        expect(options.readinessCheck).toEqual(expect.any(Function));
        const readiness = await options.readinessCheck!({
          targetId: "fixturenode7",
          env: candidateEnv,
        });
        if (!readiness.ok) {
          return {
            ok: false as const,
            status: readiness.status ?? 503,
            message: readiness.message,
            error: readiness.error,
          };
        }
        return { ok: true as const, targetId: "fixturenode7", env: candidateEnv };
      },
    );

    const response = await POST(makeRequest({
      type: "codex",
      name: "CURRENT_MANAGED_CODEX",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockRunProxmoxHostScript).toHaveBeenCalledTimes(4);
    const readinessScript = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(readinessScript).toContain(
      `case "$OBSERVED_VERSION" in\n  ${PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS.map(version => `'${version}'`).join("|")}) ;;\n  *) echo "Hivra provisioner version mismatch" >&2; exit 1 ;;\nesac`,
    );
    expect(spawnSync("bash", ["-n"], { input: readinessScript, encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
    const kickoff = mockRunProxmoxHostScript.mock.calls[1][0] as string;
    expect(kickoff).toContain("HIVRA_PROV_DIR='/root/hivra-provisioner'");
    expect(kickoff).toContain("HIVRA_STORAGE='local-lvm'");
    expect(kickoff).toContain("HIVRA_BRIDGE='vmbr1'");
    expect(kickoff).toContain("HIVRA_UBUNTU_IMG='/root/jammy-server-cloudimg-amd64.img'");
    expect(kickoff).toContain("HIVRA_VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
    expect(kickoff).toContain("HIVRA_LOG_DIR='/root'");
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      computer_substrate: "proxmox-kvm",
      managed_provisioner_channel: "default",
    }));
  });

  it("requires and launches the current bundle from the isolated Canary channel", async () => {
    process.env.VERCEL_TARGET_ENV = "canary";
    const candidateEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PROXMOX_NODE: "fixturenode7",
      PROXMOX_VMID_START: "200",
      PROXMOX_VMID_END: "249",
      PROXMOX_IP_LAST_OCTET_START: "50",
      PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
      PROXMOX_PRIVATE_GATEWAY: "10.250.21.1",
    };
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_HOST_READY\n" })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.250.21.50"}\n',
      })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
    mockSelectAvailableProxmoxProvisionTarget.mockImplementationOnce(
      async (options: ManagedPlacementOptions) => {
        const readiness = await options.readinessCheck!({
          targetId: "fixturenode7",
          env: candidateEnv,
        });
        return readiness.ok
          ? { ok: true as const, targetId: "fixturenode7", env: candidateEnv }
          : { ok: false as const, status: readiness.status ?? 503, message: readiness.message };
      },
    );

    const response = await POST(makeRequest({
      type: "codex",
      name: "CANARY_MANAGED_CODEX",
      cpu: 0.5,
      ram: 1,
      managedProvisionerChannel: "default",
    }) as never);

    expect(response.status).toBe(201);
    const readinessScript = String(mockRunProxmoxHostScript.mock.calls[0][0]);
    expect(readinessScript).toContain("PROVISIONER_DIR='/root/hivra-provisioner-canary'");
    expect(readinessScript).toContain(`case "$OBSERVED_VERSION" in\n  '${PORTABLE_HIVRA_PROVISIONER_VERSION}') ;;`);
    const kickoff = String(mockRunProxmoxHostScript.mock.calls[1][0]);
    expect(kickoff).toContain("HIVRA_PROV_DIR='/root/hivra-provisioner-canary'");
    expect(kickoff).toContain("bash '/root/hivra-provisioner-canary'/hivra-provision-on-host.sh");
    expect(kickoff).not.toMatch(/HIVRA_PROV_DIR='\/root\/hivra-provisioner'/);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      computer_substrate: "proxmox-kvm",
      managed_provisioner_channel: "canary",
    }));
  });

  it("preserves the free Claude half-core request while provisioning a one-core VM capped to 0.5 CPU", async () => {
    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);

    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "claude-code",
      proxmox_host: "fixturenode7",
      cpu: 0.5,
      ram: 1,
      infrastructure_binding_token_enforced: true,
    }));

    expect(mockSelectAvailableProxmoxProvisionTarget).toHaveBeenCalledWith(expect.objectContaining({
      hostConfig: null,
      neededCpu: 0.5,
      neededRamMb: 1024,
      neededDiskGb: 30,
      userId: "user-free",
      skipTemplateAvailabilityCheck: true,
      readinessCheck: expect.any(Function),
    }));

    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('hivra-provision-on-host.sh "$VMID" "$OCTET" "1" "1024" "claude"'),
      expect.objectContaining({
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
        PROXMOX_PRIVATE_GATEWAY: "10.250.21.1",
      }),
      expect.objectContaining({
        earlyFinishMarker: "HIVRA_PROVISION_RESULT",
      }),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_SUBNET_PREFIX='10.250.21'");
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_GW='10.250.21.1'");
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain('ip":"10.250.21.%s');
    // The octet must avoid IPs already in use on the host (no blind vmid-offset
    // that can collide with an out-of-band VM). Lock in the collision-avoidance scan.
    const kickoff = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(kickoff).toContain("claimed_octets=");
    expect(kickoff).toContain('grep -qx "$cand"');
    const allocationLockedAt = kickoff.indexOf("flock -w 60 8");
    const localInventoryAt = kickoff.indexOf('local_vmids="$(qm list');
    const clusterInventoryAt = kickoff.indexOf("pvesh get /cluster/resources --type vm");
    const ipInventoryAt = kickoff.indexOf('claimed_octets="$(');
    expect(allocationLockedAt).toBeGreaterThanOrEqual(0);
    expect(localInventoryAt).toBeGreaterThan(allocationLockedAt);
    expect(clusterInventoryAt).toBeGreaterThan(allocationLockedAt);
    expect(ipInventoryAt).toBeGreaterThan(localInventoryAt);
    // Managed hosts must now run the current reviewed provisioner. The
    // operation-scoped PATH wrapper remains a second ownership boundary around
    // the exact real `qm create`; it must preserve rather than duplicate the
    // tags emitted by the current bundle. A detached guardian keeps both
    // allocation locks until those tags and the expected IP are visible. The
    // background child closes inherited locks and consumes secrets from the
    // root-only handoff file rather than placing them in argv.
    expect(kickoff).toContain('install -m 0600 /dev/null "$SECRET_ENV_FILE"');
    expect(kickoff).toContain('read_secret_b64()');
    expect(kickoff).toContain('exec 8>&-');
    expect(kickoff).toContain('exec 9>&-');
    expect(kickoff).toContain('rm -f -- "$SECRET_ENV_FILE"');
    expect(kickoff).toContain('REAL_QM="$(command -v qm)"');
    expect(kickoff).toContain("stat -Lc '%u:%g'");
    expect(kickoff).toContain('install -d -o root -g root -m 0700 "$WRAPPER_DIR"');
    expect(kickoff).toContain("cat > \"$QM_WRAPPER\" <<'HIVRA_QM_WRAPPER'");
    expect(kickoff).toContain(
      'if [ "${1:-}" = create ] && [ "${2:-}" = "$HIVRA_EXPECTED_VMID" ]; then',
    );
    expect(kickoff).toContain(
      'for required_tag in "$HIVRA_BINDING_TAG" "$HIVRA_OPERATION_TAG"; do',
    );
    expect(kickoff).toContain(
      'exec "$HIVRA_REAL_QM" "${forward_args[@]}" --tags "$combined_tags"',
    );
    expect(kickoff).toContain("HIVRA_OPERATION_TAG='hivra-op-");
    expect(kickoff).toContain("HIVRA_BINDING_TAG='hivra-bind-");
    expect(kickoff).toContain("printf 'binding_enforced=%s\\n' 1");
    expect(kickoff).toContain('ALLOCATION_RECEIPT="/run/hivra-provision/$VMID.allocated"');
    expect(kickoff).toContain("provisioner exited before producing an ownership receipt");
    expect(kickoff).toContain("[ \"$(stat -Lc '%a:%u:%g' \"$ALLOCATION_RECEIPT\" 2>/dev/null)\" = \"600:0:0\" ]");

    // A foreign actor that takes the selected VMID cannot receive ownership:
    // only the exact child create is wrapped, and the guardian refuses to write
    // a receipt until both unguessable tags and the selected IP are present.
    const guardianIdentityAt = kickoff.indexOf("while ! vm_has_exact_identity_and_ip");
    const expectedIpCheckAt = kickoff.indexOf('grep -Fxq "ip=$EXPECTED_IP/24"');
    const receiptMoveAt = kickoff.indexOf('mv -f -- "$RECEIPT_TMP" "$ALLOCATION_RECEIPT"');
    const unlockAt = kickoff.indexOf("flock -u 8", receiptMoveAt);
    const keepWrapperAt = kickoff.indexOf("while child_is_exact_operation; do sleep 1; done");
    const finalReceiptGateAt = kickoff.lastIndexOf("allocation_receipt_is_exact");
    const resultAt = kickoff.indexOf("HIVRA_PROVISION_RESULT");
    expect(guardianIdentityAt).toBeGreaterThanOrEqual(0);
    expect(expectedIpCheckAt).toBeGreaterThanOrEqual(0);
    expect(guardianIdentityAt).toBeGreaterThan(expectedIpCheckAt);
    expect(receiptMoveAt).toBeGreaterThan(expectedIpCheckAt);
    expect(unlockAt).toBeGreaterThan(receiptMoveAt);
    expect(keepWrapperAt).toBeGreaterThan(unlockAt);
    expect(finalReceiptGateAt).toBeGreaterThan(receiptMoveAt);
    expect(resultAt).toBeGreaterThan(finalReceiptGateAt);

    const wrapperMatch = kickoff.match(
      /cat > "\$QM_WRAPPER" <<'HIVRA_QM_WRAPPER'\n([\s\S]*?)\nHIVRA_QM_WRAPPER/,
    );
    expect(wrapperMatch).not.toBeNull();
    expect(spawnSync("bash", ["-n"], { input: kickoff, encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
    expect(spawnSync("bash", ["-n"], { input: wrapperMatch?.[1] ?? "", encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
    const wrapperEnv = {
      ...process.env,
      HIVRA_REAL_QM: "/bin/echo",
      HIVRA_EXPECTED_VMID: "200",
      HIVRA_OPERATION_TAG: "hivra-op-test",
      HIVRA_BINDING_TAG: "hivra-bind-test",
    };
    const exactCreate = spawnSync(
      "bash",
      ["-s", "--", "create", "200", "--name", "box", "--tags", "existing"],
      { input: wrapperMatch?.[1] ?? "", encoding: "utf8", env: wrapperEnv },
    );
    expect(exactCreate).toMatchObject({ status: 0, stderr: "" });
    expect(exactCreate.stdout.trim()).toBe(
      "create 200 --name box --tags existing;hivra-bind-test;hivra-op-test",
    );
    const alreadyTaggedCreate = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "create",
        "200",
        "--name",
        "current-bundle",
        "--tags",
        "hivra-bind-test;hivra-op-test",
      ],
      { input: wrapperMatch?.[1] ?? "", encoding: "utf8", env: wrapperEnv },
    );
    expect(alreadyTaggedCreate).toMatchObject({ status: 0, stderr: "" });
    expect(alreadyTaggedCreate.stdout.trim()).toBe(
      "create 200 --name current-bundle --tags hivra-bind-test;hivra-op-test",
    );
    const foreignVmidCreate = spawnSync(
      "bash",
      ["-s", "--", "create", "201", "--name", "foreign"],
      { input: wrapperMatch?.[1] ?? "", encoding: "utf8", env: wrapperEnv },
    );
    expect(foreignVmidCreate).toMatchObject({ status: 0, stderr: "" });
    expect(foreignVmidCreate.stdout.trim()).toBe("create 201 --name foreign");
    expect(foreignVmidCreate.stdout).not.toContain("hivra-bind-test");
    const managedExec = kickoff.split("\n").find((line) => line.trimStart().startsWith("exec env ")) ?? "";
    expect(managedExec).not.toMatch(/HIVRA_(?:TUNNEL_TOKEN|MODEL_KEY|MODEL_BASE_URL|HERMES_MODEL|ACTIVITY_TELEMETRY)=/);
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("qm set 200 --cores 1 --cpulimit 0.5 --memory 1024 --balloon 1024"),
      expect.objectContaining({
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
        PROXMOX_PRIVATE_GATEWAY: "10.250.21.1",
      }),
    );
    expect(mockRunProxmoxHostScript.mock.calls[1][0]).toContain(
      "/var/lib/hivra/provision-operations/operation-",
    );
    const cpuUnitsMutation = mockRunProxmoxHostScript.mock.calls[2][0];
    expect(cpuUnitsMutation).toContain("/run/lock/hivra-allocation.lock");
    expect(cpuUnitsMutation).toMatch(/hivra-bind-[0-9a-f]{32}/);
    expect(cpuUnitsMutation).toMatch(/hivra-op-[0-9a-f]{32}/);
    expect(cpuUnitsMutation.indexOf("grep -Fxq")).toBeLessThan(
      cpuUnitsMutation.indexOf("qm set 200 --cpuunits"),
    );
  });

  it("launches on the exact owner-scoped target without using managed placement or pools", async () => {
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.251.20.50"}\n',
      })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_ALLOCATION_VERIFIED 200\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });

    const response = await POST(makeRequest({
      type: "codex",
      name: "PORTABLE_CODEX",
      cpu: 2,
      ram: 4,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockResolveSelfManagedProxmoxExecutionContext).toHaveBeenCalledWith(
      "user-free",
      {
        connectionId: SELF_MANAGED_DEPLOYMENT.connectionId,
        targetId: SELF_MANAGED_DEPLOYMENT.targetId,
        expectedConnectionRevision: 3,
      },
    );
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
    expect(mockGetOrCreatePoolId).not.toHaveBeenCalled();
    expect(mockGetReservedProxmoxVmidsForNode).not.toHaveBeenCalled();
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      pool_id: null,
      infrastructure_binding_token_enforced: true,
      infrastructure_connection_id: SELF_MANAGED_DEPLOYMENT.connectionId,
      deployment_target_id: SELF_MANAGED_DEPLOYMENT.targetId,
      infrastructure_connection_revision: 3,
    }));
    expect(mockCheckHostWakeCapacity).toHaveBeenCalledWith(
      4096,
      expect.objectContaining({ PROXMOX_NODE: "pve-personal" }),
    );
    const kickoff = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(kickoff).toContain("exec 8>/run/lock/hivra-allocation.lock");
    expect(kickoff).toContain("HIVRA_ALLOCATION_LOCK_FD=8");
    expect(kickoff).toContain("HIVRA_BINDING_TAG='hivra-bind-");
    expect(kickoff).toContain('ALLOCATION_RECEIPT="/run/hivra-provision/$VMID.allocated"');
    expect(kickoff).toContain("provisioner exited before producing an ownership receipt");
    expect(kickoff).toContain("binding_tag=");
    expect(kickoff.indexOf("allocation_receipt_is_exact")).toBeLessThan(
      kickoff.indexOf("HIVRA_PROVISION_RESULT"),
    );
    expect(kickoff).toContain("install -m 0600 /dev/null \"$LOG\"");
    expect(kickoff).toContain("HIVRA_PROV_DIR='/opt/hivra/provisioner'");
    expect(kickoff).toContain("HIVRA_BRIDGE='hivra0'");
    expect(kickoff).toContain("HIVRA_VM_SSH_KEY_PATH='/etc/hivra/keys/vm-orchestrator'");
    expect(kickoff).toContain("/var/log/hivra");
  });

  it("provisions an explicit envelope with guaranteed admission and hard Proxmox ceilings", async () => {
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({ ok: true, stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.251.20.50"}\n' })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_ALLOCATION_VERIFIED 200\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });

    const response = await POST(makeRequest({
      type: "codex", name: "ELASTIC_CODEX", browser: true,
      cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockCheckHostWakeCapacity).toHaveBeenCalledWith(4096, expect.any(Object));
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      cpu: 2, ram: 4, cpu_max: 4, ram_max: 8,
    }));
    const kickoff = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(kickoff).toContain('"4" "8192" "codex" "4"');
    expect(kickoff).toContain("hivra-host-capacity-admission' - 4096 8192 4 2048 0 1000 1000 0");
    const capMutation = mockRunProxmoxHostScript.mock.calls[1][0] as string;
    expect(capMutation).toContain("--cores 4 --cpulimit 4 --memory 8192 --balloon 4096");
  });

  it("fails an explicit managed envelope when the exact selected host cannot fit its maximum", async () => {
    mockSubscriptionRow = {
      plan: "fleet", status: "active", instance_limit: 5,
      total_cpu_budget: 8, total_ram_budget: 16384, current_period_end: null,
    };
    mockRunProxmoxHostScript.mockReset().mockResolvedValueOnce({
      ok: false, stdout: "", stderr: "resource maximum exceeds selected host totals",
    });
    const response = await POST(makeRequest({
      type: "codex", name: "TOO_LARGE_MAX", browser: true,
      cpu: 1.5, ram: 3, maximumCpu: 4, maximumRam: 8,
    }) as never);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: "No managed host can enforce that CPU and memory maximum.",
    }));
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_RESOURCE_MAXIMUM_FITS");
    expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it("rejects explicit envelope fields on a non-unified runtime", async () => {
    const response = await POST(makeRequest({
      type: "claude-code", cpu: 1, ram: 2, maximumCpu: 2, maximumRam: 4,
    }) as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: expect.stringMatching(/only for Codex and Ubuntu Desktop/i),
    }));
    expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it("routes a provider VM to its original whole-computer adapter with no managed or Proxmox work", async () => {
    mockGetInfrastructureTarget.mockResolvedValue(providerVmTarget());
    mockLaunchProviderAgent.mockResolvedValue({ agent: { id: "fixture-agent", status: "provisioning" } });
    const request = makeRequest({ type: "codex", name: "Provider Codex", deployment: SELF_MANAGED_DEPLOYMENT });
    request.headers.set("Origin", "https://hivra.cloud");
    const response = await POST(request as never);
    expect(response.status).toBe(202); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockLaunchProviderAgent).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-free", type: "codex",
      name: "Provider Codex", targetId: SELF_MANAGED_DEPLOYMENT.targetId,
      connectionId: SELF_MANAGED_DEPLOYMENT.connectionId, expectedConnectionRevision: 3 }));
    expect(mockResolveSelfManagedProxmoxExecutionContext).not.toHaveBeenCalled();
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled(); expect(mockGetOrCreatePoolId).not.toHaveBeenCalled();
    expect(mockOperationReserve).toHaveBeenCalledTimes(1);
    expect(mockOperationReserve.mock.invocationCallOrder[0]).toBeLessThan(mockLaunchProviderAgent.mock.invocationCallOrder[0]);
    expect(mockOperationBindAgent).toHaveBeenCalledWith(expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), "fixture-agent");
    expect(mockOperationAccept).toHaveBeenCalledWith(expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), "fixture-agent", 202);
  });

  it("launches a Linux terminal computer only through exact ready gVisor authority", async () => {
    mockGetInfrastructureTarget.mockResolvedValue({
      id: SELF_MANAGED_DEPLOYMENT.targetId,
      connectionId: SELF_MANAGED_DEPLOYMENT.connectionId,
      evidenceConnectionRevision: 3,
      externalId: `gvisor-${"a".repeat(24)}`,
      displayName: "Linux host — gVisor",
      status: "ready",
      capacity: { cpu: { totalCores: 8, utilizationRatio: null }, memoryBytes: { total: 16 * 1024 ** 3, available: 12 * 1024 ** 3 }, storageBytes: { total: 100 * 1024 ** 3, available: 80 * 1024 ** 3 } },
      capabilities: { kind: "gvisor", launchReady: true, hostIdentityDigest: "b".repeat(64),
        adapter: { version: "2026.09.15.1", sha256: "c".repeat(64) }, runtime: { path: "/usr/local/bin/runsc", sha256: "d".repeat(64) },
        runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
        resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
        access: { terminal: "owner-gated-command-v1", publicPorts: false }, desktop: false, windows: false },
      supportedIsolationDrivers: ["gvisor-runsc"], isolationClass: "application-kernel",
      lastPreflightAt: "2026-09-15T12:00:00.000Z", lastErrorCode: null,
      createdAt: "2026-09-15T12:00:00.000Z", updatedAt: "2026-09-15T12:00:00.000Z",
    });
    mockLaunchGvisorComputer.mockResolvedValue({ id: "agent-gvisor", type: "linux-terminal", computer_profile: "linux-terminal", computer_substrate: "gvisor", status: "running" });

    const response = await POST(makeRequest({
      type: "linux-terminal", computerProfile: "linux-terminal", name: "Terminal workspace",
      cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4,
      launchRequestId: LAUNCH_REQUEST_ID, deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ success: true, data: {
      launchRequestId: LAUNCH_REQUEST_ID,
      launch: { state: "accepted", phase: "accepted" },
      agent: { id: "agent-gvisor", status: "running" },
    } });
    expect(mockLaunchGvisorComputer).toHaveBeenCalledWith({ userId: "user-free",
      targetId: SELF_MANAGED_DEPLOYMENT.targetId, launchRequestId: LAUNCH_REQUEST_ID,
      name: "Terminal workspace", cpu: 2, ramGb: 4 });
    expect(mockResolveSelfManagedProxmoxExecutionContext).not.toHaveBeenCalled();
    expect(mockLaunchProviderAgent).not.toHaveBeenCalled();
  });

  it("rejects gVisor CPU or memory maxima that differ from the reservation", async () => {
    const response = await POST(makeRequest({
      type: "linux-terminal", computerProfile: "linux-terminal", name: "Terminal workspace",
      cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 4,
      launchRequestId: LAUNCH_REQUEST_ID, deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);
    expect(response.status).toBe(400);
    expect(mockLaunchGvisorComputer).not.toHaveBeenCalled();
  });

  it("rejects cross-origin provider launch before the adapter", async () => {
    mockGetInfrastructureTarget.mockResolvedValue(providerVmTarget());
    const request = makeRequest({ type: "codex", deployment: SELF_MANAGED_DEPLOYMENT });
    request.headers.set("Origin", "https://foreign.example");
    expect((await POST(request as never)).status).toBe(403);
    expect(mockLaunchProviderAgent).not.toHaveBeenCalled(); expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it.each([["model",400],["template",400],["capacity",400],["conflict",409],["not_ready",409],["access",503]] as const)(
    "returns safe provider %s failure without managed fallback", async (code, status) => {
      mockGetInfrastructureTarget.mockResolvedValue(providerVmTarget());
      mockLaunchProviderAgent.mockRejectedValue(new ProviderAgentLaunchError(code));
      const request = makeRequest({ type: "codex", deployment: SELF_MANAGED_DEPLOYMENT });
      request.headers.set("Origin", "https://hivra.cloud");
      const response = await POST(request as never);
      expect(response.status).toBe(status); expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
      expect(mockCreateManagedVeniceProxyKey).not.toHaveBeenCalled();
      expect(mockOperationFail).toHaveBeenCalledWith(expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }),
        status, `provider_${code}`);
    });

  it("keeps an unconfirmed provider outcome reconciling and never returns a fake accepted agent", async () => {
    mockGetInfrastructureTarget.mockResolvedValue(providerVmTarget());
    mockLaunchProviderAgent.mockRejectedValue(new ProviderAgentLaunchError("unconfirmed"));
    const request = makeRequest({ type: "codex", deployment: SELF_MANAGED_DEPLOYMENT });
    request.headers.set("Origin", "https://hivra.cloud");
    const response = await POST(request as never);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ data: {
      launchRequestId: LAUNCH_REQUEST_ID,
      launch: { state: "reconciling", phase: "reconciling" },
    } }));
    expect(mockOperationMarkReconciling).toHaveBeenCalledTimes(1);
    expect(mockOperationFail).not.toHaveBeenCalled();
    expect(mockOperationBindAgent).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects a self-managed runtime-target pair excluded by compatibility evidence", async () => {
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValueOnce(
      selfManagedExecutionContext({ supportedCatalogRuntimeIds: ["claude-code"] }),
    );

    const response = await POST(makeRequest({
      type: "codex",
      name: "INCOMPATIBLE_CODEX",
      cpu: 2,
      ram: 4,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringMatching(/preflight.*compatibility evidence.*Codex/i),
    }));
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects old self-managed target evidence with no compatibility record", async () => {
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValueOnce(
      selfManagedExecutionContext({ omitRuntimeCompatibility: true }),
    );

    const response = await POST(makeRequest({
      type: "codex",
      name: "LEGACY_CODEX",
      cpu: 2,
      ram: 4,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringMatching(/run preflight again/i),
    }));
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects matching self-managed compatibility evidence from an older provisioner", async () => {
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValueOnce(
      selfManagedExecutionContext({ provisionerVersion: "2026.08.26.4" }),
    );

    const response = await POST(makeRequest({
      type: "codex",
      name: "STALE_COMPATIBILITY_CODEX",
      cpu: 2,
      ram: 4,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringMatching(/run preflight again/i),
    }));
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects an invalid deployment object before resolving or mutating infrastructure", async () => {
    const response = await POST(makeRequest({
      type: "codex",
      name: "INVALID_TARGET",
      deployment: {
        mode: "self-managed",
        connectionId: "not-a-uuid",
        targetId: SELF_MANAGED_DEPLOYMENT.targetId,
        expectedConnectionRevision: 3,
      },
    }) as never);

    expect(response.status).toBe(400);
    expect(mockResolveSelfManagedProxmoxExecutionContext).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("requires every launch request to choose a deployment mode explicitly", async () => {
    const response = await POST(makeRequest({
      deployment: undefined,
      type: "codex",
      cpu: 1,
      ram: 2,
    }) as never);
    expect(response.status).toBe(400);
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("enforces the browser-enabled runtime floor on user-owned compute", async () => {
    const response = await POST(makeRequest({
      type: "claude-code",
      name: "UNDERSIZED_BROWSER",
      cpu: 0.5,
      ram: 1,
      browser: true,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/requires at least/i);
    expect(mockResolveSelfManagedProxmoxExecutionContext).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it("rejects a self-managed launch that exceeds saved target capacity", async () => {
    mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValueOnce(
      selfManagedExecutionContext({ availableMemoryBytes: 2 * 1024 ** 3 }),
    );

    const response = await POST(makeRequest({
      type: "codex",
      name: "TOO_LARGE",
      cpu: 2,
      ram: 4,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(409);
    expect(mockCheckHostWakeCapacity).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
  });

  it("fails closed before side effects when live self-managed memory cannot be measured", async () => {
    mockCheckHostWakeCapacity.mockResolvedValueOnce({ ok: true, freeMb: null });

    const response = await POST(makeRequest({
      type: "codex",
      name: "UNMEASURED_TARGET",
      cpu: 2,
      ram: 4,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(503);
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockCreateBoxTunnel).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("fails closed when the selected connection revision is stale", async () => {
    const { ProxmoxExecutionContextError } = jest.requireMock(
      "@/lib/infrastructure/proxmox-execution-context",
    ) as { ProxmoxExecutionContextError: new (code: string) => Error };
    mockResolveSelfManagedProxmoxExecutionContext.mockRejectedValueOnce(
      new ProxmoxExecutionContextError("connection_stale"),
    );

    const response = await POST(makeRequest({
      type: "codex",
      name: "STALE_TARGET",
      cpu: 2,
      ram: 4,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/changed.*check again/i);
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rolls back a newly allocated self-managed VM when its identity reservation conflicts", async () => {
    mockPersistHivraAgentProvisionIdentity.mockRejectedValueOnce({
      code: "23505",
      message: "duplicate key",
    });
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.251.20.50"}\n',
      })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_VM_ROLLBACK_OK 200\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "intent removed\n" });

    const response = await POST(makeRequest({
      type: "codex",
      name: "IDENTITY_CONFLICT",
      cpu: 2,
      ram: 4,
      deployment: SELF_MANAGED_DEPLOYMENT,
    }) as never);

    expect(response.status).toBe(409);
    expect(mockRunProxmoxHostScript).toHaveBeenCalledTimes(3);
    expect(mockRunProxmoxHostScript.mock.calls[1][0]).toContain("HIVRA_VM_ROLLBACK_OK");
    expect(mockRunProxmoxHostScript.mock.calls[1][0]).toContain('qm destroy "$VMID" --purge');
    expect(mockCompleteHivraAgentDelete).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-1",
    }));
    expect(mockReleaseHivraAgentOperation).not.toHaveBeenCalled();
  });

  it("fills identity from a template when launched with templateId", async () => {
    mockGetTemplateForLaunch.mockResolvedValue({
      type: "codex",
      name: "Forked Builder",
      goal: "build",
      context: "carried-over context",
      personality: "direct",
      emoji: "🔨",
      llm_config: null,
    });

    const response = await POST(makeRequest({
      templateId: "11111111-1111-4111-8111-111111111111",
      launchRequestId: LAUNCH_REQUEST_ID,
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockGetTemplateForLaunch).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "user-free",
    );
    // Identity fields come from the template (no body overrides given).
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex",
      name: "Forked Builder",
      goal: "build",
      context: "carried-over context",
      personality: "direct",
      emoji: "🔨",
    }));
    // Provisions the codex CLI runtime derived from the template's type.
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('"$VMID" "$OCTET" "1" "1024" "codex"'),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects a launch when the referenced template is not found/available", async () => {
    mockGetTemplateForLaunch.mockResolvedValue(null);
    const response = await POST(makeRequest({
      templateId: "22222222-2222-4222-8222-222222222222",
    }) as never);
    expect(response.status).toBe(404);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("fails fast with 503 when the host has no RAM headroom (no half-dead box)", async () => {
    // OOM guard: a saturated host would boot the guest into swap and strand it.
    mockCheckHostWakeCapacity.mockResolvedValue({ ok: false, freeMb: 200 });
    const response = await POST(makeRequest({ cpu: 0.5, ram: 1 }) as never);
    expect(response.status).toBe(503);
    // No provisioning side effects: no kickoff, no DB row, no tunnel created.
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockCreateBoxTunnel).not.toHaveBeenCalled();
  });

  it("lets explicit body fields override the template identity", async () => {
    mockGetTemplateForLaunch.mockResolvedValue({
      type: "codex",
      name: "Template Name",
      goal: "build",
      context: "tpl context",
      personality: "direct",
      emoji: "🔨",
      llm_config: null,
    });
    const response = await POST(makeRequest({
      templateId: "33333333-3333-4333-8333-333333333333",
      launchRequestId: LAUNCH_REQUEST_ID,
      name: "Override Name",
      emoji: "🚀",
      cpu: 0.5,
      ram: 1,
    }) as never);
    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex",
      name: "Override Name",
      emoji: "🚀",
      // Non-overridden fields still come from the template.
      goal: "build",
      personality: "direct",
    }));
  });

  it("provisions a Codex box on the free tier and selects the codex CLI", async () => {
    const response = await POST(makeRequest({
      type: "codex",
      name: "CODEX_AGENT",
      cpu: 0.5,
      ram: 1,
      browser: false,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex",
      cpu: 0.5,
      ram: 1,
      operation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }));
    expect(mockOperationReserve).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreatePoolId.mock.invocationCallOrder[0]).toBeLessThan(mockOperationReserve.mock.invocationCallOrder[0]);
    expect(mockOperationReserve.mock.invocationCallOrder[0]).toBeLessThan(mockAgentInsert.mock.invocationCallOrder[0]);
    expect(mockOperationBindAgent).toHaveBeenCalledWith(expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), "agent-1");
    expect(mockOperationAccept).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), "agent-1", 202);
    expect(mockOperationAccept).toHaveBeenCalledWith(expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), "agent-1", 201);
    // 5th positional arg = AGENT_KIND; codex selects the codex CLI on the box.
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('hivra-provision-on-host.sh "$VMID" "$OCTET" "1" "1024" "codex"'),
      expect.anything(),
      expect.anything(),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_WANT_BROWSER='0'");
  });

  it("makes a confirmed generic row-insert failure terminal", async () => {
    mockAgentInsertError = { code: "fixture_insert_rejected" };
    const response = await POST(makeRequest({ type: "codex", cpu: 0.5, ram: 1 }) as never);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: false,
      code: "agent_insert_failed",
      launch: { state: "failed", phase: "failed" },
    }));
    expect(mockOperationFail).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), 500, "agent_insert_failed",
    );
    expect(mockOperationMarkReconciling).not.toHaveBeenCalled();
    expect(mockOperationBindAgent).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("keeps a thrown generic row-insert acknowledgement reconciling", async () => {
    mockAgentInsertThrows = new Error("lost insert response");
    const response = await POST(makeRequest({ type: "codex", cpu: 0.5, ram: 1 }) as never);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ data: {
      launchRequestId: LAUNCH_REQUEST_ID,
      launch: { state: "reconciling", phase: "reconciling" },
    } }));
    expect(mockOperationMarkReconciling).toHaveBeenCalledTimes(1);
    expect(mockOperationFail).not.toHaveBeenCalled();
    expect(mockOperationBindAgent).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("gates Codex browser automation on Free exactly like Claude Code", async () => {
    const response = await POST(makeRequest({
      type: "codex",
      name: "CODEX_AGENT",
      cpu: 0.5,
      ram: 1,
      browser: true, // codex now ships the browser stack — paid-gated, not dropped
    }) as never);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/browser automation requires a paid plan/i);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("admits a browser-off Codex envelope on Free with the legacy welcome provisioning", async () => {
    const provisionerArgs = (script: string) => script.match(/hivra-provision-on-host\.sh "\$VMID" "\$OCTET" "[^\n>]*/)?.[0];
    // The legacy welcome form sends a pinned request with no maxima.
    const legacy = await POST(makeRequest({
      type: "codex", name: "FREE_CODEX", browser: false, cpu: 0.5, ram: 1,
    }) as never);
    expect(legacy.status).toBe(201);
    const legacyKickoff = String(mockRunProxmoxHostScript.mock.calls[0][0]);
    expect(mockAgentInsert).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "codex", cpu: 0.5, ram: 1, cpu_max: 0.5, ram_max: 1,
    }));

    // The unified Launch journey sends the same fields plus its explicit envelope.
    mockRunProxmoxHostScript.mockReset()
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_RESOURCE_MAXIMUM_FITS 16 65536\n" })
      .mockResolvedValueOnce({ ok: true, stdout: 'HIVRA_PROVISION_RESULT {"vmid":201,"ip":"10.250.21.51"}\n' })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
    const unified = await POST(makeRequest({
      type: "codex", name: "FREE_CODEX", browser: false,
      cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1,
    }) as never);

    expect(unified.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "codex", cpu: 0.5, ram: 1, cpu_max: 0.5, ram_max: 1,
    }));
    const unifiedKickoff = String(mockRunProxmoxHostScript.mock.calls[1][0]);
    expect(provisionerArgs(unifiedKickoff)).toBeDefined();
    expect(provisionerArgs(unifiedKickoff)).toBe(provisionerArgs(legacyKickoff));
    expect(unifiedKickoff).toContain("HIVRA_WANT_BROWSER='0'");
    expect(legacyKickoff).toContain("HIVRA_WANT_BROWSER='0'");
  });

  it("still refuses a browser-on Codex envelope below the browser floor", async () => {
    mockSubscriptionRow = {
      plan: "operator", status: "active", instance_limit: 4,
      total_cpu_budget: 4, total_ram_budget: 8192, current_period_end: null,
    };
    const response = await POST(makeRequest({
      type: "codex", name: "SMALL_BROWSER_CODEX", browser: true,
      cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1,
    }) as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/profile floor/i) });
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("provisions a paid Codex box with the browser stack enabled", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "codex",
      name: "CODEX_AGENT",
      cpu: 2,
      ram: 4,
      browser: true,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('hivra-provision-on-host.sh "$VMID" "$OCTET" "2" "4096" "codex"'),
      expect.anything(),
      expect.anything(),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_WANT_BROWSER='1'");
  });

  it.each(["accepted","unconfirmed","capacity"])("routes owner-bound provider Ubuntu through replay-safe admission: %s",async outcome=>{
    process.env.NEXT_PUBLIC_APP_URL="https://canary.hermesos.cloud";mockTunnelConfigured=true;
    mockGetInfrastructureTarget.mockResolvedValue(providerVmTarget());
    const agentId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    if(outcome==="accepted")mockLaunchProviderAgent.mockResolvedValue({agent:{id:agentId,type:"linux-desktop",computer_profile:"ubuntu-desktop",status:"provisioning"}});
    else mockLaunchProviderAgent.mockRejectedValue(new ProviderAgentLaunchError(outcome as "unconfirmed"|"capacity"));
    const response=await POST(makeRequest({type:"linux-desktop",computerProfile:"ubuntu-desktop",name:"PROVIDER DESKTOP",
      cpu:2,ram:8,browser:false,deployment:SELF_MANAGED_DEPLOYMENT}));
    expect(response.status).toBe(outcome==="capacity"?400:202);
    expect(mockLaunchProviderAgent).toHaveBeenCalledWith(expect.objectContaining({userId:"user-free",type:"linux-desktop",
      computerProfile:"ubuntu-desktop",targetId:SELF_MANAGED_DEPLOYMENT.targetId,connectionId:SELF_MANAGED_DEPLOYMENT.connectionId}));
    expect(mockOperationReserve).toHaveBeenCalledTimes(1);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();expect(mockGetOrCreatePoolId).not.toHaveBeenCalled();
    if(outcome==="accepted") {
      expect(mockOperationBindAgent).toHaveBeenCalledWith(expect.any(Object),agentId);
      expect(mockOperationAccept).toHaveBeenCalledWith(expect.any(Object),agentId,202);
    } else {
      expect(mockOperationAccept).not.toHaveBeenCalled();
      if(outcome==="unconfirmed")expect(mockOperationMarkReconciling).toHaveBeenCalled();
      else expect(mockOperationFail).toHaveBeenCalledWith(expect.any(Object),400,"provider_capacity");
    }
  });
  it("launches a custom-sized Ubuntu computer with its durable profile and canonical control origin", async () => {
    mockSubscriptionRow = {
      plan: "fleet",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };
    process.env.NEXT_PUBLIC_APP_URL = "https://canary.hermesos.cloud";
    mockTunnelConfigured = true;
    mockCreateBoxTunnel.mockResolvedValue({
      token: "synthetic-tunnel",
      url: "https://fixture.example.test",
      tunnelId: "fixture-tunnel",
      hostname: "fixture.example.test",
    });

    const response = await POST(makeRequest({
      type: "linux-desktop",
      computerProfile: "ubuntu-desktop",
      name: "WORK COMPUTER",
      cpu: 4,
      ram: 8,
      browser: false,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      cpu: 4,
      ram: 8,
    }));
    expect(mockOperationPrepare).toHaveBeenCalledWith("user-free", LAUNCH_REQUEST_ID, expect.anything(), expect.objectContaining({
      resourceKind: "computer",
      runtimeId: "linux-desktop",
      computerProfile: "ubuntu-desktop",
      desktopControlOrigin: "https://canary.hermesos.cloud",
      deployment: { mode: "hivra-managed" },
    }));
    expect(mockGetOrCreatePoolId.mock.invocationCallOrder[0]).toBeLessThan(mockOperationReserve.mock.invocationCallOrder[0]);
    expect(mockOperationReserve.mock.invocationCallOrder[0]).toBeLessThan(mockAgentInsert.mock.invocationCallOrder[0]);
    expect(mockOperationBindAgent).toHaveBeenCalledWith(expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), "agent-1");
    expect(mockOperationAccept).toHaveBeenCalledWith(expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), "agent-1", 201);
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('hivra-provision-on-host.sh "$VMID" "$OCTET" "4" "8192" "linux-desktop"'),
      expect.anything(),
      expect.anything(),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_COMPUTER_ID='agent-1'");
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_CONTROL_ORIGIN='https://canary.hermesos.cloud'");
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_WANT_BROWSER=''");
  });

  it("rejects a staged computer profile before allocating capacity", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "linux-desktop",
      computerProfile: "omarchy",
      name: "OMARCHY COMPUTER",
      cpu: 4,
      ram: 8,
      browser: false,
    }) as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: expect.stringMatching(/prepared Canary computer launch path/i),
    }));
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects Ubuntu computer launch when the installation has no canonical HTTPS desktop ingress", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "linux-desktop",
      name: "WORK COMPUTER",
      cpu: 2,
      ram: 4,
      browser: false,
    }) as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: expect.stringMatching(/canonical HTTPS access and named-tunnel configuration/i),
    }));
    expect(mockLaunchReserve).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("launches Aeon on an exhausted pool (slot-only), pinned to a 0.5 CPU / 512 MB footprint", async () => {
    // Paid plan with 2 slots; the whole CPU/RAM pool is already consumed by a
    // running Claude box. A normal launch would be rejected for lack of pool —
    // Aeon is pool-exempt, so it still launches into the free slot.
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 2,
      total_cpu_budget: 2,
      total_ram_budget: 4096,
      current_period_end: null,
    };
    mockExistingAgents = [{ id: "agent-claude", cpu: 2, ram: 4, status: "running", type: "claude-code" }];

    const response = await POST(makeRequest({
      type: "aeon",
      name: "AEON_AGENT",
      cpu: 8, // ignored — Aeon is pinned to its floor regardless of request
      ram: 16,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "aeon",
      cpu: 0.5,
      ram: 1,
    }));
    // memMb = 1 * 1024 = 1024; 5th positional arg = AGENT_KIND "aeon".
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('hivra-provision-on-host.sh "$VMID" "$OCTET" "1" "1024" "aeon"'),
      expect.anything(),
      expect.anything(),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_WANT_BROWSER='0'");
  });

  it("provisions an OpenClaw box on a paid tier and selects the openclaw runtime (pool-charged, not pinned)", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "openclaw",
      name: "OPENCLAW_AGENT",
      cpu: 1,
      ram: 2,
    }) as never);

    expect(response.status).toBe(201);
    // Not pool-exempt: the requested 1 CPU / 2 GB base is honored, not pinned to a floor.
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "openclaw",
      cpu: 1,
      ram: 2,
    }));
    // memMb = 2 * 1024 = 2048; 5th positional arg = AGENT_KIND "openclaw".
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('hivra-provision-on-host.sh "$VMID" "$OCTET" "1" "2048" "openclaw"'),
      expect.anything(),
      expect.anything(),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_WANT_BROWSER='0'");
  });

  it("provisions an OpenClaw box with the live browser stack on a power tier (+1 CPU / +2 GB)", async () => {
    mockSubscriptionRow = {
      plan: "fleet",
      status: "active",
      instance_limit: 5,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "openclaw",
      name: "OPENCLAW_AGENT",
      cpu: 2,
      ram: 4,
      browser: true,
    }) as never);

    expect(response.status).toBe(201);
    // memMb = 4 * 1024 = 4096; the browser opt-in flows HIVRA_WANT_BROWSER='1'.
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('hivra-provision-on-host.sh "$VMID" "$OCTET" "2" "4096" "openclaw"'),
      expect.anything(),
      expect.anything(),
    );
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_WANT_BROWSER='1'");
  });

  it("mints a managed-Venice key at launch for OpenClaw and threads it into the provisioner env", async () => {
    mockCreateManagedVeniceProxyKey.mockResolvedValueOnce({ id: "key-oc-1", keyPrefix: "hven_live_AB", plaintextKey: "hven_live_TESTKEY123" });
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "openclaw",
      name: "OPENCLAW_AGENT",
      cpu: 2,
      ram: 4,
      managedVenice: true,
      llm: { provider: "venice", mode: "managed", walletType: "hermesos" },
    }) as never);

    expect(response.status).toBe(201);
    expect(mockCreateManagedVeniceProxyKey).toHaveBeenCalledWith(
      expect.objectContaining({ defaultWalletType: "hermesos" }),
    );
    // OpenClaw has no connect step → the minted plaintext key + managed gateway
    // baseUrl + default model ride the SAME generic provisioner env the box uses
    // for any managed-Venice agent (HIVRA_MODEL_*), delivered at launch.
    const provisionScript = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(provisionScript).toContain("HIVRA_MODEL_KEY_B64=");
    expect(provisionScript).toContain("write_secret_b64 'hven_live_TESTKEY123'");
    expect(provisionScript).toContain("HIVRA_MODEL_BASE_URL_B64=");
    expect(provisionScript).toContain("write_secret_b64 'https://hivra.cloud/api/managed-venice/v1'");
    expect(provisionScript).toContain("HIVRA_HERMES_MODEL_B64=");
    expect(provisionScript).toContain("write_secret_b64 'deepseek-v4-pro'");
    const openClawExec = provisionScript.split("\n").find((line) => line.trimStart().startsWith("exec env ")) ?? "";
    expect(openClawExec).not.toContain("hven_live_TESTKEY123");
    expect(mockAgentInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openclaw", managed_venice: true }),
    );
  });

  it("provisions an Agent Zero box on a paid tier and selects the agent-zero runtime (pool-charged, fixed 2/4)", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "agent-zero",
      name: "AGENT_ZERO",
      cpu: 2,
      ram: 4,
    }) as never);

    expect(response.status).toBe(201);
    // Not pool-exempt: the 2 CPU / 4 GB footprint charges the pool.
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "agent-zero",
      cpu: 2,
      ram: 4,
    }));
    // memMb = 4 * 1024 = 4096; 5th positional arg = AGENT_KIND "agent-zero".
    expect(mockRunProxmoxHostScript).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('hivra-provision-on-host.sh "$VMID" "$OCTET" "2" "4096" "agent-zero"'),
      expect.anything(),
      expect.anything(),
    );
    // Agent Zero ships its own in-container browser; the box CDP stack stays off.
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_WANT_BROWSER='0'");
  });

  it("mints a managed-Venice key at launch for Agent Zero and threads it into the provisioner env", async () => {
    mockCreateManagedVeniceProxyKey.mockResolvedValueOnce({ id: "key-az-1", keyPrefix: "hven_live_AZ", plaintextKey: "hven_live_AZKEY123" });
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "agent-zero",
      name: "AGENT_ZERO",
      cpu: 2,
      ram: 4,
      managedVenice: true,
      llm: { provider: "venice", mode: "managed", walletType: "hermesos" },
    }) as never);

    expect(response.status).toBe(201);
    expect(mockCreateManagedVeniceProxyKey).toHaveBeenCalledWith(
      expect.objectContaining({ defaultWalletType: "hermesos" }),
    );
    // Agent Zero has no connect step → the minted key + gateway baseUrl + default
    // model ride the SAME generic HIVRA_MODEL_* provisioner env any managed-Venice
    // agent uses, delivered at launch (the provisioner writes it into /a0/.env).
    const provisionScript = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(provisionScript).toContain("HIVRA_MODEL_KEY_B64=");
    expect(provisionScript).toContain("write_secret_b64 'hven_live_AZKEY123'");
    expect(provisionScript).toContain("HIVRA_MODEL_BASE_URL_B64=");
    expect(provisionScript).toContain("write_secret_b64 'https://hivra.cloud/api/managed-venice/v1'");
    expect(provisionScript).toContain("HIVRA_HERMES_MODEL_B64=");
    expect(provisionScript).toContain("write_secret_b64 'deepseek-v4-pro'");
    const agentZeroExec = provisionScript.split("\n").find((line) => line.trimStart().startsWith("exec env ")) ?? "";
    expect(agentZeroExec).not.toContain("hven_live_AZKEY123");
    expect(mockAgentInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-zero", managed_venice: true }),
    );
  });

  it("persists the managed-Venice opt-in for a supporting agent (Aeon)", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 2,
      total_cpu_budget: 2,
      total_ram_budget: 4096,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "aeon",
      name: "AEON_AGENT",
      managedVenice: true,
    }) as never);

    expect(response.status).toBe(201);
    // Aeon is a connect-flow agent (def.connect:"github") — the managed key is
    // minted during the GitHub connect step, NOT auto-baked at launch. So the
    // opt-in is persisted (managed_venice:true) but NO llm_config block is
    // synthesized here (that would orphan a second managed proxy key).
    expect(mockAgentInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "aeon", managed_venice: true, llm_config: null }),
    );
  });

  it("ignores the managed-Venice opt-in for an agent type without box wiring (Claude Code)", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 2,
      total_cpu_budget: 2,
      total_ram_budget: 4096,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
      managedVenice: true,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "claude-code", managed_venice: false }),
    );
  });

  it("does not count an existing Aeon box against the CPU/RAM pool", async () => {
    // Free pool (0.5 CPU / 1 GB), 2 slots. One Aeon box already exists. A normal
    // Claude launch at the full 0.5/1 must still fit — Aeon's reservation is
    // excluded from pool usage (only its slot counts).
    mockSubscriptionRow = {
      plan: "free",
      status: "active",
      instance_limit: 2,
      total_cpu_budget: 0.5,
      total_ram_budget: 1024,
      current_period_end: null,
    };
    mockExistingAgents = [{ id: "agent-aeon", cpu: 0.5, ram: 0.5, status: "running", type: "aeon" }];

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({ type: "claude-code", cpu: 0.5, ram: 1 }));
  });

  it("uses allocator placement for Claude Code when no dedicated host override is configured", async () => {
    process.env.HIVRA_PROXMOX_HOST = "fixturenode10";

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "claude-code",
      proxmox_host: "fixturenode7",
    }));
    const placementRequest = mockSelectAvailableProxmoxProvisionTarget.mock.calls[0][0];
    expect(placementRequest.forceTargetId).toBeNull();
    expect(placementRequest.skipTemplateAvailabilityCheck).toBe(true);
    expect(mockResolveProxmoxTargetConfiguration).not.toHaveBeenCalledWith(expect.anything(), "fixturenode10");
  });

  it("keeps Claude Code on the user's sticky host when no dedicated host override is configured", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };
    mockExistingAgents = [
      {
        id: "agent-existing",
        type: "claude-code",
        status: "running",
        proxmox_host: "fixturenode5",
        cpu: 0.5,
        ram: 1,
        created_at: "2026-06-08T10:00:00.000Z",
      },
    ];
    mockSelectAvailableProxmoxProvisionTarget.mockResolvedValueOnce({
      ok: true,
      targetId: "fixturenode5",
      env: {
        PROXMOX_NODE: "fixturenode5",
        PROXMOX_VMID_START: "500",
        PROXMOX_VMID_END: "549",
        PROXMOX_IP_LAST_OCTET_START: "50",
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.22",
        PROXMOX_PRIVATE_GATEWAY: "10.250.22.1",
      },
    });
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":500,"ip":"10.250.22.50"}\n',
      })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_ALLOCATION_VERIFIED 500\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "SECOND_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockSelectAvailableProxmoxProvisionTarget).toHaveBeenCalledWith(expect.objectContaining({
      forceTargetId: "fixturenode5",
      skipTemplateAvailabilityCheck: true,
    }));
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "claude-code",
      proxmox_host: "fixturenode5",
    }));
    expect(mockGetReservedProxmoxVmidsForNode).toHaveBeenCalledWith({
      proxmoxNode: "fixturenode5",
      excludeInstanceId: "agent-1",
    });
    expect(mockHivraAgentEqCalls).toContainEqual(["deployment_mode", "hivra-managed"]);
  });

  it("does not use a self-managed rollback sentinel for managed sticky placement", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 4,
      total_cpu_budget: 4,
      total_ram_budget: 8192,
      current_period_end: null,
    };
    mockExistingAgents = [{
      id: "portable-existing",
      type: "codex",
      status: "running",
      deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      cpu: 2,
      ram: 4,
      created_at: "2026-08-26T10:00:00.000Z",
    }];

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "MANAGED_AFTER_PORTABLE",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockSelectAvailableProxmoxProvisionTarget).toHaveBeenCalledWith(
      expect.objectContaining({ forceTargetId: null }),
    );
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      deployment_mode: "hivra-managed",
      proxmox_host: "fixturenode7",
    }));
  });

  it("honors an explicit Claude Code Proxmox host override", async () => {
    process.env.HIVRA_CLAUDE_CODE_PROXMOX_HOST = "fixturenode10";
    mockSelectAvailableProxmoxProvisionTarget.mockResolvedValueOnce({
      ok: true,
      targetId: "fixturenode10",
      env: {
        PROXMOX_NODE: "fixturenode10",
        PROXMOX_VMID_START: "400",
        PROXMOX_VMID_END: "449",
        PROXMOX_IP_LAST_OCTET_START: "90",
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.24",
        PROXMOX_PRIVATE_GATEWAY: "10.250.24.1",
      },
    });
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":400,"ip":"10.250.24.90"}\n',
      })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_ALLOCATION_VERIFIED 400\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockSelectAvailableProxmoxProvisionTarget).toHaveBeenCalledWith(expect.objectContaining({
      forceTargetId: "fixturenode10",
      skipTemplateAvailabilityCheck: true,
    }));
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "claude-code",
      proxmox_host: "fixturenode10",
    }));
  });

  it("ignores disabled Claude Code host override values and falls back to allocator placement", async () => {
    process.env.HIVRA_CLAUDE_CODE_PROXMOX_HOST = "auto";

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockSelectAvailableProxmoxProvisionTarget).toHaveBeenCalledWith(expect.objectContaining({
      forceTargetId: null,
      skipTemplateAvailabilityCheck: true,
    }));
  });

  it("passes DB-reserved VMIDs into the Hivra phase-1 picker", async () => {
    mockGetReservedProxmoxVmidsForNode.mockResolvedValueOnce([200, 201]);

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockGetReservedProxmoxVmidsForNode).toHaveBeenCalledWith({
      proxmoxNode: "fixturenode7",
      excludeInstanceId: "agent-1",
    });
    const kickoffScript = mockRunProxmoxHostScript.mock.calls[0][0] as string;
    expect(kickoffScript).toContain("RESERVED_VMIDS='200\n201'");
    expect(kickoffScript).toContain('if [ -n "$RESERVED_VMIDS" ]; then');
  });

  it("rejects browser automation on the free pool before provisioning", async () => {
    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 1.5,
      ram: 3,
      browser: true,
    }) as never);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/browser automation requires a paid plan/i);
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects free launches above the remaining pool before provisioning", async () => {
    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 2,
      ram: 4,
      browser: false,
    }) as never);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/only has 0.5 CPU \/ 1 GB free/i);
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("does not count failed Hivra deployments against pool resources or agent slots", async () => {
    mockExistingAgents = [
      {
        id: "agent-failed",
        type: "claude-code",
        status: "error",
        proxmox_host: "fixturenode21",
        cpu: 0.5,
        ram: 1,
      },
    ];

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
      browser: false,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "claude-code",
      cpu: 0.5,
      ram: 1,
    }));
  });

  it("allows paid browser launches when the pool has enough remaining resources", async () => {
    mockSubscriptionRow = {
      plan: "operator",
      status: "active",
      instance_limit: 3,
      total_cpu_budget: 2,
      total_ram_budget: 4096,
      current_period_end: null,
    };

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 2,
      ram: 4,
      browser: true,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({
      type: "claude-code",
      cpu: 2,
      ram: 4,
    }));
    expect(mockRunProxmoxHostScript.mock.calls[0][0]).toContain("HIVRA_WANT_BROWSER='1'");
  });

  it.each([true, false])("never allocates a VM after a tunnel journal failure (compensated=%s)", async (cleanupVerified) => {
    mockTunnelConfigured = true;
    mockCreateBoxTunnel.mockRejectedValue(new BoxTunnelProvisionError(cleanupVerified));
    const response = await POST(makeRequest({ type: "claude-code", cpu: 0.5, ram: 1 }) as never);
    expect(response.status).toBe(502);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    if (cleanupVerified) {
      expect(mockFailHivraAgentBeforeAllocation).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("No VM was allocated") }));
      expect(mockRecordHivraAgentOperationFailure).not.toHaveBeenCalled();
    } else {
      expect(mockRecordHivraAgentOperationFailure).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("recorded tunnel identity") }));
      expect(mockReleaseHivraAgentOperation).not.toHaveBeenCalled();
    }
    expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({ operation_payload: { stage: "pre_allocation_access" } }));
    expect(mockBeginHivraAgentVmAllocation).not.toHaveBeenCalled();
  });

  it("replays accepted 202 after a native Codex row survives later access failure", async () => {
    mockTunnelConfigured = true;
    mockCreateBoxTunnel.mockRejectedValue(new BoxTunnelProvisionError(false));
    const request = { type: "codex", name: "RECOVERABLE_CODEX", cpu: 0.5, ram: 1 };
    const first = await POST(makeRequest(request) as never);
    expect(first.status).toBe(502);
    expect(mockOperationAccept).toHaveBeenCalledTimes(1);
    expect(mockOperationAccept).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: LAUNCH_REQUEST_ID }), "agent-1", 202,
    );

    mockOperationLookup.mockResolvedValue({ existing: {
      state: "accepted", requestId: LAUNCH_REQUEST_ID, phase: "accepted", responseStatus: 202,
      agent: { id: "agent-1", user_id: "user-free", type: "codex", computer_profile: null, status: "error" },
    } });
    const replay = await POST(makeRequest(request) as never);
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toEqual(expect.objectContaining({ data: expect.objectContaining({
      agent: expect.objectContaining({ id: "agent-1", status: "error" }),
      launch: { state: "accepted", phase: "accepted" },
    }) }));
    expect(mockAgentInsert).toHaveBeenCalledTimes(1);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it.each([true, false])("revokes the minted managed key after tunnel failure (compensated=%s)", async (cleanupVerified) => {
    mockTunnelConfigured = true;
    mockSubscriptionRow = { plan: "operator", status: "active", instance_limit: 4, total_cpu_budget: 4, total_ram_budget: 8192 };
    mockCreateManagedVeniceProxyKey.mockResolvedValueOnce({ id: "key-setup", keyPrefix: "test", plaintextKey: "test-key" });
    mockCreateBoxTunnel.mockRejectedValue(new BoxTunnelProvisionError(cleanupVerified));
    const response = await POST(makeRequest({ type: "openclaw", cpu: 2, ram: 4, managedVenice: true, llm: { provider: "venice", mode: "managed", walletType: "hermesos" } }) as never);
    expect(response.status).toBe(502);
    expect(mockRevokeManagedVeniceProxyKey).toHaveBeenCalledWith({ userId: "user-free", keyId: "key-setup" });
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    if (cleanupVerified) expect(mockRevokeManagedVeniceProxyKey.mock.invocationCallOrder[0]).toBeLessThan(mockFailHivraAgentBeforeAllocation.mock.invocationCallOrder[0]);
    else expect(mockFailHivraAgentBeforeAllocation).not.toHaveBeenCalled();
  });

  it("retains the lease and access stage if managed key revocation is unverified", async () => {
    mockTunnelConfigured = true;
    mockSubscriptionRow = { plan: "operator", status: "active", instance_limit: 4, total_cpu_budget: 4, total_ram_budget: 8192 };
    mockCreateManagedVeniceProxyKey.mockResolvedValueOnce({ id: "key-setup", keyPrefix: "test", plaintextKey: "test-key" });
    mockCreateBoxTunnel.mockRejectedValue(new BoxTunnelProvisionError(true));
    mockRevokeManagedVeniceProxyKey.mockRejectedValue(new Error("DB unavailable"));
    const response = await POST(makeRequest({ type: "openclaw", cpu: 2, ram: 4, managedVenice: true, llm: { provider: "venice", mode: "managed", walletType: "hermesos" } }) as never);
    expect(response.status).toBe(502);
    expect(mockRecordHivraAgentOperationFailure).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("Managed API key cleanup is unverified") }));
    expect(mockFailHivraAgentBeforeAllocation).not.toHaveBeenCalled();
    expect(mockReleaseHivraAgentOperation).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("finalizes cancellation after tunnel compensation instead of releasing the provision lease", async () => {
    mockTunnelConfigured = true;
    mockCreateBoxTunnel.mockRejectedValue(new BoxTunnelProvisionError(true));
    mockFailHivraAgentBeforeAllocation.mockResolvedValue(false);
    const response = await POST(makeRequest({ type: "claude-code", cpu: 0.5, ram: 1 }) as never);
    expect(response.status).toBe(409);
    expect(mockCompleteHivraAgentDelete).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-1", userId: "user-free" }));
    expect(mockReleaseHivraAgentOperation).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("retains cancelled launch authority when its no-VM finalizer cannot complete", async () => {
    mockBeginHivraAgentVmAllocation.mockResolvedValue(false);
    mockCompleteHivraAgentDelete.mockResolvedValue(false);
    const response = await POST(makeRequest({ type: "claude-code", cpu: 0.5, ram: 1 }) as never);
    expect(response.status).toBe(409);
    expect(mockRecordHivraAgentOperationFailure).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("Delete cancellation could not be finalized") }));
    expect(mockReleaseHivraAgentOperation).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("does not allocate a VM after an uncertain access-stage transition", async () => {
    mockBeginHivraAgentVmAllocation.mockRejectedValueOnce(new Error("Database response unavailable"));
    const response = await POST(makeRequest({ type: "claude-code", cpu: 0.5, ram: 1 }) as never);
    expect(response.status).toBe(500);
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockReleaseHivraAgentOperation).not.toHaveBeenCalled();
  });

  it("removes an allocated VM when the mandatory CPU cap cannot be applied", async () => {
    // Tunnel configured: the cpu-limit failure path must release both the new
    // VM and named tunnel (error rows never reach the ordinary DELETE flow).
    mockTunnelConfigured = true;
    mockCreateBoxTunnel.mockResolvedValue({
      tunnelId: "tun-1",
      token: "run-token",
      hostname: "box-agent1.hermesos.cloud",
      url: "https://box-agent1.hermesos.cloud",
      dnsRecordId: "dns-1",
    });
    mockSelectAvailableProxmoxProvisionTarget.mockResolvedValueOnce({
      ok: true,
      targetId: "fixturenode7",
      env: {
        PROXMOX_NODE: "fixturenode7",
        PROXMOX_STORAGE: "historical-storage-that-must-not-win",
        PROXMOX_VMID_START: "200",
        PROXMOX_VMID_END: "249",
        PROXMOX_IP_LAST_OCTET_START: "50",
        PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.21",
        PROXMOX_PRIVATE_GATEWAY: "10.250.21.1",
      },
    });
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.250.21.50"}\n',
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "cpu limit apply failed",
        stderr: "qm set failed",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "HIVRA_VM_ROLLBACK_OK 200\n",
      });

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(502);
    expect(mockPersistHivraAgentProvisionIdentity).toHaveBeenCalledWith(expect.objectContaining({
      vmid: 200,
      ip: "10.250.21.50",
    }));
    expect(mockReleaseHivraAgentOperation).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining("cpu limit apply failed"),
      markError: true,
    }));
    expect(mockRunProxmoxHostScript.mock.calls[2][0]).toContain("HIVRA_VM_ROLLBACK_OK");
    expect(mockRunProxmoxHostScript.mock.calls[2][0]).toContain("STORAGE='local-lvm'");
    expect(mockRunProxmoxHostScript.mock.calls[2][0]).not.toContain(
      "historical-storage-that-must-not-win",
    );
    expect(mockDeleteBoxTunnel).toHaveBeenCalledWith({
      tunnelId: "tun-1",
      hostname: "box-agent1.hermesos.cloud",
    });
  });

  it("retains the box tunnel and provision lease when kickoff transport fails ambiguously", async () => {
    mockTunnelConfigured = true;
    mockCreateBoxTunnel.mockResolvedValue({
      tunnelId: "tun-kickoff",
      token: "run-token",
      hostname: "box-kickoff.hermesos.cloud",
      url: "https://box-kickoff.hermesos.cloud",
      dnsRecordId: "dns-1",
    });
    mockRunProxmoxHostScript
      .mockReset()
      .mockResolvedValueOnce({ ok: false, error: "ssh failed", stdout: "", stderr: "" });

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(502);
    expect(mockAgentUpdates).not.toContainEqual(expect.objectContaining({ status: "error" }));
    expect(mockRecordHivraAgentOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-1",
      error: "ssh failed",
    }));
    expect(mockReleaseHivraAgentOperation).not.toHaveBeenCalled();
    expect(mockDeleteBoxTunnel).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "", apiKey: "synthetic-launch-key" },
    { provider: "venice", mode: "byok", apiKey: "short" },
    { provider: "venice", mode: "byok", apiKey: "synthetic\nlaunch-key" },
    { provider: "venice", mode: "managed", walletType: "invalid-wallet" },
    { provider: "venice", mode: "managed", apiKey: "synthetic-launch-key" },
  ])("rejects malformed model input before any allocation or credit key on either destination: %j", async llm => {
    for (const deployment of [{ mode: "hivra-managed" }, SELF_MANAGED_DEPLOYMENT]) {
      const response = await POST(makeRequest({ type: "codex", name: "VALIDATION_FIXTURE", cpu: 2, ram: 4, llm, deployment }) as never);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("synthetic-launch-key");
    }
    expect(mockCreateManagedVeniceProxyKey).not.toHaveBeenCalled();
    expect(mockAgentInsert).not.toHaveBeenCalled();
    expect(mockCreateBoxTunnel).not.toHaveBeenCalled();
    expect(mockRunProxmoxHostScript).not.toHaveBeenCalled();
    expect(mockLaunchProviderAgent).not.toHaveBeenCalled();
    expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
  });

  describe("agent-run reporting credential", () => {
    const AGENT_ID = "00000000-0000-4000-8000-000a00000006";
    const originalSigningSecret = process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET;
    let consoleSpies: jest.SpyInstance[] = [];

    beforeEach(() => {
      mockInsertedAgentId = AGENT_ID;
      process.env.NEXT_PUBLIC_APP_URL = "https://canary.example.test";
      process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET = "fixture-activity-signing-secret-0123456789";
      consoleSpies = (["log", "info", "warn", "error"] as const)
        .map(method => jest.spyOn(console, method).mockImplementation(() => undefined));
      mockSubscriptionRow = {
        plan: "operator", status: "active", instance_limit: 4,
        total_cpu_budget: 4, total_ram_budget: 8192, current_period_end: null,
      };
      // A current host bundle: phase 1 staged the credential it was handed.
      mockRunProxmoxHostScript.mockReset()
        .mockImplementationOnce(async (body: string) => ({
          ok: true,
          stdout: `${body.includes("HIVRA_ACTIVITY_STAGE=1") ? "HIVRA_ACTIVITY_CREDENTIAL_STAGED\n" : ""}HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.250.21.50"}\n`,
        }))
        .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
        .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
    });
    afterEach(() => {
      consoleSpies.forEach(spy => spy.mockRestore());
      if (originalSigningSecret === undefined) delete process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET;
      else process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET = originalSigningSecret;
    });

    const consoleOutput = () => consoleSpies.flatMap(spy => spy.mock.calls.map(args => args.map(String).join(" "))).join("\n");
    function kickoffScript(): string {
      const script = mockRunProxmoxHostScript.mock.calls
        .map(([body]) => String(body))
        .find(body => body.includes("/hivra-provision-on-host.sh"));
      expect(script).toBeDefined();
      return script as string;
    }
    // The shellQuote'd value phase 1 may write into the root-only secret
    // handoff file (only after its bundle probe passes).
    function handedOffTelemetry(script: string): string {
      const match = script.match(/printf 'HIVRA_ACTIVITY_TELEMETRY_B64='; (?:if \[ "\$HIVRA_ACTIVITY_STAGE" = 1 \]; then )?write_secret_b64 '([^'\n]*)'(?:; else printf '\\n'; fi)?\n/);
      expect(match).not.toBeNull();
      return match?.[1] ?? "";
    }
    // Run phase 1's real probe + handoff fragment against a host bundle
    // directory, with only root-owned paths and GNU-only flags shimmed.
    function stageOnBundle(script: string, provisionerDirectory: string, bundle: string) {
      const start = script.indexOf("HIVRA_ACTIVITY_STAGE=0");
      const endMarker = 'if [ "$HIVRA_ACTIVITY_STAGE" = 1 ]; then echo HIVRA_ACTIVITY_CREDENTIAL_STAGED; fi\n';
      const end = script.indexOf(endMarker);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const fragment = script.slice(start, end + endMarker.length)
        .split(`'${provisionerDirectory}/`).join(`'${bundle}/`);
      expect(fragment).not.toContain(provisionerDirectory);
      const work = mkdtempSync(nodePath.join(tmpdir(), "hivra-launch-activity-"));
      try {
        const secretFile = nodePath.join(work, "200.env");
        const run = spawnSync("bash", ["-c", `set -euo pipefail
install() { : > "\${@: -1}"; chmod 600 "\${@: -1}"; }
base64() { [ "\${1:-}" != -w ] || shift 2; command base64 "$@" | tr -d '\\n'; }
SECRET_ENV_FILE="$1"
${fragment}`, "phase1", secretFile], { encoding: "utf8" });
        const handoff = readFixtureFile(secretFile, "utf8");
        const line = handoff.split("\n").find(entry => entry.startsWith("HIVRA_ACTIVITY_TELEMETRY_B64=")) ?? "";
        return {
          status: run.status,
          stdout: run.stdout,
          stderr: run.stderr,
          handoffKeyPresent: handoff.split("\n").some(entry => entry.startsWith("HIVRA_ACTIVITY_TELEMETRY_B64=")),
          credential: Buffer.from(line.slice("HIVRA_ACTIVITY_TELEMETRY_B64=".length), "base64").toString("utf8"),
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
    function bundleFixture(files: Record<string, string>): string {
      const bundle = mkdtempSync(nodePath.join(tmpdir(), "hivra-launch-bundle-"));
      for (const [name, content] of Object.entries(files)) writeFileSync(nodePath.join(bundle, name), content);
      return bundle;
    }

    it.each([["claude-code", "claude"], ["codex", "codex"]])(
      "hands a %s launch a credential scoped to exactly its computer, only through the secret handoff",
      async (type, kind) => {
        const response = await POST(makeRequest({ type, name: "TRACED", cpu: 2, ram: 4 }) as never);

        expect(response.status).toBe(201);
        const script = kickoffScript();
        expect(script).toContain(`hivra-provision-on-host.sh "$VMID" "$OCTET" "2" "4096" "${kind}"`);
        const credential = JSON.parse(handedOffTelemetry(script));
        expect(Object.keys(credential)).toEqual(["endpoint", "resourceId", "token", "expiresAt"]);
        expect(credential).toMatchObject({ endpoint: "https://canary.example.test/api/activity/ingest", resourceId: AGENT_ID });
        const claims = verifyActivityCollectorToken(`Bearer ${credential.token}`);
        expect(claims).toEqual({ v: 1, userId: "user-free", resourceIds: [AGENT_ID], iat: expect.any(Number), exp: expect.any(Number) });
        expect(claims!.exp - claims!.iat).toBe(ACTIVITY_COLLECTOR_TTL_SECONDS);
        expect(new Date(credential.expiresAt).getTime()).toBe(claims!.exp * 1000);

        // Exactly once, in the 0600 handoff file: never the managed exec line
        // (argv/env of the host provisioner), the SSH environment, another
        // host script, the collector row, the response, or a log line.
        const managedExec = script.split("\n").find(line => line.trimStart().startsWith("exec env ")) ?? "";
        expect(managedExec).toContain("hivra-provision-on-host.sh");
        expect(managedExec).not.toMatch(/HIVRA_(?:TUNNEL_TOKEN|MODEL_KEY|MODEL_BASE_URL|HERMES_MODEL|ACTIVITY_TELEMETRY)=/);
        expect(script.split(credential.token)).toHaveLength(2);
        expect(script).toContain('export HIVRA_ACTIVITY_TELEMETRY="$(read_secret_b64 HIVRA_ACTIVITY_TELEMETRY_B64)"');
        for (const [body, env] of mockRunProxmoxHostScript.mock.calls) {
          expect(JSON.stringify(env ?? {})).not.toContain("hvra_otlp_v1");
          if (body !== script) expect(String(body)).not.toContain("hvra_otlp_v1");
        }
        expect(mockCollectorUpsert).toHaveBeenCalledTimes(1);
        expect(mockCollectorUpsert).toHaveBeenCalledWith(expect.objectContaining({
          agent_id: AGENT_ID, user_id: "user-free", issue_reason: "launch", credential_expires_at: credential.expiresAt,
        }), { onConflict: "agent_id" });
        expect(JSON.stringify(mockCollectorUpsert.mock.calls)).not.toContain("hvra_otlp_v1");
        expect(JSON.stringify(await response.json())).not.toContain("hvra_otlp_v1");
        expect(consoleOutput()).not.toContain("hvra_otlp_v1");
      },
    );

    it.each(["aeon", "openclaw", "agent-zero"])("hands %s no credential and records no issuance", async type => {
      const response = await POST(makeRequest({ type, name: "UNTRACED", cpu: 2, ram: 4 }) as never);

      expect(response.status).toBe(201);
      expect(handedOffTelemetry(kickoffScript())).toBe("");
      expect(mockCollectorUpsert).not.toHaveBeenCalled();
      expect(consoleOutput()).not.toContain("hivra_activity_collector_unavailable");
    });

    it("hands no credential in local-auth mode, where guests cannot reach ingest", async () => {
      mockLocalAuthMode = true;
      const response = await POST(makeRequest({ type: "claude-code", name: "LOCAL", cpu: 2, ram: 4 }) as never);

      expect(response.status).toBe(201);
      expect(handedOffTelemetry(kickoffScript())).toBe("");
      expect(mockCollectorUpsert).not.toHaveBeenCalled();
    });

    it.each([
      ["no signing secret", () => { delete process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET; }],
      ["a short signing secret", () => { process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET = "too-short"; }],
      ["no public origin", () => { process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; }],
    ])("still launches with %s, without a credential and with a structured warning", async (_label, arrange) => {
      arrange();
      const response = await POST(makeRequest({ type: "codex", name: "UNSIGNED", cpu: 2, ram: 4 }) as never);

      expect(response.status).toBe(201);
      expect(handedOffTelemetry(kickoffScript())).toBe("");
      expect(mockCollectorUpsert).not.toHaveBeenCalled();
      expect(consoleOutput()).toContain("hivra_activity_collector_unavailable");
    });

    it("launches when recording the issuance fails and logs it without the credential", async () => {
      mockCollectorUpsert.mockResolvedValueOnce({ error: { message: "fixture outage" } });
      const response = await POST(makeRequest({ type: "claude-code", name: "UNRECORDED", cpu: 2, ram: 4 }) as never);

      expect(response.status).toBe(201);
      expect(handedOffTelemetry(kickoffScript())).not.toBe("");
      expect(consoleOutput()).toContain("hivra_activity_collector_record_failed");
      expect(consoleOutput()).not.toContain("hvra_otlp_v1");
    });

    it("records no issuance when the managed default host bundle did not stage the credential", async () => {
      // Regression: admission still accepts predecessor bundles (for example
      // 2026.09.15.2) that silently drop the credential. Recording it anyway
      // produced a false "credential expired, restart to fix" alert on day 7.
      mockRunProxmoxHostScript.mockReset()
        .mockResolvedValueOnce({ ok: true, stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.250.21.50"}\n' })
        .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
        .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
      const response = await POST(makeRequest({ type: "claude-code", name: "OLD_DEFAULT", cpu: 2, ram: 4 }) as never);

      expect(response.status).toBe(201);
      expect(handedOffTelemetry(kickoffScript())).not.toBe("");
      expect(mockCollectorUpsert).not.toHaveBeenCalled();
      expect(consoleOutput()).toContain("hivra_activity_collector_not_staged");
      expect(consoleOutput()).not.toContain("hvra_otlp_v1");
    });

    it("stages the credential only on a host bundle that consumes and reports it end to end", async () => {
      const response = await POST(makeRequest({ type: "codex", name: "PROBED", cpu: 2, ram: 4 }) as never);
      expect(response.status).toBe(201);
      const script = kickoffScript();
      const provisionerDirectory = script.match(/HIVRA_PROV_DIR='([^']+)'/)?.[1] ?? "";
      expect(provisionerDirectory).not.toBe("");
      const handed = handedOffTelemetry(script);

      // The bundle this release ships satisfies the probe.
      const current = stageOnBundle(script, provisionerDirectory, nodePath.join(process.cwd(), "provisioner"));
      expect({ status: current.status, stdout: current.stdout, stderr: current.stderr })
        .toEqual({ status: 0, stdout: "HIVRA_ACTIVITY_CREDENTIAL_STAGED\n", stderr: "" });
      expect(current.credential).toBe(handed);

      const newHost = "read_optional_secret_b64 HIVRA_ACTIVITY_TELEMETRY_B64\n";
      const newInstaller = 'line = "HIVRA_ACTIVITY_COLLECTOR status=installed"\n';
      const cases: Array<[string, Record<string, string>]> = [
        ["a predecessor bundle without reporting", {
          "hivra-provision-on-host.sh": "guest_launch_document\n", "hivra-install-agent.py": "KINDS = set()\n" }],
        ["a host script that ignores the credential", {
          "hivra-provision-on-host.sh": "guest_launch_document\n", "hivra-install-agent.py": newInstaller,
          "hivra-agent-trace.py": "", "hivra-agent-trace.service": "" }],
        ["a fail-closed installer that reports no install status", {
          "hivra-provision-on-host.sh": newHost, "hivra-install-agent.py": "install_activity_reporter(launch, source)\n",
          "hivra-agent-trace.py": "", "hivra-agent-trace.service": "" }],
        ["a bundle missing the reporter sources", {
          "hivra-provision-on-host.sh": newHost, "hivra-install-agent.py": newInstaller }],
      ];
      for (const [label, files] of cases) {
        const bundle = bundleFixture(files);
        try {
          const staged = stageOnBundle(script, provisionerDirectory, bundle);
          expect({ label, status: staged.status, stdout: staged.stdout, key: staged.handoffKeyPresent, credential: staged.credential })
            .toEqual({ label, status: 0, stdout: "", key: true, credential: "" });
        } finally {
          rmSync(bundle, { recursive: true, force: true });
        }
      }
    });

    it("hands no credential to a self-managed bundle that predates the reporter", async () => {
      mockResolveSelfManagedProxmoxExecutionContext.mockResolvedValue(
        selfManagedExecutionContext({ provisionerVersion: "2026.09.08.3" }),
      );
      mockRunProxmoxHostScript.mockReset()
        .mockResolvedValueOnce({ ok: true, stdout: 'HIVRA_PROVISION_RESULT {"vmid":200,"ip":"10.251.20.50"}\n' })
        .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_ALLOCATION_VERIFIED 200\n" })
        .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
      const response = await POST(makeRequest({
        type: "codex", name: "OLD_BUNDLE", cpu: 2, ram: 4, deployment: SELF_MANAGED_DEPLOYMENT,
      }) as never);

      expect(response.status).toBe(201);
      const script = kickoffScript();
      expect(handedOffTelemetry(script)).toBe("");
      // The portable host script reads the handoff file itself; the key is
      // always present (empty here) and never on the detached command line.
      const portableKickoff = script.split("\n").find(line => line.startsWith("nohup env ")) ?? "";
      expect(portableKickoff).toContain('HIVRA_SECRET_ENV_FILE="$SECRET_ENV_FILE"');
      expect(portableKickoff).not.toContain("ACTIVITY");
      expect(mockCollectorUpsert).not.toHaveBeenCalled();
    });

    it("issues to a pinned current bundle exactly when that release ships the reporter", async () => {
      // Self-managed evidence and the managed Canary channel both pin the
      // current release; the managed default fleet is covered above.
      const expected = provisionerSupportsActivityTelemetry(PORTABLE_HIVRA_PROVISIONER_VERSION);
      // The pinned host runs the same bundle probe; it prints the staged
      // marker only when the probe passed, and only then is issuance recorded.
      const phase1 = (ip: string) => async (body: string) => ({
        ok: true,
        stdout: `${body.includes("HIVRA_ACTIVITY_STAGE=1") ? "HIVRA_ACTIVITY_CREDENTIAL_STAGED\n" : ""}HIVRA_PROVISION_RESULT {"vmid":200,"ip":"${ip}"}\n`,
      });
      mockRunProxmoxHostScript.mockReset()
        .mockImplementationOnce(phase1("10.251.20.50"))
        .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_ALLOCATION_VERIFIED 200\n" })
        .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
      const selfManaged = await POST(makeRequest({
        type: "codex", name: "CURRENT_BUNDLE", cpu: 2, ram: 4, deployment: SELF_MANAGED_DEPLOYMENT,
      }) as never);
      expect(selfManaged.status).toBe(201);
      expect(handedOffTelemetry(kickoffScript()) !== "").toBe(expected);
      expect(mockCollectorUpsert).toHaveBeenCalledTimes(expected ? 1 : 0);

      process.env.VERCEL_TARGET_ENV = "canary";
      mockRunProxmoxHostScript.mockReset()
        .mockImplementationOnce(phase1("10.250.21.50"))
        .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
        .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
      const canary = await POST(makeRequest({ type: "claude-code", name: "CANARY", cpu: 2, ram: 4 }) as never);
      expect(canary.status).toBe(201);
      expect(kickoffScript()).toContain("/root/hivra-provisioner-canary");
      expect(handedOffTelemetry(kickoffScript()) !== "").toBe(expected);
      expect(mockCollectorUpsert).toHaveBeenCalledTimes(expected ? 2 : 0);
      for (const [row] of mockCollectorUpsert.mock.calls) expect(row).toMatchObject({ agent_id: AGENT_ID, issue_reason: "launch" });
    });
  });

  describe("launch request boundary", () => {
    const noAllocation = () => {
      expect(mockAgentInsert).not.toHaveBeenCalled(); expect(mockCreateManagedVeniceProxyKey).not.toHaveBeenCalled();
      expect(mockRunProxmoxHostScript).not.toHaveBeenCalled(); expect(mockLaunchProviderAgent).not.toHaveBeenCalled();
      expect(mockGetInfrastructureTarget).not.toHaveBeenCalled(); expect(mockSelectAvailableProxmoxProvisionTarget).not.toHaveBeenCalled();
    };
    it.each(["foreign", "missing-origin", "cross-site", "missing-fetch-site"])("rejects %s before reading or allocating", async mode => {
      const request = makeRequest({ type: "codex", llm: { provider: "venice", mode: "byok", apiKey: "synthetic-key" } });
      if (mode === "foreign") request.headers.set("Origin", "https://foreign.example");
      if (mode === "missing-origin") request.headers.delete("Origin");
      if (mode === "cross-site") request.headers.set("Sec-Fetch-Site", "cross-site");
      if (mode === "missing-fetch-site") request.headers.delete("Sec-Fetch-Site");
      const response = await POST(request);
      expect(response.status).toBe(403); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(request.bodyUsed).toBe(false); noAllocation();
    });
    it.each(["text/plain", "application/json; charset=utf-8", ""])("requires exact JSON content type: %s", async contentType => {
      const request = makeRequest({ type: "codex" }); request.headers.set("Content-Type", contentType);
      const response = await POST(request);
      expect(response.status).toBe(415); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(request.bodyUsed).toBe(false); noAllocation();
    });
    it.each(["{", "null", "[]", "true", '"string"'])("rejects invalid JSON/envelope %s without fallback launch", async body => {
      const request = new NextRequest("https://hivra.cloud/api/hivra/agents", { method: "POST", headers: makeRequest({}).headers, body });
      const response = await POST(request);
      expect(response.status).toBe(400); expect(response.headers.get("Cache-Control")).toBe("no-store"); noAllocation();
    });
    it("rejects an oversized streamed body even without Content-Length", async () => {
      const request = makeRequest({ context: "x".repeat(40_000) });
      const response = await POST(request);
      expect(response.status).toBe(413); noAllocation();
    });
    it("rejects an oversized declared body before consuming it", async () => {
      const request = makeRequest({}); request.headers.set("Content-Length", "40000");
      const response = await POST(request);
      expect(response.status).toBe(413); expect(request.bodyUsed).toBe(false); noAllocation();
    });
    it("rate limits before body parsing, including the original managed launch", async () => {
      mockLaunchRateLimit.mockReturnValue(new Response("{}", { status: 429 }));
      const request = makeRequest({ type: "codex" }), response = await POST(request);
      expect(response.status).toBe(429); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(request.bodyUsed).toBe(false); noAllocation();
      expect(mockLaunchRateLimit).toHaveBeenCalledWith(request, expect.objectContaining({ userId: "user-free", routeKey: "hivra_agent_launch" }));
    });
    it("ends a stalled body after its bounded read window", async () => {
      jest.useFakeTimers(); const cancel = jest.fn();
      try {
        const request = new NextRequest("https://hivra.cloud/api/hivra/agents", {
          method: "POST", headers: makeRequest({}).headers, body: new ReadableStream({ cancel }), duplex: "half",
        } as never);
        const pending = POST(request);
        await jest.advanceTimersByTimeAsync(5100);
        const response = await pending;
        expect(response.status).toBe(400); expect(cancel).toHaveBeenCalled(); noAllocation();
      } finally { jest.useRealTimers(); }
    });
    it("keeps authentication failures non-cacheable without parsing the body", async () => {
      mockAuth.mockResolvedValue({ userId: null });
      const request = makeRequest({}), response = await POST(request);
      expect(response.status).toBe(401); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(request.bodyUsed).toBe(false); noAllocation();
    });
  });

  it("does not touch tunnel teardown on a successful provision", async () => {
    mockTunnelConfigured = true;
    mockCreateBoxTunnel.mockResolvedValue({
      tunnelId: "tun-ok",
      token: "run-token",
      hostname: "box-ok.hermesos.cloud",
      url: "https://box-ok.hermesos.cloud",
      dnsRecordId: "dns-1",
    });

    const response = await POST(makeRequest({
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      cpu: 0.5,
      ram: 1,
    }) as never);

    expect(response.status).toBe(201);
    expect(mockDeleteBoxTunnel).not.toHaveBeenCalled();
  });

  // box_created (hivra lane): the server-side funnel event mirrors the Hermes
  // lane's #353 fix — exactly once per agent id, attributed to the Clerk user.
  it("emits box_created once per agent id and dedupes a re-emit in the same process", async () => {
    // Fresh module → fresh process-lifetime once-guard Set, so this test does
    // not depend on which earlier test in this file first consumed "agent-1"
    // (the insert mock returns a fixed id for every successful launch).
    let isolatedPost!: typeof POST;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      isolatedPost = require("../route").POST;
    });
    const launch = () =>
      isolatedPost(makeRequest({
        type: "codex",
        name: "TELEMETRY_AGENT",
        cpu: 0.5,
        ram: 1,
        browser: false,
      }) as never);

    const first = await launch();
    expect(first.status).toBe(201);
    const boxCreatedCalls = mockPosthogCapture.mock.calls.filter(
      ([payload]) => payload?.event === "box_created"
    );
    expect(boxCreatedCalls).toHaveLength(1);
    const [payload] = boxCreatedCalls[0];
    // Clerk user id as distinctId — merges onto the person the client identifies.
    expect(payload.distinctId).toBe("user-free");
    expect(payload.properties.lane).toBe("hivra");
    expect(payload.properties.agent_type).toBe("codex");
    expect(payload.properties.instance_id).toBe("agent-1");
    expect(payload.properties.$insert_id).toBe("box_created_agent-1");
    expect(payload.properties.$set_once).toEqual({ hermes_user_id: "user-free" });
    expect(mockPosthogFlush).toHaveBeenCalled();

    // The same agent id reaching the emit again in a warm process must not
    // re-emit (retries / duplicate POSTs — the #353 over-fire vector).
    // beforeEach arms runProxmoxHostScript with exactly one launch's worth of
    // mockResolvedValueOnce results — re-arm for the second launch.
    mockRunProxmoxHostScript
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'HIVRA_PROVISION_RESULT {"vmid":201,"ip":"10.250.21.51"}\n',
      })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu limit set\n" })
      .mockResolvedValueOnce({ ok: true, stdout: "cpu units set\n" });
    const second = await launch();
    expect(second.status).toBe(201);
    expect(
      mockPosthogCapture.mock.calls.filter(([p]) => p?.event === "box_created")
    ).toHaveLength(1);
  });
});

describe("GET /api/hivra/agents", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistingAgents = [];
    mockAuth.mockResolvedValue({ userId: "user-free" });
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table !== "hivra_agents") throw new Error(`Unexpected table ${table}`);
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        order: jest.fn(async () => ({
          data: mockExistingAgents,
          error: null,
        })),
      };
    });
  });

  it("hides failed deployments from the active agent list", async () => {
    mockExistingAgents = [
      {
        id: "agent-failed",
        type: "claude-code",
        name: "FAILED_AGENT",
        status: "error",
        cpu: 2,
        ram: 4,
      },
      {
        id: "agent-running",
        type: "claude-code",
        name: "RUNNING_AGENT",
        status: "running",
        cpu: 2,
        ram: 4,
      },
    ];

    const response = await GET(makeGetRequest() as never);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.data.agents).toEqual([
      expect.objectContaining({ id: "agent-running", status: "running" }),
    ]);
  });
});
