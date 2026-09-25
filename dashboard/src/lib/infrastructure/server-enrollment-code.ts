import "server-only";

import { createHash, randomBytes } from "node:crypto";

/** A one-time server enrollment code: `hse1_` + 32 lowercase RFC 4648 base32
 * characters, from 20 random bytes (160 bits). It is a bearer secret that can
 * put a server under an account's control for 15 minutes, so it travels only
 * in the Authorization header of the script download and of the report,
 * never in a URL, and it is stored only as its purpose-bound SHA-256. */
export const SERVER_ENROLLMENT_CODE_PATTERN = /^hse1_[a-z2-7]{32}$/;
export const SERVER_ENROLLMENT_AUTHORIZATION_PATTERN = /^Bearer (hse1_[a-z2-7]{32})$/;
export const SERVER_ENROLLMENT_TTL_MS = 15 * 60_000;
export const SERVER_ENROLLMENT_CONFIRM_WINDOW_MS = 30 * 60_000;
export const SERVER_ENROLLMENT_MAX_FETCHES = 20;
export const SERVER_ENROLLMENT_MAX_REFUSED_REPORTS = 10;
export const SERVER_ENROLLMENT_MAX_ACTIVE = 3;
export const SERVER_ENROLLMENT_MAX_PER_DAY = 30;
export const SERVER_ENROLLMENT_MAX_REPLACEMENT_ATTEMPTS = 5;
export const SERVER_ENROLLMENT_REPORT_BODY_LIMIT = 2_048;
/** The encryptSecret purpose tag for an enrollment's admin private key. */
export const SERVER_ENROLLMENT_ADMIN_KEY_PURPOSE = "hivra/server-enrollment/admin-key/v1";
/** The public comment on the key line the script installs. */
export const SERVER_ENROLLMENT_ADMIN_KEY_COMMENT = "hivra-enrollment";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CODE_PURPOSE = "hivra/server-enrollment/code/v1";

/** RFC 4648 base32, lowercase, without padding. 20 bytes give exactly 32. */
export function base32Lower(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32[(buffer << (5 - bits)) & 31];
  return output;
}

export function generateServerEnrollmentCode(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(20);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 20) throw new Error("Enrollment code entropy unavailable");
  const code = "hse1_" + base32Lower(bytes);
  if (!SERVER_ENROLLMENT_CODE_PATTERN.test(code)) throw new Error("Enrollment code generation failed");
  return code;
}

/** What the database stores instead of the code:
 * sha256("hivra/server-enrollment/code/v1" || 0x00 || code), hex. A 160-bit
 * random secret needs no pepper or slow hash. Throws for anything that is not
 * a well-formed code, so a malformed header never reaches the database. */
export function serverEnrollmentCodeSha256(code: string): string {
  if (typeof code !== "string" || !SERVER_ENROLLMENT_CODE_PATTERN.test(code)) {
    throw new Error("Not an enrollment code");
  }
  return createHash("sha256").update(CODE_PURPOSE).update(Buffer.from([0])).update(code).digest("hex");
}

/** The code in an `Authorization: Bearer hse1_…` header, or null. */
export function serverEnrollmentCodeFromAuthorization(header: string | null): string | null {
  return header?.match(SERVER_ENROLLMENT_AUTHORIZATION_PATTERN)?.[1] ?? null;
}
