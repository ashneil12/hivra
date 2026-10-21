import { runHivraLapseSweep, HIVRA_LAPSE_MAX_STOPS_PER_RUN } from "../hivra-lapse-enforce";
import { stopHivraManagedComputer } from "../stop-deleted-user-computers";
import { sendHivraComputerStoppedEmail } from "@/lib/email/hivra-computer-stopped";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { log } from "@/lib/logger";

// The sweep stops running Hivra Cloud computers whose owner has no paid plan.
// The entitlement rule itself is resolveEffectiveSubscription (covered by its
// own tests); these tests pin who is selected, what is skipped, and that the
// sweep writes nothing until HIVRA_LAPSE_ENFORCE_LIVE is "true".

type Row = Record<string, unknown>;
let table: Row[] = [];
let writes = 0;

// A tiny in-memory hivra_agents that honours the filters the sweep sends, so
// the selection rules are tested, not assumed.
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (name: string) => {
      if (name !== "hivra_agents") throw new Error(`unexpected table ${name}`);
      const filters: Array<(row: Row) => boolean> = [];
      let max = Infinity;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; },
        is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return builder; },
        gt: (column: string, value: string) => { filters.push((row) => String(row[column]) > value); return builder; },
        order: () => builder,
        limit: (n: number) => { max = n; return builder; },
        update: () => { writes += 1; return builder; },
        insert: () => { writes += 1; return builder; },
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: table.filter((row) => filters.every((f) => f(row))).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, max), error: null }),
      };
      return builder;
    },
  },
}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../stop-deleted-user-computers", () => ({ stopHivraManagedComputer: jest.fn() }));
jest.mock("@/lib/email/hivra-computer-stopped", () => ({ sendHivraComputerStoppedEmail: jest.fn() }));
jest.mock("@/lib/billing/instance-entitlement", () => ({ resolveEffectiveSubscription: jest.fn(), hasTokenTierInGrace: () => Promise.resolve(false) }));

const resolve = resolveEffectiveSubscription as jest.Mock;
const stop = stopHivraManagedComputer as jest.Mock;
const email = sendHivraComputerStoppedEmail as jest.Mock;

const computer = (id: string, userId: string, extra: Row = {}): Row => ({
  id, user_id: userId, name: id, status: "running", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
  deployment_target_id: null, infrastructure_connection_id: null, provider_server_id: null, ...extra,
});
const stripe = (status: "active" | "past_due" = "active") => ({ plan: "operator", source: "stripe", status });
const entitlements: Record<string, unknown> = {
  stripe_active: stripe(), past_due_in_grace: stripe("past_due"),
  apple: { plan: "operator", source: "apple_iap", status: "active" },
  yearly: { plan: "operator", source: "token_yearly", status: "active" },
  token: { plan: "operator", source: "token_holding", status: "active" },
  manual_grant: { plan: "fleet", source: "stripe", status: "active" },
};
const free = { plan: "free", source: "free", status: "active" };

const originalLive = process.env.HIVRA_LAPSE_ENFORCE_LIVE;
const setLive = (on: boolean) => { if (on) process.env.HIVRA_LAPSE_ENFORCE_LIVE = "true"; else delete process.env.HIVRA_LAPSE_ENFORCE_LIVE; };
beforeEach(() => {
  jest.clearAllMocks();
  table = []; writes = 0;
  setLive(true);
  stop.mockResolvedValue(undefined);
  email.mockResolvedValue({ sent: true });
  resolve.mockResolvedValue(null);
});
afterAll(() => { if (originalLive === undefined) delete process.env.HIVRA_LAPSE_ENFORCE_LIVE; else process.env.HIVRA_LAPSE_ENFORCE_LIVE = originalLive; });

describe("while the switch is off", () => {
  it("stops nothing, writes nothing and sends nothing, and only logs who would be stopped", async () => {
    setLive(false);
    table = [computer("c-1", "user_lapsed"), computer("c-2", "user_free")];
    resolve.mockImplementation(async (userId: string) => (userId === "user_free" ? free : null));
    const result = await runHivraLapseSweep();
    expect(result).toMatchObject({ live: false, running: 2, lapsed: 2, stopped: 0 });
    expect(stop).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(writes).toBe(0);
    const logged = JSON.stringify((log.warn as jest.Mock).mock.calls);
    expect(logged).toContain("c-1");
    expect(logged).toContain("c-2");
    expect(logged).not.toMatch(/@/);
  });
});

describe("while the switch is on", () => {
  it("stops a computer whose owner has no entitlement, then sends the one email", async () => {
    table = [computer("c-1", "user_lapsed")];
    const result = await runHivraLapseSweep();
    expect(stop).toHaveBeenCalledWith("user_lapsed", "c-1");
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_lapsed", agentId: "c-1" }));
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(email.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ live: true, lapsed: 1, stopped: 1, failed: 0 });
  });

  it("stops a computer that sits on a Free account", async () => {
    table = [computer("c-1", "user_free")];
    resolve.mockResolvedValue(free);
    await runHivraLapseSweep();
    expect(stop).toHaveBeenCalledWith("user_free", "c-1");
  });

  it.each(Object.keys(entitlements))("leaves a computer alone when the owner is entitled by %s", async (lane) => {
    table = [computer("c-1", "user_paid")];
    resolve.mockResolvedValue(entitlements[lane]);
    const result = await runHivraLapseSweep();
    expect(stop).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(result).toMatchObject({ lapsed: 0, stopped: 0 });
  });

  it("fails open: a resolver error stops nothing", async () => {
    table = [computer("c-1", "user_unknown")];
    resolve.mockRejectedValue(new Error("database unavailable"));
    const result = await runHivraLapseSweep();
    expect(stop).not.toHaveBeenCalled();
    expect(result).toMatchObject({ lapsed: 0, stopped: 0 });
  });

  it("only selects running Hivra Cloud computers", async () => {
    table = [
      computer("c-run", "user_lapsed"),
      computer("c-stopped", "user_lapsed", { status: "stopped" }),
      computer("c-deleted", "user_lapsed", { status: "deleted" }),
      computer("c-self", "user_lapsed", { deployment_mode: "self-managed", deployment_target_id: "t", infrastructure_connection_id: "i" }),
      computer("c-conn", "user_lapsed", { infrastructure_connection_id: "i" }),
      computer("c-provider", "user_lapsed", { computer_substrate: "provider-vm", deployment_mode: "self-managed" }),
      computer("c-gvisor", "user_lapsed", { computer_substrate: "gvisor", deployment_mode: "self-managed" }),
    ];
    await runHivraLapseSweep();
    expect(stop.mock.calls).toEqual([["user_lapsed", "c-run"]]);
  });

  it("asks about each owner once, however many computers they have", async () => {
    table = [computer("c-1", "user_a"), computer("c-2", "user_a"), computer("c-3", "user_b")];
    await runHivraLapseSweep();
    expect(resolve.mock.calls.slice(0, 2).map((call) => call[0])).toEqual(["user_a", "user_b"]);
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it("asks again just before each stop, so an owner who has just paid is not stopped", async () => {
    table = [computer("c-1", "user_a"), computer("c-2", "user_b")];
    resolve.mockImplementation(async (userId: string) => (userId === "user_b" && stop.mock.calls.length > 0 ? entitlements.stripe_active : null));
    const result = await runHivraLapseSweep();
    expect(stop.mock.calls).toEqual([["user_a", "c-1"]]);
    expect(email).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ lapsed: 2, stopped: 1 });
  });

  it("stops at most the cap per run", async () => {
    table = Array.from({ length: 12 }, (_, i) => computer(`c-${String(i).padStart(2, "0")}`, `user_${i}`));
    const result = await runHivraLapseSweep();
    expect(HIVRA_LAPSE_MAX_STOPS_PER_RUN).toBe(5);
    expect(stop).toHaveBeenCalledTimes(HIVRA_LAPSE_MAX_STOPS_PER_RUN);
    expect(result).toMatchObject({ lapsed: 12, stopped: 5 });
  });

  it("does not select a computer that is already stopped, so a second run does nothing", async () => {
    table = [computer("c-1", "user_lapsed")];
    stop.mockImplementation(async (_user: string, id: string) => { table.find((row) => row.id === id)!.status = "stopped"; });
    await runHivraLapseSweep();
    await runHivraLapseSweep();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("does not send the email, and keeps going, when a stop fails", async () => {
    table = [computer("c-1", "user_a"), computer("c-2", "user_b")];
    stop.mockRejectedValueOnce(new Error("Computer shutdown or autostart disable is unconfirmed"));
    const result = await runHivraLapseSweep();
    expect(email).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ agentId: "c-2" }));
    expect(result).toMatchObject({ stopped: 1, failed: 1 });
  });

  it.each(["rejects", "returns not sent"])("a failing email never undoes the stop (%s)", async (mode) => {
    table = [computer("c-1", "user_lapsed")];
    if (mode === "rejects") email.mockRejectedValue(new Error("resend down"));
    else email.mockResolvedValue({ sent: false, reason: "send_failed" });
    const result = await runHivraLapseSweep();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ stopped: 1, failed: 0 });
  });
});
