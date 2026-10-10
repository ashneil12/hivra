# The new-token-surfaces switch (HIVRA_NEW_TOKEN_SURFACES)

One server-side environment variable decides whether the new $HIVRA / dual-token launch surfaces are visible.
It has no NEXT_PUBLIC twin. Unset or anything other than `1`, `true`, `on`, `yes` means OFF, which is the production default.

## What it holds back while OFF

- Redirects (307, so they can come back): `/token`, `/tokenomics`, `/why-hivra/evolution`, `/dashboard/convert`,
  the litepaper (`/docs/litepaper`, `/docs/litepaper/index.html`), `/LITEPAPER.md`, `/WHITEPAPER.md`, `/TOKENOMICS.md`.
  `/token` sends a signed-in customer to `/dashboard/wallet` and everyone else to `/pricing`. The others go to
  `/pricing`, `/why-hivra`, `/dashboard/billing` or `/`. Implemented in `src/proxy.ts` and
  `src/lib/compliance/token-geo-documents.ts` (the `.html` document is outside the proxy matcher).
- Links removed: header and footer (Litepaper, Token, Formerly HermesOS link), homepage "How Hivra compares" and
  "open-source commitment" links (they pointed into the litepaper), ecosystem page links, `llms.txt` Papers section and token sentence,
  the sitemap entry for `/token`. The roadmap renders its token-free copy.
- The UK list (`token-geo-list.ts`, `GB`) is inert: `resolveTokenGeoBlock` and `isNewTokenQualificationRefused` return "not blocked"
  and read nothing, so a UK $HermesOS customer is never refused. The client hook still asks `/api/token-geo`, which answers "not blocked".

## What it never touches (the $HermesOS features prod customers have today)

Wallet verification and unlock, tier eligibility and the tier crons, `/dashboard/wallet`, lock-wallet and agent-wallet withdraw,
USDC top-ups, managed-Venice $HermesOS deposits, yearly $HermesOS subscriptions, treasury gas, the reconciliation crons.
While `HIVRA_TOKEN_LAUNCH.contractAddress` is empty these run on $HermesOS alone. Activating $HIVRA stays its own reviewed PR
(`docs/token/HIVRA-ACTIVATION.md`) and is not part of this switch.

## Turning it on later

1. Legal review of the token copy and the UK decision are done (GO-PROMOTE sections 1a and 1b).
2. Set `HIVRA_NEW_TOKEN_SURFACES=true` in the Vercel project's Production environment (Ash, dashboard only).
3. Trigger a new build (a merge), because static pages and the sitemap read it at build or request time on the new deployment.
4. Check `/token`, `/tokenomics`, `/dashboard/convert`, `/llms.txt` and `/sitemap.xml` on the served deployment.

Canary keeps the switch ON for Ash (set in the `hermesos-canary` project env by Ash; the code default is OFF everywhere).
Tests run with it ON (`jest.setup.tsx`) and set it per case in `src/lib/__tests__/token-surfaces-switch.test.ts`.
