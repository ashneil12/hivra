import { accountNeedsPlanForFree, freePlanClosedAt, isFreePlanClosed } from "../free-plan-closure";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const env = { HIVRA_FREE_PLAN_CLOSED_AT: "2026-11-20T00:00:00Z" };
const before = async () => new Date("2026-11-01T00:00:00Z");
const after = async () => new Date("2026-11-21T00:00:00Z");
const free = async () => ({ plan: "free", source: "free", status: "active" });
const none = async () => null;
const pro = async () => ({ plan: "operator", source: "stripe", status: "active" });

describe("freePlanClosedAt / isFreePlanClosed", () => {
  it("is open when unset or invalid", () => {
    expect(freePlanClosedAt({})).toBeNull();
    expect(freePlanClosedAt({ HIVRA_FREE_PLAN_CLOSED_AT: "soon" })).toBeNull();
    expect(isFreePlanClosed({})).toBe(false);
  });

  it("closes the public offer once the cut-off has passed", () => {
    expect(isFreePlanClosed(env, new Date("2026-11-19T00:00:00Z"))).toBe(false);
    expect(isFreePlanClosed(env, new Date("2026-11-20T00:00:00Z"))).toBe(true);
  });
});

describe("accountNeedsPlanForFree", () => {
  it.each([
    ["a new account with no plan", none, after, true],
    ["a new account on the Free fallback row", free, after, true],
    ["an account created before the cut-off", none, before, false],
    ["an existing free account", free, before, false],
    ["a new account with a paid plan or trial", pro, after, false],
  ])("%s -> %s", async (_name, resolveSubscription, resolveAccountCreatedAt, expected) => {
    await expect(accountNeedsPlanForFree("u1", { env, resolveSubscription, resolveAccountCreatedAt })).resolves.toBe(expected);
  });

  it("never closes anything while the cut-off is unset", async () => {
    const resolveSubscription = jest.fn(none);
    await expect(accountNeedsPlanForFree("u1", { env: {}, resolveSubscription, resolveAccountCreatedAt: after })).resolves.toBe(false);
    expect(resolveSubscription).not.toHaveBeenCalled();
  });

  it("allows the account when a read fails", async () => {
    const failing = async () => { throw new Error("down"); };
    await expect(accountNeedsPlanForFree("u1", { env, resolveSubscription: failing, resolveAccountCreatedAt: after })).resolves.toBe(false);
  });
});
