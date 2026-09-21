import crypto from "node:crypto";

/**
 * Timing-safe check that an Authorization header value is exactly
 * `Bearer ${expectedSecret}`.
 *
 * Returns `true` only when the secret is present and the header matches.
 * Returns `false` for: missing secret, missing/blank header, wrong scheme,
 * wrong length, or any byte mismatch — without leaking which case via
 * timing.
 *
 * Why a helper: callers used `header !== \`Bearer ${secret}\`` which is a
 * variable-time compare. The window is small over a network, but standard
 * practice for shared-secret auth is a constant-time compare, and
 * centralising the check means we can't accidentally regress one route.
 */
export function verifyBearerHeader(
  source:
    | { headers: { get(name: string): string | null } }
    | Request
    | string
    | null
    | undefined,
  expectedSecret: string | null | undefined,
): boolean {
  if (!expectedSecret) return false;

  let header: string | null;
  if (source == null) {
    header = null;
  } else if (typeof source === "string") {
    header = source;
  } else {
    header = source.headers.get("authorization");
  }

  if (typeof header !== "string" || !header) return false;
  // Trim wrapping whitespace so we don't reject a header that picked up
  // accidental padding from a proxy. Internal whitespace in the secret
  // itself is still significant.
  header = header.trim();

  const expected = `Bearer ${expectedSecret}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(header, "utf8");

  // timingSafeEqual throws on length mismatch — pre-check and fail.
  if (receivedBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}
