/**
 * The countries that may not use Hivra's token features: the ONE line to edit.
 * ISO-3166 alpha-2, upper case, e.g. "GB". An empty list makes the gate dormant.
 *
 * It lives in its own file so most of the test suite can run against an empty
 * list (jest.setup.tsx), as any other country sees the app, while the
 * *-real-list tests (and token-geo-policy.test.ts) load this real list and
 * prove it reaches the policy, the routes, the pages and the rewrites. Read
 * docs/token/TOKEN-GEO-POLICY.md before changing it.
 */
export const BLOCKED_COUNTRIES: readonly string[] = ["GB"];
