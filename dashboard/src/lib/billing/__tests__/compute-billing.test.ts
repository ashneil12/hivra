import {
  billHourlyComputeUsage,
  getBaseHourlyComputeCredits,
  getComputeGracePeriodHours,
  pauseComputeForCreditInstance,
  startComputeForCreditInstance,
} from "@/lib/billing/compute-billing";
import {
  shutdownProxmoxInstance,
  startProxmoxInstance,
} from "@/lib/services/proxmox-instance-service";

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
  startProxmoxInstance: jest.fn(),
}));

const now = new Date("2026-04-24T12:30:00.000Z");

function createDb(initialInstances: Array<Record<string, unknown>>) {
  const instances = initialInstances.map((instance) => ({ ...instance }));

  function hermesInstancesTable() {
    return {
      select: () => {
        const filters: Record<string, unknown> = {};
        const notFilters: Record<string, unknown> = {};
        const query: {
          eq: jest.Mock;
          neq: jest.Mock;
          order: jest.Mock;
          limit: jest.Mock;
        } = {} as {
          eq: jest.Mock;
          neq: jest.Mock;
          order: jest.Mock;
          limit: jest.Mock;
        };

        query.eq = jest.fn((column: string, value: unknown) => {
          filters[column] = value;
          return query;
        });
        query.neq = jest.fn((column: string, value: unknown) => {
          notFilters[column] = value;
          return query;
        });
        query.order = jest.fn(() => query);
        query.limit = jest.fn(async (limit: number) => ({
          data: instances
            .filter((instance) =>
              Object.entries(filters).every(([column, value]) => instance[column] === value)
            )
            .filter((instance) =>
              Object.entries(notFilters).every(([column, value]) => instance[column] !== value)
            )
            .slice(0, limit),
          error: null,
        }));

        return query;
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const query: {
          eq: jest.Mock;
          then: Promise<{ error: null }>["then"];
        } = {} as {
          eq: jest.Mock;
          then: Promise<{ error: null }>["then"];
        };

        query.eq = jest.fn((column: string, value: unknown) => {
          filters[column] = value;
          return query;
        });
        query.then = (resolve, reject) => {
          for (const instance of instances) {
            if (Object.entries(filters).every(([column, value]) => instance[column] === value)) {
              Object.assign(instance, patch);
            }
          }

          return Promise.resolve({ error: null }).then(resolve, reject);
        };

        return query;
      },
    };
  }

  return {
    instances,
    db: {
      from: jest.fn((name: string) => {
        if (name === "hermes_instances") return hermesInstancesTable();
        throw new Error(`Unexpected table ${name}`);
      }),
    },
  };
}

function creditInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst_1",
    user_id: "user_1",
    status: "running",
    lifecycle_state: "active",
    resource_tier: "credit_base",
    entitlement_state: "ok",
    entitlement_grace_started_at: null,
    entitlement_grace_ends_at: null,
    entitlement_last_checked_at: null,
    entitlement_reason: null,
    entitlement_suspended_at: null,
    entitlement_last_resumed_at: null,
    infrastructure_provider: "proxmox",
    proxmox_node: null,
    proxmox_vmid: 201,
    hetzner_server_id: null,
    host_id: null,
    config: {},
    created_at: "2026-04-24T10:30:00.000Z",
    last_usage_billed_at: null,
    cpu_limit: 1,
    ram_limit: 2048,
    ...overrides,
  };
}

function tokenSnapshot(qualifiesBaseTier: boolean) {
  return {
    id: "snapshot_1",
    userId: "user_1",
    walletId: "wallet_1",
    walletAddress: "0x000000000000000000000000000000000000dEaD",
    normalizedWalletAddress: "0x000000000000000000000000000000000000dead",
    chainId: 8453,
    tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
    tokenSymbol: "Hivra",
    tokenDecimals: 18,
    balanceRaw: qualifiesBaseTier ? "1000000000000000000" : "0",
    balanceDisplay: qualifiesBaseTier ? "1" : "0",
    balance: qualifiesBaseTier ? 1 : 0,
    qualifiesBaseTier,
    blockNumber: 16,
    source: "base_rpc" as const,
    checkedAt: "2026-04-24T12:00:00.000Z",
  };
}

describe("compute billing worker", () => {
  it("reads hourly base compute price from configuration with a safe default", () => {
    expect(getBaseHourlyComputeCredits({})).toBe(100);
    expect(getBaseHourlyComputeCredits({ HERMES_COMPUTE_BASE_HOURLY_CREDITS: "75" })).toBe(75);
    expect(getBaseHourlyComputeCredits({ HERMES_COMPUTE_BASE_HOURLY_CREDITS: "0" })).toBe(100);
  });

  it("reads the compute grace period from configuration with a safe default", () => {
    expect(getComputeGracePeriodHours({})).toBe(24);
    expect(getComputeGracePeriodHours({ HERMES_COMPUTE_GRACE_HOURS: "12" })).toBe(12);
    expect(getComputeGracePeriodHours({ HERMES_COMPUTE_GRACE_HOURS: "0" })).toBe(24);
    expect(getComputeGracePeriodHours({ HERMES_COMPUTE_GRACE_HOURS: "999" })).toBe(168);
  });

  it("does not touch credit_base instances — credits-as-compute-gate is disabled", async () => {
    // Hermes' compute model is plan-based (free/paid/token-holding) — credit
    // balances no longer gate compute. This test pins that the credit_base
    // loops in billHourlyComputeUsage are no-ops so a future refactor can't
    // accidentally re-enable them. Token_base behavior is exercised by the
    // tests below.
    const { db } = createDb([
      creditInstance({ id: "inst_active" }),
      creditInstance({ id: "inst_suspended", lifecycle_state: "suspended", status: "stopped" }),
    ]);
    const recordDebit = jest.fn();
    const pauseCompute = jest.fn();
    const startCompute = jest.fn();

    const result = await billHourlyComputeUsage({
      db,
      now: new Date("2026-04-24T11:30:00.000Z"),
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 0),
      readReserved: jest.fn(async () => 0),
      recordDebit,
      pauseCompute,
      startCompute,
    });

    expect(recordDebit).not.toHaveBeenCalled();
    expect(pauseCompute).not.toHaveBeenCalled();
    expect(startCompute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      billedInstances: 0,
      billedEvents: 0,
      suspended: 0,
      resumed: 0,
    });
  });

  it.skip("LEGACY: bills whole due hours for credit-based active instances only", async () => {
    const { db, instances } = createDb([
      creditInstance(),
      creditInstance({
        id: "inst_subscription",
        resource_tier: "operator",
      }),
    ]);
    let balance = 500;
    const debits: unknown[] = [];

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      readBalance: jest.fn(async () => balance),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(async (params) => {
        balance -= params.amountCredits;
        debits.push(params);
        return { inserted: true, balance };
      }),
    });

    expect(result).toMatchObject({
      checked: 1,
      billedInstances: 1,
      billedEvents: 2,
      skipped: 0,
      underfunded: 0,
      failed: 0,
      creditsDebited: 200,
    });
    expect(debits).toEqual([
      expect.objectContaining({
        userId: "user_1",
        instanceId: "inst_1",
        amountCredits: 100,
        referenceId: "compute:inst_1:2026-04-24T10:30:00.000Z",
        periodEnd: "2026-04-24T11:30:00.000Z",
      }),
      expect.objectContaining({
        referenceId: "compute:inst_1:2026-04-24T11:30:00.000Z",
        periodEnd: "2026-04-24T12:30:00.000Z",
      }),
    ]);
    expect(instances[0]).toEqual(expect.objectContaining({
      last_usage_billed_at: "2026-04-24T12:30:00.000Z",
    }));
    expect(instances[1].last_usage_billed_at).toBeNull();
  });

  it.skip("LEGACY: skips credit instances that have no complete hour due", async () => {
    const { db } = createDb([
      creditInstance({
        created_at: "2026-04-24T12:00:00.000Z",
      }),
    ]);

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 500),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
    });

    expect(result).toMatchObject({
      checked: 1,
      billedInstances: 0,
      billedEvents: 0,
      skipped: 1,
      underfunded: 0,
    });
  });

  it.skip("LEGACY: starts a grace period when available credits run out", async () => {
    const { db, instances } = createDb([creditInstance()]);
    let balance = 150;

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      gracePeriodHours: 24,
      readBalance: jest.fn(async () => balance),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(async (params) => {
        balance -= params.amountCredits;
        return { inserted: true, balance };
      }),
      pauseCompute: jest.fn(),
    });

    expect(result).toMatchObject({
      checked: 1,
      billedInstances: 0,
      billedEvents: 1,
      underfunded: 1,
      suspended: 0,
      creditsDebited: 100,
    });
    expect(result.results[0]).toMatchObject({
      status: "grace_started",
      instanceId: "inst_1",
      availableCredits: 50,
      requiredCredits: 100,
      graceEndsAt: "2026-04-25T12:30:00.000Z",
    });
    expect(instances[0]).toEqual(expect.objectContaining({
      last_usage_billed_at: "2026-04-24T11:30:00.000Z",
      entitlement_state: "grace",
      entitlement_grace_started_at: "2026-04-24T12:30:00.000Z",
      entitlement_grace_ends_at: "2026-04-25T12:30:00.000Z",
      entitlement_reason: "insufficient_credits",
    }));
  });

  it.skip("LEGACY: keeps an underfunded instance active while the grace period has not expired", async () => {
    const { db, instances } = createDb([
      creditInstance({
        last_usage_billed_at: "2026-04-24T11:30:00.000Z",
        entitlement_state: "grace",
        entitlement_grace_started_at: "2026-04-24T11:45:00.000Z",
        entitlement_grace_ends_at: "2026-04-24T13:30:00.000Z",
      }),
    ]);
    const pauseCompute = jest.fn();

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 50),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      pauseCompute,
    });

    expect(result).toMatchObject({
      checked: 1,
      underfunded: 1,
      suspended: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "grace_active",
      graceEndsAt: "2026-04-24T13:30:00.000Z",
    });
    expect(pauseCompute).not.toHaveBeenCalled();
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "running",
      lifecycle_state: "active",
      entitlement_state: "grace",
      entitlement_reason: "insufficient_credits",
    }));
  });

  it.skip("LEGACY: suspends compute after the grace period expires", async () => {
    const { db, instances } = createDb([
      creditInstance({
        last_usage_billed_at: "2026-04-24T11:30:00.000Z",
        entitlement_state: "grace",
        entitlement_grace_started_at: "2026-04-24T10:30:00.000Z",
        entitlement_grace_ends_at: "2026-04-24T12:00:00.000Z",
      }),
    ]);
    const pauseCompute = jest.fn(async () => ({ ok: true }));

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 50),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      pauseCompute,
    });

    expect(result).toMatchObject({
      checked: 1,
      underfunded: 1,
      suspended: 1,
      pauseFailed: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "suspended",
      instanceId: "inst_1",
    });
    expect(pauseCompute).toHaveBeenCalledWith(expect.objectContaining({ id: "inst_1" }));
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "stopped",
      lifecycle_state: "suspended",
      entitlement_state: "suspended",
      entitlement_suspended_at: "2026-04-24T12:30:00.000Z",
      last_usage_billed_at: "2026-04-24T12:30:00.000Z",
    }));
  });

  it.skip("LEGACY: does not mark an instance suspended when infrastructure pause fails", async () => {
    const { db, instances } = createDb([
      creditInstance({
        last_usage_billed_at: "2026-04-24T11:30:00.000Z",
        entitlement_state: "grace",
        entitlement_grace_ends_at: "2026-04-24T12:00:00.000Z",
      }),
    ]);

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 50),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      pauseCompute: jest.fn(async () => ({ ok: false, error: "host unavailable" })),
    });

    expect(result).toMatchObject({
      checked: 1,
      underfunded: 1,
      suspended: 0,
      pauseFailed: 1,
    });
    expect(result.results[0]).toMatchObject({
      status: "pause_failed",
      error: "host unavailable",
    });
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "running",
      lifecycle_state: "active",
      entitlement_state: "grace",
    }));
  });

  it.skip("LEGACY: resumes a suspended credit instance when credits are available", async () => {
    const { db, instances } = createDb([
      creditInstance({
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_state: "suspended",
        entitlement_grace_started_at: "2026-04-24T10:30:00.000Z",
        entitlement_grace_ends_at: "2026-04-24T11:30:00.000Z",
        entitlement_suspended_at: "2026-04-24T12:00:00.000Z",
        last_usage_billed_at: "2026-04-24T12:00:00.000Z",
      }),
    ]);
    const startCompute = jest.fn(async () => ({ ok: true }));

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 500),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      startCompute,
    });

    expect(result).toMatchObject({
      checked: 1,
      billedInstances: 0,
      resumed: 1,
      resumeWaiting: 0,
      resumeFailed: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "resumed",
      instanceId: "inst_1",
      availableCredits: 500,
      requiredCredits: 100,
    });
    expect(startCompute).toHaveBeenCalledWith(expect.objectContaining({ id: "inst_1" }));
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "provisioning",
      lifecycle_state: "provisioning",
      entitlement_state: "ok",
      entitlement_grace_started_at: null,
      entitlement_grace_ends_at: null,
      entitlement_reason: "credits_restored",
      entitlement_suspended_at: null,
      entitlement_last_resumed_at: "2026-04-24T12:30:00.000Z",
      last_usage_billed_at: "2026-04-24T12:30:00.000Z",
    }));
  });

  it.skip("LEGACY: leaves a suspended credit instance stopped while credits remain insufficient", async () => {
    const { db, instances } = createDb([
      creditInstance({
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_state: "suspended",
        last_usage_billed_at: "2026-04-24T12:00:00.000Z",
      }),
    ]);
    const startCompute = jest.fn();

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 25),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      startCompute,
    });

    expect(result).toMatchObject({
      checked: 1,
      resumed: 0,
      resumeWaiting: 1,
      resumeFailed: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "resume_waiting",
      availableCredits: 25,
      requiredCredits: 100,
    });
    expect(startCompute).not.toHaveBeenCalled();
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "stopped",
      lifecycle_state: "suspended",
      entitlement_state: "suspended",
      entitlement_reason: "insufficient_credits",
    }));
  });

  it.skip("LEGACY: does not mark a suspended instance resumed when infrastructure start fails", async () => {
    const { db, instances } = createDb([
      creditInstance({
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_state: "suspended",
      }),
    ]);

    const result = await billHourlyComputeUsage({
      db,
      now,
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 500),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      startCompute: jest.fn(async () => ({ ok: false, error: "start failed" })),
    });

    expect(result).toMatchObject({
      checked: 1,
      resumed: 0,
      resumeWaiting: 0,
      resumeFailed: 1,
    });
    expect(result.results[0]).toMatchObject({
      status: "resume_failed",
      error: "start failed",
    });
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "stopped",
      lifecycle_state: "suspended",
      entitlement_state: "suspended",
    }));
  });

  it("starts a grace period when a token-backed instance loses qualification", async () => {
    const { db, instances } = createDb([
      creditInstance({
        resource_tier: "token_base",
        entitlement_state: "ok",
      }),
    ]);

    const result = await billHourlyComputeUsage({
      db,
      now,
      gracePeriodHours: 24,
      readBalance: jest.fn(async () => 0),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      readTokenSnapshot: jest.fn(async () => tokenSnapshot(false)),
      pauseCompute: jest.fn(),
    });

    expect(result).toMatchObject({
      checked: 1,
      tokenChecked: 1,
      tokenGrace: 1,
      tokenSuspended: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "token_grace_started",
      instanceId: "inst_1",
      graceEndsAt: "2026-04-25T12:30:00.000Z",
    });
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "running",
      lifecycle_state: "active",
      entitlement_state: "grace",
      entitlement_grace_started_at: "2026-04-24T12:30:00.000Z",
      entitlement_grace_ends_at: "2026-04-25T12:30:00.000Z",
      entitlement_reason: "token_holding_below_minimum",
    }));
  });

  it("suspends token-backed compute after token grace expires", async () => {
    const { db, instances } = createDb([
      creditInstance({
        resource_tier: "token_base",
        entitlement_state: "grace",
        entitlement_grace_started_at: "2026-04-24T10:30:00.000Z",
        entitlement_grace_ends_at: "2026-04-24T12:00:00.000Z",
      }),
    ]);
    const pauseCompute = jest.fn(async () => ({ ok: true }));

    const result = await billHourlyComputeUsage({
      db,
      now,
      readBalance: jest.fn(async () => 0),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      readTokenSnapshot: jest.fn(async () => tokenSnapshot(false)),
      pauseCompute,
    });

    expect(result).toMatchObject({
      checked: 1,
      tokenChecked: 1,
      tokenSuspended: 1,
      tokenFailed: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "token_suspended",
      instanceId: "inst_1",
    });
    expect(pauseCompute).toHaveBeenCalledWith(expect.objectContaining({ id: "inst_1" }));
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "stopped",
      lifecycle_state: "suspended",
      entitlement_state: "suspended",
      entitlement_reason: "token_holding_below_minimum",
      entitlement_suspended_at: "2026-04-24T12:30:00.000Z",
    }));
  });

  it("resumes suspended token-backed compute when qualification returns", async () => {
    const { db, instances } = createDb([
      creditInstance({
        resource_tier: "token_base",
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_state: "suspended",
        entitlement_grace_started_at: "2026-04-24T10:30:00.000Z",
        entitlement_grace_ends_at: "2026-04-24T11:30:00.000Z",
        entitlement_suspended_at: "2026-04-24T12:00:00.000Z",
      }),
    ]);
    const startCompute = jest.fn(async () => ({ ok: true }));

    const result = await billHourlyComputeUsage({
      db,
      now,
      readBalance: jest.fn(async () => 0),
      readReserved: jest.fn(async () => 0),
      recordDebit: jest.fn(),
      readTokenSnapshot: jest.fn(async () => tokenSnapshot(true)),
      startCompute,
    });

    expect(result).toMatchObject({
      checked: 1,
      tokenChecked: 1,
      tokenResumed: 1,
      tokenWaiting: 0,
      tokenFailed: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "token_resumed",
      instanceId: "inst_1",
    });
    expect(startCompute).toHaveBeenCalledWith(expect.objectContaining({ id: "inst_1" }));
    expect(instances[0]).toEqual(expect.objectContaining({
      status: "provisioning",
      lifecycle_state: "provisioning",
      entitlement_state: "ok",
      entitlement_grace_started_at: null,
      entitlement_grace_ends_at: null,
      entitlement_reason: "token_holding_restored",
      entitlement_suspended_at: null,
      entitlement_last_resumed_at: "2026-04-24T12:30:00.000Z",
    }));
  });

  it.skip("LEGACY: continues billing later instances when one instance fails", async () => {
    const { db } = createDb([
      creditInstance({ id: "inst_fail" }),
      creditInstance({ id: "inst_ok", user_id: "user_2" }),
    ]);
    const recordDebit = jest
      .fn()
      .mockRejectedValueOnce(new Error("debit failed"))
      .mockResolvedValue({ inserted: true, balance: 400 });

    const result = await billHourlyComputeUsage({
      db,
      now: new Date("2026-04-24T11:30:00.000Z"),
      hourlyCredits: 100,
      readBalance: jest.fn(async () => 500),
      readReserved: jest.fn(async () => 0),
      recordDebit,
    });

    expect(result).toMatchObject({
      checked: 2,
      billedInstances: 1,
      billedEvents: 1,
      failed: 1,
    });
    expect(result.results).toEqual([
      {
        status: "failed",
        instanceId: "inst_fail",
        errorName: "Error",
      },
      expect.objectContaining({
        status: "billed",
        instanceId: "inst_ok",
      }),
    ]);
  });

  it("routes credit-based Proxmox pause/start by stored proxmox_node when config infrastructure is missing", async () => {
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true });
    (startProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true });

    const instance = creditInstance({
      proxmox_node: "fixturenode2",
      proxmox_vmid: 209,
      config: {},
    });

    await expect(pauseComputeForCreditInstance(instance)).resolves.toEqual({ ok: true });
    await expect(startComputeForCreditInstance(instance)).resolves.toEqual({ ok: true });

    expect(shutdownProxmoxInstance).toHaveBeenCalledWith(
      { vmid: 209, node: "fixturenode2" },
      { hostConfig: { hostId: null, hostSlug: "fixturenode2", envPrefix: null, failClosed: true } }
    );
    expect(startProxmoxInstance).toHaveBeenCalledWith(
      { vmid: 209, node: "fixturenode2" },
      { hostConfig: { hostId: null, hostSlug: "fixturenode2", envPrefix: null, failClosed: true } }
    );
  });
});
