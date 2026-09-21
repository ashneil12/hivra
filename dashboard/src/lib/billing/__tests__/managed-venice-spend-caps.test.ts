import {
  ManagedVeniceSpendCapError,
  resolveManagedVeniceSpendCapConfig,
  monthStartIso,
  getManagedVeniceMonthlySpendMicroUsd,
  assertManagedVeniceWithinSpendCap,
} from "@/lib/billing/managed-venice-spend-caps";

// Minimal mock of the supabase select chain: select().eq().eq().gte() then await.
function mockUsageDb(rows: Array<{ charged_micro_usd: number }>, capture?: { gte?: unknown }) {
  const chain: Record<string, unknown> = {};
  const ret = () => chain;
  chain.select = ret;
  chain.eq = ret;
  chain.gte = (_col: string, val: unknown) => { if (capture) capture.gte = val; return chain; };
  chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  return { from: () => chain };
}

describe("resolveManagedVeniceSpendCapConfig", () => {
  it("is disabled with no cap by default", () => {
    expect(resolveManagedVeniceSpendCapConfig({})).toEqual({ enabled: false, capMicroUsd: null });
  });
  it("reads the flag and parses USD → microdollars", () => {
    expect(
      resolveManagedVeniceSpendCapConfig({
        MANAGED_VENICE_SPEND_CAPS_ENABLED: "true",
        MANAGED_VENICE_MONTHLY_SPEND_CAP_USD: "25",
      })
    ).toEqual({ enabled: true, capMicroUsd: 25_000_000 });
  });
  it("ignores a non-positive / junk cap", () => {
    expect(resolveManagedVeniceSpendCapConfig({ MANAGED_VENICE_MONTHLY_SPEND_CAP_USD: "0" }).capMicroUsd).toBeNull();
    expect(resolveManagedVeniceSpendCapConfig({ MANAGED_VENICE_MONTHLY_SPEND_CAP_USD: "nope" }).capMicroUsd).toBeNull();
  });
});

describe("monthStartIso", () => {
  it("returns the first instant of the current UTC month", () => {
    expect(monthStartIso(new Date("2026-06-13T18:30:00.000Z"))).toBe("2026-06-01T00:00:00.000Z");
    expect(monthStartIso(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("getManagedVeniceMonthlySpendMicroUsd", () => {
  it("sums charged_micro_usd and filters from the month start", async () => {
    const capture: { gte?: unknown } = {};
    const db = mockUsageDb([{ charged_micro_usd: 1_000 }, { charged_micro_usd: 2_500 }], capture);
    const spent = await getManagedVeniceMonthlySpendMicroUsd("user-1", new Date("2026-06-13T00:00:00Z"), db);
    expect(spent).toBe(3_500);
    expect(capture.gte).toBe("2026-06-01T00:00:00.000Z");
  });
  it("tolerates missing/garbage charged values", async () => {
    const db = mockUsageDb([{ charged_micro_usd: 100 }, {} as { charged_micro_usd: number }, { charged_micro_usd: NaN }]);
    expect(await getManagedVeniceMonthlySpendMicroUsd("user-1", new Date(), db)).toBe(100);
  });
});

describe("assertManagedVeniceWithinSpendCap", () => {
  const enabled = { MANAGED_VENICE_SPEND_CAPS_ENABLED: "true", MANAGED_VENICE_MONTHLY_SPEND_CAP_USD: "10" };

  it("is a no-op when disabled (never queries the db)", async () => {
    const db = { from: () => { throw new Error("should not query when disabled"); } };
    await expect(
      assertManagedVeniceWithinSpendCap({ userId: "u", addMicroUsd: 999_999_999 }, db, {})
    ).resolves.toBeUndefined();
  });

  it("allows a request that stays under the cap", async () => {
    const db = mockUsageDb([{ charged_micro_usd: 5_000_000 }]);
    await expect(
      assertManagedVeniceWithinSpendCap({ userId: "u", addMicroUsd: 1_000_000 }, db, enabled)
    ).resolves.toBeUndefined();
  });

  it("throws ManagedVeniceSpendCapError when the request would exceed the cap", async () => {
    const db = mockUsageDb([{ charged_micro_usd: 9_500_000 }]);
    await expect(
      assertManagedVeniceWithinSpendCap({ userId: "u", addMicroUsd: 1_000_000 }, db, enabled)
    ).rejects.toBeInstanceOf(ManagedVeniceSpendCapError);
  });

  it("carries cap + spent on the error for the 402 message", async () => {
    const db = mockUsageDb([{ charged_micro_usd: 10_000_001 }]);
    await expect(
      assertManagedVeniceWithinSpendCap({ userId: "u", addMicroUsd: 1 }, db, enabled)
    ).rejects.toMatchObject({ capMicroUsd: 10_000_000, spentMicroUsd: 10_000_001 });
  });
});
