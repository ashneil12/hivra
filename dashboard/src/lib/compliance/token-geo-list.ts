/**
 * The countries that may not use Hivra's token features: the ONE line to edit.
 * ISO-3166 alpha-2, upper case, e.g. "GB". An empty list makes the gate dormant.
 *
 * It lives in its own file so the test suite can run against an empty list
 * (jest.setup.tsx) while the tests in token-geo-policy.test.ts still check the
 * real list. Read docs/token/TOKEN-GEO-POLICY.md before changing it.
 */
export const BLOCKED_COUNTRIES: readonly string[] = ["GB"];
