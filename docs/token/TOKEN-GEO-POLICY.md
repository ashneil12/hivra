# Token geo-policy runbook

A server-enforced country gate for Hivra's token features. It is built and
**dormant**: the committed list is empty, so it blocks nobody, reads no
country and changes nothing anyone sees.

Enabling it is a legal decision first. Before any country is listed, the UK
financial-promotion and crypto position needs review by a UK crypto lawyer.
The 2026-09-24 UK exposure research found that blocking helps but is not a
full fix for a UK-based founder, and that the FCA's good-practice example is
geo-blocking plus onboarding checks that refuse a UK address or UK payment
method, with UK-exclusion notices. This page is not legal advice.

## The one file

`dashboard/src/lib/compliance/token-geo-policy.ts`:

```ts
export const TOKEN_GEO_POLICY: TokenGeoPolicy = {
  blockedCountries: [],        // ISO-3166 alpha-2, upper case. Empty = dormant.
};
```

To block the United Kingdom, the change is one line:

```ts
  blockedCountries: ["GB"],
```

"UK" is not a valid code; `token-geo-policy.test.ts` fails the build on a
malformed entry.

## Who counts as blocked

Either signal blocks (`dashboard/src/lib/compliance/token-geo-gate.ts`):

1. **Request IP country:** the `x-vercel-ip-country` header Vercel's edge sets.
   A missing header, `XX` (unknown) or `T1` (Tor) is **not** blocked: self-hosted
   installs have no Vercel edge, and an unknown IP is not evidence of a country.
   A VPN user outside the list is therefore not blocked by this signal.
2. **Stored country:** `signup_risk_assessments.country_code`, the sign-up IP
   country the free-tier abuse check recorded (proxycheck). Only users that
   check assessed have one. A read failure counts as unknown.

Hivra stores no billing address and no profile country, and the Stripe card's
issuing country is not kept. So the FCA's "refuse a UK payment method" check
does not exist yet; capturing `card.country` at the `setup_intent.succeeded`
webhook would be a separate reviewed change.

## What a blocked user can't do (server, HTTP 403)

Every refusal is `403` with `code: "token_geo_blocked"` and the message
"Token features aren't available to people in the United Kingdom." (the
country name follows the matched code).

| Action | Route |
|---|---|
| New yearly token quote | `POST /api/billing/yearly-token-quote` |
| New managed-Venice token top-up quote | `POST /api/billing/managed-venice/hermesos/quote` |
| New deposit (hold-for-tier) quote | `POST /api/billing/wallet/quote` |
| New crypto (USDC) top-up | `POST /api/billing/crypto/top-up` |
| Start a $HermesOS → $HIVRA conversion | `POST /api/billing/token-access {"action":"convert"}` |
| First wallet verification (no existing token access) | `POST /api/billing/wallet/challenge`, `/verify` |
| New token-tier qualification | refused inside `evaluateAndRecordTokenTierEligibility` (the only place a tier row is created): from the request on wallet refresh/unlock, and from the stored country on crons |

## What never changes for anyone

- Existing tier rows keep being evaluated as before: held, breached, recovered,
  re-qualified after suspension, moved to $HIVRA after a conversion.
- Existing yearly years run to expiry. Renewing by token is a new payment and
  is refused; card is available.
- Yearly and managed-Venice quotes already issued settle in their window;
  `check-now`, managed-Venice `check`/`settle`, sweeps and reconciliation
  never consult the policy. (A deposit quote is only a price lock for a new
  tier, so a blocked user doesn't qualify from one.)
- Withdrawals and withdraw addresses (exits) are never gated.
- A user with a tier row, a self-verified wallet or a legacy lock wallet may
  still verify a wallet, so moving tokens or leaving a lock wallet never costs
  the tier. The 1-token base tier continues for anyone already verified.
- Card payments (plans, top-ups, managed-Venice card credit) never consult it.

`token-geo-surfaces.test.ts` pins both lists against the source.

## What a blocked user doesn't see (UI)

- Billing: the "Pay with $HermesOS" path and its "Up to N% less than a card
  year" chip; the Payment methods token blocks (notice shown instead, with a
  link to Wallet for an existing holding); token top-ups, the launch-bonus
  banner and the crypto top-up in Credits; the token option in the top-up dialog.
- Welcome flow: the Card / $HermesOS choice ("save up to ~59%"), "use $HermesOS
  for bonus credits", the optional token top-up and launch-bonus copy.
- Command center: the launch-bonus and launch-allocation rows.
- Wallet: the buy-token (Uniswap) card; the notice is shown.
- `/dashboard/convert`: no switch step and no conversion link; contracts,
  the address checker and the notice stay.
- `/token`: contracts, BaseScan links and current access stay, the notice is
  added, the proposals and litepaper link are dropped.
- `/tokenomics`: only the contract addresses, a link to `/token` and the notice.
- `/why-hivra/evolution`: the token-discount lines are replaced by the notice.

While the policy lists a country, dashboard components hide promotions until
`GET /api/token-geo` answers, and keep them hidden if it fails; the card path
is always there. With the empty list no component asks.

## Not covered

- The static litepaper and white paper (`/docs/litepaper/…`), `/TOKENOMICS.md`
  and other files served straight from `public/` bypass the app and are
  unchanged. So are emails, X posts and anything posted off-site.
- Agent wallets (the user's own Bankr account) and `POST /api/billing/bankr/wallet`
  (provisions a deposit address; every payment that uses it is gated).
- $HIVRA itself trades on a permissionless pool; nothing here can block that.

## Enabling it

1. Legal review agrees the country list, the notice wording and whether the
   uncovered items above need their own change.
2. Open one PR changing the list. Title it so the review is visible.
3. Merge into `canary`; the Vercel Git build deploys it.
4. Production goes live only through Ash's Promote of a `main` build that
   contains it.

Once a country is listed, `/token`, `/tokenomics` and `/why-hivra/evolution`
read the request country when they render. (These routes are already
server-rendered on demand, so their rendering mode does not change.)

## Verifying it

On the target (after the build serves the merge commit):

1. From a UK connection: `GET /api/token-geo` returns
   `{"blocked":true,"notice":"Token features aren't available to people in the United Kingdom."}`.
2. `/token` and `/tokenomics` show the notice and the contract addresses, with
   no discount, bonus or proposal copy.
3. Signed in with a disposable fixture: Billing shows card plans only, no
   chip; a direct `POST /api/billing/yearly-token-quote {"tier":"pro"}` returns
   403 `token_geo_blocked`; a card checkout still opens Stripe.
4. From a non-UK connection (VPN): everything is as before, and
   `GET /api/token-geo` returns `{"blocked":false,"notice":null}`.
5. Logs: refusals are logged at info with `failureType: "token_geo_blocked"`,
   the matched country and the signal (`ip_country` / `stored_country`).

Dormant check (what this PR shipped): `GET /api/token-geo` returns
`{"blocked":false,"notice":null}` from any country, and every page looks as it
did before.

## Rolling back

Revert the list to `[]` in a PR. Nothing is stored by the gate, so there is
nothing to clean up; refused actions simply become available again.
