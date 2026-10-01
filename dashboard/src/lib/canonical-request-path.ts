/**
 * Spells a request path the one way the app routes expect.
 *
 * RFC 3986 section 2.3 says a percent-encoded letter, digit, hyphen, period,
 * underscore or tilde means exactly the same thing as the character itself, so
 * `/%70ricing` is `/pricing`. The app does not treat them alike:
 *
 *   - Next.js answers an encoded app route with a plain 404.
 *   - On Vercel the Next launcher looks the still-encoded text up as a pages
 *     router module and throws, so the visitor gets a 500 page
 *     (`Cannot find module './.next/server/pages/%70ricing.js'`).
 *   - Files in `public/` are decoded by the platform before they are found, so
 *     `/%54OKENOMICS.md` serves the file while a rule written against the
 *     literal path `/TOKENOMICS.md` (a rewrite in next.config.ts) never sees it.
 *
 * Redirecting to the plain spelling makes every route and every path rule see
 * the one form they were written for, for unreserved characters only.
 *
 * Only unreserved characters are decoded. `%2F`, `%5C`, `%25`, `%3F`, `%23` and
 * the other reserved characters change what a path means, and bytes of 0x80 and
 * up are the pieces of a multi-byte character, so all of those stay as they are.
 *
 * This is NOT a security boundary for files in `public/`: `%2F` and `%5C`
 * spellings still reach them, so nothing that must stay private may rely on a
 * path rule here. The UK token documents do not: they are not in `public/` at all
 * and are served by route handlers that decide by country
 * (see docs/token/TOKEN-GEO-POLICY.md).
 */

const UNRESERVED_ESCAPE = /%([0-9A-Fa-f]{2})/g;

function isUnreservedByte(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d || // -
    code === 0x2e || // .
    code === 0x5f || // _
    code === 0x7e // ~
  );
}

/**
 * The path with its percent-encoded unreserved characters decoded, or null when
 * there is nothing to change (or when changing it would be unsafe).
 */
export function canonicalRequestPath(pathname: string): string | null {
  // Build chunks name files with %5B and %5D; the proxy does not run for them
  // and they must never be rewritten.
  if (pathname.startsWith("/_next/")) return null;
  if (!pathname.includes("%")) return null;
  // A lone % that does not start an escape is malformed. Decoding the escapes
  // beside it could join them into a new escape (`%%370` would become `%70`),
  // so a path like that is left exactly as it came.
  if (/%(?![0-9A-Fa-f]{2})/.test(pathname)) return null;

  const decoded = pathname.replace(UNRESERVED_ESCAPE, (escape, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return isUnreservedByte(code) ? String.fromCharCode(code) : escape;
  });
  if (decoded === pathname) return null;

  // `%2e%2e` would turn into `..`. A browser or a server collapses a dot
  // segment, which can move the request to a different path than the one that
  // was asked for, so leave such a path alone.
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;

  return decoded;
}
