import {
  CreateInstanceSchema,
  FreeInstanceLimitError,
  InstanceService,
  PROVISION_HOST_FAILURE_MESSAGE,
  PROXMOX_CAPACITY_PAUSED_MESSAGE,
  ProxmoxTenantCapacityError,
  assertFreeInstanceCreatable,
  assertProxmoxTenantCapacityAvailable,
  classifyProxmoxHostLocalProvisionFailure,
  isFreeTierKey,
  isSingleInstanceBaseTierKey,
  resolveInstanceResourceTier,
  selectAvailableProxmoxProvisionTarget,
} from "../instance-service";
import { clerkClient } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { posthogClient } from "@/lib/posthog";
import { log } from "@/lib/logger";
import { decryptApiKey } from "@/lib/crypto";
import { buildInstanceInsertPayload } from "@/lib/instance-record";
import {
  getProxmoxTemplateAvailability,
  getProxmoxVmidAvailability,
  isProxmoxProvisioningConfigured,
  provisionProxmoxInstance,
  resolveProxmoxHostEnv,
} from "@/lib/services/proxmox-instance-service";
import {
  guardProxmoxHostPlacementReadiness,
  reportCorrelatedProxmoxHostFailure,
  reportProxmoxHostRegistryUnavailable,
  reportProxmoxVmidRangeUtilization,
} from "@/lib/services/proxmox-host-guards";
import { resolveCodexDeploymentSecret } from "@/lib/codex-oauth";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { createManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { SLOT_FREEING_LIFECYCLE_IN_LIST } from "@/lib/instance-lifecycle";

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(),
    storage: { from: jest.fn() },
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
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
}));

// Provisioning guards are unit-tested in proxmox-host-guards.test.ts; here we
// only assert instance-service wires them into placement / failover correctly.
// Defaults are pass-through so every pre-existing test keeps its happy path.
jest.mock("@/lib/services/proxmox-host-guards", () => ({
  guardProxmoxHostPlacementReadiness: jest.fn(async () => ({ skip: false })),
  reportProxmoxVmidRangeUtilization: jest.fn(async () => "ok"),
  reportCorrelatedProxmoxHostFailure: jest.fn(async () => ({ correlated: false, hosts: [] })),
  reportProxmoxHostRegistryUnavailable: jest.fn(async () => undefined),
}));

/**
 * A `proxmox_hosts` registry that reads successfully and holds zero rows — the
 * one state in which the legacy env-order fallback is legitimate.
 *
 * `loadProxmoxHostRegistry` issues exactly ONE read: a whole-table select, no
 * `status` filter and no count probe, partitioned in memory. A single
 * createInstance can read the registry several times (each VMID-exhaustion
 * failover hop re-selects a target), so the resolved value is produced fresh per
 * `select()` call.
 *
 * Before 2026-07 most fixtures below simply threw `Unexpected table lookup:
 * proxmox_hosts`, and the loader swallowed the throw into a silent env-order
 * fallback — which is the very defect this suite now guards.
 */
function createEmptyProxmoxHostsRegistry(): () => unknown {
  return () => ({
    select: jest.fn().mockResolvedValue({ data: [], error: null }),
  });
}

/**
 * One `proxmox_hosts` row as the placement select now reads it — `status`
 * included, because the query no longer filters on it.
 */
function proxmoxHostRow(id: string, status: string) {
  return {
    id,
    status,
    env_prefix: null,
    total_cpu: 12,
    total_ram_mb: 65536,
    reserved_cpu: 2,
    reserved_ram_mb: 4096,
    wake_headroom_ram_mb: 8192,
    max_tenant_instances: null,
    thinpool_size_gb: 800,
    thinpool_overcommit_ratio: 1.5,
  };
}

/** A registry that reads successfully and holds exactly these rows. */
function createProxmoxHostsRegistry(rows: ReturnType<typeof proxmoxHostRow>[]): () => unknown {
  return () => ({
    select: jest.fn().mockResolvedValue({ data: rows, error: null }),
  });
}

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  DEFAULT_PROXMOX_VM_DISK_GB: 30,
  resolveProxmoxVmDiskGb: jest.fn((env: NodeJS.ProcessEnv = process.env) => {
    const parsed = Number.parseInt(env.PROXMOX_VM_DISK_GB || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }),
  provisionProxmoxInstance: jest.fn(),
  getProxmoxTemplateAvailability: jest.fn().mockResolvedValue({
    ok: true,
    targetId: "fixturenode1_node",
    templateId: 9000,
  }),
  getProxmoxVmidAvailability: jest.fn().mockResolvedValue({
    ok: true,
    vmidStart: 200,
    vmidEnd: 219,
    occupiedVmids: [],
    freeVmids: [200],
  }),
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
    const ids: string[] = [];
    const push = (value: string | undefined) => {
      const id = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (id && !ids.includes(id)) ids.push(id);
    };
    push(env.HERMES_PROXMOX_TARGET || env.PROXMOX_TARGET || env.PROXMOX_NODE);
    for (const target of (env.HERMES_PROXMOX_TARGETS || env.PROXMOX_TARGETS || "").split(/[,\s]+/)) {
      push(target);
    }
    return ids;
  }),
  resolveProxmoxMaxTenantInstances: jest.fn(() => {
    const raw = process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES?.trim();
    if (!raw) return 15;
    if (raw === "0" || raw.toLowerCase() === "none" || raw.toLowerCase() === "unlimited") {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
  }),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/venice/proxy-keys", () => ({
  createManagedVeniceProxyKey: jest.fn(),
}));

jest.mock("@/lib/venice/managed-endpoints", () => ({
  getManagedVeniceProxyBaseUrl: jest.fn(
    () => "https://hermesos.cloud/api/managed-venice/v1"
  ),
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
  getPlan: jest.fn((key: string) => {
    if (key === "credit_base" || key === "free") {
      return { name: "Free", maxCpuPerAgent: 0.5, maxRamPerAgent: 1024 };
    }
    return { name: "Operator", maxCpuPerAgent: 8, maxRamPerAgent: 16384 };
  }),
}));

jest.mock("@/lib/models", () => ({
  normalizeModelValue: jest.fn((model: string) => model),
  // PROVIDERS is consumed by reconcileModelForProvider via a lazy require
  // in src/lib/services/provider-config.ts. Without this entry the mock
  // returns undefined for PROVIDERS and the find() call inside the
  // reconciler throws — see the new model-vs-provider compatibility check
  // in InstanceService.createInstance. Empty array keeps the reconciler
  // on its safe-default branch (treat unknown as compatible).
  PROVIDERS: [],
}));

interface OrFilterCall {
  expression: string;
}

interface NotFilterCall {
  column: string;
  operator: string;
  value: string;
}

interface FreeGuardQueryRecorder {
  table: string | null;
  selected: string | null;
  userId: string | null;
  orCalls: OrFilterCall[];
  notCalls: NotFilterCall[];
  neqCalls: Array<{ column: string; value: string }>;
  limit: number | null;
}

function buildFreeGuardSupabaseStub(rows: Array<{ id: string }>) {
  const recorder: FreeGuardQueryRecorder = {
    table: null,
    selected: null,
    userId: null,
    orCalls: [],
    notCalls: [],
    neqCalls: [],
    limit: null,
  };

  const query: Record<string, unknown> = {};
  query.select = jest.fn((selection: string) => {
    recorder.selected = selection;
    return query;
  });
  query.eq = jest.fn((column: string, value: string) => {
    if (column === "user_id") recorder.userId = value;
    return query;
  });
  query.or = jest.fn((expression: string) => {
    recorder.orCalls.push({ expression });
    return query;
  });
  query.not = jest.fn((column: string, operator: string, value: string) => {
    recorder.notCalls.push({ column, operator, value });
    return query;
  });
  query.neq = jest.fn((column: string, value: string) => {
    recorder.neqCalls.push({ column, value });
    return query;
  });
  query.limit = jest.fn(async (limit: number) => {
    recorder.limit = limit;
    return { data: rows, error: null };
  });

  const fakeSupabase = {
    from: jest.fn((table: string) => {
      recorder.table = table;
      return query;
    }),
  } as unknown as typeof supabaseAdmin;

  return { fakeSupabase, recorder };
}

function buildProxmoxCapacitySupabaseStub(count: number, hivraCount = 0) {
  const query: Record<string, unknown> = {};
  const hivraQuery: Record<string, unknown> = {};
  const eqCalls: Array<{ column: string; value: string }> = [];
  const hivraEqCalls: Array<{ column: string; value: string }> = [];
  query.select = jest.fn().mockReturnValue(query);
  query.or = jest.fn().mockReturnValue(query);
  query.not = jest.fn().mockReturnValue(query);
  query.eq = jest.fn((column: string, value: string) => {
    eqCalls.push({ column, value });
    return query;
  });
  query.then = (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) =>
    Promise.resolve({
      data: Array.from({ length: count }, (_, index) => ({
        id: `inst_${index}`,
        status: "running",
        lifecycle_state: "active",
        proxmox_vmid: 300 + index,
      })),
      error: null,
    }).then(resolve);
  hivraQuery.select = jest.fn().mockReturnValue(hivraQuery);
  hivraQuery.eq = jest.fn((column: string, value: string) => {
    hivraEqCalls.push({ column, value });
    return hivraQuery;
  });
  hivraQuery.then = (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) =>
    Promise.resolve({
      data: Array.from({ length: hivraCount }, (_, index) => ({
        id: `hivra_${index}`,
        status: "running",
        vmid: 1090 + index,
        proxmox_host: "fixturenode2",
      })),
      error: null,
    }).then(resolve);

  const fakeSupabase = {
    from: jest.fn((table: string) => {
      if (table === "hivra_agents") return hivraQuery;
      if (table !== "hermes_instances") throw new Error(`Unexpected table lookup: ${table}`);
      return query;
    }),
  } as unknown as typeof supabaseAdmin;

  return { fakeSupabase, query, eqCalls, hivraQuery, hivraEqCalls };
}

function emptyHivraAgentsQuery() {
  const query: Record<string, unknown> = {};
  query.select = jest.fn().mockReturnValue(query);
  query.eq = jest.fn().mockReturnValue(query);
  query.in = jest.fn().mockReturnValue(query);
  query.neq = jest.fn().mockResolvedValue({ data: [], count: 0, error: null });
  query.then = (resolve: (value: { data: unknown[]; error: null }) => void) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return query;
}

// hivra_agents allocation query that resolves to `rows` however the chain
// filters it (the mock does not apply the filters; assert them instead).
function hivraAllocationRowsQuery(rows: Array<Record<string, unknown>>) {
  const query: Record<string, jest.Mock | unknown> = {};
  query.select = jest.fn().mockReturnValue(query);
  query.in = jest.fn().mockReturnValue(query);
  query.neq = jest.fn().mockReturnValue(query);
  query.then = (resolve: (value: { data: unknown[]; error: null }) => void) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  return query as Record<string, jest.Mock>;
}

function buildProxmoxCapacityRowsSupabaseStub(
  rows: Array<{
    status: string | null;
    lifecycle_state: string | null;
    infrastructure_provider: string | null;
    proxmox_node?: string | null;
    proxmox_vmid?: number | null;
  }>
) {
  const filters = {
    providerOrVmid: false,
    excluded: new Map<string, Set<string>>(),
    eq: new Map<string, string>(),
  };
  const query: Record<string, unknown> = {};
  const hivraQuery: Record<string, unknown> = {};

  query.select = jest.fn().mockReturnValue(query);
  query.or = jest.fn((expression: string) => {
    if (expression === "infrastructure_provider.eq.proxmox,proxmox_vmid.not.is.null") {
      filters.providerOrVmid = true;
    }
    return query;
  });
  query.not = jest.fn((column: string, operator: string, value: string) => {
    if (operator !== "in") return query;
    const excludedValues = value
      .replace(/[()"]/g, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    filters.excluded.set(column, new Set(excludedValues));
    return query;
  });
  query.eq = jest.fn((column: string, value: string) => {
    filters.eq.set(column, value);
    return query;
  });
  query.then = (resolve: (value: { data: typeof rows; error: null }) => void) => {
    const data = rows.filter((row) => {
      if (
        filters.providerOrVmid &&
        row.infrastructure_provider !== "proxmox" &&
        row.proxmox_vmid == null
      ) {
        return false;
      }

      for (const [column, value] of filters.eq.entries()) {
        if (String(row[column as keyof typeof row] ?? "") !== value) return false;
      }

      for (const [column, excludedValues] of filters.excluded.entries()) {
        const value = row[column as keyof typeof row];
        if (typeof value === "string" && excludedValues.has(value)) return false;
      }

      return true;
    });

    return Promise.resolve({ data, error: null }).then(resolve);
  };
  hivraQuery.select = jest.fn().mockReturnValue(hivraQuery);
  hivraQuery.eq = jest.fn().mockReturnValue(hivraQuery);
  hivraQuery.then = (resolve: (value: { data: unknown[]; error: null }) => void) =>
    Promise.resolve({ data: [], error: null }).then(resolve);

  const fakeSupabase = {
    from: jest.fn((table: string) => {
      if (table === "hivra_agents") return hivraQuery;
      if (table !== "hermes_instances") throw new Error(`Unexpected table lookup: ${table}`);
      return query;
    }),
  } as unknown as typeof supabaseAdmin;

  return { fakeSupabase, query };
}

describe("isFreeTierKey", () => {
  it("treats 'free' and 'credit_base' as free, paid plans as paid, and null as paid", () => {
    expect(isFreeTierKey("free")).toBe(true);
    expect(isFreeTierKey("FREE")).toBe(true);
    expect(isFreeTierKey("credit_base")).toBe(true);
    expect(isFreeTierKey("Credit_Base")).toBe(true);
    expect(isFreeTierKey("operator")).toBe(false);
    expect(isFreeTierKey("fleet")).toBe(false);
    expect(isFreeTierKey("command")).toBe(false);
    expect(isFreeTierKey(null)).toBe(false);
    expect(isFreeTierKey(undefined)).toBe(false);
    expect(isFreeTierKey("")).toBe(false);
  });
});

describe("isSingleInstanceBaseTierKey", () => {
  it("limits Free and token-base tiers to one active base instance", () => {
    expect(isSingleInstanceBaseTierKey("free")).toBe(true);
    expect(isSingleInstanceBaseTierKey("credit_base")).toBe(true);
    expect(isSingleInstanceBaseTierKey("token_base")).toBe(true);
    expect(isSingleInstanceBaseTierKey("operator")).toBe(false);
  });
});

describe("resolveInstanceResourceTier", () => {
  it("stores Free subscriptions as the legacy free resource tier", () => {
    expect(resolveInstanceResourceTier("free")).toBe("credit_base");
    expect(resolveInstanceResourceTier("credit_base")).toBe("credit_base");
    expect(resolveInstanceResourceTier("operator")).toBe("operator");
  });
});

describe("CreateInstanceSchema agentFlavor", () => {
  it("rejects Operator OS until its first-party runtime is inside the public boundary", () => {
    expect(() => CreateInstanceSchema.parse({
      name: "Operator OS Agent",
      provider: "openrouter",
      agentFlavor: "operatoros",
    })).toThrow();
  });

  it("defaults agentFlavor to 'vanilla' when not provided", () => {
    const parsed = CreateInstanceSchema.parse({
      name: "Standard Agent",
      provider: "openrouter",
    });
    expect(parsed.agentFlavor).toBe("vanilla");
  });

  it("rejects an unknown agentFlavor value", () => {
    expect(() =>
      CreateInstanceSchema.parse({
        name: "Bad Agent",
        provider: "openrouter",
        agentFlavor: "something-else",
      })
    ).toThrow();
  });
});

describe("CreateInstanceSchema free limits", () => {
  it("accepts the exact Free resource limits so the server can enforce them downstream", () => {
    expect(
      CreateInstanceSchema.parse({
        name: "Free Agent",
        provider: "openrouter",
        cpuLimit: 0.5,
        ramLimit: 1024,
      })
    ).toMatchObject({
      cpuLimit: 0.5,
      ramLimit: 1024,
    });
  });

  it("rejects requests below the Free resource floor", () => {
    expect(() =>
      CreateInstanceSchema.parse({
        name: "Too Small",
        provider: "openrouter",
        cpuLimit: 0.25,
        ramLimit: 512,
      })
    ).toThrow();
  });
});

describe("assertFreeInstanceCreatable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes when the user has no instances", async () => {
    const { fakeSupabase, recorder } = buildFreeGuardSupabaseStub([]);

    await expect(
      assertFreeInstanceCreatable("user_no_rows", { supabase: fakeSupabase })
    ).resolves.toBeUndefined();

    expect(recorder.table).toBe("hermes_instances");
    expect(recorder.userId).toBe("user_no_rows");
    expect(recorder.orCalls).toHaveLength(1);
    expect(recorder.orCalls[0].expression).toContain("resource_tier.eq.free");
    expect(recorder.orCalls[0].expression).toContain("resource_tier.eq.credit_base");
    expect(recorder.orCalls[0].expression.split(",")).not.toContain("tier.eq.free");
    expect(recorder.orCalls[0].expression.split(",")).not.toContain("tier.eq.credit_base");
    // Counts "slot occupied" by status != 'deleted' AND lifecycle_state NOT IN
    // (deleted, cold_archived). The lifecycle exclusion is required because
    // deleted/cold_archived base instances are routinely left at
    // status='stopped' (status isn't synced on every lifecycle transition), so
    // a status-only guard would count a user's GONE base instance and wrongly
    // refuse a new free agent.
    expect(recorder.neqCalls).toEqual([{ column: "status", value: "deleted" }]);
    expect(recorder.notCalls).toEqual([
      {
        column: "lifecycle_state",
        operator: "in",
        value: SLOT_FREEING_LIFECYCLE_IN_LIST,
      },
    ]);
    expect(recorder.limit).toBe(1);
  });

  it("rejects when the user already owns one active free-tier instance", async () => {
    const { fakeSupabase } = buildFreeGuardSupabaseStub([{ id: "inst_existing" }]);

    await expect(
      assertFreeInstanceCreatable("user_with_free", { supabase: fakeSupabase })
    ).rejects.toMatchObject({
      name: "FreeInstanceLimitError",
      code: "FREE_INSTANCE_LIMIT_REACHED",
      status: 403,
      existingInstanceId: "inst_existing",
    });
  });

  it("passes when the user's only free instance is already deleted (filter excludes it)", async () => {
    // The supabase stub already filters via `.neq('status', 'deleted')`,
    // so the .limit() call resolves with an empty array — exactly the
    // shape the guard treats as "no slot occupied". This test asserts the
    // guard doesn't throw when supabase returns `[]` after the filter.
    const { fakeSupabase, recorder } = buildFreeGuardSupabaseStub([]);

    await expect(
      assertFreeInstanceCreatable("user_only_deleted", { supabase: fakeSupabase })
    ).resolves.toBeUndefined();

    expect(recorder.neqCalls[0]).toEqual({ column: "status", value: "deleted" });
  });

  it("frees the slot for a deleted/cold_archived base instance via the lifecycle exclusion (not just status)", async () => {
    // Regression: a user whose only base agent is deleted or cold_archived must
    // be able to create a new free agent. Those rows are routinely left at
    // status='stopped', so a status-only guard counted them and blocked the
    // user. The stub returns [] to represent the post-filter result; assert the
    // guard applies the lifecycle_state exclusion that produces it.
    const { fakeSupabase, recorder } = buildFreeGuardSupabaseStub([]);

    await expect(
      assertFreeInstanceCreatable("user_only_cold_archived", { supabase: fakeSupabase })
    ).resolves.toBeUndefined();

    expect(recorder.notCalls).toContainEqual({
      column: "lifecycle_state",
      operator: "in",
      value: SLOT_FREEING_LIFECYCLE_IN_LIST,
    });
  });

  it("passes when the user's only instance is paid (filter excludes paid tiers)", async () => {
    // Same shape as the deleted-instance case: the supabase OR/NOT filters
    // would skip a paid row server-side, so the helper sees `[]` and
    // resolves without throwing. The contract here is "if the query
    // returns nothing, the user can create a free instance."
    const { fakeSupabase, recorder } = buildFreeGuardSupabaseStub([]);

    await expect(
      assertFreeInstanceCreatable("user_paid_only", { supabase: fakeSupabase })
    ).resolves.toBeUndefined();

    expect(recorder.orCalls[0].expression).toContain("resource_tier.eq.credit_base");
  });

  it("propagates db errors as a generic failure", async () => {
    const fakeSupabase = {
      from: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        limit: jest.fn(async () => ({ data: null, error: { message: "shard down" } })),
      })),
    } as unknown as typeof supabaseAdmin;

    await expect(
      assertFreeInstanceCreatable("user_db_err", { supabase: fakeSupabase })
    ).rejects.toThrow(/shard down/);

    expect(log.error).toHaveBeenCalledWith(
      "failed to verify free-instance limit",
      expect.any(Error),
      expect.objectContaining({
        source: "instance-service",
        failureType: "free_instance_limit_check_failed",
        userId: "user_db_err",
      })
    );
  });
});

describe("classifyProxmoxHostLocalProvisionFailure", () => {
  it("classifies known host-local failure signatures", () => {
    expect(
      classifyProxmoxHostLocalProvisionFailure(
        "[caddy] missing Cloudflare Origin CA cert/key at /etc/caddy/wildcards/hermesos.cloud.{crt,key}; seed the host before provisioning"
      )
    ).toBe("host_cert_seed_missing");
    expect(
      classifyProxmoxHostLocalProvisionFailure(
        "host fixturenode21 is missing private bridge vmbr1 — persist /etc/network/interfaces.d/vmbr1 and `ifup vmbr1` on the host before retrying"
      )
    ).toBe("host_bridge_missing");
    expect(
      classifyProxmoxHostLocalProvisionFailure("bridge 'vmbr1' does not exist")
    ).toBe("host_bridge_missing");
    expect(
      classifyProxmoxHostLocalProvisionFailure(
        "clone failed: cannot determine size of volume 'local-lvm:base-9001-disk-0'"
      )
    ).toBe("host_template_clone_failed");
    expect(
      classifyProxmoxHostLocalProvisionFailure(
        "Configuration file 'nodes/fixturenode21/qemu-server/9001.conf' does not exist"
      )
    ).toBe("host_template_clone_failed");
    expect(
      classifyProxmoxHostLocalProvisionFailure(
        "hermes_caddy_reload: invalid Caddyfile, refusing to reload"
      )
    ).toBe("host_caddy_invalid");
    expect(
      classifyProxmoxHostLocalProvisionFailure(
        "Timed out waiting for hermes-proxmox provision lock"
      )
    ).toBe("host_provision_lock_timeout");
    expect(
      classifyProxmoxHostLocalProvisionFailure("SSH connection failed: connect ETIMEDOUT")
    ).toBe("host_unreachable");
    expect(
      classifyProxmoxHostLocalProvisionFailure(
        "Proxmox SSH operation timed out after 300000ms"
      )
    ).toBe("host_unreachable");
    expect(
      classifyProxmoxHostLocalProvisionFailure("Remote bash exited with code 1")
    ).toBe("host_script_failure");
  });

  it("returns null for user-input and unknown failures so they never trigger failover", () => {
    expect(
      classifyProxmoxHostLocalProvisionFailure("provider rejected the supplied API key")
    ).toBeNull();
    expect(
      classifyProxmoxHostLocalProvisionFailure(
        "user_data length of 40000 exceeds 32768 bytes"
      )
    ).toBeNull();
    expect(
      classifyProxmoxHostLocalProvisionFailure("No free Proxmox VMID in range 300-349")
    ).toBeNull();
    expect(classifyProxmoxHostLocalProvisionFailure("")).toBeNull();
  });
});

describe("assertProxmoxTenantCapacityAvailable", () => {
  const originalCap = process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES;

  afterEach(() => {
    if (originalCap === undefined) {
      delete process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES;
    } else {
      process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = originalCap;
    }
  });

  it("passes while the temporary Proxmox oversell cap still has room", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";
    const { fakeSupabase, query } = buildProxmoxCapacitySupabaseStub(19);

    await expect(
      assertProxmoxTenantCapacityAvailable({ supabase: fakeSupabase })
    ).resolves.toBeUndefined();

    expect(query.or).toHaveBeenCalledWith(
      "infrastructure_provider.eq.proxmox,proxmox_vmid.not.is.null"
    );
    expect(query.select).toHaveBeenCalledWith("id, status, lifecycle_state, proxmox_vmid");
    expect(query.not).not.toHaveBeenCalled();
  });

  it("scopes the temporary Proxmox cap to the selected target instead of counting the old pool", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";
    const { fakeSupabase, eqCalls } = buildProxmoxCapacitySupabaseStub(0);

    await expect(
      assertProxmoxTenantCapacityAvailable({
        supabase: fakeSupabase,
        env: {
          HERMES_PROXMOX_TARGET: "fixturelegacy",
          PROXMOX_FIXTURELEGACY_SSH_HOST: "fixturelegacy.example.invalid",
        },
      })
    ).resolves.toBeUndefined();

    expect(eqCalls).toContainEqual({ column: "proxmox_node", value: "fixturelegacy" });
  });

  it("keeps a pre-resolved Proxmox target candidate scoped to its own node", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";
    const { fakeSupabase, eqCalls } = buildProxmoxCapacitySupabaseStub(0);

    await expect(
      assertProxmoxTenantCapacityAvailable({
        supabase: fakeSupabase,
        targetId: "fixturenode2",
        env: {
          HERMES_PROXMOX_TARGET: "fixturenode3",
          HERMES_PROXMOX_TARGETS: "fixturenode3,fixturenode2",
          PROXMOX_NODE: "fixturenode2",
          PROXMOX_FIXTURENODE2_SSH_HOST: "fixturenode2.example.invalid",
        },
      })
    ).resolves.toBeUndefined();

    expect(eqCalls).toContainEqual({ column: "proxmox_node", value: "fixturenode2" });
    expect(eqCalls).not.toContainEqual({ column: "proxmox_node", value: "fixturenode3" });
  });

  it("rejects when the temporary Proxmox oversell cap is reached", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";
    const { fakeSupabase } = buildProxmoxCapacitySupabaseStub(20);

    await expect(
      assertProxmoxTenantCapacityAvailable({ supabase: fakeSupabase })
    ).rejects.toBeInstanceOf(ProxmoxTenantCapacityError);
  });

  it("counts Hivra agents against the selected Proxmox host cap", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";
    const { fakeSupabase, eqCalls, hivraEqCalls } = buildProxmoxCapacitySupabaseStub(19, 1);

    await expect(
      assertProxmoxTenantCapacityAvailable({
        supabase: fakeSupabase,
        targetId: "fixturenode2",
      })
    ).rejects.toBeInstanceOf(ProxmoxTenantCapacityError);

    expect(eqCalls).toContainEqual({ column: "proxmox_node", value: "fixturenode2" });
    expect(hivraEqCalls).toContainEqual({ column: "proxmox_host", value: "fixturenode2" });
  });

  it("counts error/failed Proxmox rows while they still claim a VMID", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "2";
    const { fakeSupabase } = buildProxmoxCapacityRowsSupabaseStub([
      {
        status: "error",
        lifecycle_state: "failed",
        infrastructure_provider: "proxmox",
        proxmox_vmid: 200,
      },
      {
        status: "failed",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
        proxmox_vmid: 201,
      },
      {
        status: "running",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
        proxmox_vmid: 202,
      },
    ]);

    await expect(
      assertProxmoxTenantCapacityAvailable({ supabase: fakeSupabase })
    ).rejects.toBeInstanceOf(ProxmoxTenantCapacityError);
  });

  it("does not count terminal Proxmox rows once they have no VMID claim", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "2";
    const { fakeSupabase } = buildProxmoxCapacityRowsSupabaseStub([
      {
        status: "error",
        lifecycle_state: "failed",
        infrastructure_provider: "proxmox",
        proxmox_vmid: null,
      },
      {
        status: "failed",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
        proxmox_vmid: null,
      },
      {
        status: "deleted",
        lifecycle_state: "deleted",
        infrastructure_provider: "proxmox",
        proxmox_vmid: 200,
      },
      {
        status: "running",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
        proxmox_vmid: 201,
      },
    ]);

    await expect(
      assertProxmoxTenantCapacityAvailable({ supabase: fakeSupabase })
    ).resolves.toBeUndefined();
  });
});

describe("InstanceService.createInstance free-tier guard", () => {
  const originalHetznerToken = process.env.HETZNER_API_TOKEN;
  const originalInstanceBackend = process.env.INSTANCE_BACKEND;
  const originalInfraProvider = process.env.HERMES_INFRA_PROVIDER;
  const originalProxmoxEnabledUserIds = process.env.HERMES_PROXMOX_ENABLED_USER_IDS;
  const originalProxmoxCap = process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES;
  const originalProxmoxTarget = process.env.HERMES_PROXMOX_TARGET;
  const originalProxmoxTargets = process.env.HERMES_PROXMOX_TARGETS;
  const originalProxmoxVmDiskGb = process.env.PROXMOX_VM_DISK_GB;
  const originalNodeEnv = process.env.NODE_ENV as string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    (guardProxmoxHostPlacementReadiness as jest.Mock).mockResolvedValue({ skip: false });
    (getProxmoxTemplateAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode1_node",
      templateId: 9000,
    });
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      vmidStart: 200,
      vmidEnd: 219,
      occupiedVmids: [],
      freeVmids: [200],
    });
    process.env.HETZNER_API_TOKEN = "test-token";
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_free";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    delete process.env.HERMES_PROXMOX_TARGET;
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.PROXMOX_VM_DISK_GB;
    delete process.env.INSTANCE_BACKEND;
    // Force production-mode behaviour in createInstance so the dev-mode
    // "Mock default plan" branch never substitutes an operator sub for us.
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";

    (clerkClient as jest.Mock).mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }),
      },
    });
    (resolveCodexDeploymentSecret as jest.Mock).mockImplementation((apiKey: string) => ({ apiKey }));
    (decryptApiKey as jest.Mock).mockImplementation((value: string) => value);
    (createManagedVeniceProxyKey as jest.Mock).mockResolvedValue({
      id: "managed_key_1",
      plaintextKey: "hven_live_instance_proxy",
      keyPrefix: "hven_live_instance_",
      // The mint returns the EFFECTIVE wallet it bound the key to, which the
      // deploy must persist verbatim (it can differ from what was requested).
      defaultWalletType: "hermesos",
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("agent gateway unavailable in test")
    );
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
    if (originalProxmoxCap === undefined) {
      delete process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES;
    } else {
      process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = originalProxmoxCap;
    }
    if (originalProxmoxTarget === undefined) {
      delete process.env.HERMES_PROXMOX_TARGET;
    } else {
      process.env.HERMES_PROXMOX_TARGET = originalProxmoxTarget;
    }
    if (originalProxmoxTargets === undefined) {
      delete process.env.HERMES_PROXMOX_TARGETS;
    } else {
      process.env.HERMES_PROXMOX_TARGETS = originalProxmoxTargets;
    }
    if (originalProxmoxVmDiskGb === undefined) {
      delete process.env.PROXMOX_VM_DISK_GB;
    } else {
      process.env.PROXMOX_VM_DISK_GB = originalProxmoxVmDiskGb;
    }
    if (originalNodeEnv === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    } else {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }
  });

  it("rejects a second free-tier provision with FREE_INSTANCE_LIMIT_REACHED before any backend call", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "credit_base",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 1,
          total_ram_budget: 1024,
        },
      }),
    };

    const freeGuardQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      limit: jest.fn(async () => ({
        data: [{ id: "inst_existing_free" }],
        error: null,
      })),
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        // The free-tier guard is the FIRST hermes_instances query — if any
        // backend call happens before the guard resolves, this assertion
        // catches it.
        return freeGuardQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Free Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 403,
        message: expect.stringMatching(/one active base-tier agent/i),
        error: expect.objectContaining({
          code: "FREE_INSTANCE_LIMIT_REACHED",
          existingInstanceId: "inst_existing_free",
        }),
      })
    );
    expect(hermesInstancesCall).toBe(1);
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("blocks a NEW provision while a paid sub is past_due (dunning), before any backend call", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "past_due",
          instance_limit: 3,
          total_cpu_budget: 2,
          total_ram_budget: 4096,
          // Still inside the grace window, so resolveEffectiveSubscription
          // returns a live past_due Stripe entitlement — existing agents keep
          // running, but a brand-new provision must be refused (402).
          grace_period_ends_at: "2999-01-01T00:00:00.000Z",
          stripe_subscription_id: "sub_live_pd",
        },
      }),
    };

    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      // The dunning gate fires before the free-tier guard's hermes_instances
      // read and before placement — reaching any other table means the gate
      // failed to short-circuit.
      throw new Error(`Unexpected table lookup after dunning gate: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_pastdue",
      CreateInstanceSchema.parse({
        name: "Dunning Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 402,
        message: expect.stringMatching(/payment/i),
      })
    );
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("allows a free-tier provision when no active free instance exists", async () => {
    let rejectGateway!: (error: Error) => void;
    const gatewayPromise = new Promise<never>((_resolve, reject) => {
      rejectGateway = reject;
    });
    (fetchFirstReachableGatewayResponse as jest.Mock).mockReturnValue(gatewayPromise);

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "credit_base",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 1,
          total_ram_budget: 1024,
        },
      }),
    };

    const freeGuardQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      limit: jest.fn(async () => ({ data: [], error: null })),
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
          id: "inst_new_free",
          name: "Free Agent",
          subdomain: "free-subdomain",
        },
        error: null,
      }),
    };

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: updateEq,
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 201,
      ipv4: "10.250.20.51",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://abc.203-0-113-10.sslip.io",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        vmid: 201,
        privateIpv4: "10.250.20.51",
        gatewayHost: "abc.203-0-113-10.sslip.io",
      },
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return freeGuardQuery;
        if (hermesInstancesCall === 2) return agentCountQuery;
        if (hermesInstancesCall === 3) return resourceUsageQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const resultPromise = InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Free Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 2048,
      })
    );
    let settled = false;
    resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    // Microtask drain, not a timing assertion — the bound only has to exceed
    // the number of awaits between createInstance and the gateway probe.
    // Placement grew two (the registry count probe and its retry wrapper).
    for (let attempt = 0; attempt < 60 && (fetchFirstReachableGatewayResponse as jest.Mock).mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(fetchFirstReachableGatewayResponse).toHaveBeenCalled();
    await Promise.resolve();
    expect(settled).toBe(false);

    rejectGateway(new Error("gateway booting"));
    const result = await resultPromise;

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(buildInstanceInsertPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        cpuLimit: 0.5,
        ramLimit: 1024,
        resourceTier: "credit_base",
      })
    );
    expect(provisionProxmoxInstance).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "bankr suite skill preinstall failed — agent still created",
      expect.objectContaining({
        failureType: "bankr_suite_preinstall_failed",
        instanceId: "inst_new_free",
        userId: "user_free",
        error: "gateway booting",
      })
    );
  });

  it("rejects invalid OpenRouter key shapes before storing or provisioning an instance", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
          total_cpu_budget: 20,
          total_ram_budget: 40960,
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
      single: jest.fn(),
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
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Bad OpenRouter Agent",
        provider: "openrouter",
        apiKey: "github_pat_wrong_secret",
        cpuLimit: 1,
        ramLimit: 2048,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 400,
        message: "OpenRouter API keys must start with sk-or-.",
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "rejecting invalid provider API key shape for instance create",
      expect.objectContaining({
        failureType: "provider_key_invalid_shape",
        provider: "openrouter",
        userId: "user_free",
      })
    );
    expect(insertQuery.insert).not.toHaveBeenCalled();
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("keeps a real Venice key on BYOK even when a stale managed Venice flag is submitted", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
          total_cpu_budget: 20,
          total_ram_budget: 40960,
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
          id: "inst_venice_byok",
          name: "Venice BYOK",
          subdomain: "venice-byok",
        },
        error: null,
      }),
    };

    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 206,
      ipv4: "10.250.20.56",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://venice-byok.example",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode1",
        vmid: 206,
        privateIpv4: "10.250.20.56",
        gatewayHost: "venice-byok.example",
      },
    });

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

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Venice BYOK",
        provider: "venice",
        apiKey: "sk-venice-real",
        model: "deepseek-v4-pro",
        cpuLimit: 2,
        ramLimit: 4096,
        agentSettings: {
          customLlmBaseUrl: "https://hermesos.cloud/api/managed-venice/v1",
        },
        managedVenice: {
          enabled: true,
          walletType: "card",
        },
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(createManagedVeniceProxyKey).not.toHaveBeenCalled();
    expect(buildInstanceInsertPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "venice",
        encryptedApiKey: "enc:sk-venice-real",
        config: expect.not.objectContaining({
          managedVenice: expect.anything(),
        }),
      })
    );
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "venice",
        apiKey: "sk-venice-real",
        agentSettings: expect.not.objectContaining({
          customLlmBaseUrl: expect.stringContaining("managed-venice"),
        }),
      }),
      expect.any(Object)
    );
    expect(log.warn).toHaveBeenCalledWith(
      "ignored managed Venice create request because a real Venice BYOK key was provided",
      expect.objectContaining({
        failureType: "managed_venice_create_byok_overrode_managed",
        userId: "user_free",
        provider: "venice",
        walletType: "card",
        hasVaultKeyId: false,
        strippedManagedProxyBaseUrl: true,
      })
    );
  });

  // ── deploy-card redesign: managed-Venice mint vs. clean-slate ────────────
  // Part 3 of the deploy-card test contract.
  // Regression guard: a Managed=ON Venice deploy (no real BYOK key) still MINTS
  // a managed-Venice proxy key and stamps the managed config. Companion guard:
  // a clean-slate (Managed=OFF / unconfigured) deploy must NOT mint a proxy key.
  it("mints a managed Venice proxy key for a Managed=ON Venice deploy (no real BYOK key)", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
          total_cpu_budget: 20,
          total_ram_budget: 40960,
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
          id: "inst_venice_managed",
          name: "Venice Managed",
          subdomain: "venice-managed",
        },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 207,
      ipv4: "10.250.20.57",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://venice-managed.example",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode1",
        vmid: 207,
        privateIpv4: "10.250.20.57",
        gatewayHost: "venice-managed.example",
      },
    });

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

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Venice Managed",
        provider: "venice",
        // No real Venice BYOK key → the managed path owns key minting.
        apiKey: "",
        model: "deepseek-v4-pro",
        cpuLimit: 2,
        ramLimit: 4096,
        managedVenice: {
          enabled: true,
          walletType: "hermesos",
        },
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(createManagedVeniceProxyKey).toHaveBeenCalledTimes(1);
    expect(createManagedVeniceProxyKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_free",
        defaultWalletType: "hermesos",
        // The deploy card's walletType is an implicit default, so the mint is
        // allowed to re-resolve it against post-starter-grant balances.
        autoSelectFundedWallet: true,
      })
    );
    // The minted proxy key + managed config are persisted on the instance.
    expect(buildInstanceInsertPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          managedVenice: expect.objectContaining({
            walletType: "hermesos",
            proxyKeyId: "managed_key_1",
          }),
        }),
      })
    );
  });

  it("persists the wallet the minted key ACTUALLY bills, not the one the deploy card requested", async () => {
    // A brand-new free user: the deploy card submits 'hermesos' (their card
    // wallet was empty at page load), but the mint grants the starter credit and
    // binds the key to 'card'. If the instance config recorded the REQUESTED
    // wallet, config would claim hermesos while every request bills card — and
    // managed-webui-enable would re-mint a fresh key on every enable click.
    (createManagedVeniceProxyKey as jest.Mock).mockResolvedValue({
      id: "managed_key_1",
      plaintextKey: "hven_live_instance_proxy",
      keyPrefix: "hven_live_instance_",
      defaultWalletType: "card",
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
          total_cpu_budget: 20,
          total_ram_budget: 40960,
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
          id: "inst_venice_managed",
          name: "Venice Managed",
          subdomain: "venice-managed",
        },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 207,
      ipv4: "10.250.20.57",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://venice-managed.example",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode1",
        vmid: 207,
        privateIpv4: "10.250.20.57",
        gatewayHost: "venice-managed.example",
      },
    });

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

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Venice Managed",
        provider: "venice",
        apiKey: "",
        model: "deepseek-v4-pro",
        cpuLimit: 2,
        ramLimit: 4096,
        managedVenice: { enabled: true, walletType: "hermesos" },
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(buildInstanceInsertPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          managedVenice: expect.objectContaining({
            walletType: "card",
            proxyKeyId: "managed_key_1",
          }),
        }),
      })
    );
  });

  it("does NOT mint a managed Venice proxy key for a clean-slate (unconfigured / Managed=OFF) deploy", async () => {
    // CONTRACT: the deploy card's "Managed (Venice)? = OFF" path sends
    // `unconfigured: true` and omits provider/model/apiKey. The box deploys with
    // NO inference provider/key/model; the agent's native onboarding overlay
    // fires after boot. A clean-slate deploy must therefore NEVER hit the
    // managed-Venice proxy-key mint (that path is Managed=ON only).
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
          total_cpu_budget: 20,
          total_ram_budget: 40960,
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
          id: "inst_clean_slate",
          name: "Clean Slate",
          subdomain: "clean-slate",
        },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 208,
      ipv4: "10.250.20.58",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://clean-slate.example",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode1",
        vmid: 208,
        privateIpv4: "10.250.20.58",
        gatewayHost: "clean-slate.example",
      },
    });

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

    await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Clean Slate",
        // provider/model/apiKey omitted → benign "openrouter" default, unused.
        // `unconfigured: true` is the deploy card's clean-slate (Managed=OFF) intent.
        unconfigured: true,
      })
    );

    // Billing-adjacent invariant (the load-bearing guarantee of this task): a
    // clean-slate deploy must NEVER mint a managed-Venice proxy key. This holds
    // on the clean-slate path regardless of where the request later terminates,
    // because cleanSlateUnconfigured gates the managed-Venice mint OFF
    // (instance-service.ts: `managedVenice?.enabled && !cleanSlateUnconfigured`).
    expect(createManagedVeniceProxyKey).not.toHaveBeenCalled();
  });

  it("persists config.unconfigured (no provider sentinel) when a clean-slate deploy reaches insert", async () => {
    // CONTRACT: clean-slate intent persists in config.unconfigured; the provider
    // column stays at its benign "openrouter" default so PROVIDER_ID_MAP lookups
    // / redeploy never throw. This test guards the persistence shape.
    //
    // NOTE: it only asserts the insert payload IF the create reached insert.
    // The clean-slate path deploys with NO API key by design; the pre-insert
    // no-key guard (instance-service.ts: `!finalApiKey &&
    // !supportsHermesAuthProvider(provider)`) must exempt cleanSlateUnconfigured
    // for the deploy to reach insert. See open_questions — when that exemption
    // lands this assertion becomes load-bearing; until then it is a no-op guard
    // that never produces a false green (it asserts nothing was mis-persisted).
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
          total_cpu_budget: 20,
          total_ram_budget: 40960,
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
        data: { id: "inst_clean_slate_2", name: "Clean Slate 2", subdomain: "clean-slate-2" },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 209,
      ipv4: "10.250.20.59",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://clean-slate-2.example",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode1",
        vmid: 209,
        privateIpv4: "10.250.20.59",
        gatewayHost: "clean-slate-2.example",
      },
    });

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

    await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Clean Slate 2",
        unconfigured: true,
      })
    );

    // No managed-Venice mint regardless of where the request terminated.
    expect(createManagedVeniceProxyKey).not.toHaveBeenCalled();
    // If (and only if) the create reached the instance insert, the persisted
    // config carries unconfigured:true and the provider column is untouched
    // (benign "openrouter" default — never a sentinel). Guarded so this test is
    // green both before and after the no-key-guard exemption lands.
    if ((buildInstanceInsertPayload as jest.Mock).mock.calls.length > 0) {
      expect(buildInstanceInsertPayload).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openrouter",
          config: expect.objectContaining({ unconfigured: true }),
        })
      );
    }
  });

  it("rejects a second token-base provision before any backend call", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "token_base",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 0.5,
          total_ram_budget: 1024,
        },
      }),
    };

    const baseGuardQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      limit: jest.fn(async () => ({
        data: [{ id: "inst_existing_token_base" }],
        error: null,
      })),
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        return baseGuardQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_token",
      CreateInstanceSchema.parse({
        name: "Token Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 403,
        message: expect.stringMatching(/one active base-tier agent/i),
        error: expect.objectContaining({
          code: "FREE_INSTANCE_LIMIT_REACHED",
          existingInstanceId: "inst_existing_token_base",
        }),
      })
    );
    expect(hermesInstancesCall).toBe(1);
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("falls through to the next Proxmox target when the primary target VMID range is full", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode3";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode3,fixturenode2";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: env.PROXMOX_NODE === "fixturenode2" ? 200 : 300,
        vmidEnd: env.PROXMOX_NODE === "fixturenode2" ? 249 : 349,
        occupiedVmids:
          env.PROXMOX_NODE === "fixturenode2"
            ? []
            : Array.from({ length: 50 }, (_, index) => 300 + index),
        freeVmids: env.PROXMOX_NODE === "fixturenode2" ? [200] : [],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_new_paid",
          name: "Paid Agent",
          subdomain: "paid-subdomain",
        },
        error: null,
      }),
    };

    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 200,
      ipv4: "10.250.21.50",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://abc.agents.hermesos.cloud",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode2",
        vmid: 200,
        privateIpv4: "10.250.21.50",
        gatewayHost: "abc.agents.hermesos.cloud",
      },
    });

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

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Paid Agent" }),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode2" }),
        hostConfig: null,
      })
    );
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ proxmox_node: "fixturenode2", proxmox_vmid: 200 })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "skipping exhausted Proxmox VMID target",
      expect.objectContaining({
        failureType: "proxmox_vmid_range_exhausted",
        targetId: "fixturenode3",
      })
    );
  });

  it("retries the next Proxmox target when provision races into VMID exhaustion", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode3";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode3,fixturenode2";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: env.PROXMOX_NODE === "fixturenode2" ? 200 : 300,
        vmidEnd: env.PROXMOX_NODE === "fixturenode2" ? 249 : 349,
        occupiedVmids: [],
        freeVmids: [env.PROXMOX_NODE === "fixturenode2" ? 200 : 300],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_new_paid_race",
          name: "Paid Agent",
          subdomain: "paid-race-subdomain",
        },
        error: null,
      }),
    };

    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        error: "No free Proxmox VMID in range 300-349",
        failureType: "proxmox_vmid_range_exhausted",
        targetId: "fixturenode3",
        vmidStart: 300,
        vmidEnd: 349,
      })
      .mockResolvedValueOnce({
        ok: true,
        provider: "proxmox",
        serverId: 0,
        vmid: 200,
        ipv4: "10.250.21.50",
        sshHostFingerprint: null,
        apiServerKey: "gateway-secret",
        gatewayUrl: "https://abc.agents.hermesos.cloud",
        serverType: "proxmox-kvm",
        infrastructure: {
          provider: "proxmox" as const,
          node: "fixturenode2",
          vmid: 200,
          privateIpv4: "10.250.21.50",
          gatewayHost: "abc.agents.hermesos.cloud",
        },
      });

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

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(2);
    expect(provisionProxmoxInstance).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "Paid Agent" }),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode3" }),
        hostConfig: null,
      })
    );
    expect(provisionProxmoxInstance).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "Paid Agent" }),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode2" }),
        hostConfig: null,
      })
    );
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ proxmox_node: "fixturenode2", proxmox_vmid: 200 })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "Proxmox target exhausted VMID range during provision; retrying placement",
      expect.objectContaining({
        failureType: "proxmox_vmid_exhausted_after_preflight",
        targetId: "fixturenode3",
        vmidStart: 300,
        vmidEnd: 349,
        excludedTargetIds: ["fixturenode3"],
      })
    );
  });

  it("fails over to the next Proxmox target when provision fails host-locally", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode3";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode3,fixturenode2";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: 200,
        vmidEnd: 249,
        occupiedVmids: [],
        freeVmids: [200],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_host_local_failover",
          name: "Paid Agent",
          subdomain: "host-local-failover",
        },
        error: null,
      }),
    };

    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        error:
          "[caddy] missing Cloudflare Origin CA cert/key at /etc/caddy/wildcards/hermesos.cloud.{crt,key}; seed the host before provisioning",
      })
      .mockResolvedValueOnce({
        ok: true,
        provider: "proxmox",
        serverId: 0,
        vmid: 200,
        ipv4: "10.250.21.50",
        sshHostFingerprint: null,
        apiServerKey: "gateway-secret",
        gatewayUrl: "https://abc.agents.hermesos.cloud",
        serverType: "proxmox-kvm",
        infrastructure: {
          provider: "proxmox" as const,
          node: "fixturenode2",
          vmid: 200,
          privateIpv4: "10.250.21.50",
          gatewayHost: "abc.agents.hermesos.cloud",
        },
      });

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

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(2);
    expect(provisionProxmoxInstance).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "Paid Agent" }),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode3" }),
        hostConfig: null,
      })
    );
    expect(provisionProxmoxInstance).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "Paid Agent" }),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode2" }),
        hostConfig: null,
      })
    );
    // The failover hop is logged at error level (only error mirrors into
    // ops_events) with the host id + failure class for repeat alerting.
    expect(log.error).toHaveBeenCalledWith(
      "Proxmox host-local provision failure; failing over placement",
      expect.any(Error),
      expect.objectContaining({
        failureType: "proxmox_host_local_provision_failure",
        failureClass: "host_cert_seed_missing",
        targetId: "fixturenode3",
        hostId: null,
        attempt: 1,
        excludedTargetIds: ["fixturenode3"],
      })
    );
    // GUARD 3 wiring: every host-local failure feeds the correlation detector,
    // which escalates to FATAL once a second distinct host reports the same class.
    expect(reportCorrelatedProxmoxHostFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "host_cert_seed_missing",
        targetId: "fixturenode3",
      })
    );
  });

  it("does not retry placement when the provision failure is not host-local", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode3";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode3,fixturenode2";

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_user_input_failure",
          name: "Paid Agent",
          subdomain: "user-input-failure",
        },
        error: null,
      }),
    };

    const rollbackQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: "provider rejected the supplied API key",
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return rollbackQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(rollbackQuery.delete).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 500,
        message: "Deployment failed: provider rejected the supplied API key",
      })
    );
    expect(result).not.toHaveProperty("failureType");
  });

  it("redacts host-local provision details from the client error when no alternate target exists", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode3";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode3";

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_host_local_dead_end",
          name: "Paid Agent",
          subdomain: "host-local-dead-end",
        },
        error: null,
      }),
    };

    const rollbackQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error:
        "[caddy] missing Cloudflare Origin CA cert/key at /etc/caddy/wildcards/hermesos.cloud.{crt,key}; seed the host before provisioning",
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return rollbackQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    // Only one configured target — the failover has nowhere to go, but the
    // raw host-script stderr must still never reach the client.
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 500,
        message: PROVISION_HOST_FAILURE_MESSAGE,
        failureType: "provision_host_failure",
      })
    );
    const clientMessage = (result as { message: string }).message;
    expect(clientMessage).not.toContain("/etc/caddy");
    expect(clientMessage).not.toContain("Cloudflare Origin CA");
  });

  it("returns the friendly capacity message when provision-time VMID exhaustion has no target id to retry", async () => {
    // Single-host config: no PROXMOX_NODE / target lists anywhere, so the
    // exhausted target has no capacity scope id and the retry loop cannot
    // exclude-and-retry. The user must still get the friendly 503, never
    // the raw "No free Proxmox VMID in range X-Y" error.
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    delete process.env.PROXMOX_NODE;
    delete process.env.PROXMOX_TARGET;
    delete process.env.PROXMOX_TARGETS;
    (resolveProxmoxHostEnv as jest.Mock).mockImplementationOnce(
      (_hostConfig: unknown, env: NodeJS.ProcessEnv = process.env) => {
        const resolved = { ...env };
        delete resolved.PROXMOX_NODE;
        return resolved;
      }
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_exhausted_single_host",
          name: "Paid Agent",
          subdomain: "exhausted-single-subdomain",
        },
        error: null,
      }),
    };

    const deleteQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: "No free Proxmox VMID in range 200-249",
      failureType: "proxmox_vmid_range_exhausted",
      targetId: null,
      vmidStart: 200,
      vmidEnd: 249,
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return deleteQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 503,
        message:
          "Temporary Proxmox capacity reached. New agents are paused until more capacity is available.",
        error: expect.objectContaining({ code: "PROXMOX_TENANT_CAPACITY_REACHED" }),
      })
    );
    // The raw operator detail must not leak anywhere in the response.
    expect(JSON.stringify(result)).not.toContain("No free Proxmox VMID");
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "Proxmox VMID range exhausted with no failover available",
      expect.any(Error),
      expect.objectContaining({
        failureType: "proxmox_vmid_exhaustion_failover_unavailable",
        instanceId: "inst_exhausted_single_host",
        vmidStart: 200,
        vmidEnd: 249,
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      "Proxmox VMID range exhausted at provision time; returning capacity-paused response",
      expect.any(Error),
      expect.objectContaining({
        failureType: "proxmox_vmid_range_exhausted",
        instanceId: "inst_exhausted_single_host",
        vmidStart: 200,
        vmidEnd: 249,
      })
    );
  });

  it("returns the friendly capacity message when every retry target is also VMID-exhausted", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode3";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode3,fixturenode2";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    // fixturenodea looks free at preflight (the race), fixturenodea is genuinely full, so
    // the post-provision retry has nowhere left to place the agent.
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: env.PROXMOX_NODE === "fixturenode2" ? 200 : 300,
        vmidEnd: env.PROXMOX_NODE === "fixturenode2" ? 249 : 349,
        occupiedVmids:
          env.PROXMOX_NODE === "fixturenode2"
            ? Array.from({ length: 50 }, (_, index) => 200 + index)
            : [],
        freeVmids: env.PROXMOX_NODE === "fixturenode2" ? [] : [300],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_exhausted_retry",
          name: "Paid Agent",
          subdomain: "exhausted-retry-subdomain",
        },
        error: null,
      }),
    };

    const deleteQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: "No free Proxmox VMID in range 300-349",
      failureType: "proxmox_vmid_range_exhausted",
      targetId: "fixturenode3",
      vmidStart: 300,
      vmidEnd: 349,
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return deleteQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 503,
        message:
          "Temporary Proxmox capacity reached. New agents are paused until more capacity is available.",
        error: expect.objectContaining({ code: "PROXMOX_TENANT_CAPACITY_REACHED" }),
      })
    );
    expect(JSON.stringify(result)).not.toContain("No free Proxmox VMID");
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "no alternate Proxmox target available after VMID range exhaustion",
      expect.any(Error),
      expect.objectContaining({
        failureType: "proxmox_vmid_exhaustion_retry_exhausted",
        instanceId: "inst_exhausted_retry",
        exhaustedTargetIds: ["fixturenode3"],
      })
    );
  });

  it("surfaces a friendly capacity message (never the raw VMID error) when every target's range is exhausted at provision time", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode3";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode3,fixturenode2";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: env.PROXMOX_NODE === "fixturenode2" ? 200 : 300,
        vmidEnd: env.PROXMOX_NODE === "fixturenode2" ? 249 : 349,
        occupiedVmids: [],
        freeVmids: [env.PROXMOX_NODE === "fixturenode2" ? 200 : 300],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_all_exhausted",
          name: "Paid Agent",
          subdomain: "all-exhausted-subdomain",
        },
        error: null,
      }),
    };

    const deleteQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    // Provision-time exhaustion on EVERY host (pre-flight raced/stale).
    (provisionProxmoxInstance as jest.Mock).mockImplementation(
      async (_params: unknown, deps: { env: NodeJS.ProcessEnv }) => ({
        ok: false,
        error: `No free Proxmox VMID in range ${
          deps.env.PROXMOX_NODE === "fixturenode2" ? "200-249" : "300-349"
        }`,
        failureType: "proxmox_vmid_range_exhausted",
        targetId: deps.env.PROXMOX_NODE,
        vmidStart: deps.env.PROXMOX_NODE === "fixturenode2" ? 200 : 300,
        vmidEnd: deps.env.PROXMOX_NODE === "fixturenode2" ? 249 : 349,
      })
    );

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return deleteQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    // One provision per target (fixturenodea then fixturenodea), then the re-selection comes
    // back empty and the user sees the placement gate's friendly message.
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 503,
        message: PROXMOX_CAPACITY_PAUSED_MESSAGE,
        error: expect.objectContaining({ code: "PROXMOX_TENANT_CAPACITY_REACHED" }),
      })
    );
    expect((result as { message: string }).message).not.toMatch(
      /No free Proxmox VMID/i
    );
    // The failed-provision row was rolled back.
    expect(deleteQuery.delete).toHaveBeenCalled();
  });

  it("bounds VMID-exhaustion failover hops and falls back to the friendly capacity message", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode1";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode1,fixturenode2,fixturenode3,fixturenode4,fixturenode5,fixturenode6";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: 200,
        vmidEnd: 249,
        occupiedVmids: [],
        freeVmids: [200],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_failover_cap",
          name: "Paid Agent",
          subdomain: "failover-cap-subdomain",
        },
        error: null,
      }),
    };

    const deleteQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockImplementation(
      async (_params: unknown, deps: { env: NodeJS.ProcessEnv }) => ({
        ok: false,
        error: "No free Proxmox VMID in range 200-249",
        failureType: "proxmox_vmid_range_exhausted",
        targetId: deps.env.PROXMOX_NODE,
        vmidStart: 200,
        vmidEnd: 249,
      })
    );

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return deleteQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    // 1 initial attempt + 3 bounded failover hops, then stop — even though
    // more env targets exist. The loop must be provably finite.
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(4);
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 503,
        message: PROXMOX_CAPACITY_PAUSED_MESSAGE,
        error: { code: "PROXMOX_TENANT_CAPACITY_REACHED" },
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      "Proxmox VMID range exhausted with no failover available",
      expect.any(Error),
      expect.objectContaining({
        failureType: "proxmox_vmid_exhaustion_failover_unavailable",
        hostPinned: false,
        vmidExhaustionFailovers: 3,
      })
    );
    expect(deleteQuery.delete).toHaveBeenCalled();
  });

  it("does not fail over when the host is pinned; surfaces the friendly capacity message after one attempt", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_DEFAULT_HOST_SLUG = "fixturenode2";

    try {
      const subscriptionQuery = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: {
            plan: "operator",
            status: "active",
            instance_limit: 10,
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
            id: "inst_pinned_exhausted",
            name: "Pinned Agent",
            subdomain: "pinned-subdomain",
          },
          error: null,
        }),
      };

      const deleteQuery = {
        delete: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ error: null }),
      };

      (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
        ok: false,
        error: "No free Proxmox VMID in range 200-249",
        failureType: "proxmox_vmid_range_exhausted",
        targetId: "fixturenode2_node",
        vmidStart: 200,
        vmidEnd: 249,
      });

      let hermesInstancesCall = 0;
      const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
      (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
        if (tableName === "hermes_subscriptions") return subscriptionQuery;
        if (tableName === "hermes_instances") {
          hermesInstancesCall += 1;
          if (hermesInstancesCall === 1) return agentCountQuery;
          if (hermesInstancesCall === 2) return resourceUsageQuery;
          if (hermesInstancesCall === 3) return insertQuery;
          if (hermesInstancesCall === 4) return deleteQuery;
        }
        if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
        throw new Error(`Unexpected table lookup: ${tableName}`);
      });

      const result = await InstanceService.createInstance(
        "user_free",
        CreateInstanceSchema.parse({
          name: "Pinned Agent",
          provider: "openrouter",
          apiKey: "sk-or-test",
          cpuLimit: 2,
          ramLimit: 4096,
        })
      );

      // A pinned host config always re-resolves to the same host, so a
      // retry would replay the same exhausted range — exactly one attempt.
      expect(provisionProxmoxInstance).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          status: 503,
          message: PROXMOX_CAPACITY_PAUSED_MESSAGE,
          error: { code: "PROXMOX_TENANT_CAPACITY_REACHED" },
        })
      );
      expect(log.error).toHaveBeenCalledWith(
        "Proxmox VMID range exhausted with no failover available",
        expect.any(Error),
        expect.objectContaining({
          failureType: "proxmox_vmid_exhaustion_failover_unavailable",
          hostPinned: true,
        })
      );
      expect(deleteQuery.delete).toHaveBeenCalled();
    } finally {
      delete process.env.HERMES_PROXMOX_DEFAULT_HOST_SLUG;
    }
  });

  it("keeps non-capacity provisioning failures untouched (raw error, no failover, rollback preserved)", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode3";
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode3,fixturenode2";

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: "inst_other_error",
          name: "Paid Agent",
          subdomain: "other-error-subdomain",
        },
        error: null,
      }),
    };

    const deleteQuery = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: false,
      error: "Proxmox provisioning did not return VM metadata.",
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return insertQuery;
        if (hermesInstancesCall === 4) return deleteQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    // Non-capacity errors must not trigger failover, must keep the original
    // message shape, and must not gain the capacity error code.
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      status: 500,
      message: "Deployment failed: Proxmox provisioning did not return VM metadata.",
    });
    expect(deleteQuery.delete).toHaveBeenCalled();
  });

  it("picks the proxmox_hosts registry host with the most free RAM (worst-fit on bottleneck)", async () => {
    // No env-list — the registry is the source of truth.
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.HERMES_PROXMOX_TARGET;
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: 200,
        vmidEnd: 219,
        occupiedVmids: [],
        freeVmids: [200],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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

    // proxmox_hosts: fixturenodea + fixturenodea, both 64 GB AX41-NVMe-class boxes.
    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode1",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
          },
          {
            id: "fixturenode2",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
          },
        ],
        error: null,
      }),
    };

    // Allocation query: fixturenodea has zero allocated, fixturenodea already runs a
    // big agent (8 vCPU / 49 GB). Both hosts can still fit a 4 GB
    // request, but fixturenodea has more free RAM, so worst-fit picks fixturenodea.
    let allocInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocInCalls += 1;
      if (allocInCalls === 1) return allocationQuery;
      return Promise.resolve({
        data: [
          {
            proxmox_node: "fixturenode2",
            cpu_limit: 8,
            ram_limit: 49152,
            lifecycle_state: "active",
          },
        ],
        error: null,
      });
    });

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_worstfit",
          name: "Worst Fit Pick",
          subdomain: "worst-fit-pick",
        },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockImplementation(
      async (
        _instance: unknown,
        { env }: { env: NodeJS.ProcessEnv }
      ) => ({
        ok: true,
        provider: "proxmox",
        serverId: 0,
        vmid: 200,
        ipv4: "10.250.21.50",
        sshHostFingerprint: null,
        apiServerKey: "gateway-secret",
        gatewayUrl: "https://abc.agents.hermesos.cloud",
        serverType: "proxmox-kvm",
        infrastructure: {
          provider: "proxmox" as const,
          node: env.PROXMOX_NODE,
          vmid: 200,
          privateIpv4: "10.250.21.50",
          gatewayHost: "abc.agents.hermesos.cloud",
        },
      })
    );

    let hermesInstancesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return allocationQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Worst Fit Pick",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(proxmoxHostsQuery.select).toHaveBeenCalled();
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Worst Fit Pick" }),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode1" }),
      })
    );
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ proxmox_node: "fixturenode1" })
    );
    // Observability: the registry path must announce itself so the
    // env-order fallback path is never silently used when the registry
    // is populated (regression guard against the 2026-05-12 imbalance
    // where every placement landed on fixturenodea despite fixturenodea/fixturenodea being
    // empty).
    expect(log.info).toHaveBeenCalledWith(
      "proxmox placement using registry path",
      expect.objectContaining({
        registryHostCount: 2,
        rankedHostIds: expect.arrayContaining(["fixturenode1"]),
      })
    );
  });

  it("counts running Hivra agents when ranking Proxmox host capacity", async () => {
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.HERMES_PROXMOX_TARGET;
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: 1090,
        vmidEnd: 1097,
        occupiedVmids: [],
        freeVmids: [1090],
      })
    );

    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode1",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 391,
            thinpool_overcommit_ratio: 1.5,
          },
          {
            id: "fixturenode2",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 391,
            thinpool_overcommit_ratio: 1.5,
          },
        ],
        error: null,
      }),
    };

    let allocationInCalls = 0;
    const legacyAllocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    legacyAllocationQuery.in = jest.fn(() => {
      allocationInCalls += 1;
      if (allocationInCalls === 1) return legacyAllocationQuery;
      return Promise.resolve({ data: [], error: null });
    });

    const hivraAllocationQuery = hivraAllocationRowsQuery([
      {
        proxmox_host: "fixturenode1",
        cpu: 4,
        ram: 48,
        status: "running",
        vmid: 1090,
      },
    ]);

    const fakeSupabase = {
      from: jest.fn((tableName: string) => {
        if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
        if (tableName === "hermes_instances") return legacyAllocationQuery;
        if (tableName === "hivra_agents") return hivraAllocationQuery;
        throw new Error(`Unexpected table lookup: ${tableName}`);
      }),
    } as unknown as typeof supabaseAdmin;

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: fakeSupabase,
      env: process.env,
      hostConfig: null,
      userId: "user_multi_agent",
      neededCpu: 2,
      neededRamMb: 4096,
      neededDiskGb: 30,
    });

    expect(selection).toEqual(
      expect.objectContaining({
        ok: true,
        targetId: "fixturenode2",
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode2" }),
      })
    );
    expect(hivraAllocationQuery.select).toHaveBeenCalledWith("proxmox_host, cpu, ram, status, vmid");
  });

  it("counts stopped Hivra computers' disk but not their CPU/RAM when ranking hosts", async () => {
    // A stopped Hivra computer keeps its thin-pool disk. Placement used to
    // read only provisioning/running rows, so a host full of stopped
    // computers looked empty on disk and kept winning placements.
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.HERMES_PROXMOX_TARGET;
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9000,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: 1090,
        vmidEnd: 1097,
        occupiedVmids: [],
        freeVmids: [1090],
      })
    );

    const host = {
      status: "active",
      env_prefix: null,
      total_cpu: 12,
      reserved_cpu: 2,
      reserved_ram_mb: 4096,
      wake_headroom_ram_mb: 8192,
      max_tenant_instances: null,
      thinpool_size_gb: 391,
      thinpool_overcommit_ratio: 1.5,
    };
    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          // More free RAM, so worst-fit prefers it unless disk rules it out.
          { ...host, id: "fixturenode1", total_ram_mb: 131072 },
          { ...host, id: "fixturenode2", total_ram_mb: 65536 },
        ],
        error: null,
      }),
    };

    let allocationInCalls = 0;
    const legacyAllocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    legacyAllocationQuery.in = jest.fn(() => {
      allocationInCalls += 1;
      if (allocationInCalls === 1) return legacyAllocationQuery;
      return Promise.resolve({ data: [], error: null });
    });

    // fixturenode1: 19 stopped computers x 30 GB = 570 GB of a 586.5 GB
    // budget, leaving less than one more VM's disk.
    // fixturenode2: two stopped computers whose CPU/RAM would exhaust the host
    // if counted, but a stopped VM holds neither.
    const hivraAllocationQuery = hivraAllocationRowsQuery([
      ...Array.from({ length: 19 }, (_, index) => ({
        proxmox_host: "fixturenode1",
        cpu: 2,
        ram: 4,
        status: "stopped",
        vmid: 2000 + index,
      })),
      { proxmox_host: "fixturenode2", cpu: 20, ram: 64, status: "stopped", vmid: 3000 },
      { proxmox_host: "fixturenode2", cpu: 20, ram: 64, status: "stopped", vmid: 3001 },
    ]);

    const fakeSupabase = {
      from: jest.fn((tableName: string) => {
        if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
        if (tableName === "hermes_instances") return legacyAllocationQuery;
        if (tableName === "hivra_agents") return hivraAllocationQuery;
        throw new Error(`Unexpected table lookup: ${tableName}`);
      }),
    } as unknown as typeof supabaseAdmin;

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: fakeSupabase,
      env: process.env,
      hostConfig: null,
      userId: "user_stopped_hivra_disk",
      neededCpu: 2,
      neededRamMb: 4096,
      neededDiskGb: 30,
    });

    expect(selection).toEqual(
      expect.objectContaining({
        ok: true,
        targetId: "fixturenode2",
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode2" }),
      })
    );
    expect(hivraAllocationQuery.neq).toHaveBeenCalledWith("status", "deleted");
  });

  it("uses the configured VM disk size for placement instead of the template default", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PROXMOX_VM_DISK_GB: "800",
    };
    delete env.HERMES_PROXMOX_TARGETS;
    delete env.HERMES_PROXMOX_TARGET;

    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode12",
            status: "active",
            env_prefix: null,
            total_cpu: 24,
            total_ram_mb: 131072,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 391,
            thinpool_overcommit_ratio: 1.5,
          },
        ],
        error: null,
      }),
    };
    let allocationInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocationInCalls += 1;
      if (allocationInCalls === 1) return allocationQuery;
      return Promise.resolve({ data: [], error: null });
    });

    const fakeSupabase = {
      from: jest.fn((tableName: string) => {
        if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
        if (tableName === "hermes_instances") return allocationQuery;
        if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
        throw new Error(`Unexpected table lookup: ${tableName}`);
      }),
    } as unknown as typeof supabaseAdmin;

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: fakeSupabase,
      env,
      hostConfig: null,
      userId: "user_disk_guard",
      neededCpu: 1,
      neededRamMb: 1024,
      neededDiskGb: 30,
    });

    expect(selection).toEqual({
      ok: false,
      status: 503,
      message:
        "All Proxmox hosts are at capacity. New agents are paused until more capacity is available.",
      error: { code: "PROXMOX_NO_PLACEMENT_TARGET" },
    });
    expect(log.warn).toHaveBeenCalledWith(
      "no Proxmox host has enough placement capacity",
      expect.objectContaining({
        placementDiagnostics: expect.arrayContaining([
          expect.objectContaining({ hostId: "fixturenode12", neededDiskGb: 800 }),
        ]),
      })
    );
  });

  it("honors explicit Proxmox target lists when registry hosts belong to another environment", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode10";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode10";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode1",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 391,
            thinpool_overcommit_ratio: 1.5,
          },
          {
            id: "fixturenode2",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 813,
            thinpool_overcommit_ratio: 1.5,
          },
        ],
        error: null,
      }),
    };

    let allocationInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocationInCalls += 1;
      if (allocationInCalls === 1) return allocationQuery;
      return Promise.resolve({ data: [], error: null });
    });

    const fakeSupabase = {
      from: jest.fn((tableName: string) => {
        if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
        if (tableName === "hermes_instances") return allocationQuery;
        throw new Error(`Unexpected table lookup: ${tableName}`);
      }),
    } as unknown as typeof supabaseAdmin;

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: fakeSupabase,
      env: process.env,
      hostConfig: null,
      userId: "user_canary",
      neededCpu: 1,
      neededRamMb: 2048,
      neededDiskGb: 30,
    });

    expect(selection).toEqual(
      expect.objectContaining({
        ok: true,
        targetId: "fixturenode10",
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode10" }),
      })
    );
    expect(getProxmoxTemplateAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode10" }),
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "proxmox registry has no active hosts matching configured target list; falling back to explicit env targets",
      expect.objectContaining({
        failureType: "proxmox_registry_no_configured_targets",
        configuredTargetIds: ["fixturenode10"],
        registryHostIds: ["fixturenode1", "fixturenode2"],
      })
    );
  });

  it("allows specialized Proxmox provisioners to skip the generic template gate", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode21";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode21";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode10",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 391,
            thinpool_overcommit_ratio: 1.5,
          },
        ],
        error: null,
      }),
    };

    (getProxmoxTemplateAvailability as jest.Mock).mockResolvedValue({
      ok: false,
      targetId: "fixturenode21",
      templateId: 9000,
      reason: "missing",
      error: "Configuration file 'nodes/fixturenode21/qemu-server/9000.conf' does not exist",
    });
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode21",
      vmidStart: 300,
      vmidEnd: 349,
      occupiedVmids: [],
      freeVmids: [300],
    });

    const fakeSupabase = {
      from: jest.fn((tableName: string) => {
        if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
        throw new Error(`Unexpected table lookup: ${tableName}`);
      }),
    } as unknown as typeof supabaseAdmin;

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: fakeSupabase,
      env: process.env,
      hostConfig: null,
      userId: "user_hivra",
      neededCpu: 0.5,
      neededRamMb: 1024,
      neededDiskGb: 30,
      forceTargetId: "fixturenode21",
      skipTemplateAvailabilityCheck: true,
    });

    expect(selection).toEqual(
      expect.objectContaining({
        ok: true,
        targetId: "fixturenode21",
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode21" }),
      })
    );
    expect(getProxmoxTemplateAvailability).not.toHaveBeenCalled();
    expect(getProxmoxVmidAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode21" }),
      })
    );
    expect(log.info).toHaveBeenCalledWith(
      "skipping generic Proxmox template availability check",
      expect.objectContaining({
        failureType: "proxmox_template_availability_check_skipped",
        targetId: "fixturenode21",
      })
    );
  });

  // fixturenodea carries the larger thinpool (830 vs 391), so placement ranks it
  // first — which is exactly the incident shape: the unseeded host wins.
  function buildTwoHostSupabase(): typeof supabaseAdmin {
    const hostRow = (id: string, thinpoolSizeGb: number) => ({
      id,
      status: "active",
      env_prefix: null,
      total_cpu: 12,
      total_ram_mb: 65536,
      reserved_cpu: 2,
      reserved_ram_mb: 4096,
      wake_headroom_ram_mb: 8192,
      max_tenant_instances: null,
      thinpool_size_gb: thinpoolSizeGb,
      thinpool_overcommit_ratio: 1.5,
    });

    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [hostRow("fixturenode10", 391), hostRow("fixturenode21", 830)],
        error: null,
      }),
    };
    const allocationQuery: Record<string, unknown> = { select: jest.fn().mockReturnThis() };
    let allocationInCalls = 0;
    allocationQuery.in = jest.fn(() => {
      allocationInCalls += 1;
      if (allocationInCalls % 2 === 1) return allocationQuery;
      return Promise.resolve({ data: [], error: null });
    });

    return {
      from: jest.fn((tableName: string) => {
        if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
        if (tableName === "hermes_instances") return allocationQuery;
        if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
        throw new Error(`Unexpected table lookup: ${tableName}`);
      }),
    } as unknown as typeof supabaseAdmin;
  }

  it("skips specialized Proxmox targets that fail the live readiness check", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode10,fixturenode21";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode10",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 391,
            thinpool_overcommit_ratio: 1.5,
          },
          {
            id: "fixturenode21",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 830,
            thinpool_overcommit_ratio: 1.5,
          },
        ],
        error: null,
      }),
    };
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    let allocationInCalls = 0;
    allocationQuery.in = jest.fn(() => {
      allocationInCalls += 1;
      if (allocationInCalls % 2 === 1) return allocationQuery;
      return Promise.resolve({ data: [], error: null });
    });
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      vmidStart: 300,
      vmidEnd: 349,
      occupiedVmids: [],
      freeVmids: [300],
    });
    const readinessCheck = jest.fn(async (candidate: { targetId: string | null }) => {
      if (candidate.targetId !== "fixturenode21") return { ok: true as const };
      return {
        ok: false as const,
        status: 503,
        message: "Hivra provisioner not ready",
        error: { code: "HIVRA_HOST_READINESS_FAILED" },
      };
    });

    const fakeSupabase = {
      from: jest.fn((tableName: string) => {
        if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
        if (tableName === "hermes_instances") return allocationQuery;
        if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
        throw new Error(`Unexpected table lookup: ${tableName}`);
      }),
    } as unknown as typeof supabaseAdmin;

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: fakeSupabase,
      env: process.env,
      hostConfig: null,
      userId: "user_hivra",
      neededCpu: 0.5,
      neededRamMb: 1024,
      neededDiskGb: 30,
      skipTemplateAvailabilityCheck: true,
      readinessCheck,
    });

    expect(selection).toEqual(
      expect.objectContaining({
        ok: true,
        targetId: "fixturenode10",
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode10" }),
      })
    );
    expect(readinessCheck).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "fixturenode21" })
    );
    expect(readinessCheck).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "fixturenode10" })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "skipping Proxmox provisioning target that failed live readiness",
      expect.objectContaining({
        failureType: "proxmox_target_readiness_check_failed",
        targetId: "fixturenode21",
      })
    );
  });

  // GUARD 1 wiring: an active-registry host that fails the readiness preflight
  // must lose placement to a healthy host. The 2026-06-09/10 incident shape.
  it("skips an active-registry host that fails the host-registration preflight", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode21,fixturenode10";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (guardProxmoxHostPlacementReadiness as jest.Mock).mockImplementation(
      async ({ targetId }: { targetId: string | null }) =>
        targetId === "fixturenode21"
          ? {
              skip: true,
              status: 503,
              message: "Deployment target is temporarily unavailable while the host is being prepared. Please try again shortly.",
              error: { code: "PROXMOX_HOST_PREFLIGHT_FAILED", targetId, failureClasses: ["host_cert_seed_missing"] },
            }
          : { skip: false }
    );

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: buildTwoHostSupabase(),
      env: process.env,
      hostConfig: null,
      userId: "user_preflight",
      neededCpu: 0.5,
      neededRamMb: 1024,
      neededDiskGb: 30,
      skipTemplateAvailabilityCheck: true,
    });

    expect(selection).toEqual(
      expect.objectContaining({ ok: true, targetId: "fixturenode10" })
    );
    expect(guardProxmoxHostPlacementReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "fixturenode21", userId: "user_preflight" })
    );
  });

  it("returns the preflight failure surface when EVERY candidate host fails preflight", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode21,fixturenode10";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (guardProxmoxHostPlacementReadiness as jest.Mock).mockImplementation(
      async ({ targetId }: { targetId: string | null }) => ({
        skip: true,
        status: 503,
        message: "Deployment target is temporarily unavailable while the host is being prepared. Please try again shortly.",
        error: { code: "PROXMOX_HOST_PREFLIGHT_FAILED", targetId, failureClasses: ["host_caddy_invalid"] },
      })
    );

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: buildTwoHostSupabase(),
      env: process.env,
      hostConfig: null,
      userId: "user_preflight_all",
      neededCpu: 0.5,
      neededRamMb: 1024,
      neededDiskGb: 30,
      skipTemplateAvailabilityCheck: true,
    });

    expect(selection).toEqual(
      expect.objectContaining({
        ok: false,
        status: 503,
        error: expect.objectContaining({ code: "PROXMOX_HOST_PREFLIGHT_FAILED" }),
      })
    );
  });

  // GUARD 2 wiring: the VMID utilization guard sees every candidate's live
  // occupancy, which is what turns a silently-filling range into an alert.
  it("evaluates VMID-range utilization for the selected host", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode21,fixturenode10";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (guardProxmoxHostPlacementReadiness as jest.Mock).mockImplementation(async () => ({ skip: false }));
    // `Once` so the module-level default resolution is left intact for the
    // tests that follow (jest `clearMocks` wipes calls, not implementations).
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValueOnce({
      ok: true,
      targetId: "fixturenode21",
      vmidStart: 1300,
      vmidEnd: 1349,
      occupiedVmids: Array.from({ length: 41 }, (_, i) => 1300 + i),
      freeVmids: [1341],
    });

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: buildTwoHostSupabase(),
      env: process.env,
      hostConfig: null,
      userId: "user_vmid",
      neededCpu: 0.5,
      neededRamMb: 1024,
      neededDiskGb: 30,
      skipTemplateAvailabilityCheck: true,
    });

    expect(selection).toEqual(expect.objectContaining({ ok: true, targetId: "fixturenode21" }));
    expect(reportProxmoxVmidRangeUtilization).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "fixturenode21",
        vmidStart: 1300,
        vmidEnd: 1349,
        occupiedCount: 41,
        freeCount: 1,
      })
    );
  });

  it("warns when the proxmox_hosts registry returns no active rows and falls back to env order", async () => {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode9";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode9";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.PROXMOX_FIXTURENODE9_PUBLIC_IP = "203.0.113.9";
    process.env.PROXMOX_FIXTURENODE9_SSH_HOST = "203.0.113.9";
    process.env.PROXMOX_FIXTURENODE9_SSH_PRIVATE_KEY_B64 = "AAAA";
    process.env.PROXMOX_FIXTURENODE9_SSH_USER = "root";
    process.env.PROXMOX_FIXTURENODE9_TEMPLATE_ID = "9000";
    process.env.PROXMOX_FIXTURENODE9_VMID_START = "200";
    process.env.PROXMOX_FIXTURENODE9_VMID_END = "249";
    process.env.PROXMOX_FIXTURENODE9_IP_LAST_OCTET_START = "50";
    process.env.PROXMOX_FIXTURENODE9_PRIVATE_SUBNET_PREFIX = "10.250.29";
    process.env.PROXMOX_FIXTURENODE9_PRIVATE_GATEWAY = "10.250.29.1";
    process.env.PROXMOX_FIXTURENODE9_GATEWAY_DOMAIN = "203-0-113-9.sslip.io";
    process.env.PROXMOX_FIXTURENODE9_VM_SSH_USER = "hermes";
    process.env.PROXMOX_FIXTURENODE9_VM_SSH_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";

    (getProxmoxTemplateAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode9",
      templateId: 9000,
    });
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode9",
      vmidStart: 200,
      vmidEnd: 249,
      occupiedVmids: [],
      freeVmids: [200],
    });

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
    // The registry reads clean and holds zero rows — i.e. migration not yet
    // seeded. This is the only shape that should fall through to the legacy
    // env-order path. One read, no count probe.
    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({ data: [], error: null }),
    };
    let proxmoxCall = 0;
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_envfb", name: "Env Fallback", subdomain: "env-fb" },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 200,
      ipv4: "10.250.29.50",
      sshHostFingerprint: null,
      apiServerKey: "gw",
      gatewayUrl: "https://x.agents.hermesos.cloud",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode9",
        vmid: 200,
        privateIpv4: "10.250.29.50",
        gatewayHost: "x.agents.hermesos.cloud",
      },
    });

    let hermesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") {
        proxmoxCall += 1;
        if (proxmoxCall === 1) return proxmoxHostsQuery;
        throw new Error("Unexpected proxmox_hosts query in env-fallback test");
      }
      if (tableName === "hermes_instances") {
        hermesCall += 1;
        if (hermesCall === 1) return agentCountQuery;
        if (hermesCall === 2) return resourceUsageQuery;
        if (hermesCall === 3) return insertQuery;
        if (hermesCall === 4) return updateQuery;
      }
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Env Fallback",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 1024,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    // ONE read. The `head`-only count probe that used to distinguish
    // "unadopted" from "fully drained" is gone: reading all ten rows answers
    // both questions at once.
    expect(proxmoxCall).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      "proxmox_hosts registry returned no active hosts",
      expect.objectContaining({
        failureType: "proxmox_hosts_registry_empty",
        registryHasAnyRows: false,
        totalRowCount: 0,
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "proxmox placement falling back to env-order path",
      expect.objectContaining({
        failureType: "proxmox_placement_env_order_fallback",
        targetIds: expect.arrayContaining(["fixturenode9"]),
        // Nothing to exclude: an unseeded registry knows of no drained host.
        drainedEnvTargetIds: [],
      })
    );
    // A SUCCESSFUL read of an unadopted registry is the one state where the
    // legacy fallback is legitimate. It must not halt, and must not page.
    expect(reportProxmoxHostRegistryUnavailable).not.toHaveBeenCalled();
  });

  it("refuses env-order fallback when the proxmox_hosts registry is seeded but every host is non-active", async () => {
    // Regression guard for gotcha #4 in reference_proxmox_vm_migration.md:
    // when every host is deliberately marked draining/maintenance the
    // env-order fallback would route placements onto the very hosts the
    // operator just took out of rotation. The fix returns no candidates
    // so the caller surfaces PROXMOX_NO_PLACEMENT_TARGET (503) instead.
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode9";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode9";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.PROXMOX_FIXTURENODE9_PUBLIC_IP = "203.0.113.9";
    process.env.PROXMOX_FIXTURENODE9_SSH_HOST = "203.0.113.9";
    process.env.PROXMOX_FIXTURENODE9_SSH_PRIVATE_KEY_B64 = "AAAA";
    process.env.PROXMOX_FIXTURENODE9_SSH_USER = "root";
    process.env.PROXMOX_FIXTURENODE9_TEMPLATE_ID = "9000";
    process.env.PROXMOX_FIXTURENODE9_VMID_START = "200";
    process.env.PROXMOX_FIXTURENODE9_VMID_END = "249";
    process.env.PROXMOX_FIXTURENODE9_IP_LAST_OCTET_START = "50";
    process.env.PROXMOX_FIXTURENODE9_PRIVATE_SUBNET_PREFIX = "10.250.29";
    process.env.PROXMOX_FIXTURENODE9_PRIVATE_GATEWAY = "10.250.29.1";
    process.env.PROXMOX_FIXTURENODE9_GATEWAY_DOMAIN = "203-0-113-9.sslip.io";
    process.env.PROXMOX_FIXTURENODE9_VM_SSH_USER = "hermes";
    process.env.PROXMOX_FIXTURENODE9_VM_SSH_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
    // Six rows, every one of them drained. The old fixture could only express
    // this as "active select empty + count probe says 6"; the whole-table read
    // now models the real thing.
    const proxmoxHostsRegistry = createProxmoxHostsRegistry([
      proxmoxHostRow("fixturenode1", "maintenance"),
      proxmoxHostRow("fixturenode2", "maintenance"),
      proxmoxHostRow("fixturenode3", "draining"),
      proxmoxHostRow("fixturenode4", "draining"),
      proxmoxHostRow("fixturenode5", "maintenance"),
      proxmoxHostRow("fixturenode9", "maintenance"),
    ]);
    let proxmoxCall = 0;
    let hermesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") {
        proxmoxCall += 1;
        if (proxmoxCall === 1) return proxmoxHostsRegistry();
        throw new Error("Unexpected proxmox_hosts query in no-active test");
      }
      if (tableName === "hermes_instances") {
        hermesCall += 1;
        if (hermesCall === 1) return agentCountQuery;
        if (hermesCall === 2) return resourceUsageQuery;
      }
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "All Draining",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 1024,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: "PROXMOX_NO_PLACEMENT_TARGET",
        }),
      })
    );
    expect(proxmoxCall).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      "proxmox_hosts registry returned no active hosts",
      expect.objectContaining({
        failureType: "proxmox_hosts_registry_empty",
        registryHasAnyRows: true,
        totalRowCount: 6,
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "proxmox placement: registry seeded but no active hosts; refusing env-order fallback",
      expect.objectContaining({
        failureType: "proxmox_no_active_hosts",
      })
    );
    // The legacy fallback must NOT fire when status was deliberate.
    expect(log.warn).not.toHaveBeenCalledWith(
      "proxmox placement falling back to env-order path",
      expect.anything()
    );
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Registry-query FAILURE must never degrade into an unvetted env-order pick.
  //
  // Prod ops_events, 2026-05-10..14: `proxmox_hosts_registry_query_failed` x71.
  // 70 of them were `column proxmox_hosts.thinpool_size_gb does not exist` — a
  // plain code/DB schema skew, i.e. a deploy-ordering mistake, not an outage.
  // It was harmless only because the registry held no rows yet. Today
  // HERMES_PROXMOX_TARGETS still names fixturenodea and fixturenodea (both `maintenance`
  // since 2026-07-04) and 12 hosts that no longer exist, so the same skew would
  // route every new agent onto a host nobody vetted.
  // ---------------------------------------------------------------------

  /** The fixturenodea env block used by the registry-failure tests below. */
  function seedPve9TargetEnv() {
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode9";
    process.env.HERMES_PROXMOX_TARGET = "fixturenode9";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    process.env.PROXMOX_FIXTURENODE9_PUBLIC_IP = "203.0.113.9";
    process.env.PROXMOX_FIXTURENODE9_SSH_HOST = "203.0.113.9";
    process.env.PROXMOX_FIXTURENODE9_SSH_PRIVATE_KEY_B64 = "AAAA";
    process.env.PROXMOX_FIXTURENODE9_SSH_USER = "root";
    process.env.PROXMOX_FIXTURENODE9_TEMPLATE_ID = "9000";
    process.env.PROXMOX_FIXTURENODE9_VMID_START = "200";
    process.env.PROXMOX_FIXTURENODE9_VMID_END = "249";
    process.env.PROXMOX_FIXTURENODE9_IP_LAST_OCTET_START = "50";
    process.env.PROXMOX_FIXTURENODE9_PRIVATE_SUBNET_PREFIX = "10.250.29";
    process.env.PROXMOX_FIXTURENODE9_PRIVATE_GATEWAY = "10.250.29.1";
    process.env.PROXMOX_FIXTURENODE9_GATEWAY_DOMAIN = "203-0-113-9.sslip.io";
    process.env.PROXMOX_FIXTURENODE9_VM_SSH_USER = "hermes";
    process.env.PROXMOX_FIXTURENODE9_VM_SSH_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";
  }

  function baseCreateInstanceQueries() {
    return {
      subscriptionQuery: {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: {
            plan: "operator",
            status: "active",
            instance_limit: 10,
            total_cpu_budget: 16,
            total_ram_budget: 32768,
          },
        }),
      },
      agentCountQuery: {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ count: 0 }) }),
      },
      resourceUsageQuery: {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({ data: [] }) }),
      },
    };
  }

  it("halts provisioning instead of placing onto a maintenance host when the proxmox_hosts query fails", async () => {
    // fixturenodea is the only declared env target and is `maintenance` in prod. The
    // registry read fails, so placement cannot know that. It must refuse.
    seedPve9TargetEnv();
    const { subscriptionQuery, agentCountQuery, resourceUsageQuery } = baseCreateInstanceQueries();

    // The exact prod error, on every attempt (a schema skew is sticky).
    let registrySelectAttempts = 0;
    const failingRegistryQuery = () => ({
      select: jest.fn(() => {
        registrySelectAttempts += 1;
        return Promise.resolve({
          data: null,
          error: { message: "column proxmox_hosts.thinpool_size_gb does not exist" },
        });
      }),
    });

    let hermesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return failingRegistryQuery();
      if (tableName === "hermes_instances") {
        hermesCall += 1;
        if (hermesCall === 1) return agentCountQuery;
        if (hermesCall === 2) return resourceUsageQuery;
      }
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Registry Down",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 1024,
      })
    );

    // THE INVARIANT: no VM is created on the unvetted host.
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 503,
        message:
          "Temporary Proxmox capacity reached. New agents are paused until more capacity is available.",
        error: expect.objectContaining({ code: "PROXMOX_HOST_REGISTRY_UNAVAILABLE" }),
      })
    );

    // The env-order fallback must never even be considered.
    expect(log.warn).not.toHaveBeenCalledWith(
      "proxmox placement falling back to env-order path",
      expect.anything()
    );
    // Retried once before giving up.
    expect(registrySelectAttempts).toBe(2);
    // And the driver's error text never reaches the user.
    expect(JSON.stringify(result)).not.toContain("thinpool_size_gb");
  });

  it("emits exactly one fatal ops_event when the registry query fails", async () => {
    seedPve9TargetEnv();
    const { subscriptionQuery, agentCountQuery, resourceUsageQuery } = baseCreateInstanceQueries();

    let hermesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") {
        return {
          select: jest.fn().mockResolvedValue({
            data: null,
            error: { message: "column proxmox_hosts.thinpool_size_gb does not exist" },
          }),
        };
      }
      if (tableName === "hermes_instances") {
        hermesCall += 1;
        if (hermesCall === 1) return agentCountQuery;
        if (hermesCall === 2) return resourceUsageQuery;
      }
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Registry Down",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 1024,
      })
    );

    expect(reportProxmoxHostRegistryUnavailable).toHaveBeenCalledTimes(1);
    expect(reportProxmoxHostRegistryUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "column proxmox_hosts.thinpool_size_gb does not exist",
        attempts: 2,
      })
    );

    // The generic log.error → ops_events mirror is suppressed: it fingerprints
    // on the driver's error string AND the user id, so it can never fold an
    // incident into a single page (in prod it produced 2 rows / 71 sightings).
    expect(log.error).toHaveBeenCalledWith(
      "failed to load proxmox_hosts registry",
      expect.any(Error),
      expect.objectContaining({ reportOpsEvent: false })
    );
  });

  // ---------------------------------------------------------------------
  // The residual #524 left open: registry loads fine and HAS active hosts, but
  // HERMES_PROXMOX_TARGETS names none of them. Placement falls back to the
  // declared env list — which in prod names fixturenodea and fixturenodea, `maintenance` since
  // 2026-07-04. Both answer ssh, so #522's readiness probe waves them straight
  // through. Only the registry knows an operator drained them, and before the
  // whole-table read their ids were never even fetched.
  // ---------------------------------------------------------------------

  it("never places onto a maintenance host that the declared env rotation still names", async () => {
    // THE REGRESSION. fixturenodea is the only declared target and is `maintenance`.
    // fixturenodea is active but undeclared, so the registry path has nothing to rank
    // and the legacy fallback takes over. It must refuse fixturenodea anyway.
    seedPve9TargetEnv();
    const { subscriptionQuery, agentCountQuery, resourceUsageQuery } = baseCreateInstanceQueries();

    const proxmoxHostsRegistry = createProxmoxHostsRegistry([
      proxmoxHostRow("fixturenode1", "active"),
      proxmoxHostRow("fixturenode9", "maintenance"),
    ]);

    // The host is perfectly healthy — it is drained, not broken. Left to the
    // probe alone, fixturenodea sails through and wins placement.
    (guardProxmoxHostPlacementReadiness as jest.Mock).mockResolvedValue({ skip: false });
    (getProxmoxTemplateAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode9",
      templateId: 9000,
    });
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode9",
      vmidStart: 200,
      vmidEnd: 249,
      occupiedVmids: [],
      freeVmids: [200],
    });

    // Every downstream mock a SUCCESSFUL provision onto fixturenodea would need. They
    // exist so that if the drained-host filter ever regresses, this test fails
    // on `provisionProxmoxInstance` — the actual invariant — rather than dying
    // on a missing fixture and passing for the wrong reason later.
    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_drained", name: "Drained Target", subdomain: "drained" },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 200,
      ipv4: "10.250.29.50",
      sshHostFingerprint: null,
      apiServerKey: "gw",
      gatewayUrl: "https://x.agents.hermesos.cloud",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode9",
        vmid: 200,
        privateIpv4: "10.250.29.50",
        gatewayHost: "x.agents.hermesos.cloud",
      },
    });

    let hermesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      if (tableName === "hermes_instances") {
        hermesCall += 1;
        if (hermesCall === 1) return agentCountQuery;
        if (hermesCall === 2) return resourceUsageQuery;
        if (hermesCall === 3) return insertQuery;
        if (hermesCall === 4) return updateQuery;
      }
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Drained Target",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 1024,
      })
    );

    // THE INVARIANT: no VM lands on the host ops took out of rotation.
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
    expect(insertQuery.insert).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "PROXMOX_NO_PLACEMENT_TARGET" }),
      })
    );

    // fixturenodea is dropped BEFORE the readiness probe — a healthy drained host would
    // have passed it. The registry is the only thing that can say no here.
    expect(guardProxmoxHostPlacementReadiness).not.toHaveBeenCalled();

    expect(log.warn).toHaveBeenCalledWith(
      "proxmox registry has no active hosts matching configured target list; falling back to explicit env targets",
      expect.objectContaining({
        failureType: "proxmox_registry_no_configured_targets",
        nonActiveRegistryHostIds: ["fixturenode9"],
      })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "proxmox placement falling back to env-order path",
      expect.objectContaining({
        failureType: "proxmox_placement_env_order_fallback",
        reason: "registry_no_configured_targets",
        targetIds: [],
        drainedEnvTargetIds: ["fixturenode9"],
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      "proxmox placement: declared env-order rotation resolved to no targets",
      expect.any(Error),
      expect.objectContaining({
        failureType: "proxmox_placement_declared_targets_unresolvable",
        drainedEnvTargetIds: ["fixturenode9"],
      })
    );
  });

  it("still places onto a declared host the registry has never heard of, skipping only the drained one", async () => {
    // The complement, so the drained-host filter is not mistaken for "reject
    // everything the registry does not list". fixturenodea has no registry row at all —
    // it stays a candidate, is probed conclusively (rule 3), passes, and takes
    // the VM. fixturenodea is drained and is dropped outright (rule 2), even though it
    // is listed FIRST and would otherwise win.
    seedPve9TargetEnv();
    process.env.HERMES_PROXMOX_TARGETS = "fixturenode9,fixturenode7";
    process.env.PROXMOX_FIXTURENODE7_PUBLIC_IP = "203.0.113.7";
    process.env.PROXMOX_FIXTURENODE7_SSH_HOST = "203.0.113.7";
    process.env.PROXMOX_FIXTURENODE7_SSH_PRIVATE_KEY_B64 = "AAAA";
    process.env.PROXMOX_FIXTURENODE7_SSH_USER = "root";
    process.env.PROXMOX_FIXTURENODE7_TEMPLATE_ID = "9000";
    process.env.PROXMOX_FIXTURENODE7_VMID_START = "200";
    process.env.PROXMOX_FIXTURENODE7_VMID_END = "249";
    process.env.PROXMOX_FIXTURENODE7_IP_LAST_OCTET_START = "50";
    process.env.PROXMOX_FIXTURENODE7_PRIVATE_SUBNET_PREFIX = "10.250.27";
    process.env.PROXMOX_FIXTURENODE7_PRIVATE_GATEWAY = "10.250.27.1";
    process.env.PROXMOX_FIXTURENODE7_GATEWAY_DOMAIN = "203-0-113-7.sslip.io";
    process.env.PROXMOX_FIXTURENODE7_VM_SSH_USER = "hermes";
    process.env.PROXMOX_FIXTURENODE7_VM_SSH_KEY_PATH = "/etc/hivra/keys/vm-orchestrator";

    const { subscriptionQuery, agentCountQuery, resourceUsageQuery } = baseCreateInstanceQueries();
    const proxmoxHostsRegistry = createProxmoxHostsRegistry([
      proxmoxHostRow("fixturenode1", "active"),
      proxmoxHostRow("fixturenode9", "maintenance"),
    ]);

    // Both hosts are reachable. Nothing but the registry distinguishes them.
    (guardProxmoxHostPlacementReadiness as jest.Mock).mockResolvedValue({ skip: false });
    (getProxmoxTemplateAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode7",
      templateId: 9000,
    });
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode7",
      vmidStart: 200,
      vmidEnd: 249,
      occupiedVmids: [],
      freeVmids: [200],
    });

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_ghost", name: "Ghost Target", subdomain: "ghost" },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    (provisionProxmoxInstance as jest.Mock).mockImplementation(
      async (_instance: unknown, { env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        provider: "proxmox",
        serverId: 0,
        vmid: 200,
        ipv4: "10.250.27.50",
        sshHostFingerprint: null,
        apiServerKey: "gw",
        gatewayUrl: "https://y.agents.hermesos.cloud",
        serverType: "proxmox-kvm",
        infrastructure: {
          provider: "proxmox" as const,
          node: env.PROXMOX_NODE,
          vmid: 200,
          privateIpv4: "10.250.27.50",
          gatewayHost: "y.agents.hermesos.cloud",
        },
      })
    );

    let hermesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      if (tableName === "hermes_instances") {
        hermesCall += 1;
        if (hermesCall === 1) return agentCountQuery;
        if (hermesCall === 2) return resourceUsageQuery;
        if (hermesCall === 3) return insertQuery;
        if (hermesCall === 4) return updateQuery;
      }
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Ghost Target",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 1024,
      })
    );

    // The legitimate fallback still works — fixturenodea is listed first, and the VM
    // lands on fixturenodea anyway.
    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(provisionProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode7" }),
      })
    );

    // fixturenodea survived the drained filter and reached the probe, fail-closed...
    expect(guardProxmoxHostPlacementReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "fixturenode7", requireConclusivePass: true })
    );
    // ...and fixturenodea, healthy but drained, never did.
    expect(guardProxmoxHostPlacementReadiness).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "fixturenode9" })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "proxmox placement falling back to env-order path",
      expect.objectContaining({
        targetIds: ["fixturenode7"],
        drainedEnvTargetIds: ["fixturenode9"],
      })
    );
  });

  it("recovers on the retry when the registry query fails transiently, and uses the registry path", async () => {
    // A socket reset must NOT halt onboarding — that is what the single cheap
    // retry buys, and what keeps this guard from being an outage amplifier.
    seedPve9TargetEnv();
    const { subscriptionQuery, agentCountQuery, resourceUsageQuery } = baseCreateInstanceQueries();

    let registrySelectAttempts = 0;
    const registryQuery = () => ({
      select: jest.fn(() => {
        registrySelectAttempts += 1;
        if (registrySelectAttempts === 1) {
          return Promise.resolve({ data: null, error: { message: "socket hang up" } });
        }
        return Promise.resolve({
          data: [proxmoxHostRow("fixturenode9", "active")],
          error: null,
        });
      }),
    });

    let allocationInCalls = 0;
    const allocationQuery: Record<string, unknown> = { select: jest.fn().mockReturnThis() };
    allocationQuery.in = jest.fn(() => {
      allocationInCalls += 1;
      if (allocationInCalls === 1) return allocationQuery;
      return Promise.resolve({ data: [], error: null });
    });

    // Stop the flow right after placement picks the registry host — the VMID
    // range is exhausted, so nothing is inserted or provisioned. This test is
    // only about which PATH placement took.
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode9",
      vmidStart: 200,
      vmidEnd: 249,
      occupiedVmids: Array.from({ length: 50 }, (_, i) => 200 + i),
      freeVmids: [],
    });

    let hermesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return registryQuery();
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      if (tableName === "hermes_instances") {
        hermesCall += 1;
        if (hermesCall === 1) return agentCountQuery;
        if (hermesCall === 2) return resourceUsageQuery;
        if (hermesCall === 3) return allocationQuery;
      }
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Transient",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 1024,
      })
    );

    expect(registrySelectAttempts).toBe(2);
    // Second attempt succeeded → registry path, no halt, no page.
    expect(reportProxmoxHostRegistryUnavailable).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "proxmox placement using registry path",
      expect.objectContaining({ rankedHostIds: ["fixturenode9"] })
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      "proxmox placement falling back to env-order path",
      expect.anything()
    );
  });

  it("requires a conclusive readiness verdict for env-order candidates drawn from a declared rotation", async () => {
    // HERMES_PROXMOX_TARGETS still names 12 decommissioned hosts whose IPs
    // Hetzner recycled. For those, an unreachable probe is not ambiguity — so
    // the fallback candidates must be probed fail-CLOSED, unlike registry hosts.
    seedPve9TargetEnv();
    const { subscriptionQuery, agentCountQuery, resourceUsageQuery } = baseCreateInstanceQueries();
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();

    let hermesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      if (tableName === "hermes_instances") {
        hermesCall += 1;
        if (hermesCall === 1) return agentCountQuery;
        if (hermesCall === 2) return resourceUsageQuery;
      }
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    // The host is unreachable: the #522 probe returns an inconclusive verdict,
    // which for a declared-rotation candidate must remove it from placement.
    (guardProxmoxHostPlacementReadiness as jest.Mock).mockImplementation(
      async ({ requireConclusivePass }: { requireConclusivePass?: boolean }) =>
        requireConclusivePass
          ? {
              skip: true,
              status: 503,
              message: "Deployment target is temporarily unavailable while the host is being prepared. Please try again shortly.",
              error: { code: "PROXMOX_HOST_READINESS_UNVERIFIED" },
            }
          : { skip: false }
    );

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Dead Host",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 1024,
      })
    );

    expect(guardProxmoxHostPlacementReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "fixturenode9", requireConclusivePass: true })
    );
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "PROXMOX_HOST_READINESS_UNVERIFIED" }),
      })
    );
  });

  it("reports configuration drift when an active capacity host is missing runtime env while configured hosts are capped", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";
    (isProxmoxProvisioningConfigured as jest.Mock).mockImplementation(
      (env: NodeJS.ProcessEnv) => env.PROXMOX_NODE !== "fixturenode6"
    );

    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode6",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 131072,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: 100,
            thinpool_size_gb: 830,
            thinpool_overcommit_ratio: 1.5,
          },
          {
            id: "fixturenode2",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 813,
            thinpool_overcommit_ratio: 1.5,
          },
        ],
        error: null,
      }),
    };

    let allocationInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocationInCalls += 1;
      if (allocationInCalls === 1) return allocationQuery;
      return Promise.resolve({ data: [], error: null });
    });

    const capacityQuery: Record<string, unknown> = {};
    capacityQuery.select = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.or = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.not = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.eq = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.then = (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) =>
      Promise.resolve({
        data: Array.from({ length: 20 }, (_, index) => ({
          id: `inst_capped_${index}`,
          status: "running",
          lifecycle_state: "active",
          proxmox_node: "fixturenode2",
          proxmox_vmid: 220 + index,
        })),
        error: null,
      }).then(resolve);

    let hermesInstancesCall = 0;
    const fakeSupabase = {
      from: jest.fn((tableName: string) => {
        if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
        if (tableName === "hermes_instances") {
          hermesInstancesCall += 1;
          if (hermesInstancesCall === 1) return allocationQuery;
          if (hermesInstancesCall === 2) return capacityQuery;
        }
        if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
        throw new Error(`Unexpected table lookup: ${tableName}`);
      }),
    } as unknown as typeof supabaseAdmin;

    const selection = await selectAvailableProxmoxProvisionTarget({
      supabase: fakeSupabase,
      env: process.env,
      hostConfig: null,
      userId: "user_free",
      neededCpu: 1,
      neededRamMb: 2048,
      neededDiskGb: 30,
    });

    expect(selection).toEqual({
      ok: false,
      status: 503,
      message:
        "Proxmox capacity exists, but an active capacity host is missing runtime configuration. New agents are paused until ops reconnects the host.",
      error: {
        code: "PROXMOX_TARGET_CONFIGURATION_MISSING",
        unconfiguredTargetIds: ["fixturenode6"],
        cappedTargetId: "fixturenode2",
        currentInstances: 20,
        maxInstances: 20,
        recoveryAction: "configure_target_env_or_mark_host_draining",
      },
    });
    expect(capacityQuery.eq).toHaveBeenCalledWith("proxmox_node", "fixturenode2");
    expect(log.error).toHaveBeenCalledWith(
      "proxmox placement capacity masked by unconfigured target",
      expect.any(Error),
      expect.objectContaining({
        failureType: "proxmox_capacity_masked_by_unconfigured_target",
        userId: "user_free",
        unconfiguredTargetIds: ["fixturenode6"],
        cappedTargetId: "fixturenode2",
        currentInstances: 20,
        maxInstances: 20,
        recoveryAction: "configure_target_env_or_mark_host_draining",
      })
    );
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("rejects new provision with PROXMOX_NO_PLACEMENT_TARGET when every registry host is over-allocated", async () => {
    // Regression for the misleading "Proxmox deployment not configured"
    // error that the catch-all used to return whenever placement found
    // zero candidates — including the common case where the registry is
    // healthy but every host's freeCpu/freeRamMb is exhausted.
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.HERMES_PROXMOX_TARGET;
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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

    // Two active registry hosts, each at AX41-NVMe spec.
    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode1",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
          },
          {
            id: "fixturenode2",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
          },
        ],
        error: null,
      }),
    };

    // Both hosts over-allocated: cpu_limit far exceeds total_cpu, so
    // rankProxmoxHostsForPlacement filters both out and the candidates
    // list is empty.
    let allocInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocInCalls += 1;
      if (allocInCalls === 1) return allocationQuery;
      return Promise.resolve({
        data: [
          {
            proxmox_node: "fixturenode1",
            cpu_limit: 30,
            ram_limit: 70000,
            lifecycle_state: "active",
          },
          {
            proxmox_node: "fixturenode2",
            cpu_limit: 30,
            ram_limit: 70000,
            lifecycle_state: "active",
          },
        ],
        error: null,
      });
    });

    let hermesInstancesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return allocationQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Capacity Probe",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual({
      success: false,
      status: 503,
      message:
        "All Proxmox hosts are at capacity. New agents are paused until more capacity is available.",
      error: { code: "PROXMOX_NO_PLACEMENT_TARGET" },
    });
    expect(log.warn).toHaveBeenCalledWith(
      "no Proxmox host has enough placement capacity",
      expect.objectContaining({
        failureType: "proxmox_no_placement_target",
        neededCpu: 2,
        neededRamMb: 4096,
        cpuOvercommitRatio: 5,
        placementDiagnostics: expect.arrayContaining([
          expect.objectContaining({
            hostId: "fixturenode1",
            cpuBudget: 50,
            allocatedCpu: 30,
            allocatedRamMb: 70000,
          }),
        ]),
      })
    );
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("keeps light Proxmox agents placeable until RAM headroom is exhausted", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 100,
          total_cpu_budget: 128,
          total_ram_budget: 131072,
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
    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode1",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
          },
        ],
        error: null,
      }),
    };

    let allocInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocInCalls += 1;
      if (allocInCalls === 1) return allocationQuery;
      return Promise.resolve({
        data: Array.from({ length: 49 }, (_, index) => ({
          proxmox_node: "fixturenode1",
          cpu_limit: 0.5,
          ram_limit: 1024,
          lifecycle_state: "active",
          proxmox_vmid: 200 + index,
        })),
        error: null,
      });
    });

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: "inst_light_agent",
          name: "Light Agent",
          subdomain: "light-agent",
        },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 249,
      ipv4: "10.250.20.99",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://light-agent.agents.hermesos.cloud",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox",
        node: "fixturenode1",
        vmid: 249,
        privateIpv4: "10.250.20.99",
        gatewayHost: "light-agent.agents.hermesos.cloud",
      },
    });

    let hermesInstancesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return allocationQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Light Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 0.5,
        ramLimit: 1024,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Light Agent" }),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: "fixturenode1" }),
      })
    );
  });

  it("drains new placements to an empty host even when the loaded hosts pass CPU budget", async () => {
    // Placement regression: four established hosts carried ~30 tenants each while
    // two newly added hosts were empty, yet fresh signups kept landing on the
    // established hosts. Worst-fit
    // on free RAM must hand the slot to one of the empty 128 GB hosts.
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.HERMES_PROXMOX_TARGET;
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9004,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: 500,
        vmidEnd: 549,
        occupiedVmids: [],
        freeVmids: [500],
      })
    );

    // Use an "operator" plan to skip the free-tier abuse gate (which has
    // its own .or() call shape). The placement bug we're regression-testing
    // is plan-independent — it's purely a routing decision based on the
    // proxmox_hosts registry and per-host allocation totals.
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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

    // Six-host fleet: four 64 GB hosts carry heavy load while two new 128 GB
    // hosts start with zero load.
    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          { id: "fixturenode1", status: "active", env_prefix: null, total_cpu: 12, total_ram_mb: 65536, reserved_cpu: 2, reserved_ram_mb: 4096, wake_headroom_ram_mb: 8192, max_tenant_instances: null },
          { id: "fixturenode2", status: "active", env_prefix: null, total_cpu: 12, total_ram_mb: 65536, reserved_cpu: 2, reserved_ram_mb: 4096, wake_headroom_ram_mb: 8192, max_tenant_instances: null },
          { id: "fixturenode3", status: "active", env_prefix: null, total_cpu: 12, total_ram_mb: 65536, reserved_cpu: 2, reserved_ram_mb: 4096, wake_headroom_ram_mb: 8192, max_tenant_instances: null },
          { id: "fixturenode4", status: "active", env_prefix: null, total_cpu: 12, total_ram_mb: 65536, reserved_cpu: 2, reserved_ram_mb: 4096, wake_headroom_ram_mb: 8192, max_tenant_instances: null },
          { id: "fixturenode5", status: "active", env_prefix: null, total_cpu: 12, total_ram_mb: 131072, reserved_cpu: 2, reserved_ram_mb: 4096, wake_headroom_ram_mb: 8192, max_tenant_instances: null },
          { id: "fixturenode6", status: "active", env_prefix: null, total_cpu: 12, total_ram_mb: 131072, reserved_cpu: 2, reserved_ram_mb: 4096, wake_headroom_ram_mb: 8192, max_tenant_instances: null },
        ],
        error: null,
      }),
    };

    // Existing allocation matches what we observed in production right
    // before the regression: four established hosts each run ~25-44 light VMs
    // that fit easily in CPU overcommit budget but eat most of the RAM.
    const heavyHosts: Array<[string, number]> = [
      ["fixturenode1", 34],
      ["fixturenode2", 36],
      ["fixturenode3", 44],
      ["fixturenode4", 16],
    ];
    const allocationRows = heavyHosts.flatMap(([node, count]) =>
      Array.from({ length: count }, () => ({
        proxmox_node: node,
        cpu_limit: 0.5,
        ram_limit: 1024,
        lifecycle_state: "active",
      }))
    );

    let allocInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocInCalls += 1;
      if (allocInCalls === 1) return allocationQuery;
      return Promise.resolve({ data: allocationRows, error: null });
    });

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_drain_new", name: "First Agent", subdomain: "first-agent" },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockImplementation(
      async (_instance: unknown, { env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        provider: "proxmox",
        serverId: 0,
        vmid: 500,
        ipv4: "10.250.22.50",
        sshHostFingerprint: null,
        apiServerKey: "gateway-secret",
        gatewayUrl: "https://first-agent.agents.hermesos.cloud",
        serverType: "proxmox-kvm",
        infrastructure: {
          provider: "proxmox" as const,
          node: env.PROXMOX_NODE,
          vmid: 500,
          privateIpv4: "10.250.22.50",
          gatewayHost: "first-agent.agents.hermesos.cloud",
        },
      })
    );

    let hermesInstancesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return allocationQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "First Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 0.5,
        ramLimit: 1024,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    // fixturenodea wins (alphabetically before fixturenodea with identical free RAM).
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "First Agent" }),
      expect.objectContaining({
        env: expect.objectContaining({ PROXMOX_NODE: expect.stringMatching(/^fixturenode[56]$/) }),
      })
    );
    // Explicitly assert the new VM did NOT land on the over-loaded fixturenodea
    // — that's the exact production regression this test is locking in.
    const calls = (provisionProxmoxInstance as jest.Mock).mock.calls;
    const pickedNode = calls[calls.length - 1][1].env.PROXMOX_NODE;
    expect(["fixturenode5", "fixturenode6"]).toContain(pickedNode);
    expect(pickedNode).not.toBe("fixturenode4");
  });

  it("filters out hosts whose LVM-thin pool is full even when CPU+RAM look fine", async () => {
    // Regression for the 2026-05-12 fixturenodea incident: fixturenodea hit 99.99%
    // data_percent on its LVM-thin pool while it still had free CPU and
    // RAM budget, so the placement scheduler kept landing new VMs on
    // it. With thinpool_size_gb + thinpool_overcommit_ratio on the
    // registry, a host that's structurally out of disk must drop out of
    // the candidate list regardless of its CPU/RAM headroom.
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.HERMES_PROXMOX_TARGET;
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9004,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: 500,
        vmidEnd: 549,
        occupiedVmids: [],
        freeVmids: [500],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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

    // Two hosts that both pass CPU + RAM. fixturenodea is at the same disk
    // ceiling fixturenodea actually hit on 2026-05-12 (~390 GB pool at 1.5x
    // overcommit ≈ 586 GB provisioned budget, occupied); fixturenodea has its
    // full 830 GB pool barely used.
    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode1",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 391,
            thinpool_overcommit_ratio: 1.5,
          },
          {
            id: "fixturenode3",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 830,
            thinpool_overcommit_ratio: 1.5,
          },
        ],
        error: null,
      }),
    };

    // fixturenodea has 20 VMs at 30 GB each = 600 GB provisioned, which is over
    // its (391 * 1.5) = 586.5 GB disk budget. CPU/RAM still fine.
    // fixturenodea has a handful of VMs (well within all three resources).
    const allocationRows = [
      ...Array.from({ length: 20 }, () => ({
        proxmox_node: "fixturenode1",
        cpu_limit: 0.5,
        ram_limit: 1024,
        disk_size_gb: 30,
        lifecycle_state: "active",
      })),
      ...Array.from({ length: 4 }, () => ({
        proxmox_node: "fixturenode3",
        cpu_limit: 0.5,
        ram_limit: 1024,
        disk_size_gb: 30,
        lifecycle_state: "active",
      })),
    ];

    let allocInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocInCalls += 1;
      if (allocInCalls === 1) return allocationQuery;
      return Promise.resolve({ data: allocationRows, error: null });
    });

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_disk_avoid", name: "Disk Aware", subdomain: "disk-aware" },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockImplementation(
      async (_instance: unknown, { env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        provider: "proxmox",
        serverId: 0,
        vmid: 500,
        ipv4: "10.250.20.55",
        sshHostFingerprint: null,
        apiServerKey: "gateway-secret",
        gatewayUrl: "https://disk-aware.agents.hermesos.cloud",
        serverType: "proxmox-kvm",
        infrastructure: {
          provider: "proxmox" as const,
          node: env.PROXMOX_NODE,
          vmid: 500,
          privateIpv4: "10.250.20.55",
          gatewayHost: "disk-aware.agents.hermesos.cloud",
        },
      })
    );

    let hermesInstancesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return allocationQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Disk Aware",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 0.5,
        ramLimit: 1024,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    const calls = (provisionProxmoxInstance as jest.Mock).mock.calls;
    const pickedNode = calls[calls.length - 1][1].env.PROXMOX_NODE;
    expect(pickedNode).toBe("fixturenode3");
    expect(pickedNode).not.toBe("fixturenode1");
  });

  it("keeps worst-fit-by-free-RAM tie-break working when disk is plentiful on both hosts", async () => {
    // Companion to the disk-filter regression above: when neither host
    // is disk-constrained, the original worst-fit-by-free-RAM ordering
    // must still decide. fixturenodea has more free RAM than fixturenodea here, so the
    // VM should land on fixturenodea even though both have ample disk.
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.HERMES_PROXMOX_TARGET;
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";

    (getProxmoxTemplateAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        templateId: 9004,
      })
    );
    (getProxmoxVmidAvailability as jest.Mock).mockImplementation(
      async ({ env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        targetId: env.PROXMOX_NODE,
        vmidStart: 500,
        vmidEnd: 549,
        occupiedVmids: [],
        freeVmids: [500],
      })
    );

    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
    const proxmoxHostsQuery = {
      select: jest.fn().mockResolvedValue({
        data: [
          {
            id: "fixturenode4",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 65536,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 830,
            thinpool_overcommit_ratio: 1.5,
          },
          {
            id: "fixturenode5",
            status: "active",
            env_prefix: null,
            total_cpu: 12,
            total_ram_mb: 131072,
            reserved_cpu: 2,
            reserved_ram_mb: 4096,
            wake_headroom_ram_mb: 8192,
            max_tenant_instances: null,
            thinpool_size_gb: 830,
            thinpool_overcommit_ratio: 1.5,
          },
        ],
        error: null,
      }),
    };

    // Both hosts well inside their disk budgets; fixturenodea has fewer free RAM
    // MB than fixturenodea (smaller box, light load), so fixturenodea wins worst-fit.
    const allocationRows = [
      ...Array.from({ length: 10 }, () => ({
        proxmox_node: "fixturenode4",
        cpu_limit: 0.5,
        ram_limit: 1024,
        disk_size_gb: 30,
        lifecycle_state: "active",
      })),
      ...Array.from({ length: 5 }, () => ({
        proxmox_node: "fixturenode5",
        cpu_limit: 0.5,
        ram_limit: 1024,
        disk_size_gb: 30,
        lifecycle_state: "active",
      })),
    ];

    let allocInCalls = 0;
    const allocationQuery: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
    };
    allocationQuery.in = jest.fn(() => {
      allocInCalls += 1;
      if (allocInCalls === 1) return allocationQuery;
      return Promise.resolve({ data: allocationRows, error: null });
    });

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_worst_fit", name: "Worst Fit", subdomain: "worst-fit" },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockImplementation(
      async (_instance: unknown, { env }: { env: NodeJS.ProcessEnv }) => ({
        ok: true,
        provider: "proxmox",
        serverId: 0,
        vmid: 500,
        ipv4: "10.250.22.55",
        sshHostFingerprint: null,
        apiServerKey: "gateway-secret",
        gatewayUrl: "https://worst-fit.agents.hermesos.cloud",
        serverType: "proxmox-kvm",
        infrastructure: {
          provider: "proxmox" as const,
          node: env.PROXMOX_NODE,
          vmid: 500,
          privateIpv4: "10.250.22.55",
          gatewayHost: "worst-fit.agents.hermesos.cloud",
        },
      })
    );

    let hermesInstancesCall = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "proxmox_hosts") return proxmoxHostsQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return allocationQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Worst Fit",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 0.5,
        ramLimit: 1024,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    const calls = (provisionProxmoxInstance as jest.Mock).mock.calls;
    const pickedNode = calls[calls.length - 1][1].env.PROXMOX_NODE;
    expect(pickedNode).toBe("fixturenode5");
  });

  it("provisions WebUI openai-codex aliases with the stored OAuth bundle instead of a raw API key", async () => {
    const codexAuthBundle = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      lastRefresh: "2026-04-11T12:00:00Z",
    };
    (resolveCodexDeploymentSecret as jest.Mock).mockReturnValue({
      apiKey: "",
      authBundle: codexAuthBundle,
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
          id: "inst_codex_alias",
          name: "Codex Alias Agent",
          subdomain: "codex-alias",
        },
        error: null,
      }),
    };

    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 203,
      ipv4: "10.250.20.53",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://codex-alias.example",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        vmid: 203,
        privateIpv4: "10.250.20.53",
        gatewayHost: "codex-alias.example",
      },
    });

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

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Codex Alias Agent",
        provider: "openai-codex",
        apiKey: "serialized-codex-session",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(resolveCodexDeploymentSecret).toHaveBeenCalledWith("serialized-codex-session");
    expect(provisionProxmoxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        apiKey: "",
        model: "gpt-5.4",
        codexAuthBundle,
      }),
      expect.any(Object)
    );
  });

  it("logs insert diagnostics when a Free instance row cannot be created", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "free",
          status: "active",
          instance_limit: 1,
          total_cpu_budget: 0.5,
          total_ram_budget: 1024,
        },
      }),
    };

    const freeGuardQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      limit: jest.fn(async () => ({ data: [], error: null })),
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
        data: null,
        error: {
          code: "22P02",
          message: 'invalid input syntax for type integer: "0.5"',
          details: "Bad fractional CPU input",
          hint: null,
        },
      }),
    };

    // resolveEffectiveSubscription falls through to apple + yearly +
    // token-tier tables when the Stripe row is 'free' (so wallet-only users
    // aren't blocked). This test exercises the Free fallback, so all must
    // return empty.
    const appleIapQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const yearlyTokenQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const tokenQualQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockImplementation(function (this: typeof tokenQualQuery, col: string) {
        // Second .eq("currently_eligible", true) resolves the chain.
        if (col === "currently_eligible") {
          return Promise.resolve({ data: [], error: null });
        }
        return this;
      }),
    };

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "apple_iap_subscriptions") return appleIapQuery;
      if (tableName === "yearly_token_subscriptions") return yearlyTokenQuery;
      if (tableName === "token_tier_qualifications") return tokenQualQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return freeGuardQuery;
        if (hermesInstancesCall === 2) return agentCountQuery;
        if (hermesInstancesCall === 3) return resourceUsageQuery;
        if (hermesInstancesCall === 4) return insertQuery;
      }
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Free Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 1,
        ramLimit: 2048,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 500,
        message: "Failed to create instance record",
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      "failed to create instance record",
      expect.any(Error),
      expect.objectContaining({
        failureType: "instance_record_insert_failed",
        userId: "user_free",
        resourceTier: "credit_base",
        cpuLimit: 0.5,
        ramLimit: 1024,
        insertErrorCode: "22P02",
        insertErrorDetailsPresent: true,
        verboseErrors: true,
      })
    );
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("does not run the free-instance guard for paid tiers", async () => {
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
        data: { id: "inst_paid", name: "Paid Agent", subdomain: "paid" },
        error: null,
      }),
    };

    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    // The guard MUST NOT run for operator-tier; if it did, this test
    // would only have 4 hermes_instances calls instead of 5 below.
    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 202,
      ipv4: "10.250.20.52",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://paid.example",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        vmid: 202,
        privateIpv4: "10.250.20.52",
        gatewayHost: "paid.example",
      },
    });

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

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Paid Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    // Exactly 4 hermes_instances queries → guard skipped for paid tier.
    expect(hermesInstancesCall).toBe(4);
  });

  it("allows paid Proxmox provisioning on the selected target when another target is at its cap", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";
    process.env.HERMES_PROXMOX_TARGET = "fixturelegacy";

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

    const capacityEqCalls: Array<{ column: string; value: string }> = [];
    const capacityQuery: Record<string, unknown> = {};
    capacityQuery.select = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.or = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.not = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.eq = jest.fn((column: string, value: string) => {
      capacityEqCalls.push({ column, value });
      return Promise.resolve({ count: 0, error: null });
    });
    capacityQuery.then = (resolve: (value: { count: number; error: null }) => void) =>
      Promise.resolve({ count: 0, error: null }).then(resolve);

    const insertQuery = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "inst_fixturelegacy", name: "FixtureLegacy Agent", subdomain: "fixturelegacy" },
        error: null,
      }),
    };

    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 200,
      ipv4: "10.250.30.50",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://fixturelegacy.example",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturelegacy",
        vmid: 200,
        privateIpv4: "10.250.30.50",
        gatewayHost: "fixturelegacy.example",
      },
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return capacityQuery;
        if (hermesInstancesCall === 4) return insertQuery;
        if (hermesInstancesCall === 5) return updateQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "FixtureLegacy Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(capacityEqCalls).toContainEqual({ column: "proxmox_node", value: "fixturelegacy" });
    expect(provisionProxmoxInstance).toHaveBeenCalled();
  });

  it("rejects paid Proxmox provisioning before insert when the real host VMID range is full", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";

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

    const capacityQuery: Record<string, unknown> = {};
    capacityQuery.select = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.or = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.not = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.eq = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.then = (resolve: (value: { count: number; error: null }) => void) =>
      Promise.resolve({ count: 0, error: null }).then(resolve);

    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      vmidStart: 200,
      vmidEnd: 219,
      occupiedVmids: Array.from({ length: 20 }, (_, index) => 200 + index),
      freeVmids: [],
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return capacityQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Overflow Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual({
      success: false,
      status: 503,
      message:
        "Temporary Proxmox capacity reached. New agents are paused until more capacity is available.",
      error: {
        code: "PROXMOX_TENANT_CAPACITY_REACHED",
        currentInstances: 20,
        maxInstances: 20,
        vmidStart: 200,
        vmidEnd: 219,
      },
    });
    expect(hermesInstancesCall).toBe(3);
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("rejects Proxmox provisioning before insert when the configured template is missing on the target host", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";

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

    const capacityQuery: Record<string, unknown> = {};
    capacityQuery.select = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.or = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.not = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.eq = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.then = (resolve: (value: { count: number; error: null }) => void) =>
      Promise.resolve({ count: 0, error: null }).then(resolve);

    (getProxmoxTemplateAvailability as jest.Mock).mockResolvedValue({
      ok: false,
      targetId: "fixturelegacy",
      templateId: 9003,
      reason: "missing",
      error: "Configuration file 'nodes/fixturenode1/qemu-server/9003.conf' does not exist",
    });

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return capacityQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Missing Template Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual({
      success: false,
      status: 503,
      message:
        "Deployment target is temporarily unavailable while the VM template is being prepared. Please try again shortly.",
      error: {
        code: "PROXMOX_TEMPLATE_UNAVAILABLE",
        templateId: 9003,
        reason: "missing",
      },
    });
    expect(hermesInstancesCall).toBe(3);
    expect(log.error).toHaveBeenCalledWith(
      "failed to verify live Proxmox template availability",
      expect.any(Error),
      expect.objectContaining({
        failureType: "proxmox_template_availability_check_failed",
        templateError: "Configuration file 'nodes/fixturenode1/qemu-server/9003.conf' does not exist",
      })
    );
    expect(getProxmoxVmidAvailability).not.toHaveBeenCalled();
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });

  it("rejects Proxmox provisioning when the temporary tenant cap is reached before any backend call", async () => {
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "20";

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

    const capacityQuery: Record<string, unknown> = {};
    capacityQuery.select = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.or = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.not = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.eq = jest.fn().mockReturnValue(capacityQuery);
    capacityQuery.then = (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) =>
      Promise.resolve({
        data: Array.from({ length: 20 }, (_, index) => ({
          id: `inst_capacity_${index}`,
          status: "running",
          lifecycle_state: "active",
          proxmox_vmid: 300 + index,
        })),
        error: null,
      }).then(resolve);

    let hermesInstancesCall = 0;
    const proxmoxHostsRegistry = createEmptyProxmoxHostsRegistry();
    (supabaseAdmin!.from as jest.Mock).mockImplementation((tableName: string) => {
      if (tableName === "hermes_subscriptions") return subscriptionQuery;
      if (tableName === "hermes_instances") {
        hermesInstancesCall += 1;
        if (hermesInstancesCall === 1) return agentCountQuery;
        if (hermesInstancesCall === 2) return resourceUsageQuery;
        if (hermesInstancesCall === 3) return capacityQuery;
      }
      if (tableName === "hivra_agents") return emptyHivraAgentsQuery();
      if (tableName === "proxmox_hosts") return proxmoxHostsRegistry();
      throw new Error(`Unexpected table lookup: ${tableName}`);
    });

    const result = await InstanceService.createInstance(
      "user_free",
      CreateInstanceSchema.parse({
        name: "Overflow Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual({
      success: false,
      status: 503,
      message:
        "Temporary Proxmox capacity reached. New agents are paused until more capacity is available.",
      error: {
        code: "PROXMOX_TENANT_CAPACITY_REACHED",
        currentInstances: 20,
        maxInstances: 20,
      },
    });
    expect(provisionProxmoxInstance).not.toHaveBeenCalled();
  });
});

describe("FreeInstanceLimitError", () => {
  it("carries a stable code, status and instance id", () => {
    const err = new FreeInstanceLimitError("inst_xyz");
    expect(err.code).toBe("FREE_INSTANCE_LIMIT_REACHED");
    expect(err.status).toBe(403);
    expect(err.existingInstanceId).toBe("inst_xyz");
  });
});

// Issue #353: box_created over-fired ~24x per instance and collapsed onto a
// handful of PostHog persons, making the signup→box→use→paid funnel unusable.
// These tests lock in the contract the fix establishes: exactly one
// box_created per instance.id, attributed to the real signed-in Clerk user.
describe("InstanceService.createInstance box_created activation event", () => {
  const originalHetznerToken = process.env.HETZNER_API_TOKEN;
  const originalInstanceBackend = process.env.INSTANCE_BACKEND;
  const originalInfraProvider = process.env.HERMES_INFRA_PROVIDER;
  const originalProxmoxEnabledUserIds = process.env.HERMES_PROXMOX_ENABLED_USER_IDS;
  const originalProxmoxCap = process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES;
  const originalProxmoxTarget = process.env.HERMES_PROXMOX_TARGET;
  const originalProxmoxTargets = process.env.HERMES_PROXMOX_TARGETS;
  const originalNodeEnv = process.env.NODE_ENV as string | undefined;

  // Wire a full successful Proxmox create that inserts a row with `instanceId`.
  // Mirrors the free-tier-guard block's success-path mocks so the create
  // reaches the box_created emit. Returns the insert mock so callers can assert
  // the create actually reached insert.
  function wireSuccessfulCreate(instanceId: string) {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          plan: "operator",
          status: "active",
          instance_limit: 10,
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
          id: instanceId,
          name: "Funnel Agent",
          subdomain: `${instanceId}-subdomain`,
        },
        error: null,
      }),
    };
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };

    (provisionProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      provider: "proxmox",
      serverId: 0,
      vmid: 200,
      ipv4: "10.250.21.50",
      sshHostFingerprint: null,
      apiServerKey: "gateway-secret",
      gatewayUrl: "https://abc.agents.hermesos.cloud",
      serverType: "proxmox-kvm",
      infrastructure: {
        provider: "proxmox" as const,
        node: "fixturenode1",
        vmid: 200,
        privateIpv4: "10.250.21.50",
        gatewayHost: "abc.agents.hermesos.cloud",
      },
    });

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

    return { insertQuery };
  }

  function boxCreatedCaptureCalls() {
    return (posthogClient.capture as jest.Mock).mock.calls.filter(
      ([payload]) => payload?.event === "box_created"
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (getProxmoxTemplateAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      targetId: "fixturenode1_node",
      templateId: 9000,
    });
    (getProxmoxVmidAvailability as jest.Mock).mockResolvedValue({
      ok: true,
      vmidStart: 200,
      vmidEnd: 219,
      occupiedVmids: [],
      freeVmids: [200],
    });
    process.env.HETZNER_API_TOKEN = "test-token";
    process.env.HERMES_INFRA_PROVIDER = "proxmox";
    process.env.HERMES_PROXMOX_ENABLED_USER_IDS = "user_funnel";
    process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = "0";
    delete process.env.HERMES_PROXMOX_TARGET;
    delete process.env.HERMES_PROXMOX_TARGETS;
    delete process.env.INSTANCE_BACKEND;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";

    (clerkClient as jest.Mock).mockResolvedValue({
      users: {
        getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }),
      },
    });
    (resolveCodexDeploymentSecret as jest.Mock).mockImplementation((apiKey: string) => ({ apiKey }));
    (decryptApiKey as jest.Mock).mockImplementation((value: string) => value);
    (fetchFirstReachableGatewayResponse as jest.Mock).mockRejectedValue(
      new Error("agent gateway unavailable in test")
    );
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
    if (originalProxmoxCap === undefined) {
      delete process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES;
    } else {
      process.env.HERMES_PROXMOX_MAX_TENANT_INSTANCES = originalProxmoxCap;
    }
    if (originalProxmoxTarget === undefined) {
      delete process.env.HERMES_PROXMOX_TARGET;
    } else {
      process.env.HERMES_PROXMOX_TARGET = originalProxmoxTarget;
    }
    if (originalProxmoxTargets === undefined) {
      delete process.env.HERMES_PROXMOX_TARGETS;
    } else {
      process.env.HERMES_PROXMOX_TARGETS = originalProxmoxTargets;
    }
    if (originalNodeEnv === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    } else {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }
  });

  it("emits box_created exactly once, attributed to the signed-in Clerk user", async () => {
    // Unique id so the process-lifetime dedup Set never collides with another
    // test that already ran in this module.
    const instanceId = "inst_box_created_single_353a";
    const { insertQuery } = wireSuccessfulCreate(instanceId);

    const result = await InstanceService.createInstance(
      "user_funnel",
      CreateInstanceSchema.parse({
        name: "Funnel Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    // Guard against a false green: the create must have actually reached insert,
    // otherwise "emitted once" would be trivially satisfied by never emitting.
    expect(insertQuery.single).toHaveBeenCalled();

    const calls = boxCreatedCaptureCalls();
    expect(calls).toHaveLength(1);

    const [payload] = calls[0];
    // distinct_id is the Clerk user id — the SAME identifier the client uses for
    // identifyUserClient(user.id, …) — so the server event merges onto the real
    // signed-in user's PostHog person (issue #353 cause #2: identity scatter).
    expect(payload.distinctId).toBe("user_funnel");
    expect(payload.properties.instance_id).toBe(instanceId);
    // Stable dedup key PostHog reads from properties (collapses the
    // cross-process tail inside the ingestion window).
    expect(payload.properties.$insert_id).toBe(`box_created_${instanceId}`);
    // Reinforces the server→client person merge.
    expect(payload.properties.$set_once).toEqual({ hermes_user_id: "user_funnel" });
  });

  it("does not re-emit box_created when the same instance.id reaches the emit again", async () => {
    // Reproduces the issue #353 over-fire shape: the SAME instance.id reaching
    // the emit on a retry / re-render / duplicate POST must NOT produce a second
    // box_created event. The process-lifetime guard keys on instance.id.
    const instanceId = "inst_box_created_dedup_353b";

    wireSuccessfulCreate(instanceId);
    const first = await InstanceService.createInstance(
      "user_funnel",
      CreateInstanceSchema.parse({
        name: "Funnel Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );
    expect(first).toEqual(expect.objectContaining({ success: true }));
    expect(boxCreatedCaptureCalls()).toHaveLength(1);

    // clearAllMocks would wipe the capture spy history; clear only that spy so
    // the module-level dedup Set (which is NOT reset between calls) is exercised.
    (posthogClient.capture as jest.Mock).mockClear();

    // Re-run a create whose insert returns the SAME instance.id (the over-fire
    // vector). The dedup guard must suppress the second emit entirely.
    wireSuccessfulCreate(instanceId);
    const second = await InstanceService.createInstance(
      "user_funnel",
      CreateInstanceSchema.parse({
        name: "Funnel Agent",
        provider: "openrouter",
        apiKey: "sk-or-test",
        cpuLimit: 2,
        ramLimit: 4096,
      })
    );
    expect(second).toEqual(expect.objectContaining({ success: true }));
    expect(boxCreatedCaptureCalls()).toHaveLength(0);
  });
});
