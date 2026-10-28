import {
  BILLING_SWEEP_MAX_USERS_PER_RUN,
  enforceGraceExpiredComputeStop,
  GRACE_EXPIRED_ENTITLEMENT_REASON,
  isDunningGraceEnforceLive,
  sweepBillingSuspendedCompute,
} from "@/lib/recovery/dunning-grace-enforce";
import { supabaseAdmin } from "@/lib/supabase";
import {
  shutdownProxmoxInstance,
  getProxmoxInfrastructure,
  isProxmoxVmMissingResult,
} from "@/lib/services/proxmox-instance-service";
import {
  hasTokenTierInGrace,
  resolveEffectiveSubscription,
} from "@/lib/billing/instance-entitlement";
import { log } from "@/lib/logger";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  isProxmoxVmMissingResult: jest.fn(() => false),
}));
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn(),
  hasTokenTierInGrace: jest.fn(),
}));

type Row = {
  id: string;
  user_id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  infrastructure_provider: string | null;
  /** What the billing suspend left on the row; the enforcer filters on it. */
  entitlement_reason?: string;
};

const infra = {
  provider: "proxmox" as const,
  node: "fixturenode1",
  vmid: 200,
  privateIpv4: "10.250.20.50",
  gatewayHost: "x.agents.hermesos.cloud",
};

/**
 * Stub from("hermes_instances") for both shapes: the terminal SELECT
 * (`.select().eq().in().not().is()`) resolves to the candidates whose
 * entitlement_reason passes the eq/in filters the code applied; each per-row
 * UPDATE (`.update().eq().in()`) records the patch and the reasons it was
 * allowed to overwrite, and resolves `{error:null}`. Distinguished by whether
 * `.update()` was called on the builder.
 */
function stubInstances(candidates: Row[]) {
  const updates: Array<{
    id: string;
    patch: Record<string, unknown>;
    reasons: string[] | null;
  }> = [];
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== "hermes_instances") throw new Error(`unexpected table ${table}`);
    let isUpdate = false;
    let patch: Record<string, unknown> = {};
    let id: string | null = null;
    let reasons: string[] | null = null;
    const builder: Record<string, unknown> = {
      select: jest.fn(() => builder),
      update: jest.fn((p: Record<string, unknown>) => {
        isUpdate = true;
        patch = p;
        return builder;
      }),
      eq: jest.fn((col: string, val: string) => {
        if (col === "id") id = val;
        if (col === "entitlement_reason") reasons = [val];
        return builder;
      }),
      in: jest.fn((col: string, vals: string[]) => {
        if (col === "entitlement_reason") reasons = vals;
        return builder;
      }),
      not: jest.fn(() => builder),
      is: jest.fn(() => builder),
      then: (resolve: (v: unknown) => void) => {
        if (isUpdate) {
          updates.push({ id: id ?? "?", patch, reasons });
          resolve({ error: null });
        } else {
          resolve({
            data: candidates.filter(
              (c) =>
                reasons === null ||
                reasons.includes(c.entitlement_reason ?? "subscription_past_due")
            ),
            error: null,
          });
        }
      },
    };
    return builder;
  });
  return updates;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "inst_1",
    user_id: "user_1",
    proxmox_node: "fixturenode1",
    proxmox_vmid: 200,
    host_id: "host_1",
    config: { infrastructure: { provider: "proxmox", node: "fixturenode1", vmid: 200 } },
    infrastructure_provider: "proxmox",
    entitlement_reason: "subscription_past_due",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getProxmoxInfrastructure as jest.Mock).mockReturnValue(infra);
  (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true });
  (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(false);
  (hasTokenTierInGrace as jest.Mock).mockResolvedValue(false);
  delete process.env.DUNNING_GRACE_ENFORCE_LIVE;
});

describe("isDunningGraceEnforceLive", () => {
  it("is false unless the flag is exactly 'true'", () => {
    expect(isDunningGraceEnforceLive({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isDunningGraceEnforceLive({ DUNNING_GRACE_ENFORCE_LIVE: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isDunningGraceEnforceLive({ DUNNING_GRACE_ENFORCE_LIVE: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("enforceGraceExpiredComputeStop", () => {
  it("skips a user who still has ANY effective entitlement (token/yearly underneath)", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
      source: "token_holding",
      plan: "operator",
    });

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("skipped_entitled");
    expect(result.affected).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    // Must not even query instances once we know the user is still entitled.
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("returns skipped_no_instances when the lapsed user has no eligible rows", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    stubInstances([]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("skipped_no_instances");
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("DRY-RUN by default: reports wouldStop but never touches a VM or a row", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    const updates = stubInstances([row(), row({ id: "inst_2", proxmox_vmid: 201 })]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: false });
    expect(result.outcome).toBe("dry_run");
    expect(result.affected).toBe(2);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("LIVE: shuts the VM down (onboot:0) and pins the grace-expired reason", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    const updates = stubInstances([row()]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("stopped");
    expect(result.affected).toBe(1);
    expect(shutdownProxmoxInstance).toHaveBeenCalledWith(
      infra,
      expect.objectContaining({ setOnboot: 0, shutdownTimeoutSeconds: 30 })
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({
      status: "stopped",
      lifecycle_state: "suspended",
      entitlement_state: "suspended",
      entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON,
    });
  });

  it("treats a MISSING VM as already-stopped and still pins the reason", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: false });
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(true);
    const updates = stubInstances([row()]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("stopped");
    expect(updates[0].patch.entitlement_reason).toBe(GRACE_EXPIRED_ENTITLEMENT_REASON);
  });

  it("does NOT pin the reason when a real (non-missing) shutdown fails — leaves it for retry", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: false, stderr: "boom" });
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(false);
    const updates = stubInstances([row()]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("error");
    expect(result.affected).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("skips a non-Proxmox (legacy) row without failing the batch", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
    const updates = stubInstances([
      row({ proxmox_vmid: null, proxmox_node: null, config: null }),
    ]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.affected).toBe(0);
  });

  describe("cancelled owners (subscription_canceled)", () => {
    const cancelled = () => row({ entitlement_reason: "subscription_canceled" });

    it("dry run (switch unset): a cancelled owner's running Proxmox computer is not touched", async () => {
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("dry_run");
      expect(result.affected).toBe(1);
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("dry-run"),
        expect.objectContaining({ userId: "user_1", wouldStop: 1 })
      );
    });

    it("live: shuts a cancelled owner's computer down (onboot 0) and flips the row to grace expired", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("stopped");
      expect(shutdownProxmoxInstance).toHaveBeenCalledWith(
        infra,
        expect.objectContaining({ setOnboot: 0 })
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].patch).toMatchObject({
        status: "stopped",
        lifecycle_state: "suspended",
        entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON,
      });
      // The compare-and-set must allow the cancelled reason to be overwritten.
      expect(updates[0].reasons).toEqual(
        expect.arrayContaining(["subscription_canceled", "subscription_past_due"])
      );
    });

    it("a cancelled owner who is now on the Free account is still stopped", async () => {
      // The Free row never pays for a hosted computer. Counting it as an
      // entitlement let a cancelled customer keep a box running just by
      // picking Free afterwards.
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
        source: "free",
        plan: "free",
        status: "active",
      });
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("stopped");
      expect(shutdownProxmoxInstance).toHaveBeenCalledWith(
        infra,
        expect.objectContaining({ setOnboot: 0 })
      );
      expect(updates[0].patch).toMatchObject({
        entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON,
      });
    });

    it("a cancelled owner left with only a trial is still stopped", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
        source: "apple_iap",
        plan: "operator",
        status: "trialing",
      });
      stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("stopped");
    });

    it("an owner with another lane's entitlement is not stopped", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
        source: "token_yearly",
        plan: "operator",
      });
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("skipped_entitled");
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it.each(["1", "TRUE", "false"])(
      "dry run: the switch set to %p is not 'true', so nothing is touched",
      async (value) => {
        process.env.DUNNING_GRACE_ENFORCE_LIVE = value;
        (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
        const updates = stubInstances([cancelled()]);

        const result = await enforceGraceExpiredComputeStop("user_1");
        expect(result.outcome).toBe("dry_run");
        expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
        expect(updates).toHaveLength(0);
      }
    );

    it("an owner whose token tier is still inside its grace is not stopped", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
      (hasTokenTierInGrace as jest.Mock).mockResolvedValue(true);
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("skipped_entitled");
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("a failed token grace read stops nothing (fail open)", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
      (hasTokenTierInGrace as jest.Mock).mockRejectedValue(new Error("read failed"));
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("skipped_entitlement_unknown");
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("a failed entitlement read stops nothing (fail open)", async () => {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      (resolveEffectiveSubscription as jest.Mock).mockRejectedValue(
        new Error("hermes_subscriptions could not be read: timeout")
      );
      const updates = stubInstances([cancelled()]);

      const result = await enforceGraceExpiredComputeStop("user_1");
      expect(result.outcome).toBe("skipped_entitlement_unknown");
      expect(result.affected).toBe(0);
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
      expect(resolveEffectiveSubscription).toHaveBeenCalledWith("user_1", {
        throwOnQueryError: true,
      });
    });
  });

  it("past_due rows are still stopped exactly as before", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    const updates = stubInstances([row({ entitlement_reason: "subscription_past_due" })]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("stopped");
    expect(updates[0].patch.entitlement_reason).toBe(GRACE_EXPIRED_ENTITLEMENT_REASON);
  });

  it("leaves a row that is already grace expired alone", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    stubInstances([row({ entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON })]);

    const result = await enforceGraceExpiredComputeStop("user_1", { live: true });
    expect(result.outcome).toBe("skipped_no_instances");
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });
});

// The sweep reaches customers who were cancelled or left unpaid BEFORE the cancel
// handler started stopping computers (or whose one stop failed): their row is
// already suspended in the database but the VM is still running. Stripe's
// "unpaid" status is written by the billing code as reason subscription_past_due.
describe("sweepBillingSuspendedCompute", () => {
  type SweepRow = Row & { lifecycle_state: string; deleted_at: string | null };
  let table: SweepRow[] = [];
  let writes = 0;
  let failUsers = new Set<string>();
  let subscriptions: Array<{ user_id: string; status: string }> = [];
  let listFails = false;
  let subscriptionsFail = false;
  const entitled = new Set<string>();

  const sweepRow = (userId: string, overrides: Partial<SweepRow> = {}): SweepRow => ({
    id: `inst_${userId}`,
    user_id: userId,
    proxmox_node: "fixturenode1",
    proxmox_vmid: 200,
    host_id: "host_1",
    config: null,
    infrastructure_provider: "proxmox",
    entitlement_reason: "subscription_canceled",
    lifecycle_state: "suspended",
    deleted_at: null,
    ...overrides,
  });

  // An in-memory hermes_instances that honours the filters the code sends and
  // applies the enforcer's compare-and-set update, so selection and the row flip
  // are tested rather than assumed.
  function stubTable() {
    (supabaseAdmin!.from as jest.Mock).mockImplementation((name: string) => {
      if (name === "hermes_subscriptions") {
        const wanted: Record<string, unknown> = {};
        const subs: Record<string, unknown> = {
          select: () => subs,
          eq: (col: string, val: unknown) => { wanted[col] = val; return subs; },
          then: (resolve: (v: unknown) => void) =>
            resolve(
              subscriptionsFail
                ? { data: null, error: { message: "subs unreadable" } }
                : { data: subscriptions.filter((r) => r.status === wanted.status), error: null }
            ),
        };
        return subs;
      }
      if (name !== "hermes_instances") throw new Error(`unexpected table ${name}`);
      const filters: Array<(r: SweepRow) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      let userEq: string | null = null;
      let idEq = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (p: Record<string, unknown>) => { patch = p; return builder; },
        eq: (col: string, val: unknown) => {
          if (col === "user_id") userEq = String(val);
          if (col === "id") idEq = true;
          filters.push((r) => (r as Record<string, unknown>)[col] === val);
          return builder;
        },
        in: (col: string, vals: string[]) => {
          filters.push((r) => vals.includes(String((r as Record<string, unknown>)[col])));
          return builder;
        },
        not: (col: string, _op: string, vals: string) => {
          const banned = vals.replace(/[()]/g, "").split(",");
          filters.push((r) => !banned.includes(String((r as Record<string, unknown>)[col])));
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => ((r as Record<string, unknown>)[col] ?? null) === val);
          return builder;
        },
        order: () => builder,
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          if (patch) {
            writes += 1;
            table.filter((r) => filters.every((f) => f(r))).forEach((r) => Object.assign(r, patch));
            return resolve({ error: null });
          }
          if (userEq && failUsers.has(userEq)) return reject(new Error("db exploded"));
          if (listFails && !userEq && !idEq) return resolve({ data: null, error: { message: "list unreadable" } });
          resolve({ data: table.filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return builder;
    });
  }

  beforeEach(() => {
    table = [];
    writes = 0;
    failUsers = new Set();
    subscriptions = [];
    listFails = false;
    subscriptionsFail = false;
    entitled.clear();
    stubTable();
    (resolveEffectiveSubscription as jest.Mock).mockImplementation(async (userId: string) =>
      entitled.has(userId) ? { source: "stripe", plan: "operator" } : null
    );
  });

  const NOW = new Date("2026-10-21T12:00:00Z");

  it("picks suspended cancelled and suspended unpaid users and nobody else", async () => {
    table = [
      sweepRow("cancelled_user"),
      sweepRow("unpaid_user", { entitlement_reason: "subscription_past_due" }),
      sweepRow("in_dunning", { entitlement_reason: "subscription_past_due" }),
      sweepRow("already_stopped", { entitlement_reason: GRACE_EXPIRED_ENTITLEMENT_REASON }),
      sweepRow("active_user", { entitlement_reason: "", lifecycle_state: "active" }),
      sweepRow("running_user", { entitlement_reason: "subscription_canceled", lifecycle_state: "running" }),
      sweepRow("deleted_user", { lifecycle_state: "deleted" }),
      sweepRow("soft_deleted_user", { deleted_at: "2026-10-01T00:00:00Z" }),
    ];
    // Stripe unpaid is stored as status inactive; a plain past_due row is the
    // grace reconciler's, which asks Stripe before stopping anything.
    subscriptions = [
      { user_id: "unpaid_user", status: "inactive" },
      { user_id: "in_dunning", status: "past_due" },
    ];

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result.picked).toBe(2);
    expect(resolveEffectiveSubscription).toHaveBeenCalledTimes(2);
    expect((resolveEffectiveSubscription as jest.Mock).mock.calls.map((c) => c[0]).sort()).toEqual([
      "cancelled_user",
      "unpaid_user",
    ]);
  });

  it("takes at most five users per run and rotates so the rest are reached", async () => {
    table = Array.from({ length: 7 }, (_, i) => sweepRow(`user_${i}`));
    const next = new Date(NOW.getTime() + 15 * 60_000);

    await sweepBillingSuspendedCompute(NOW);
    const first = (resolveEffectiveSubscription as jest.Mock).mock.calls.map((c) => c[0]);
    (resolveEffectiveSubscription as jest.Mock).mockClear();
    await sweepBillingSuspendedCompute(next);
    const second = (resolveEffectiveSubscription as jest.Mock).mock.calls.map((c) => c[0]);

    expect(BILLING_SWEEP_MAX_USERS_PER_RUN).toBe(5);
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second]).size).toBe(7);
  });

  it("skips a customer who re-subscribed after being suspended", async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [sweepRow("resubscribed"), sweepRow("lapsed")];
    entitled.add("resubscribed");

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result.stopped).toBe(1);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(table.find((r) => r.user_id === "resubscribed")!.entitlement_reason).toBe("subscription_canceled");
    expect(table.find((r) => r.user_id === "lapsed")!.entitlement_reason).toBe(GRACE_EXPIRED_ENTITLEMENT_REASON);
  });

  it("a user whose enforcer call blows up does not stop the others", async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [sweepRow("a_boom"), sweepRow("b_fine"), sweepRow("c_fine")];
    failUsers.add("a_boom");

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result).toMatchObject({ picked: 3, stopped: 2, failed: 1 });
    expect(table.filter((r) => r.entitlement_reason === GRACE_EXPIRED_ENTITLEMENT_REASON)).toHaveLength(2);
  });

  it("switch unset: powers nothing off and writes nothing, logging only the dry-run line per user", async () => {
    table = [sweepRow("one"), sweepRow("two", { entitlement_reason: "subscription_past_due" })];

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result).toMatchObject({ live: false, picked: 2, stopped: 0 });
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(writes).toBe(0);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("dry-run"), expect.anything());
  });

  it('switch "true": shuts the computer down with onboot 0 and flips the row so it is not picked again', async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [sweepRow("one")];

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result).toMatchObject({ live: true, picked: 1, stopped: 1 });
    expect(shutdownProxmoxInstance).toHaveBeenCalledWith(infra, expect.objectContaining({ setOnboot: 0 }));
    expect(table[0].entitlement_reason).toBe(GRACE_EXPIRED_ENTITLEMENT_REASON);

    (resolveEffectiveSubscription as jest.Mock).mockClear();
    const again = await sweepBillingSuspendedCompute(NOW);
    expect(again.picked).toBe(0);
    expect(resolveEffectiveSubscription).not.toHaveBeenCalled();
  });

  it("a first failure leaves the row alone and the next sweep picks the user again, then succeeds", async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [sweepRow("flaky")];
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValueOnce({ ok: false, stderr: "host unreachable" });

    const first = await sweepBillingSuspendedCompute(NOW);
    expect(first).toMatchObject({ picked: 1, stopped: 0, failed: 1 });
    expect(table[0].entitlement_reason).toBe("subscription_canceled");

    const second = await sweepBillingSuspendedCompute(NOW);
    expect(second).toMatchObject({ picked: 1, stopped: 1, failed: 0 });
    expect(table[0].entitlement_reason).toBe(GRACE_EXPIRED_ENTITLEMENT_REASON);
  });

  it("leaves a past_due subscription to the grace reconciler even when Stripe has since paid", async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [sweepRow("paid_webhook_lost", { entitlement_reason: "subscription_past_due" })];
    subscriptions = [{ user_id: "paid_webhook_lost", status: "past_due" }];

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result.picked).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(writes).toBe(0);
  });

  it("stops nothing when the suspended rows cannot be listed", async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [sweepRow("one")];
    listFails = true;

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result.picked).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(writes).toBe(0);
  });

  it("stops nothing when the past_due subscriptions cannot be listed", async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [sweepRow("one")];
    subscriptionsFail = true;

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result.picked).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(writes).toBe(0);
  });

  it("stops starting new users once its time budget is spent, but always visits one", async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [sweepRow("a"), sweepRow("b"), sweepRow("c")];

    const result = await sweepBillingSuspendedCompute(NOW, 0);
    expect(result.picked).toBe(1);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
  });

  it("does not power off a second computer whose owner paid while the first was going down", async () => {
    process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
    table = [
      sweepRow("two_boxes", { id: "inst_a" }),
      sweepRow("two_boxes", { id: "inst_b", proxmox_vmid: 201 }),
    ];
    (shutdownProxmoxInstance as jest.Mock).mockImplementationOnce(async () => {
      // The customer re-subscribes now: the resume flips the other row's reason.
      table.find((r) => r.id === "inst_b")!.entitlement_reason = "";
      return { ok: true };
    });

    const result = await sweepBillingSuspendedCompute(NOW);
    expect(result.stopped).toBe(1);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(table.find((r) => r.id === "inst_b")!.entitlement_reason).toBe("");
  });

  it("gives up on a shutdown that never returns, leaves the row for the next sweep", async () => {
    jest.useFakeTimers();
    try {
      process.env.DUNNING_GRACE_ENFORCE_LIVE = "true";
      table = [sweepRow("hung_host")];
      (shutdownProxmoxInstance as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));

      const pending = sweepBillingSuspendedCompute(NOW);
      await jest.advanceTimersByTimeAsync(90_000);
      const result = await pending;

      expect(result).toMatchObject({ picked: 1, stopped: 0, failed: 1 });
      expect(table[0].entitlement_reason).toBe("subscription_canceled");
    } finally {
      jest.useRealTimers();
    }
  });
});
