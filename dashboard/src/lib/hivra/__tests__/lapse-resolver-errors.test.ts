import { isStartBlockedForLapse, ownerHasNoPaidPlan } from "../lapse-gate";

// The real entitlement resolver against a database where one read fails. A
// failed read must never make a paying owner look unpaid, in the sweep or in
// the Start gate (both go through ownerHasNoPaidPlan).

type Result = { data: unknown; error: { message: string } | null };
let tables: Record<string, Result>;

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (name: string) => {
      const result = () => Promise.resolve(tables[name] ?? { data: null, error: null });
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "gt", "order", "limit"]) builder[method] = () => builder;
      builder.maybeSingle = result;
      builder.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => result().then(resolve, reject);
      return builder;
    },
  },
}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const ok = (data: unknown): Result => ({ data, error: null });
const failed: Result = { data: null, error: { message: "statement timeout" } };
const paidRow = { plan: "operator", status: "active", instance_limit: 3, total_cpu_budget: 4, total_ram_budget: 8, current_period_end: null, stripe_subscription_id: "sub_123", grace_period_ends_at: null };
const cloud = { user_id: "owner", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", deployment_target_id: null, infrastructure_connection_id: null };

const original = process.env.HIVRA_LAPSE_ENFORCE_LIVE;
beforeEach(() => {
  process.env.HIVRA_LAPSE_ENFORCE_LIVE = "true";
  tables = { hermes_subscriptions: ok(null), apple_iap_subscriptions: ok(null), yearly_token_subscriptions: ok([]), token_tier_qualifications: ok([]) };
});
afterAll(() => { if (original === undefined) delete process.env.HIVRA_LAPSE_ENFORCE_LIVE; else process.env.HIVRA_LAPSE_ENFORCE_LIVE = original; });

describe("the lapse decision with the real resolver", () => {
  it("treats an owner with no plan anywhere, and every read healthy, as unpaid", async () => {
    expect(await ownerHasNoPaidPlan("owner")).toBe(true);
    expect(await isStartBlockedForLapse(cloud, "start")).toBe(true);
  });

  it("does not treat a paid owner as unpaid when the subscription read fails and a later read comes back empty", async () => {
    tables.hermes_subscriptions = failed;
    expect(await ownerHasNoPaidPlan("owner")).toBe(false);
    expect(await isStartBlockedForLapse(cloud, "start")).toBe(false);
  });

  it.each(["apple_iap_subscriptions", "yearly_token_subscriptions", "token_tier_qualifications"])("does not act when the %s read fails", async (table) => {
    tables.hermes_subscriptions = ok({ ...paidRow, status: "canceled" });
    tables[table] = failed;
    expect(await ownerHasNoPaidPlan("owner")).toBe(false);
    expect(await isStartBlockedForLapse(cloud, "resize")).toBe(false);
  });

  it("still sees a healthy paid subscription as paid", async () => {
    tables.hermes_subscriptions = ok(paidRow);
    expect(await ownerHasNoPaidPlan("owner")).toBe(false);
  });
});
