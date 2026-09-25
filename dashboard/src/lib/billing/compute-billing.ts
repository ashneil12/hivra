import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import {
  deriveCreditBalance,
  deriveReservedCreditBalance,
  getCachedCreditBalance,
  recordComputeUsageDebit,
} from "@/lib/billing/credits";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { powerOnServer, shutdownServer } from "@/lib/hetzner/client";
import { getLatestAccessTokenHoldingSnapshot } from "@/lib/billing/token-access";
import {
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
} from "@/lib/services/proxmox-infrastructure";
import {
  shutdownProxmoxInstance,
  startProxmoxInstance,
} from "@/lib/services/proxmox-instance-service";

// SCRIPTURE_ANCHOR: just-weight | Proverbs 11:1 | Verse: A false balance is an abomination to Yahweh, but accurate weights are his delight.

type QueryError = { message?: string } | null;

type DbSelectFilter = {
  select: (...args: unknown[]) => DbSelectFilter;
  eq: (...args: unknown[]) => DbSelectFilter;
  neq: (...args: unknown[]) => DbSelectFilter;
  order: (...args: unknown[]) => DbSelectFilter;
  limit: (...args: unknown[]) => Promise<{ data: unknown; error: QueryError }>;
};

type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  select: (...args: unknown[]) => DbSelectFilter;
  update: (...args: unknown[]) => DbUpdateFilter;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

interface BillableCreditInstanceRow {
  id: string;
  user_id: string;
  resource_tier: string | null;
  created_at: string;
  last_usage_billed_at: string | null;
  cpu_limit: number | null;
  ram_limit: number | null;
  status: string | null;
  lifecycle_state: string | null;
  entitlement_state: string | null;
  entitlement_grace_started_at: string | null;
  entitlement_grace_ends_at: string | null;
  infrastructure_provider: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  hetzner_server_id: number | null;
  host_id: string | null;
  config: unknown;
}

type CreditBalanceReader = typeof deriveCreditBalance;
type ReservedBalanceReader = typeof deriveReservedCreditBalance;
type ComputeDebitRecorder = typeof recordComputeUsageDebit;
type ComputePauseExecutor = (instance: BillableCreditInstanceRow) => Promise<{
  ok: boolean;
  error?: string;
}>;
type ComputeStartExecutor = (instance: BillableCreditInstanceRow) => Promise<{
  ok: boolean;
  error?: string;
}>;
type TokenSnapshotReader = typeof getLatestAccessTokenHoldingSnapshot;

const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURLY_CREDITS = 100;
const DEFAULT_MAX_HOURS_PER_INSTANCE = 24;
const DEFAULT_GRACE_PERIOD_HOURS = 24;

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function normalizeLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(100, Math.floor(limit ?? 50)));
}

function normalizeMaxHours(maxHours: number | undefined) {
  if (!Number.isFinite(maxHours)) return DEFAULT_MAX_HOURS_PER_INSTANCE;
  return Math.max(1, Math.min(168, Math.floor(maxHours ?? DEFAULT_MAX_HOURS_PER_INSTANCE)));
}

function normalizeGraceHours(graceHours: number | undefined) {
  if (!Number.isFinite(graceHours)) return DEFAULT_GRACE_PERIOD_HOURS;
  return Math.max(1, Math.min(168, Math.floor(graceHours ?? DEFAULT_GRACE_PERIOD_HOURS)));
}

export function getBaseHourlyComputeCredits(
  env: Record<string, string | undefined> = process.env
) {
  const parsed = Number.parseInt(env.HERMES_COMPUTE_BASE_HOURLY_CREDITS?.trim() || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HOURLY_CREDITS;
  }

  return Math.min(100_000, Math.floor(parsed));
}

export function getComputeGracePeriodHours(
  env: Record<string, string | undefined> = process.env
) {
  const parsed = Number.parseInt(env.HERMES_COMPUTE_GRACE_HOURS?.trim() || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GRACE_PERIOD_HOURS;
  }

  return Math.min(168, Math.floor(parsed));
}

function parseDate(value: string | null | undefined, label: string) {
  if (!value) {
    throw new Error(`Missing ${label}`);
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid ${label}`);
  }

  return parsed;
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * ONE_HOUR_MS);
}

async function listBillableCreditInstances(params: {
  db: SupabaseLike;
  limit: number;
  resourceTier?: "credit_base" | "token_base";
  lifecycleState?: "active" | "suspended";
}) {
  const lifecycleState = params.lifecycleState ?? "active";
  const resourceTier = params.resourceTier ?? "credit_base";
  let query = table(params.db, "hermes_instances")
    .select(
      [
        "id",
        "user_id",
        "resource_tier",
        "created_at",
        "last_usage_billed_at",
        "cpu_limit",
        "ram_limit",
        "status",
        "lifecycle_state",
        "entitlement_state",
        "entitlement_grace_started_at",
        "entitlement_grace_ends_at",
        "infrastructure_provider",
        "proxmox_node",
        "proxmox_vmid",
        "hetzner_server_id",
        "host_id",
        "config",
      ].join(", ")
    )
    .eq("resource_tier", resourceTier)
    .eq("lifecycle_state", lifecycleState);

  if (lifecycleState === "suspended") {
    query = query.eq("entitlement_state", "suspended");
  }

  const { data, error } = await query
    .neq("status", "deleted")
    .order("last_usage_billed_at", { ascending: true, nullsFirst: true })
    .limit(params.limit);

  if (error) {
    throw new Error(error.message || "Failed to load billable credit instances");
  }

  return Array.isArray(data) ? (data as BillableCreditInstanceRow[]) : [];
}

async function updateBillingCursor(params: {
  db: SupabaseLike;
  instanceId: string;
  billedThrough: Date;
}) {
  const { error } = await table(params.db, "hermes_instances")
    .update({
      last_usage_billed_at: params.billedThrough.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.instanceId);

  if (error) {
    throw new Error(error.message || "Failed to update compute billing cursor");
  }
}

async function updateInstanceEntitlement(params: {
  db: SupabaseLike;
  instanceId: string;
  patch: Record<string, unknown>;
}) {
  const { error } = await table(params.db, "hermes_instances")
    .update({
      ...params.patch,
      entitlement_last_checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.instanceId);

  if (error) {
    throw new Error(error.message || "Failed to update instance entitlement state");
  }
}

function getStoredProxmoxVmid(instance: BillableCreditInstanceRow) {
  if (typeof instance.proxmox_vmid === "number" && Number.isFinite(instance.proxmox_vmid)) {
    return instance.proxmox_vmid;
  }

  return getProxmoxInfrastructure(instance.config)?.vmid ?? null;
}

function getStoredProxmoxLocator(instance: BillableCreditInstanceRow) {
  const infrastructure = getProxmoxInfrastructure(instance.config);
  if (infrastructure) return infrastructure;

  const vmid = getStoredProxmoxVmid(instance);
  if (!vmid) return null;

  const node = instance.proxmox_node?.trim() || undefined;
  return {
    vmid,
    ...(node ? { node } : {}),
  };
}

export async function pauseComputeForCreditInstance(
  instance: BillableCreditInstanceRow
) {
  const provider = instance.infrastructure_provider?.trim().toLowerCase();

  if (provider === "proxmox") {
    const proxmox = getStoredProxmoxLocator(instance);
    if (!proxmox) {
      return { ok: false, error: "Missing Proxmox VMID" };
    }

    const result = await shutdownProxmoxInstance(proxmox, {
      expectedInstanceId: instance.id,
      hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmox, { host_id: instance.host_id ?? null }),
    });
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error || result.stderr || "Proxmox shutdown failed" };
  }

  if (provider === "hetzner") {
    if (instance.host_id) {
      return {
        ok: false,
        error: "Shared Hetzner hosts are not paused automatically by credit entitlement enforcement",
      };
    }
    if (!instance.hetzner_server_id) {
      return { ok: false, error: "Missing Hetzner server ID" };
    }

    await shutdownServer(instance.hetzner_server_id);
    return { ok: true };
  }

  return { ok: false, error: "Unsupported infrastructure provider" };
}

export async function startComputeForCreditInstance(
  instance: BillableCreditInstanceRow
) {
  const provider = instance.infrastructure_provider?.trim().toLowerCase();

  if (provider === "proxmox") {
    const proxmox = getStoredProxmoxLocator(instance);
    if (!proxmox) {
      return { ok: false, error: "Missing Proxmox VMID" };
    }

    const result = await startProxmoxInstance(proxmox, {
      expectedInstanceId: instance.id,
      hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmox, { host_id: instance.host_id ?? null }),
    });
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error || result.stderr || "Proxmox start failed" };
  }

  if (provider === "hetzner") {
    if (instance.host_id) {
      return {
        ok: false,
        error: "Shared Hetzner hosts are not resumed automatically by credit entitlement enforcement",
      };
    }
    if (!instance.hetzner_server_id) {
      return { ok: false, error: "Missing Hetzner server ID" };
    }

    await powerOnServer(instance.hetzner_server_id);
    return { ok: true };
  }

  return { ok: false, error: "Unsupported infrastructure provider" };
}

async function markGraceStarted(params: {
  db: SupabaseLike;
  instance: BillableCreditInstanceRow;
  now: Date;
  gracePeriodHours: number;
}) {
  const graceEndsAt = addHours(params.now, params.gracePeriodHours);

  await updateInstanceEntitlement({
    db: params.db,
    instanceId: params.instance.id,
    patch: {
      entitlement_state: "grace",
      entitlement_grace_started_at: params.now.toISOString(),
      entitlement_grace_ends_at: graceEndsAt.toISOString(),
      entitlement_reason: "insufficient_credits",
    },
  });

  return {
    status: "grace_started" as const,
    instanceId: params.instance.id,
    billedEvents: 0,
    creditsDebited: 0,
    availableCredits: 0,
    graceEndsAt: graceEndsAt.toISOString(),
  };
}

async function handleUnderfundedInstance(params: {
  db: SupabaseLike;
  instance: BillableCreditInstanceRow;
  now: Date;
  gracePeriodHours: number;
  availableCredits: number;
  requiredCredits: number;
  billedEvents: number;
  creditsDebited: number;
  pauseCompute: ComputePauseExecutor;
}) {
  const existingGraceEndsAt = params.instance.entitlement_grace_ends_at
    ? parseDate(params.instance.entitlement_grace_ends_at, "entitlement grace end")
    : null;

  if (!existingGraceEndsAt || params.instance.entitlement_state !== "grace") {
    const grace = await markGraceStarted({
      db: params.db,
      instance: params.instance,
      now: params.now,
      gracePeriodHours: params.gracePeriodHours,
    });

    return {
      ...grace,
      billedEvents: params.billedEvents,
      creditsDebited: params.creditsDebited,
      availableCredits: params.availableCredits,
      requiredCredits: params.requiredCredits,
    };
  }

  if (params.now.getTime() < existingGraceEndsAt.getTime()) {
    await updateInstanceEntitlement({
      db: params.db,
      instanceId: params.instance.id,
      patch: {
        entitlement_state: "grace",
        entitlement_reason: "insufficient_credits",
      },
    });

    return {
      status: "grace_active" as const,
      instanceId: params.instance.id,
      billedEvents: params.billedEvents,
      creditsDebited: params.creditsDebited,
      availableCredits: params.availableCredits,
      requiredCredits: params.requiredCredits,
      graceEndsAt: existingGraceEndsAt.toISOString(),
    };
  }

  const pauseResult = await params.pauseCompute(params.instance);
  if (!pauseResult.ok) {
    return {
      status: "pause_failed" as const,
      instanceId: params.instance.id,
      billedEvents: params.billedEvents,
      creditsDebited: params.creditsDebited,
      availableCredits: params.availableCredits,
      requiredCredits: params.requiredCredits,
      error: pauseResult.error || "Failed to pause compute",
    };
  }

  await updateInstanceEntitlement({
    db: params.db,
    instanceId: params.instance.id,
    patch: {
      ...buildInstanceLifecyclePatch("stopped", { now: params.now }),
      lifecycle_state: "suspended",
      entitlement_state: "suspended",
      entitlement_reason: "insufficient_credits",
      entitlement_suspended_at: params.now.toISOString(),
      last_usage_billed_at: params.now.toISOString(),
    },
  });

  return {
    status: "suspended" as const,
    instanceId: params.instance.id,
    billedEvents: params.billedEvents,
    creditsDebited: params.creditsDebited,
    availableCredits: params.availableCredits,
    requiredCredits: params.requiredCredits,
  };
}

async function resumeSuspendedCreditInstance(params: {
  db: SupabaseLike;
  instance: BillableCreditInstanceRow;
  now: Date;
  hourlyCredits: number;
  readBalance: CreditBalanceReader;
  readReserved: ReservedBalanceReader;
  startCompute: ComputeStartExecutor;
}) {
  const balance = await params.readBalance(params.instance.user_id, params.db);
  const reserved = await params.readReserved(params.instance.user_id, params.db);
  const availableCredits = Math.max(0, balance - reserved);

  if (availableCredits < params.hourlyCredits) {
    await updateInstanceEntitlement({
      db: params.db,
      instanceId: params.instance.id,
      patch: {
        entitlement_state: "suspended",
        entitlement_reason: "insufficient_credits",
      },
    });

    return {
      status: "resume_waiting" as const,
      instanceId: params.instance.id,
      availableCredits,
      requiredCredits: params.hourlyCredits,
    };
  }

  const startResult = await params.startCompute(params.instance);
  if (!startResult.ok) {
    return {
      status: "resume_failed" as const,
      instanceId: params.instance.id,
      availableCredits,
      requiredCredits: params.hourlyCredits,
      error: startResult.error || "Failed to resume compute",
    };
  }

  await updateInstanceEntitlement({
    db: params.db,
    instanceId: params.instance.id,
    patch: {
      ...buildInstanceLifecyclePatch("provisioning", { now: params.now }),
      entitlement_state: "ok",
      entitlement_grace_started_at: null,
      entitlement_grace_ends_at: null,
      entitlement_reason: "credits_restored",
      entitlement_suspended_at: null,
      entitlement_last_resumed_at: params.now.toISOString(),
      last_usage_billed_at: params.now.toISOString(),
    },
  });

  return {
    status: "resumed" as const,
    instanceId: params.instance.id,
    availableCredits,
    requiredCredits: params.hourlyCredits,
  };
}

async function startTokenGrace(params: {
  db: SupabaseLike;
  instance: BillableCreditInstanceRow;
  now: Date;
  gracePeriodHours: number;
}) {
  const graceEndsAt = addHours(params.now, params.gracePeriodHours);

  await updateInstanceEntitlement({
    db: params.db,
    instanceId: params.instance.id,
    patch: {
      entitlement_state: "grace",
      entitlement_grace_started_at: params.now.toISOString(),
      entitlement_grace_ends_at: graceEndsAt.toISOString(),
      entitlement_reason: "token_holding_below_minimum",
    },
  });

  return {
    status: "token_grace_started" as const,
    instanceId: params.instance.id,
    graceEndsAt: graceEndsAt.toISOString(),
  };
}

async function reconcileActiveTokenInstance(params: {
  db: SupabaseLike;
  instance: BillableCreditInstanceRow;
  now: Date;
  gracePeriodHours: number;
  readTokenSnapshot: TokenSnapshotReader;
  pauseCompute: ComputePauseExecutor;
}) {
  const snapshot = await params.readTokenSnapshot(params.instance.user_id, params.db);
  const qualifies = snapshot?.qualifiesBaseTier === true;

  if (qualifies) {
    if (params.instance.entitlement_state === "grace") {
      await updateInstanceEntitlement({
        db: params.db,
        instanceId: params.instance.id,
        patch: {
          entitlement_state: "ok",
          entitlement_grace_started_at: null,
          entitlement_grace_ends_at: null,
          entitlement_reason: "token_holding_restored",
        },
      });

      return {
        status: "token_grace_cleared" as const,
        instanceId: params.instance.id,
      };
    }

    return {
      status: "token_ok" as const,
      instanceId: params.instance.id,
    };
  }

  const existingGraceEndsAt = params.instance.entitlement_grace_ends_at
    ? parseDate(params.instance.entitlement_grace_ends_at, "entitlement grace end")
    : null;

  if (!existingGraceEndsAt || params.instance.entitlement_state !== "grace") {
    return startTokenGrace({
      db: params.db,
      instance: params.instance,
      now: params.now,
      gracePeriodHours: params.gracePeriodHours,
    });
  }

  if (params.now.getTime() < existingGraceEndsAt.getTime()) {
    await updateInstanceEntitlement({
      db: params.db,
      instanceId: params.instance.id,
      patch: {
        entitlement_state: "grace",
        entitlement_reason: "token_holding_below_minimum",
      },
    });

    return {
      status: "token_grace_active" as const,
      instanceId: params.instance.id,
      graceEndsAt: existingGraceEndsAt.toISOString(),
    };
  }

  const pauseResult = await params.pauseCompute(params.instance);
  if (!pauseResult.ok) {
    return {
      status: "token_pause_failed" as const,
      instanceId: params.instance.id,
      error: pauseResult.error || "Failed to pause token compute",
    };
  }

  await updateInstanceEntitlement({
    db: params.db,
    instanceId: params.instance.id,
    patch: {
      ...buildInstanceLifecyclePatch("stopped", { now: params.now }),
      lifecycle_state: "suspended",
      entitlement_state: "suspended",
      entitlement_reason: "token_holding_below_minimum",
      entitlement_suspended_at: params.now.toISOString(),
    },
  });

  return {
    status: "token_suspended" as const,
    instanceId: params.instance.id,
  };
}

async function resumeSuspendedTokenInstance(params: {
  db: SupabaseLike;
  instance: BillableCreditInstanceRow;
  now: Date;
  readTokenSnapshot: TokenSnapshotReader;
  startCompute: ComputeStartExecutor;
}) {
  const snapshot = await params.readTokenSnapshot(params.instance.user_id, params.db);
  const qualifies = snapshot?.qualifiesBaseTier === true;

  if (!qualifies) {
    await updateInstanceEntitlement({
      db: params.db,
      instanceId: params.instance.id,
      patch: {
        entitlement_state: "suspended",
        entitlement_reason: "token_holding_below_minimum",
      },
    });

    return {
      status: "token_resume_waiting" as const,
      instanceId: params.instance.id,
    };
  }

  const startResult = await params.startCompute(params.instance);
  if (!startResult.ok) {
    return {
      status: "token_resume_failed" as const,
      instanceId: params.instance.id,
      error: startResult.error || "Failed to resume token compute",
    };
  }

  await updateInstanceEntitlement({
    db: params.db,
    instanceId: params.instance.id,
    patch: {
      ...buildInstanceLifecyclePatch("provisioning", { now: params.now }),
      entitlement_state: "ok",
      entitlement_grace_started_at: null,
      entitlement_grace_ends_at: null,
      entitlement_reason: "token_holding_restored",
      entitlement_suspended_at: null,
      entitlement_last_resumed_at: params.now.toISOString(),
    },
  });

  return {
    status: "token_resumed" as const,
    instanceId: params.instance.id,
  };
}

async function billCreditInstance(params: {
  db: SupabaseLike;
  instance: BillableCreditInstanceRow;
  now: Date;
  hourlyCredits: number;
  maxHoursPerInstance: number;
  gracePeriodHours: number;
  readBalance: CreditBalanceReader;
  readReserved: ReservedBalanceReader;
  recordDebit: ComputeDebitRecorder;
  pauseCompute: ComputePauseExecutor;
}) {
  const cursor = params.instance.last_usage_billed_at
    ? parseDate(params.instance.last_usage_billed_at, "last usage billed time")
    : parseDate(params.instance.created_at, "instance creation time");
  const wholeHoursDue = Math.floor((params.now.getTime() - cursor.getTime()) / ONE_HOUR_MS);

  if (wholeHoursDue <= 0) {
    return {
      status: "not_due" as const,
      instanceId: params.instance.id,
      billedEvents: 0,
      creditsDebited: 0,
    };
  }

  const hoursToBill = Math.min(wholeHoursDue, params.maxHoursPerInstance);
  let billedEvents = 0;
  let creditsDebited = 0;
  let billedThrough = cursor;

  for (let index = 0; index < hoursToBill; index += 1) {
    const periodStart = addHours(cursor, index);
    const periodEnd = addHours(periodStart, 1);
    const balance = await params.readBalance(params.instance.user_id, params.db);
    const reserved = await params.readReserved(params.instance.user_id, params.db);
    const availableCredits = Math.max(0, balance - reserved);

    if (availableCredits < params.hourlyCredits) {
      if (billedEvents > 0) {
        await updateBillingCursor({
          db: params.db,
          instanceId: params.instance.id,
          billedThrough,
        });
      }

      return handleUnderfundedInstance({
        db: params.db,
        instance: params.instance,
        now: params.now,
        gracePeriodHours: params.gracePeriodHours,
        availableCredits,
        requiredCredits: params.hourlyCredits,
        billedEvents,
        creditsDebited,
        pauseCompute: params.pauseCompute,
      });
    }

    await params.recordDebit(
      {
        userId: params.instance.user_id,
        instanceId: params.instance.id,
        amountCredits: params.hourlyCredits,
        referenceId: `compute:${params.instance.id}:${periodStart.toISOString()}`,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        metadata: {
          resourceTier: "credit_base",
          cpuLimit: params.instance.cpu_limit ?? null,
          ramLimit: params.instance.ram_limit ?? null,
        },
      },
      params.db
    );

    billedEvents += 1;
    creditsDebited += params.hourlyCredits;
    billedThrough = periodEnd;
  }

  await updateBillingCursor({
    db: params.db,
    instanceId: params.instance.id,
    billedThrough,
  });

  return {
    status: "billed" as const,
    instanceId: params.instance.id,
    billedEvents,
    creditsDebited,
    billedThrough: billedThrough.toISOString(),
  };
}

export async function billHourlyComputeUsage(params: {
  db?: SupabaseLike | null;
  limit?: number;
  now?: Date;
  hourlyCredits?: number;
  maxHoursPerInstance?: number;
  gracePeriodHours?: number;
  readBalance?: CreditBalanceReader;
  readReserved?: ReservedBalanceReader;
  recordDebit?: ComputeDebitRecorder;
  pauseCompute?: ComputePauseExecutor;
  startCompute?: ComputeStartExecutor;
  readTokenSnapshot?: TokenSnapshotReader;
} = {}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const limit = normalizeLimit(params.limit);
  const hourlyCredits = params.hourlyCredits ?? getBaseHourlyComputeCredits();
  const maxHoursPerInstance = normalizeMaxHours(params.maxHoursPerInstance);
  const gracePeriodHours = normalizeGraceHours(
    params.gracePeriodHours ?? getComputeGracePeriodHours()
  );
  const now = params.now ?? new Date();
  // Compute credits as an entitlement gate are disabled — Hermes' compute model
  // is plan-based (free / paid / token-holding), and free-plan users were being
  // wrongly suspended when their credit balance hit zero. Skip both credit_base
  // loops to neutralize the suspend/resume cycle. Token-holding entitlement (the
  // token_base tier below) is the only remaining compute gate. Dead-code
  // cleanup for billCreditInstance / resumeSuspendedCreditInstance / etc. is
  // tracked as a follow-up PR.
  const activeInstances: BillableCreditInstanceRow[] = [];
  const suspendedInstances: BillableCreditInstanceRow[] = [];
  const activeTokenInstances = await listBillableCreditInstances({
    db: admin,
    limit,
    resourceTier: "token_base",
    lifecycleState: "active",
  });
  const suspendedTokenInstances = await listBillableCreditInstances({
    db: admin,
    limit,
    resourceTier: "token_base",
    lifecycleState: "suspended",
  });
  const results: Array<
    | Awaited<ReturnType<typeof billCreditInstance>>
    | Awaited<ReturnType<typeof resumeSuspendedCreditInstance>>
    | Awaited<ReturnType<typeof reconcileActiveTokenInstance>>
    | Awaited<ReturnType<typeof resumeSuspendedTokenInstance>>
    | { status: "failed"; instanceId: string; errorName: string }
  > = [];

  let billedInstances = 0;
  let billedEvents = 0;
  let skipped = 0;
  let underfunded = 0;
  let suspended = 0;
  let pauseFailed = 0;
  let resumed = 0;
  let resumeWaiting = 0;
  let resumeFailed = 0;
  let tokenChecked = 0;
  let tokenGrace = 0;
  let tokenSuspended = 0;
  let tokenResumed = 0;
  let tokenWaiting = 0;
  let tokenFailed = 0;
  let failed = 0;
  let creditsDebited = 0;

  for (const instance of activeInstances) {
    try {
      const result = await billCreditInstance({
        db: admin,
        instance,
        now,
        hourlyCredits,
        maxHoursPerInstance,
        gracePeriodHours,
        readBalance: params.readBalance ?? getCachedCreditBalance,
        readReserved: params.readReserved ?? deriveReservedCreditBalance,
        recordDebit: params.recordDebit ?? recordComputeUsageDebit,
        pauseCompute: params.pauseCompute ?? pauseComputeForCreditInstance,
      });
      results.push(result);

      if (result.status === "billed") billedInstances += 1;
      if (result.status === "not_due") skipped += 1;
      if (
        result.status === "grace_started" ||
        result.status === "grace_active"
      ) {
        underfunded += 1;
      }
      if (result.status === "suspended") {
        underfunded += 1;
        suspended += 1;
      }
      if (result.status === "pause_failed") {
        underfunded += 1;
        pauseFailed += 1;
      }
      billedEvents += result.billedEvents;
      creditsDebited += result.creditsDebited;
    } catch (error) {
      failed += 1;
      results.push({
        status: "failed",
        instanceId: instance.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  for (const instance of suspendedInstances) {
    try {
      const result = await resumeSuspendedCreditInstance({
        db: admin,
        instance,
        now,
        hourlyCredits,
        readBalance: params.readBalance ?? getCachedCreditBalance,
        readReserved: params.readReserved ?? deriveReservedCreditBalance,
        startCompute: params.startCompute ?? startComputeForCreditInstance,
      });
      results.push(result);

      if (result.status === "resumed") resumed += 1;
      if (result.status === "resume_waiting") resumeWaiting += 1;
      if (result.status === "resume_failed") resumeFailed += 1;
    } catch (error) {
      failed += 1;
      results.push({
        status: "failed",
        instanceId: instance.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  for (const instance of activeTokenInstances) {
    tokenChecked += 1;
    try {
      const result = await reconcileActiveTokenInstance({
        db: admin,
        instance,
        now,
        gracePeriodHours,
        readTokenSnapshot: params.readTokenSnapshot ?? getLatestAccessTokenHoldingSnapshot,
        pauseCompute: params.pauseCompute ?? pauseComputeForCreditInstance,
      });
      results.push(result);

      if (
        result.status === "token_grace_started" ||
        result.status === "token_grace_active"
      ) {
        tokenGrace += 1;
      }
      if (result.status === "token_suspended") tokenSuspended += 1;
      if (result.status === "token_pause_failed") tokenFailed += 1;
    } catch (error) {
      failed += 1;
      tokenFailed += 1;
      results.push({
        status: "failed",
        instanceId: instance.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  for (const instance of suspendedTokenInstances) {
    tokenChecked += 1;
    try {
      const result = await resumeSuspendedTokenInstance({
        db: admin,
        instance,
        now,
        readTokenSnapshot: params.readTokenSnapshot ?? getLatestAccessTokenHoldingSnapshot,
        startCompute: params.startCompute ?? startComputeForCreditInstance,
      });
      results.push(result);

      if (result.status === "token_resumed") tokenResumed += 1;
      if (result.status === "token_resume_waiting") tokenWaiting += 1;
      if (result.status === "token_resume_failed") tokenFailed += 1;
    } catch (error) {
      failed += 1;
      tokenFailed += 1;
      results.push({
        status: "failed",
        instanceId: instance.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  return {
    checked:
      activeInstances.length +
      suspendedInstances.length +
      activeTokenInstances.length +
      suspendedTokenInstances.length,
    billedInstances,
    billedEvents,
    skipped,
    underfunded,
    failed,
    suspended,
    pauseFailed,
    resumed,
    resumeWaiting,
    resumeFailed,
    tokenChecked,
    tokenGrace,
    tokenSuspended,
    tokenResumed,
    tokenWaiting,
    tokenFailed,
    creditsDebited,
    hourlyCredits,
    gracePeriodHours,
    results,
  };
}
