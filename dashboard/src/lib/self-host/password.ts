import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const DEFAULT_KEY_LENGTH = 32;

export async function hashLocalOperatorPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("Operator password must contain at least 12 characters.");
  }
  const salt = randomBytes(16);
  const digest = (await scrypt(password, salt, DEFAULT_KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyLocalOperatorPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const [algorithm, saltValue, digestValue, extra] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !saltValue || !digestValue || extra !== undefined) return false;

  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(digestValue, "base64url");
    if (salt.length < 16 || expected.length !== DEFAULT_KEY_LENGTH) return false;
    const actual = (await scrypt(password, salt, expected.length)) as Buffer;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
