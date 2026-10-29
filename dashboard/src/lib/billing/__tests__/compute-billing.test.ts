import {
  billHourlyComputeUsage,
  getBaseHourlyComputeCredits,
  getComputeGracePeriodHours,
} from "@/lib/billing/compute-billing";

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
    // Hermes' compute model is plan-based — credit balances no longer gate
    // compute. The credit_base bill/suspend/resume loops and their helpers were
    // removed; this pins that billHourlyComputeUsage neither bills, pauses nor
    // resumes a credit_base row, so a future refactor can't re-enable them silently.
    const { db, instances } = createDb([
      creditInstance({ id: "inst_active" }),
      creditInstance({ id: "inst_suspended", lifecycle_state: "suspended", status: "stopped" }),
    ]);

    const result = await billHourlyComputeUsage({ db });

    expect(result).toMatchObject({
      checked: 0,
      billedInstances: 0,
      billedEvents: 0,
      suspended: 0,
      resumed: 0,
    });
    expect(instances.map((instance) => instance.last_usage_billed_at)).toEqual([null, null]);
    expect(instances.map((instance) => instance.entitlement_state)).toEqual(["ok", "ok"]);
  });

  it("leaves rows on the removed Starter tier alone — a token holding is no compute gate", async () => {
    // token_base (1 token = a free Starter computer) is gone: hosted computers
    // are paid only, and the migration moves these rows to credit_base. A row
    // the migration has not reached yet is neither graced, paused nor resumed
    // on a token balance.
    const { db, instances } = createDb([
      creditInstance({ id: "inst_starter", resource_tier: "token_base" }),
      creditInstance({
        id: "inst_starter_suspended",
        resource_tier: "token_base",
        lifecycle_state: "suspended",
        entitlement_state: "suspended",
        status: "stopped",
      }),
    ]);

    const result = await billHourlyComputeUsage({ db });

    expect(result).toMatchObject({ checked: 0, suspended: 0, resumed: 0, failed: 0 });
    expect(result).not.toHaveProperty("tokenChecked");
    expect(instances.map((instance) => instance.entitlement_state)).toEqual(["ok", "suspended"]);
  });
});
