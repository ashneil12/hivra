import { getStarterCreditLine, starterCreditMicroUsd, tryGrantStarterCredit } from "../starter-credit";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

const paid = async () => ({ plan: "pro", status: "active" });
const signedUp = async () => new Date("2026-11-12T20:28:00Z");

function rpcDb(result: { data: unknown; error: { message: string } | null }) {
  const rpc = jest.fn().mockResolvedValue(result);
  return { db: { from: jest.fn(), rpc }, rpc };
}

describe("starterCreditMicroUsd", () => {
  it.each([
    [undefined, 2_000_000],
    ["", 2_000_000],
    ["0", 0],
    ["3.5", 3_500_000],
    ["abc", 2_000_000],
    ["-1", 2_000_000],
    ["50", 10_000_000],
  ])("parses %p", (raw, expected) => {
    expect(starterCreditMicroUsd({ HIVRA_STARTER_CREDIT_USD: raw })).toBe(expected);
  });
});

describe("tryGrantStarterCredit", () => {
  it("grants $2 to an active paid plan", async () => {
    const { db, rpc } = rpcDb({ data: { granted: true, status: "granted", amountMicroUsd: 2000000 }, error: null });
    const r = await tryGrantStarterCredit({ userId: "u1", env: {}, resolveSubscription: paid, resolveAccountCreatedAt: signedUp }, db);
    expect(r).toMatchObject({ attempted: true, granted: true, amountMicroUsd: 2000000 });
    expect(rpc).toHaveBeenCalledWith("grant_starter_credit", expect.objectContaining({ p_user_id: "u1", p_amount_micro_usd: 2000000, p_account_created_at: "2026-11-12T20:28:00.000Z" }));
  });

  it("reports an already-granted repeat", async () => {
    const { db } = rpcDb({ data: { granted: false, status: "already_granted", amountMicroUsd: 2000000 }, error: null });
    const r = await tryGrantStarterCredit({ userId: "u1", env: {}, resolveSubscription: paid, resolveAccountCreatedAt: signedUp }, db);
    expect(r).toMatchObject({ attempted: true, granted: false, status: "already_granted" });
  });

  it.each([
    ["free plan", { plan: "free", status: "active" }],
    ["canceled", { plan: "pro", status: "canceled" }],
    ["no subscription", null],
  ])("skips %s", async (_n, sub) => {
    const { db, rpc } = rpcDb({ data: {}, error: null });
    const r = await tryGrantStarterCredit({ userId: "u1", env: {}, resolveSubscription: async () => sub }, db);
    expect(r).toEqual({ attempted: false, skipped: "no_paid_plan" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("skips when the sign-up time can't be read", async () => {
    const { db, rpc } = rpcDb({ data: {}, error: null });
    const r = await tryGrantStarterCredit({ userId: "u1", env: {}, resolveSubscription: paid, resolveAccountCreatedAt: async () => null }, db);
    expect(r).toEqual({ attempted: false, skipped: "no_account_created_at" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does nothing when turned off", async () => {
    const { db, rpc } = rpcDb({ data: {}, error: null });
    const r = await tryGrantStarterCredit({ userId: "u1", env: { HIVRA_STARTER_CREDIT_USD: "0" }, resolveSubscription: paid, resolveAccountCreatedAt: signedUp }, db);
    expect(r.skipped).toBe("disabled");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("swallows rpc and lookup errors", async () => {
    const { db } = rpcDb({ data: null, error: { message: "boom" } });
    expect((await tryGrantStarterCredit({ userId: "u1", env: {}, resolveSubscription: paid, resolveAccountCreatedAt: signedUp }, db)).skipped).toBe("error");
    const r = await tryGrantStarterCredit({ userId: "u1", env: {}, resolveSubscription: async () => { throw new Error("x"); } }, db);
    expect(r.skipped).toBe("error");
  });
});

describe("getStarterCreditLine", () => {
  function ledgerDb(grant: unknown, debits: unknown[]) {
    const from = jest.fn(() => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.gte = () => q;
      q.maybeSingle = async () => ({ data: grant, error: null });
      q.then = (res: (v: unknown) => unknown) => res({ data: debits, error: null });
      return q;
    });
    return { from };
  }

  it("shows the unspent part", async () => {
    const db = ledgerDb({ amount_micro_usd: 2000000, created_at: "2026-11-12T00:00:00Z" }, [{ amount_micro_usd: -500000 }]);
    expect(await getStarterCreditLine("u1", db)).toEqual({ remainingMicroUsd: 1500000, label: "$1.50 Starter credit" });
  });

  it("is null without a grant or when spent", async () => {
    expect(await getStarterCreditLine("u1", ledgerDb(null, []))).toBeNull();
    expect(await getStarterCreditLine("u1", ledgerDb({ amount_micro_usd: 2000000, created_at: "x" }, [{ amount_micro_usd: -2500000 }]))).toBeNull();
  });
});
