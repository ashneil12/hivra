/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { createHash } from "node:crypto";

import { ACCOUNT_CODE_PATTERN, accountCode, accountCodeFromDigest, sha256Bytes } from "../account-code";
import { renderEnrollFinalLine } from "../infrastructure/server-enrollment-script";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic bytes from a fixed seed (SHA-256 in counter mode), so every
 * run checks exactly the same inputs (review finding 11: no random ids). */
function seededBytes(seed: string, length: number): Uint8Array {
  const out = Buffer.alloc(length);
  for (let block = 0; block * 32 < length; block += 1) {
    createHash("sha256").update(`${seed}:${block}`).digest().copy(out, block * 32);
  }
  return new Uint8Array(out);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** A Clerk-shaped user id (27 base62 characters after the prefix) from a
 * fixed seed. The "fixture_" prefix keeps it from reading as a real hosted
 * account id to the public-tree hygiene check. */
function clerkLikeUserId(index: number): string {
  return "fixture_user_" + Array.from(seededBytes(`clerk-user:${index}`, 27), (byte) => BASE62[byte % 62]).join("");
}

const CLERK_LIKE_FIRST_ID = "fixture_user_7MFK3d7nKARq9ZuOAdC4lFTuM4e";
/** sha256 of the 100,000 codes in order, computed independently (Python's
 * hashlib) when this test was written. */
const ALL_CODES_SHA256 = "4196a541bee4f69122898b576e5d614aeb0588d788e8358c304643ed03458d72";

/** An independent reference: node:crypto and BigInt, not the module's code. */
function referenceCode(userId: string): string {
  const digest = createHash("sha256").update("hivra/account-code/v1").update(Buffer.from([0])).update(userId, "utf8").digest();
  let bits = BigInt(0);
  for (let index = 0; index < 5; index += 1) bits = bits * BigInt(256) + BigInt(digest[index]);
  let code = "";
  for (let position = 7; position >= 0; position -= 1) code += CROCKFORD[Number((bits >> BigInt(5 * position)) & BigInt(31))];
  return code.slice(0, 4) + "-" + code.slice(4);
}

describe("accountCode (T5)", () => {
  it.each([
    ["user_2abcDEF123", "G3DN-J45N"],
    ["user_123", "QJK7-53FK"],
    ["user_ümlaut", "VVTC-ZC7F"],
    ["a", "B93Z-7J1C"],
  ])("gives %s the fixed code %s", (userId, expected) => {
    expect(accountCode(userId)).toBe(expected);
  });

  it("matches node:crypto SHA-256 for inputs of every padding length", () => {
    for (let length = 0; length < 200; length += 1) {
      const bytes = seededBytes(`padding:${length}`, length);
      expect(Buffer.from(sha256Bytes(bytes)).toString("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("uses Crockford base32 without I, L, O or U, as XXXX-XXXX", () => {
    for (let index = 0; index < 2_000; index += 1) {
      const code = accountCode(clerkLikeUserId(index));
      expect(code).toMatch(ACCOUNT_CODE_PATTERN);
      expect(code).not.toMatch(/[ILOU]/);
    }
    expect(accountCodeFromDigest(new Uint8Array([0, 0, 0, 0, 0]))).toBe("0000-0000");
    expect(accountCodeFromDigest(new Uint8Array([255, 255, 255, 255, 255]))).toBe("ZZZZ-ZZZZ");
    expect(() => accountCodeFromDigest(new Uint8Array(4))).toThrow();
  });

  // About 0.005 collisions are expected among 100,000 ids at 40 bits. The
  // ids are fixed (Clerk-shaped, from a seed), so the result is a fixed
  // vector too: a digest of every code pins it, and any change to the
  // derivation shows up here rather than as a rare flake.
  it("gives 100,000 fixed Clerk-shaped user ids 100,000 distinct codes, agreeing with the reference", () => {
    const seen = new Map<string, string>();
    const all = createHash("sha256");
    for (let index = 0; index < 100_000; index += 1) {
      const userId = clerkLikeUserId(index);
      const code = accountCode(userId);
      if (index % 5_000 === 0) expect(code).toBe(referenceCode(userId));
      expect(seen.get(code)).toBeUndefined();
      seen.set(code, userId);
      all.update(code);
    }
    expect(seen.size).toBe(100_000);
    expect(clerkLikeUserId(0)).toBe(CLERK_LIKE_FIRST_ID);
    expect(all.digest("hex")).toBe(ALL_CODES_SHA256);
  });

  it("refuses an empty or oversized user id", () => {
    expect(() => accountCode("")).toThrow();
    expect(() => accountCode("x".repeat(257))).toThrow();
  });

  it("is the value the script's final line names, and the final line refuses anything else", () => {
    const userId = "user_2abcDEF123";
    const line = renderEnrollFinalLine({
      origin: "https://hivra.example",
      code: "hse1_" + "a".repeat(32),
      adminPublicKey: "ssh-ed25519 " + "A".repeat(68),
      accountCode: accountCode(userId),
    });
    expect(line).toContain(`'${accountCode(userId)}' HIVRA_END_V1; }`);
    for (const value of ["ash@example.com", "", "g3dn-j45n", "G3DNJ45N", "G3DN-J45I"]) {
      expect(() => renderEnrollFinalLine({
        origin: "https://hivra.example",
        code: "hse1_" + "a".repeat(32),
        adminPublicKey: "ssh-ed25519 " + "A".repeat(68),
        accountCode: value,
      })).toThrow();
    }
  });
});
