// `pro-tier.ts` is a `server-only` module. Under jest the real package throws on
// import, so stub it the way a Server Component runtime would.
jest.mock("server-only", () => ({}));

jest.mock("@/lib/billing/credits", () => ({
  getCreditSummary: jest.fn(async () => ({ balance: 0 })),
  deriveReservedCreditBalance: jest.fn(async () => 0),
}));

type ReadResult = { data: unknown; error: { message: string } | null };

// Each table read resolves to the { data, error } the test sets, like PostgREST.
const mockReads: Record<string, ReadResult> = {};

jest.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const result = () => mockReads[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "not"]) {
      builder[method] = () => builder;
    }
    builder.maybeSingle = async () => result();
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return builder;
  };
  return { supabaseAdmin: { from: (table: string) => chain(table) } };
});

import { isProTierUser } from "@/lib/billing/pro-tier";

describe("isProTierUser read failures", () => {
  beforeEach(() => {
    mockReads.hermes_subscriptions = { data: null, error: null };
    mockReads.hermes_instances = { data: [], error: null };
  });

  it("reports no_entitlement when both reads succeed and the user has no subscription", async () => {
    const check = await isProTierUser("user_1");

    expect(check).toEqual({ ok: false, tier: null, reason: "no_entitlement" });
  });

  it("reports lookup_failed, not no_entitlement, when the subscription read errors", async () => {
    mockReads.hermes_subscriptions = { data: null, error: { message: "connection reset" } };

    const check = await isProTierUser("user_1");

    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/^lookup_failed:.*subscription read failed: connection reset/);
  });

  it("reports lookup_failed, not no_entitlement, when the instances read errors", async () => {
    mockReads.hermes_instances = { data: null, error: { message: "statement timeout" } };

    const check = await isProTierUser("user_1");

    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/^lookup_failed:.*instances read failed: statement timeout/);
  });
});
