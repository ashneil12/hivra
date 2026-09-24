/**
 * The inventory docs/token/TOKEN-GEO-POLICY.md promises, checked against the
 * source: which routes consult the token geo-policy, and which must never
 * (card payments, and every path that serves or settles existing access).
 * A new token-action route should be added to GATED with its gate.
 */
import { readFileSync } from "node:fs";
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

describe("token geo-policy surfaces", () => {
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
    expect(text).toContain("...(geo.blocked ? { tokenGeo: geo } : {})");
  });

  it.each(NEVER_GATED)("%s never consults the token geo-policy", (route) => {
    expect(source(route)).not.toMatch(/token-geo|x-vercel-ip-country/);
  });
});
