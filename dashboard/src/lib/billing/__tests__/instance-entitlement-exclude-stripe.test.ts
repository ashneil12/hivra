import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));

type Row = Record<string, unknown>;

// Chainable query double: applies .eq/.in filters to the table's rows, then
// resolves either as a list (await) or a single row (.maybeSingle()).
function table(rows: Row[]) {
  const filters: Array<(row: Row) => boolean> = [];
  const matching = () => rows.filter((row) => filters.every((keep) => keep(row)));
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push((row) => row[column] === value);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: matching(), error: null }).then(resolve, reject),
  });
  return builder;
}

const USER = "user_lapse";
const PAID_STRIPE_ROW = {
  user_id: USER,
  plan: "command",
  status: "active",
  instance_limit: 8,
  total_cpu_budget: 8,
  total_ram_budget: 16384,
  current_period_end: "2026-10-01T00:00:00.000Z",
  stripe_subscription_id: "sub_live",
  grace_period_ends_at: null,
};
const FREE_ROW = { ...PAID_STRIPE_ROW, plan: "free", instance_limit: 1, stripe_subscription_id: null };
const LIVE_POWER_YEAR = {
  user_id: USER,
  tier: "power",
  status: "active",
  paid_at: "2026-03-07T00:00:00.000Z",
  expires_at: "2027-03-07T00:00:00.000Z",
};

function mockDb(tables: Partial<Record<string, Row[]>>) {
  (supabaseAdmin!.from as jest.Mock).mockImplementation((name: string) => table(tables[name] ?? []));
}

function tablesRead(): string[] {
  return (supabaseAdmin!.from as jest.Mock).mock.calls.map(([name]) => name);
}

describe("resolveEffectiveSubscription({ excludeStripe })", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports a yearly entitlement that a paid Stripe row would otherwise hide", async () => {
    mockDb({
      hermes_subscriptions: [PAID_STRIPE_ROW],
      yearly_token_subscriptions: [LIVE_POWER_YEAR],
    });

    const other = await resolveEffectiveSubscription(USER, { excludeStripe: true });

    expect(other).toMatchObject({ source: "token_yearly", plan: "fleet" });
    expect(tablesRead()).not.toContain("hermes_subscriptions");
  });

  it("returns null instead of the Free fallback when no other lane pays", async () => {
    mockDb({ hermes_subscriptions: [FREE_ROW] });

    await expect(
      resolveEffectiveSubscription(USER, { excludeStripe: true })
    ).resolves.toBeNull();
  });

  it("still lets a paid Stripe row win by default", async () => {
    mockDb({
      hermes_subscriptions: [PAID_STRIPE_ROW],
      yearly_token_subscriptions: [LIVE_POWER_YEAR],
    });

    await expect(resolveEffectiveSubscription(USER)).resolves.toMatchObject({
      source: "stripe",
      plan: "command",
    });
  });
});
