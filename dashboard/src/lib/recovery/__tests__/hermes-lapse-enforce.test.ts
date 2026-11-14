import {
  HERMES_LAPSE_MAX_STOPS_PER_RUN,
  NO_PAID_PLAN_PAUSED_REASON,
  runHermesLapseSweep,
} from "../hermes-lapse-enforce";
import { shutdownProxmoxInstance, isProxmoxVmMissingResult } from "@/lib/services/proxmox-instance-service";
import { sendHivraComputerStoppedEmail } from "@/lib/email/hivra-computer-stopped";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { log } from "@/lib/logger";

// The sweep stops running older-lane hosted computers whose owner has no paid
// plan. The entitlement rule is ownerHasNoPaidPlan (covered by the lapse gate
// tests); these pin who is selected, how the row is left, and that nothing is
// stopped or written until HIVRA_LAPSE_ENFORCE_LIVE is "true".

type Row = Record<string, unknown>;
let instances: Row[] = [];
let subscriptions: Row[] = [];
let writes = 0;

// A tiny in-memory database that honours the filters the sweep sends, so the
// selection and the compare-and-set on the update are tested, not assumed.
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (name: string) => {
      const rows = name === "hermes_instances" ? instances : name === "hermes_subscriptions" ? subscriptions : null;
      if (!rows) throw new Error(`unexpected table ${name}`);
      const filters: Array<(row: Row) => boolean> = [];
      let max = Infinity;
      let patch: Row | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (p: Row) => { patch = p; return builder; },
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; },
        is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return builder; },
        gt: (column: string, value: string) => { filters.push((row) => String(row[column]) > value); return builder; },
        order: () => builder,
        limit: (n: number) => { max = n; return builder; },
        then: (resolve: (value: unknown) => unknown) => {
          const matched = rows.filter((row) => filters.every((f) => f(row))).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, max);
          if (patch) { writes += 1; for (const row of matched) Object.assign(row, patch); }
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
  },
}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(() => null),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  isProxmoxVmMissingResult: jest.fn(() => false),
}));
jest.mock("@/lib/email/hivra-computer-stopped", () => ({ sendHivraComputerStoppedEmail: jest.fn() }));
jest.mock("@/lib/billing/instance-entitlement", () => ({ resolveEffectiveSubscription: jest.fn(), hasTokenTierInGrace: () => Promise.resolve(false) }));

const resolve = resolveEffectiveSubscription as jest.Mock;
const shutdown = shutdownProxmoxInstance as jest.Mock;
const email = sendHivraComputerStoppedEmail as jest.Mock;

const instance = (id: string, userId: string, extra: Row = {}): Row => ({
  id, user_id: userId, name: id, status: "running", lifecycle_state: "active", infrastructure_provider: "proxmox",
  deleted_at: null, proxmox_node: "node1", proxmox_vmid: 200, host_id: "host_1", config: null, paused_reason: null, ...extra,
});
const free = { plan: "free", source: "free", status: "active" };
const paid = { plan: "operator", source: "stripe", status: "active" };

const originalLive = process.env.HIVRA_LAPSE_ENFORCE_LIVE;
const setLive = (on: boolean) => { if (on) process.env.HIVRA_LAPSE_ENFORCE_LIVE = "true"; else delete process.env.HIVRA_LAPSE_ENFORCE_LIVE; };
beforeEach(() => {
  jest.clearAllMocks();
  instances = []; subscriptions = []; writes = 0;
  setLive(true);
  shutdown.mockResolvedValue({ ok: true });
  (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(false);
  email.mockResolvedValue({ sent: true });
  resolve.mockResolvedValue(free);
});
afterAll(() => { if (originalLive === undefined) delete process.env.HIVRA_LAPSE_ENFORCE_LIVE; else process.env.HIVRA_LAPSE_ENFORCE_LIVE = originalLive; });

describe("while the switch is off", () => {
  it("shuts nothing down, writes nothing and sends nothing, and only logs who would be stopped", async () => {
    setLive(false);
    instances = [instance("i-1", "user_free"), instance("i-2", "user_lapsed")];
    resolve.mockImplementation(async (userId: string) => (userId === "user_free" ? free : null));
    const result = await runHermesLapseSweep();
    expect(result).toMatchObject({ live: false, running: 2, lapsed: 2, stopped: 0 });
    expect(shutdown).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(writes).toBe(0);
    const logged = JSON.stringify((log.warn as jest.Mock).mock.calls);
    expect(logged).toContain("i-1");
    expect(logged).toContain("i-2");
  });
});

describe("while the switch is on", () => {
  it("shuts a Free owner's computer down with onboot 0, pauses the row (not suspended) and sends the email", async () => {
    instances = [instance("i-1", "user_free")];
    const result = await runHermesLapseSweep();
    expect(shutdown).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "proxmox", node: "node1", vmid: 200 }),
      expect.objectContaining({ expectedInstanceId: "i-1", setOnboot: 0 }),
    );
    // Paused, never suspended: the stale-suspended sweep deletes suspended Free
    // computers after 8 days, and the disk is to be kept.
    expect(instances[0]).toMatchObject({ status: "stopped", lifecycle_state: "paused", paused_reason: NO_PAID_PLAN_PAUSED_REASON });
    expect(instances[0].lifecycle_state).not.toBe("suspended");
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_free", agentId: "i-1" }));
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(email.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ live: true, lapsed: 1, stopped: 1, failed: 0 });
  });

  it("stops a computer whose owner has no entitlement at all, or only a trial", async () => {
    instances = [instance("i-1", "user_none"), instance("i-2", "user_trial")];
    resolve.mockImplementation(async (userId: string) => (userId === "user_trial" ? { ...paid, status: "trialing" } : null));
    await runHermesLapseSweep();
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Stripe", paid],
    ["a card failure inside its grace", { ...paid, status: "past_due" }],
    ["Apple", { plan: "operator", source: "apple_iap", status: "active" }],
    ["a yearly token plan", { plan: "operator", source: "token_yearly", status: "active" }],
    ["a token tier", { plan: "fleet", source: "token_holding", status: "active" }],
  ])("leaves a computer alone when the owner pays through %s", async (_lane, entitlement) => {
    instances = [instance("i-1", "user_paid")];
    resolve.mockResolvedValue(entitlement);
    const result = await runHermesLapseSweep();
    expect(shutdown).not.toHaveBeenCalled();
    expect(writes).toBe(0);
    expect(result).toMatchObject({ lapsed: 0, stopped: 0 });
  });

  it("fails open: a plan read error stops nothing", async () => {
    instances = [instance("i-1", "user_unknown")];
    resolve.mockRejectedValue(new Error("database unavailable"));
    const result = await runHermesLapseSweep();
    expect(shutdown).not.toHaveBeenCalled();
    expect(result).toMatchObject({ lapsed: 0, stopped: 0 });
  });

  it("leaves an owner whose subscription is still past_due to the grace reconciler", async () => {
    instances = [instance("i-1", "user_past_due")];
    subscriptions = [{ user_id: "user_past_due", status: "past_due" }];
    resolve.mockResolvedValue(null);
    await runHermesLapseSweep();
    expect(shutdown).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("only selects running, active, undeleted Proxmox computers", async () => {
    instances = [
      instance("i-run", "user_free"),
      instance("i-stopped", "user_free", { status: "stopped", lifecycle_state: "paused" }),
      instance("i-suspended", "user_free", { lifecycle_state: "suspended" }),
      instance("i-deleted", "user_free", { deleted_at: "2026-10-01T00:00:00Z" }),
      instance("i-hetzner", "user_free", { infrastructure_provider: "hetzner" }),
    ];
    await runHermesLapseSweep();
    expect(shutdown.mock.calls.map((call) => call[1].expectedInstanceId)).toEqual(["i-run"]);
  });

  it("asks again just before each stop, so an owner who has just paid is not stopped", async () => {
    instances = [instance("i-1", "user_a"), instance("i-2", "user_b")];
    resolve.mockImplementation(async (userId: string) => (userId === "user_b" && shutdown.mock.calls.length > 0 ? paid : free));
    const result = await runHermesLapseSweep();
    expect(shutdown.mock.calls.map((call) => call[1].expectedInstanceId)).toEqual(["i-1"]);
    expect(result).toMatchObject({ lapsed: 2, stopped: 1 });
  });

  it("stops at most the cap per run", async () => {
    instances = Array.from({ length: 12 }, (_, i) => instance(`i-${String(i).padStart(2, "0")}`, `user_${i}`));
    const result = await runHermesLapseSweep();
    expect(HERMES_LAPSE_MAX_STOPS_PER_RUN).toBe(5);
    expect(shutdown).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ lapsed: 12, stopped: 5 });
  });

  it("stops starting new shutdowns once its time budget is spent, but always does one", async () => {
    instances = [instance("i-1", "user_a"), instance("i-2", "user_b")];
    const result = await runHermesLapseSweep(new Date(), 0);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ stopped: 1 });
  });

  it("does not pick a computer it already stopped, so a second run does nothing", async () => {
    instances = [instance("i-1", "user_free")];
    await runHermesLapseSweep();
    await runHermesLapseSweep();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("leaves the row running and sends no email when the shutdown fails, then keeps going", async () => {
    instances = [instance("i-1", "user_a"), instance("i-2", "user_b")];
    shutdown.mockResolvedValueOnce({ ok: false, stderr: "host unreachable" });
    const result = await runHermesLapseSweep();
    expect(instances.find((row) => row.id === "i-1")).toMatchObject({ status: "running", lifecycle_state: "active" });
    expect(email).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ agentId: "i-2" }));
    expect(result).toMatchObject({ stopped: 1, failed: 1 });
  });

  it("treats a missing VM as already stopped and still pauses the row", async () => {
    instances = [instance("i-1", "user_free")];
    shutdown.mockResolvedValue({ ok: false });
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(true);
    await runHermesLapseSweep();
    expect(instances[0]).toMatchObject({ status: "stopped", lifecycle_state: "paused", paused_reason: NO_PAID_PLAN_PAUSED_REASON });
  });

  it("skips a row with no Proxmox address without failing the run", async () => {
    instances = [instance("i-1", "user_free", { proxmox_node: null, proxmox_vmid: null })];
    const result = await runHermesLapseSweep();
    expect(shutdown).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stopped: 0, failed: 0 });
  });

  it.each(["rejects", "returns not sent"])("a failing email never undoes the stop (%s)", async (mode) => {
    instances = [instance("i-1", "user_free")];
    if (mode === "rejects") email.mockRejectedValue(new Error("resend down"));
    else email.mockResolvedValue({ sent: false, reason: "send_failed" });
    const result = await runHermesLapseSweep();
    expect(instances[0]).toMatchObject({ lifecycle_state: "paused" });
    expect(result).toMatchObject({ stopped: 1, failed: 0 });
  });
});
