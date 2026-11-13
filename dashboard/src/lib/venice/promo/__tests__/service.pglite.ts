/**
 * @jest-environment node
 */
// Runs against the real migrations in PGlite, which needs
// `--experimental-vm-modules`: `npm run test:venice-promo`.
import type { PGlite } from "@electric-sql/pglite";

import { createPromoDb } from "./pglite-db";
import {
  expireDuePromoGrants,
  getUserPromoLines,
  loadLaunchEligibilityFacts,
  recordVeniceAttribution,
  redeemVeniceCode,
  tryGrantLaunchCredit,
  tryGrantTopupBonus,
  type LaunchFactsDeps,
  type PromoDb,
} from "../service";
import { loadPromoReport } from "../report";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const M = 1_000_000;
const NOW = new Date("2026-11-20T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let pg: PGlite;
let db: PromoDb;

jest.setTimeout(60_000);

beforeAll(async () => {
  const made = await createPromoDb();
  pg = made.pg;
  db = made.db as unknown as PromoDb;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  process.env.HIVRA_VENICE_PROMO_ENABLED = "true";
  await pg.exec(`
    delete from public.venice_promo_redemptions;
    delete from public.venice_promo_grants;
    delete from public.managed_venice_usage_events;
    delete from public.managed_venice_reservations;
    delete from public.managed_venice_card_ledger_entries;
    delete from public.hivra_agents;
    update public.venice_promo_campaigns set enabled = true, starts_at = '2026-11-01Z',
      grant_cutoff_at = '2026-12-31Z', ends_at = '2027-01-31Z';
  `);
  await pg.exec(`update public.venice_promo_campaigns set budget_micro_usd = 700000000, max_grants = 70 where slug='venice-launch-2026';
                 update public.venice_promo_campaigns set budget_micro_usd = 200000000, max_grants = 20 where slug='venice-topup-2026';`);
});

afterEach(() => {
  delete process.env.HIVRA_VENICE_PROMO_ENABLED;
});

const balance = async (user: string) =>
  Number(((await pg.query("select coalesce(sum(amount_micro_usd),0)::bigint s from public.managed_venice_card_ledger_entries where user_id=$1", [user])).rows[0] as { s: string }).s);

async function account(user: string) {
  await pg.query("insert into public.managed_venice_wallet_accounts (user_id) values ($1) on conflict do nothing", [user]);
  return ((await pg.query("select id from public.managed_venice_wallet_accounts where user_id=$1", [user])).rows[0] as { id: string }).id;
}
async function ledger(user: string, amount: number, source: string, reason: string, ref: string, at: string) {
  await pg.query(
    `insert into public.managed_venice_card_ledger_entries (account_id,user_id,amount_micro_usd,source,actor,reason,reference_id,created_at)
     values ($1,$2,$3,$4,'t',$5,$6,$7)`,
    [await account(user), user, amount, source, reason, ref, at]
  );
}

const subscriber: LaunchFactsDeps["resolveSubscription"] = async () => ({ plan: "operator", status: "active", source: "stripe" });
const stripeWith = (subscriptions: Awaited<ReturnType<LaunchFactsDeps["loadStripeHistory"]>>["subscriptions"], current = "sub_now"): LaunchFactsDeps => ({
  resolveSubscription: subscriber,
  loadStripeHistory: async () => ({ customerId: "cus_1", currentSubscriptionId: current, subscriptions }),
});
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const nowSub = { id: "sub_now", status: "active", startDate: sec("2026-11-15Z"), endedAt: null, trialEnd: null };

describe("redeeming", () => {
  it("saves VENICE case-insensitively, once, and rejects other codes", async () => {
    expect((await redeemVeniceCode({ userId: "u1", code: "venice", now: NOW }, db)).status).toBe("saved");
    expect((await redeemVeniceCode({ userId: "u1", code: "VENICE", now: NOW }, db)).status).toBe("already_saved");
    expect((await redeemVeniceCode({ userId: "u1", code: "nope", now: NOW }, db)).status).toBe("invalid_code");
    const count = ((await pg.query("select count(*)::int c from public.venice_promo_redemptions")).rows[0] as { c: number }).c;
    expect(count).toBe(1);
  });

  it("accepts ref=venice attribution passed by the caller", async () => {
    expect((await recordVeniceAttribution({ userId: "u2", attribution: { ref: "Venice", code: null }, now: NOW }, db)).status).toBe("saved");
    expect((await recordVeniceAttribution({ userId: "u3", attribution: { ref: "other" }, now: NOW }, db)).status).toBe("invalid_code");
  });

  it("does nothing while the master flag is off", async () => {
    delete process.env.HIVRA_VENICE_PROMO_ENABLED;
    expect((await redeemVeniceCode({ userId: "u1", code: "VENICE", now: NOW }, db)).status).toBe("disabled");
    expect((await tryGrantLaunchCredit({ userId: "u1", now: NOW, factsDeps: stripeWith([nowSub]) }, db)).skipped).toBe("flag_off");
    expect((await tryGrantTopupBonus({ userId: "u1", sessionId: "s", amountMicroUsd: 10 * M, now: NOW }, db)).skipped).toBe("flag_off");
    expect(await balance("u1")).toBe(0);
  });

  it("does nothing while the campaign row is disabled", async () => {
    await pg.exec("update public.venice_promo_campaigns set enabled = false");
    expect((await redeemVeniceCode({ userId: "u1", code: "VENICE", now: NOW }, db)).status).toBe("invalid_code");
  });
});

describe("launch credit", () => {
  const redeem = (u: string) => redeemVeniceCode({ userId: u, code: "VENICE", now: NOW }, db);

  it("grants $10 to a new subscriber into the card ledger, once", async () => {
    await redeem("u1");
    const first = await tryGrantLaunchCredit({ userId: "u1", now: NOW, factsDeps: stripeWith([nowSub]) }, db);
    expect(first.outcome).toMatchObject({ granted: true, amountMicroUsd: 10 * M });
    expect(first.eligibility?.reason).toBe("new_subscriber");
    expect(await balance("u1")).toBe(10 * M);
    const ledgerRow = (await pg.query("select source, reason, amount_micro_usd::bigint a from public.managed_venice_card_ledger_entries where user_id='u1'")).rows[0];
    expect(ledgerRow).toMatchObject({ source: "promo", reason: "promo_grant" });

    const second = await tryGrantLaunchCredit({ userId: "u1", now: NOW, factsDeps: stripeWith([nowSub]) }, db);
    expect(second.skipped).toBe("already_granted");
    expect(await balance("u1")).toBe(10 * M);
  });

  it("needs the code or ref first", async () => {
    const r = await tryGrantLaunchCredit({ userId: "u9", now: NOW, factsDeps: stripeWith([nowSub]) }, db);
    expect(r.skipped).toBe("not_redeemed");
    expect(await balance("u9")).toBe(0);
  });

  it("grants a returning subscriber whose plan ended 30+ days before they came back", async () => {
    await redeem("u2");
    const old = { id: "sub_old", status: "canceled", startDate: sec("2026-01-01Z"), endedAt: sec("2026-09-01Z"), trialEnd: null };
    const r = await tryGrantLaunchCredit({ userId: "u2", now: NOW, factsDeps: stripeWith([nowSub, old]) }, db);
    expect(r.eligibility?.reason).toBe("returning_subscriber");
    expect(await balance("u2")).toBe(10 * M);
  });

  it("refuses an existing subscriber and a quick returner", async () => {
    await redeem("u3");
    const live = { id: "sub_other", status: "active", startDate: sec("2026-06-01Z"), endedAt: null, trialEnd: null };
    expect((await tryGrantLaunchCredit({ userId: "u3", now: NOW, factsDeps: stripeWith([nowSub, live]) }, db)).eligibility?.reason).toBe("existing_subscriber");
    const recent = { id: "sub_old", status: "canceled", startDate: sec("2026-01-01Z"), endedAt: sec("2026-11-01Z"), trialEnd: null };
    expect((await tryGrantLaunchCredit({ userId: "u3", now: NOW, factsDeps: stripeWith([nowSub, recent]) }, db)).eligibility?.reason).toBe("returned_too_soon");
    expect(await balance("u3")).toBe(0);
  });

  it("ignores a prior subscription that never took payment", async () => {
    await redeem("u4");
    const never = { id: "sub_trial", status: "canceled", startDate: sec("2026-11-01Z"), endedAt: sec("2026-11-05Z"), trialEnd: sec("2026-11-08Z") };
    const incomplete = { id: "sub_inc", status: "incomplete_expired", startDate: sec("2026-10-01Z"), endedAt: sec("2026-10-02Z"), trialEnd: null };
    const r = await tryGrantLaunchCredit({ userId: "u4", now: NOW, factsDeps: stripeWith([nowSub, never, incomplete]) }, db);
    expect(r.eligibility?.reason).toBe("new_subscriber");
  });

  it("requires an active paid plan and a Stripe-backed one", async () => {
    await redeem("u5");
    const free: LaunchFactsDeps = { ...stripeWith([]), resolveSubscription: async () => ({ plan: "free", status: "active", source: "free" }) };
    expect((await tryGrantLaunchCredit({ userId: "u5", now: NOW, factsDeps: free }, db)).eligibility?.reason).toBe("no_paid_plan");
    const apple: LaunchFactsDeps = { ...stripeWith([]), resolveSubscription: async () => ({ plan: "operator", status: "active", source: "apple_iap" }) };
    expect((await tryGrantLaunchCredit({ userId: "u5", now: NOW, factsDeps: apple }, db)).eligibility?.reason).toBe("unsupported_plan_source");
    expect(await balance("u5")).toBe(0);
  });

  it("never exceeds budget or max_grants under concurrent grants", async () => {
    await pg.exec("update public.venice_promo_campaigns set budget_micro_usd = 35000000, max_grants = 70 where slug='venice-launch-2026'");
    const users = Array.from({ length: 8 }, (_, i) => `race${i}`);
    await Promise.all(users.map((u) => redeem(u)));
    await Promise.all(users.map((u) => tryGrantLaunchCredit({ userId: u, now: NOW, factsDeps: stripeWith([nowSub]) }, db)));
    const row = (await pg.query("select count(*)::int c, coalesce(sum(amount_micro_usd),0)::bigint s from public.venice_promo_grants")).rows[0] as { c: number; s: string };
    expect(row.c).toBe(3);
    expect(Number(row.s)).toBe(30 * M);

    await pg.exec("delete from public.venice_promo_grants; delete from public.managed_venice_card_ledger_entries; update public.venice_promo_campaigns set budget_micro_usd = 700000000, max_grants = 2 where slug='venice-launch-2026'");
    await Promise.all(users.map((u) => tryGrantLaunchCredit({ userId: u, now: NOW, factsDeps: stripeWith([nowSub]) }, db)));
    expect(((await pg.query("select count(*)::int c from public.venice_promo_grants")).rows[0] as { c: number }).c).toBe(2);
  });

  it("loadLaunchEligibilityFacts reports no history for a first subscription", async () => {
    const { facts } = await loadLaunchEligibilityFacts("u", stripeWith([nowSub]));
    expect(facts).toMatchObject({ hasActivePaidPlan: true, hasPriorPaid: false, priorPaidEndedAt: null });
  });
});

describe("top-up bonus", () => {
  const session = async (user: string, id: string, amount: number, at: string) => ledger(user, amount, "stripe", "stripe_topup", id, at);
  const deps = { resolveSubscription: subscriber };

  it("gives a subscriber's first top-up 50%, capped at $10, once even on replay", async () => {
    await session("t1", "cs_1", 30 * M, "2026-11-19T00:00:00Z");
    const a = await tryGrantTopupBonus({ userId: "t1", sessionId: "cs_1", amountMicroUsd: 30 * M, now: NOW, deps }, db);
    expect(a.outcome).toMatchObject({ granted: true, amountMicroUsd: 10 * M });
    expect(await balance("t1")).toBe(40 * M);

    const replay = await tryGrantTopupBonus({ userId: "t1", sessionId: "cs_1", amountMicroUsd: 30 * M, now: NOW, deps }, db);
    expect(replay.outcome?.granted).toBe(false);
    expect(replay.outcome?.status).toBe("already_granted");
    expect(await balance("t1")).toBe(40 * M);

    await session("t1", "cs_2", 20 * M, "2026-11-19T12:00:00Z");
    const second = await tryGrantTopupBonus({ userId: "t1", sessionId: "cs_2", amountMicroUsd: 20 * M, now: NOW, deps }, db);
    expect(second.skipped).toBe("not_first_topup");
    expect(await balance("t1")).toBe(60 * M);
  });

  it("is 50% of a small top-up, and concurrent replays grant exactly once", async () => {
    await session("t2", "cs_a", 10 * M, "2026-11-19T00:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => tryGrantTopupBonus({ userId: "t2", sessionId: "cs_a", amountMicroUsd: 10 * M, now: NOW, deps }, db))
    );
    expect(results.filter((r) => r.outcome?.granted).length).toBe(1);
    expect(await balance("t2")).toBe(15 * M);
  });

  it("ignores a top-up made before the campaign started when finding the first", async () => {
    await session("t3", "cs_old", 10 * M, "2026-10-01T00:00:00Z");
    await session("t3", "cs_new", 10 * M, "2026-11-19T00:00:00Z");
    const r = await tryGrantTopupBonus({ userId: "t3", sessionId: "cs_new", amountMicroUsd: 10 * M, now: NOW, deps }, db);
    expect(r.outcome?.granted).toBe(true);
  });

  it("skips non-subscribers", async () => {
    await session("t4", "cs_x", 10 * M, "2026-11-19T00:00:00Z");
    const free = { resolveSubscription: async () => ({ plan: "free", status: "active", source: "free" }) };
    expect((await tryGrantTopupBonus({ userId: "t4", sessionId: "cs_x", amountMicroUsd: 10 * M, now: NOW, deps: free }, db)).skipped).toBe("not_a_subscriber");
    expect(await balance("t4")).toBe(10 * M);
  });
});

describe("expiry and what the user sees", () => {
  async function grantLaunch(user: string) {
    await redeemVeniceCode({ userId: user, code: "VENICE", now: NOW }, db);
    return tryGrantLaunchCredit({ userId: user, now: NOW, factsDeps: stripeWith([nowSub]) }, db);
  }

  it("removes only the unspent promo part, leaving paid money alone, idempotently", async () => {
    await grantLaunch("e1");
    await ledger("e1", 20 * M, "stripe", "stripe_topup", "cs_e1", "2026-11-21T00:00:00Z");
    await ledger("e1", -4 * M, "system", "managed_venice_debit", "d1", "2026-11-22T00:00:00Z");

    const lines = await getUserPromoLines("e1", db, new Date("2026-11-23T00:00:00Z"));
    expect(lines).toHaveLength(1);
    expect(lines[0].remainingMicroUsd).toBe(6 * M);
    expect(lines[0].label).toBe("$6 Venice launch credit, expires 20 Dec");

    const later = new Date(NOW.getTime() + 31 * DAY);
    const run = await expireDuePromoGrants({ now: later }, db);
    expect(run).toMatchObject({ due: 1, expired: 1, removedMicroUsd: 6 * M, failed: 0 });
    // 10 promo + 20 paid - 4 spent - 6 expired = 20 (paid money intact)
    expect(await balance("e1")).toBe(20 * M);

    const again = await expireDuePromoGrants({ now: later }, db);
    expect(again.due).toBe(0);
    expect(await balance("e1")).toBe(20 * M);
    expect(await getUserPromoLines("e1", db, later)).toEqual([]);
  });

  it("does not touch grants that are not yet due, and caps removal at available balance", async () => {
    await grantLaunch("e2");
    expect((await expireDuePromoGrants({ now: new Date(NOW.getTime() + 10 * DAY) }, db)).due).toBe(0);
    const acc = await account("e2");
    await pg.query(
      `insert into public.managed_venice_reservations (account_id,user_id,wallet_type,reference_id,estimated_cost_micro_usd,reserved_micro_usd)
       values ($1,'e2','card','hold',$2,$2)`, [acc, 7 * M]);
    const run = await expireDuePromoGrants({ now: new Date(NOW.getTime() + 31 * DAY) }, db);
    expect(run.removedMicroUsd).toBe(3 * M);
    expect(await balance("e2")).toBe(7 * M);
  });

  it("builds the weekly report from the real SQL helpers", async () => {
    await grantLaunch("r1");
    await ledger("r1", -2 * M, "system", "managed_venice_debit", "rd1", "2026-11-21T00:00:00Z");
    await ledger("r1", 5 * M, "stripe", "stripe_topup", "cs_r1", "2026-11-22T00:00:00Z");
    const acc = await account("r1");
    await pg.query(
      `insert into public.managed_venice_usage_events (account_id,user_id,wallet_type,endpoint,model,charged_micro_usd,actual_cost_micro_usd,reference_id,created_at)
       values ($1,'r1','card','/c','model-a',2000000,1800000,'ue1','2026-12-02T00:00:00Z')`, [acc]);
    await pg.query("insert into public.hivra_agents (user_id,type,name,llm_config,created_at) values ('r1','hermes','a','{\"mode\":\"managed\"}','2026-11-27T00:00:00Z')");

    const report = await loadPromoReport(db as never, { now: new Date("2026-12-04T00:00:00Z"), windowDays: 7 });
    const launch = report.campaigns.find((c) => c.slug === "venice-launch-2026")!;
    expect(launch).toMatchObject({
      grants: 1, grantsInWindow: 0, grantedMicroUsd: 10 * M, spentMicroUsd: 2 * M,
      expiredMicroUsd: 0, budgetLeftMicroUsd: 690 * M, grantsLeft: 69,
    });
    expect(report.creditsModeLaunchUsers).toBe(1);
    expect(report.promoUsers).toMatchObject({
      total: 1,
      active7: { eligible: 1, active: 1 },
      active30: { eligible: 0, active: 0 },
      paidTopupAfterGrant: 1,
    });
    expect(report.spendByModel).toEqual([
      expect.objectContaining({ model: "model-a", requests: 1, chargedMicroUsd: 2 * M, promoUserChargedMicroUsd: 2 * M }),
    ]);
    expect(report.definitions.active).toBeTruthy();
  });
});
