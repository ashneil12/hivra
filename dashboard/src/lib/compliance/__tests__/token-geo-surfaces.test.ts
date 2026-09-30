/**
 * The inventory docs/token/TOKEN-GEO-POLICY.md promises, checked against the
 * source: which routes consult the token geo-policy, and which must never
 * (card payments, and every path that serves or settles existing access).
 *
 * It is also a completeness check. Every API route that mentions a token, a
 * wallet, a deposit, Bankr or crypto must be in exactly one list below, so a
 * new token route cannot ship without somebody deciding whether it is gated.
 * A new token-action route goes in GATED with its gate; a route that never
 * starts a NEW token action goes in NEVER_GATED or NOT_A_NEW_TOKEN_ACTION with
 * the reason.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * These call the tier evaluator with no request, so the evaluator decides a NEW
 * qualification from the stored and Clerk session country
 * (isNewTokenQualificationRefused). The route itself reads no country.
 */
const EVALUATOR_DECIDES_WITHOUT_A_REQUEST = [
  "cron/refresh-token-holdings",
  "cron/refresh-active-deposit-quotes",
];

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

/**
 * Routes the word match catches that start no NEW token action: each one says
 * why. None of them may consult the policy; if one is ever gated it moves to
 * GATED, and this test fails until it does.
 */
const NOT_A_NEW_TOKEN_ACTION: Record<string, string> = {
  "billing/bankr/wallet":
    "Provisions a deposit address and reports wallet status. No payment starts here, and every payment that uses the address is gated. TOKEN-GEO-POLICY.md lists it under Not covered.",
  "billing/entitlements": "Reads the compute entitlement a user already has. It starts no token action.",
  "billing/withdrawals": "Read-only withdrawal history. Exits are never gated.",
  "cron/reconcile-crypto-topups": "Settles crypto top-ups that were already started. Settlement never consults the policy.",
  "internal/billing/crypto/top-up/settle":
    "Settles one crypto top-up that was already started, called with the settlement secret. Settlement never consults the policy.",
  "cron/refresh-token-tiers":
    "Applies tiers from existing entitlements and holdings. A new qualification row is created only inside the evaluator, and the 1-token base tier is listed as not gated in TOKEN-GEO-POLICY.md.",
  "cron/yearly-token-expiry":
    "Moves existing yearly years to grace and expired, and emails the holder. It starts no payment. The emails send a holder in a listed country to card renewal.",
  "ops/managed-venice/readiness": "Ops-only readiness read, called with a bearer secret. It starts no token action.",
  "hivra/agents/[id]/bankr-wallet": "An agent's wallet is the user's own Bankr account. TOKEN-GEO-POLICY.md lists agent wallets under Not covered.",
  "hivra/agents/[id]/bankr-wallet/connect": "Connects the user's own Bankr account to an agent. Agent wallets are listed under Not covered.",
  "hivra/agents/[id]/bankr-wallet/set-destination": "Sets where an agent wallet withdraws to. Agent wallets are listed under Not covered, and exits are never gated.",
  "hivra/agents/[id]/bankr-wallet/withdraw": "An agent wallet withdrawal. Agent wallets are listed under Not covered, and exits are never gated.",
  "instances/[id]/bankr-wallet": "An agent's wallet is the user's own Bankr account. TOKEN-GEO-POLICY.md lists agent wallets under Not covered.",
  "instances/[id]/bankr-wallet/connect": "Connects the user's own Bankr account to an agent. Agent wallets are listed under Not covered.",
  "instances/[id]/bankr-wallet/withdraw": "An agent wallet withdrawal. Agent wallets are listed under Not covered, and exits are never gated.",
  "instances/[id]/bankr-wallet/withdraw-destination": "Sets where an agent wallet withdraws to. Agent wallets are listed under Not covered, and exits are never gated.",
  "hivra/agents": "Creates and lists agents. It names Bankr only to seed the Bankr skill suite onto the agent's computer.",
  "hivra/agents/[id]": "Reads and manages one agent. It names Bankr only to seed skills and to reconcile the agent's wallet settings.",
  "hivra/agents/[id]/skills/install": "Installs a skill on an agent's computer. It starts no token action.",
  "hivra/templates/shared/[token]": "The [token] in the path is a share-link secret, not a crypto token.",
  "infrastructure/connections/[id]/digitalocean/token": "A cloud provider API token for the user's own infrastructure account, not a crypto token.",
  "infrastructure/connections/[id]/digitalocean/token-expiry": "A cloud provider API token for the user's own infrastructure account, not a crypto token.",
  "infrastructure/connections/[id]/hetzner-cloud/token": "A cloud provider API token for the user's own infrastructure account, not a crypto token.",
  "mobile/push-tokens": "A push notification device token, not a crypto token.",
};

/** The gate's own endpoint: it answers whether the viewer is blocked. */
const GATE_ENDPOINT = ["token-geo"];

function routeDirectories(dir: string = API, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "__tests__") continue;
    const child = path.join(dir, entry.name);
    if (existsSync(path.join(child, "route.ts"))) found.push(path.relative(API, child));
    routeDirectories(child, found);
  }
  return found;
}

/** A route that names a token, a wallet, a deposit, Bankr or crypto in its path, or imports the libraries that move them. */
const TOKEN_PATH = /token|wallet|deposit|bankr|crypto|hermesos|conversion|convert/i;
const TOKEN_SOURCE =
  /@\/lib\/billing\/(?:token-|yearly-|managed-venice-token|wallet-verification|deposit-quotes|bankr-|crypto-)|yearly-token|token-geo|hivra-token|bankr/i;

function tokenRoutes(): string[] {
  return routeDirectories()
    .filter((route) => TOKEN_PATH.test(route) || TOKEN_SOURCE.test(source(route)))
    .sort();
}

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
    expect(text).toContain("...(isTokenGeoPolicyActive() ? { tokenGeo: geo } : {})");
  });

  it.each(EVALUATOR_DECIDES_WITHOUT_A_REQUEST)("%s leaves a new qualification to the evaluator", (route) => {
    const text = source(route);
    expect(text).toContain("evaluateAndRecordTokenTierEligibility");
    expect(text).not.toMatch(/token-geo|x-vercel-ip-country|tokenGeo/);
  });

  it.each(NEVER_GATED)("%s never consults the token geo-policy", (route) => {
    expect(source(route)).not.toMatch(/token-geo|x-vercel-ip-country/);
  });

  it.each(Object.keys(NOT_A_NEW_TOKEN_ACTION))("%s is not a new token action and never consults the policy", (route) => {
    expect(source(route)).not.toMatch(/token-geo|x-vercel-ip-country/);
  });
});

describe("every token route is classified", () => {
  const classified = new Map<string, string[]>();
  const lists: Array<[string, readonly string[]]> = [
    ["GATED", GATED],
    ["DECISION_PASSED_TO_EVALUATOR", DECISION_PASSED_TO_EVALUATOR],
    ["EVALUATOR_DECIDES_WITHOUT_A_REQUEST", EVALUATOR_DECIDES_WITHOUT_A_REQUEST],
    ["NEVER_GATED", NEVER_GATED],
    ["NOT_A_NEW_TOKEN_ACTION", Object.keys(NOT_A_NEW_TOKEN_ACTION)],
    ["GATE_ENDPOINT", GATE_ENDPOINT],
  ];
  for (const [name, routes] of lists) {
    for (const route of routes) classified.set(route, [...(classified.get(route) ?? []), name]);
  }

  it("finds the routes that start a token action, so the word match is not empty", () => {
    const found = tokenRoutes();
    for (const route of [...GATED, ...DECISION_PASSED_TO_EVALUATOR]) expect(found).toContain(route);
    expect(found.length).toBeGreaterThan(35);
  });

  it("leaves no route that mentions a token, wallet, deposit, Bankr or crypto out of every list", () => {
    const unclassified = tokenRoutes().filter((route) => !classified.has(route));
    // A failure here names the route. Decide: does it start a NEW token action?
    // Yes: add the gate (resolveTokenGeoBlock) and list it in GATED. No: list it in
    // NEVER_GATED or NOT_A_NEW_TOKEN_ACTION with the reason.
    expect(unclassified).toEqual([]);
  });

  it("lists each route once, and only routes that exist", () => {
    const listedTwice = [...classified].filter(([, names]) => names.length > 1).map(([route]) => route);
    expect(listedTwice).toEqual([]);
    const missing = [...classified.keys()].filter((route) => !existsSync(path.join(API, route, "route.ts")));
    expect(missing).toEqual([]);
  });

  it("gives every NOT_A_NEW_TOKEN_ACTION entry a real reason", () => {
    for (const [route, reason] of Object.entries(NOT_A_NEW_TOKEN_ACTION)) {
      expect({ route, enough: reason.trim().length >= 40 }).toEqual({ route, enough: true });
    }
  });
});
