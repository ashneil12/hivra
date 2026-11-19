import type Stripe from "stripe";
import {
  CARD_TRIAL_DAYS,
  cardTrialCheckoutFields,
  checkoutGetsCardTrial,
  isCardTrialEnabled,
  isCardTrialSubscription,
  isInCardTrial,
  recordCardTrialStart,
  releaseCardTrialSleep,
} from "../card-trial";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

const ON = { HIVRA_CARD_TRIAL: "on" };
const base = { planKey: "operator", cadence: "monthly", existingSub: null, hadTrial: false };

describe("checkoutGetsCardTrial", () => {
  it("offers the trial to a first-time monthly entry-plan buyer while the switch is on", () => {
    expect(checkoutGetsCardTrial(base, ON)).toBe(true);
  });

  it.each([
    ["the switch is off", base, {}],
    ["the switch has another value", base, { HIVRA_CARD_TRIAL: "true" }],
    ["a larger plan", { ...base, planKey: "fleet" }, ON],
    ["yearly billing", { ...base, cadence: "yearly" }, ON],
    ["an account that trialed before", { ...base, hadTrial: true }, ON],
    ["an account that paid before", { ...base, existingSub: { upgraded_at: "2026-10-01T00:00:00Z" } }, ON],
    ["an account with a Stripe subscription", { ...base, existingSub: { stripe_subscription_id: "sub_1" } }, ON],
  ])("does not offer it for %s", (_name, input, env) => {
    expect(checkoutGetsCardTrial(input, env)).toBe(false);
  });

  it("reads the switch case-insensitively", () => {
    expect(isCardTrialEnabled({ HIVRA_CARD_TRIAL: " ON " })).toBe(true);
  });
});

describe("cardTrialCheckoutFields", () => {
  it("asks Stripe for a 7-day trial with the card collected and cancels a trial left without one", () => {
    const fields = cardTrialCheckoutFields();
    expect(fields.payment_method_collection).toBe("always");
    expect(fields.subscription_data).toEqual({
      trial_period_days: CARD_TRIAL_DAYS,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    });
    expect(CARD_TRIAL_DAYS).toBe(7);
    expect(fields.metadata).toEqual({ hivra_trial: "card_7d" });
  });
});

describe("isCardTrialSubscription", () => {
  it.each([
    ["trialing", { hivra_trial: "card_7d" }, true],
    ["active", { hivra_trial: "card_7d" }, false],
    ["trialing", {}, false],
  ])("status %s with %j is %s", (status, metadata, expected) => {
    expect(isCardTrialSubscription({ status, metadata } as unknown as Stripe.Subscription)).toBe(expected);
  });
});

type Result = { data: unknown; error: { message: string } | null };

function fakeDb(results: Record<string, Result[]>, insertError: { code: string; message: string } | null = null) {
  const inserts: Array<{ table: string; row: unknown }> = [];
  const updates: Array<{ table: string; patch: unknown }> = [];
  const from = jest.fn((table: string) => {
    const next = () => results[table]?.shift() ?? { data: [], error: null };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq"]) q[m] = () => q;
    q.update = (patch: unknown) => {
      updates.push({ table, patch });
      const u: Record<string, unknown> = {};
      u.eq = () => u;
      u.then = (r: (v: unknown) => void) => r({ error: null });
      return u;
    };
    q.limit = () => Promise.resolve(next());
    q.maybeSingle = () => Promise.resolve(next());
    q.insert = (row: unknown) => {
      if (insertError) return Promise.resolve({ error: insertError });
      inserts.push({ table, row });
      return Promise.resolve({ error: null });
    };
    return q;
  });
  return { db: { from } as never, inserts, updates };
}

function stripeWithCard(fingerprint: string | null) {
  return {
    paymentMethods: { retrieve: jest.fn().mockResolvedValue({ card: fingerprint ? { fingerprint } : null }) },
    subscriptions: { update: jest.fn().mockResolvedValue({}) },
  } as unknown as Stripe & {
    subscriptions: { update: jest.Mock };
  };
}

const sub = { id: "sub_trial", status: "trialing", default_payment_method: "pm_1", metadata: { hivra_trial: "card_7d" } } as unknown as Stripe.Subscription;

describe("recordCardTrialStart", () => {
  it("records a new card's trial and keeps it", async () => {
    const { db, inserts } = fakeDb({ hermes_trial_usage: [{ data: [], error: null }, { data: [], error: null }] });
    const stripe = stripeWithCard("fp_new");
    await expect(recordCardTrialStart({ stripe, subscription: sub, userId: "u1", db })).resolves.toEqual({ endedEarly: false });
    expect(inserts).toEqual([{ table: "hermes_trial_usage", row: { user_id: "u1", stripe_subscription_id: "sub_trial", card_fingerprint: "fp_new" } }]);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("ends the trial now when another account already trialed with the same card", async () => {
    const { db, inserts } = fakeDb({ hermes_trial_usage: [{ data: [], error: null }, { data: [{ user_id: "u0" }], error: null }] });
    const stripe = stripeWithCard("fp_used");
    await expect(recordCardTrialStart({ stripe, subscription: sub, userId: "u1", db })).resolves.toEqual({ endedEarly: true });
    // Nothing is recorded, so a failed Stripe update is retried and checked again.
    expect(inserts).toHaveLength(0);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_trial", { trial_end: "now" });
  });

  it("ends the trial when a concurrent trial on the same card recorded first", async () => {
    const { db } = fakeDb({ hermes_trial_usage: [{ data: [], error: null }, { data: [], error: null }] }, { code: "23505", message: "duplicate" });
    const stripe = stripeWithCard("fp_race");
    await expect(recordCardTrialStart({ stripe, subscription: sub, userId: "u1", db })).resolves.toEqual({ endedEarly: true });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_trial", { trial_end: "now" });
  });

  it("keeps the trial when the unique conflict is a repeat delivery of the same subscription", async () => {
    const { db } = fakeDb(
      { hermes_trial_usage: [{ data: [], error: null }, { data: [], error: null }, { data: [{ id: "t1" }], error: null }] },
      { code: "23505", message: "duplicate" }
    );
    const stripe = stripeWithCard("fp_new");
    await expect(recordCardTrialStart({ stripe, subscription: sub, userId: "u1", db })).resolves.toEqual({ endedEarly: false });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("does not record the trial when the Stripe update fails, so the retry checks again", async () => {
    const { db, inserts } = fakeDb({ hermes_trial_usage: [{ data: [], error: null }, { data: [{ user_id: "u0" }], error: null }] });
    const stripe = stripeWithCard("fp_used");
    stripe.subscriptions.update.mockRejectedValueOnce(new Error("stripe down"));
    await expect(recordCardTrialStart({ stripe, subscription: sub, userId: "u1", db })).rejects.toThrow("stripe down");
    expect(inserts).toHaveLength(0);
  });

  it("does nothing on a repeat event for a trial already recorded", async () => {
    const { db, inserts } = fakeDb({ hermes_trial_usage: [{ data: [{ id: "t1" }], error: null }] });
    const stripe = stripeWithCard("fp_new");
    await expect(recordCardTrialStart({ stripe, subscription: sub, userId: "u1", db })).resolves.toEqual({ endedEarly: false });
    expect(inserts).toHaveLength(0);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("throws on a failed read so the webhook retries", async () => {
    const { db } = fakeDb({ hermes_trial_usage: [{ data: null, error: { message: "down" } }] });
    await expect(recordCardTrialStart({ stripe: stripeWithCard(null), subscription: sub, userId: "u1", db })).rejects.toThrow("trial usage read failed");
  });
});

describe("isInCardTrial", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  it.each([
    ["a trial ending later", { trial_ends_at: "2026-11-25T12:00:00Z" }, null, true],
    ["a trial that ended", { trial_ends_at: "2026-11-18T12:00:00Z" }, null, false],
    ["no trial", { trial_ends_at: null }, null, false],
    ["a failed read", null, { message: "down" }, false],
  ])("is %s -> %s", async (_name, data, error, expected) => {
    const { db } = fakeDb({ hermes_subscriptions: [{ data, error }] });
    await expect(isInCardTrial("u1", db, now)).resolves.toBe(expected);
  });
});

describe("releaseCardTrialSleep", () => {
  it("returns converted trial agents to the paid default while the row still shows the trial", async () => {
    const { db, updates } = fakeDb({ hermes_subscriptions: [{ data: { trial_ends_at: "2026-11-25T12:00:00Z" }, error: null }] });
    await expect(releaseCardTrialSleep("u1", db)).resolves.toBe(true);
    expect(updates).toEqual([{ table: "hivra_agents", patch: { sleep_policy: "off" } }]);
  });

  it("leaves sleep settings alone once the trial was already released", async () => {
    const { db, updates } = fakeDb({ hermes_subscriptions: [{ data: { trial_ends_at: null }, error: null }] });
    await expect(releaseCardTrialSleep("u1", db)).resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("throws on a failed read so the webhook retries before the trial is cleared", async () => {
    const { db, updates } = fakeDb({ hermes_subscriptions: [{ data: null, error: { message: "down" } }] });
    await expect(releaseCardTrialSleep("u1", db)).rejects.toThrow("trial sleep release read failed");
    expect(updates).toHaveLength(0);
  });
});
