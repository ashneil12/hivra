/**
 * The inventory docs/token/TOKEN-GEO-POLICY.md promises, checked against the
 * source: which routes consult the token geo-policy, and which must never
 * (card payments, and every path that serves or settles existing access).
 * A new token-action route should be added to GATED with its gate. A route
 * that imports the token billing libraries and is in none of the lists below
 * fails "classifies every API route" until someone decides which list it is in.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const API = path.resolve(__dirname, "../../../app/api");

function source(route: string) {
  return readFileSync(path.join(API, route, "route.ts"), "utf8");
}

const GATED = [
  "billing/yearly-token-quote",
  "billing/managed-venice/hermesos/quote",
  "billing/wallet/quote",
  "billing/crypto/top-up",
  "billing/token-access",
  "billing/wallet/challenge",
  "billing/wallet/verify",
];

/** New qualification is refused inside the evaluator; the route passes its decision. */
const DECISION_PASSED_TO_EVALUATOR = ["billing/wallet/refresh", "billing/wallet/unlock"];

const NEVER_GATED = [
  // Card payments.
  "billing/subscribe",
  "billing/top-up",
  "billing/managed-venice/card/top-up",
  "billing/change-plan",
  "billing/confirm-checkout",
  "billing/portal",
  "billing/setup-intent",
  "billing/backup-addon",
  "webhooks/stripe",
  // Existing quotes, payments, holdings and exits.
  "billing/yearly-token-quote/check-now",
  "billing/managed-venice/hermesos/check",
  "billing/managed-venice/hermesos/settle",
  "billing/bankr/wallet/withdraw",
  "billing/bankr/wallet/withdraw-address",
  "billing/token-holding",
  "billing/wallet/eligibility",
  "cron/yearly-token-sweep",
  "cron/managed-venice-token-reconciliation",
];

/** Crons with no request: they call the tier evaluator, which refuses a NEW qualification from the stored and Clerk session country. */
const EVALUATOR_DECIDES = ["cron/refresh-active-deposit-quotes", "cron/refresh-token-holdings"];

/** Routes that import the token billing libraries and start no new token action, each with the reason. */
const NOT_A_TOKEN_ACTION: Record<string, string> = {
  "billing/bankr/wallet": "provisions a deposit address; every payment that uses it is gated (TOKEN-GEO-POLICY.md, Not covered)",
  "billing/entitlements": "reads the entitlements a user already has",
  "cron/reconcile-crypto-topups": "settles crypto payments that were already started",
  "cron/refresh-token-tiers": "updates the resource tier from existing qualifications and snapshots; creates no tier row",
  "internal/billing/crypto/top-up/settle": "settles a crypto payment that was already started",
  "ops/managed-venice/readiness": "an ops read of settlement state",
  // The user's own Bankr account for an agent (TOKEN-GEO-POLICY.md, Not covered).
  "hivra/agents/[id]/bankr-wallet": "the agent's own Bankr account",
  "hivra/agents/[id]/bankr-wallet/connect": "the agent's own Bankr account",
  "hivra/agents/[id]/bankr-wallet/set-destination": "the agent's own Bankr account",
  "hivra/agents/[id]/bankr-wallet/withdraw": "the agent's own Bankr account; withdrawals are never gated",
  "instances/[id]/bankr-wallet": "the instance's own Bankr account",
  "instances/[id]/bankr-wallet/connect": "the instance's own Bankr account",
  "instances/[id]/bankr-wallet/withdraw-destination": "the instance's own Bankr account",
  "instances/[id]/bankr-wallet/withdraw": "the instance's own Bankr account; withdrawals are never gated",
};

const TOKEN_LIBRARIES = /@\/lib\/billing\/(?:token-|yearly-|managed-venice-token|wallet-verification|deposit-quotes|bankr-|crypto-)/;

function routesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return routesUnder(path.join(directory, entry.name), relative);
    return entry.name === "route.ts" ? [prefix] : [];
  });
}

describe("token geo-policy surfaces", () => {
  it("classifies every API route that imports the token billing libraries", () => {
    const classified = new Set([
      ...GATED,
      ...DECISION_PASSED_TO_EVALUATOR,
      ...NEVER_GATED,
      ...EVALUATOR_DECIDES,
      ...Object.keys(NOT_A_TOKEN_ACTION),
    ]);
    const unclassified = routesUnder(API)
      .filter((route) => TOKEN_LIBRARIES.test(source(route)))
      .filter((route) => !classified.has(route));
    // Add a new route to GATED (and gate it), or to another list with its reason.
    expect(unclassified).toEqual([]);
  });

  it("finds the routes it is meant to classify", () => {
    // A guard that matched nothing would pass for the wrong reason.
    expect(routesUnder(API).filter((route) => TOKEN_LIBRARIES.test(source(route))).length).toBeGreaterThan(25);
  });

  it.each(EVALUATOR_DECIDES)("%s has no request, so the tier evaluator refuses a new qualification", (route) => {
    expect(source(route)).toContain("evaluateAndRecordTokenTierEligibility");
    const evaluator = readFileSync(path.resolve(__dirname, "../../billing/token-tier-eligibility.ts"), "utf8");
    expect(evaluator).toContain("isNewTokenQualificationRefused(params.userId, params.tokenGeo)");
  });

  it.each(Object.entries(NOT_A_TOKEN_ACTION))("%s starts no new token action: %s", (route) => {
    expect(source(route)).not.toMatch(/token-geo|x-vercel-ip-country/);
  });

  it.each(GATED)("%s refuses a blocked request through the shared gate", (route) => {
    const text = source(route);
    expect(text).toContain('from "@/lib/compliance/token-geo-gate"');
    expect(text).toContain("resolveTokenGeoBlock(req, { userId })");
    expect(text).toContain("tokenGeoBlockedResponse(geo,");
    // No route reads the country header itself.
    expect(text).not.toContain("x-vercel-ip-country");
  });

  it.each(DECISION_PASSED_TO_EVALUATOR)("%s passes a blocked decision to the tier evaluator", (route) => {
    const text = source(route);
    expect(text).toContain("resolveTokenGeoBlock(req, { userId })");
    expect(text).toContain("...(isTokenGeoPolicyActive() ? { tokenGeo: geo } : {})");
  });

  it.each(NEVER_GATED)("%s never consults the token geo-policy", (route) => {
    expect(source(route)).not.toMatch(/token-geo|x-vercel-ip-country/);
  });
});
