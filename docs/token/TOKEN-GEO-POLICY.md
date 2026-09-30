# Token geo-policy runbook

A server-enforced country gate for Hivra's token features. **Status: on for
GB** since the owner directed it on 2026-09-30. It is live on Canary when this
merges and reaches production only through an owner-approved Promote. This page
is not legal advice, and a UK crypto lawyer should still review the position.

What a country block does and does not do, from the FCA's own pages (checked
2026-09-30): the cryptoasset promotions rules apply "regardless of whether the
firm is based overseas", to communications capable of having effect in the UK,
and lawful routes are an authorised firm, approval by one, MLR registration or
an exemption. Geo-blocking is one way to keep UK consumers out of reach, so it
only works if it covers every place the promotion appears. The app's routes and
pages are covered below; the static documents, emails and social posts are not
(see "Not covered").

## The one file

`dashboard/src/lib/compliance/token-geo-list.ts`:

```ts
export const BLOCKED_COUNTRIES: readonly string[] = ["GB"];   // empty = dormant
```

`token-geo-policy.ts` reads it. The list is its own file so the test suite can
run against an empty list (`jest.setup.tsx` mocks it) while
`token-geo-policy.test.ts` checks the real one.

Use "GB", not "UK": `token-geo-policy.test.ts` fails the build on "UK", a
lower-case or three-letter code, an unknown region or a duplicate.

## Who counts as blocked

Either signal blocks (`dashboard/src/lib/compliance/token-geo-gate.ts`):

1. **Request IP country:** the `x-vercel-ip-country` header Vercel's edge sets.
   A missing header, `XX` (unknown) or `T1` (Tor) is **not** blocked: self-hosted
   installs have no Vercel edge, and an unknown IP is not evidence of a country.
   A VPN user outside the list is therefore not blocked by this signal.
2. **Stored country:** `signup_risk_assessments.country_code`, the sign-up IP
   country the free-tier abuse check recorded (proxycheck). Only users that
   check assessed have one. A read failure counts as unknown.

Crons have no request. When one is about to record a first tier qualification,
the stored country decides, and so does the country Clerk recorded for the
user's latest session activity (the same source as the `sync-user-geo` cron),
standing in for the request IP. A failed Clerk read counts as unknown.

The ops admin is exempt, for testing and operating the service; this is not a customer-facing exception. `isOpsAdminUser` reads only the first entry of `OPS_ADMIN_USER_IDS` and of `OPS_ADMIN_EMAILS` (its email must be the user's verified primary address in Clerk), so the account that must keep token features from a listed country has to be that first entry. Prefer `OPS_ADMIN_USER_IDS`: it needs no Clerk lookup.

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
| New deposit (hold-for-tier) quote, for a tier with no existing row | `POST /api/billing/wallet/quote` |
| New crypto (USDC) top-up | `POST /api/billing/crypto/top-up` |
| Start a $HermesOS → $HIVRA conversion | `POST /api/billing/token-access {"action":"convert"}` |
| First wallet verification (no existing token access) | `POST /api/billing/wallet/challenge`, `/verify` |
| New token-tier qualification | refused inside `evaluateAndRecordTokenTierEligibility` (the only place a tier row is created): from the request on wallet refresh/unlock, and from the stored and Clerk session country on crons and other callers |

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
- A user with a tier row, a self-verified wallet, an older Bankr holder wallet
  or a legacy lock wallet may still verify a wallet, so moving tokens or
  leaving a lock wallet never costs the tier.
- A holder with a row for a tier may still lock a deposit quote for it, so a
  suspended row can re-qualify at a locked price.
- A holder who switched to $HIVRA still sees their switch deadline on
  `/dashboard/convert`.
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
  the address checker, the user's current access and switch deadline, and the
  notice stay.
- `/token`: contracts, BaseScan links and current access stay, the notice is
  added, the proposals and litepaper link are dropped.
- `/tokenomics`: only the contract addresses, a link to `/token` and the notice.
- `/why-hivra/evolution`: the token-discount lines are replaced by the notice.

While the policy lists a country, dashboard components hide promotions until
`GET /api/token-geo` answers, and keep them hidden if it fails; the card path
is always there. With the empty list no component asks.

## The static documents

The litepaper, white paper and `TOKENOMICS.md` are served from `public/`, so
the app cannot gate them. For a listed country `dashboard/next.config.ts`
rewrites these paths, before the filesystem is checked, to token-free copies:

| Path | Listed country gets |
|---|---|
| `/docs/litepaper/index.html` (and `/docs/litepaper`) | `docs/litepaper/restricted.html`: no economy chapter, no Tokenomics button, no link into either |
| `/LITEPAPER.md` | the same text without the economy section |
| `/WHITEPAPER.md` | without sections 7 and 8 and every other line about the token |
| `/TOKENOMICS.md` | a two-line notice |

Every copy is cut from the approved source by `docs/litepaper/restrict.py` and
the build fails if one still mentions the token (`test_restricted.py`). The
rewrite uses the same `x-vercel-ip-country` header as the gate and reads the
same list, so one edit covers both. Checked locally against a real Next server:
a `GB` request gets the token-free files and every other country, or none,
gets the full ones. It cannot be checked from outside the UK.

## Not covered

- Emails, X posts and anything posted off-site.
- Search-engine and archive copies of the documents made before the change.
- Agent wallets (the user's own Bankr account) and `POST /api/billing/bankr/wallet`
  (provisions a deposit address; every payment that uses it is gated).
- **The 1-token base tier is not gated.** It has no qualification record, so
  the code cannot tell a new holder from an existing one, and gating it would
  risk revoking existing holders. A blocked user can't reach it without a
  verified wallet (first verification is gated), but someone who verified a
  wallet before the policy (or behind a VPN) gets it by holding 1 token.
  Counsel should say whether that needs closing.
- A blocked user with a crypto payment already in progress who tries to start
  another gets the geo 403 rather than the "payment already active" 409; the
  active payment itself still settles.
- $HIVRA itself trades on a permissionless pool; nothing here can block that.

## Changing it

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
