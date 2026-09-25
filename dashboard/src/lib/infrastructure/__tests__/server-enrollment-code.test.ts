/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { createHash } from "node:crypto";

import {
  base32Lower,
  generateServerEnrollmentCode,
  SERVER_ENROLLMENT_CODE_PATTERN,
  serverEnrollmentCodeFromAuthorization,
  serverEnrollmentCodeSha256,
} from "../server-enrollment-code";

describe("server enrollment code (T1, T4)", () => {
  it("encodes RFC 4648 base32 test vectors in lowercase without padding", () => {
    const vector = (text: string) => base32Lower(new Uint8Array(Buffer.from(text, "ascii")));
    expect(vector("")).toBe("");
    expect(vector("f")).toBe("my");
    expect(vector("fo")).toBe("mzxq");
    expect(vector("foo")).toBe("mzxw6");
    expect(vector("foob")).toBe("mzxw6yq");
    expect(vector("fooba")).toBe("mzxw6ytb");
    expect(vector("foobar")).toBe("mzxw6ytboi");
  });

  it("draws exactly 20 bytes (160 bits) and emits hse1_ plus 32 characters", () => {
    const sizes: number[] = [];
    const code = generateServerEnrollmentCode(size => {
      sizes.push(size);
      return new Uint8Array(size).fill(0xff);
    });
    expect(sizes).toEqual([20]);
    expect(code).toBe("hse1_" + "7".repeat(32));
    expect(generateServerEnrollmentCode(size => new Uint8Array(size))).toBe("hse1_" + "a".repeat(32));
  });

  it("gives distinct well-formed codes from the real entropy source", () => {
    const codes = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
      const code = generateServerEnrollmentCode();
      expect(code).toMatch(/^hse1_[a-z2-7]{32}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(1_000);
  });

  it("refuses a short or failed entropy source", () => {
    expect(() => generateServerEnrollmentCode(() => new Uint8Array(19))).toThrow();
    expect(() => generateServerEnrollmentCode(() => "x".repeat(20) as unknown as Uint8Array)).toThrow();
  });

  it("stores only the purpose-bound sha256 of the code", () => {
    const code = "hse1_" + "b".repeat(32);
    const expected = createHash("sha256").update("hivra/server-enrollment/code/v1\u0000" + code).digest("hex");
    expect(serverEnrollmentCodeSha256(code)).toBe(expected);
    expect(serverEnrollmentCodeSha256(code)).not.toBe(createHash("sha256").update(code).digest("hex"));
    expect(serverEnrollmentCodeSha256(code)).not.toContain(code.slice(5));
  });

  it.each([
    "", "hse1_", "hse1_" + "a".repeat(31), "hse1_" + "a".repeat(33), "HSE1_" + "a".repeat(32),
    "hse1_" + "A".repeat(32), "hse1_" + "1".repeat(32), "hse2_" + "a".repeat(32), " hse1_" + "a".repeat(32),
  ])("never hashes a malformed code %p", value => {
    expect(SERVER_ENROLLMENT_CODE_PATTERN.test(value)).toBe(false);
    expect(() => serverEnrollmentCodeSha256(value)).toThrow("Not an enrollment code");
  });

  it("reads the code only from an exact Bearer header", () => {
    const code = "hse1_" + "c".repeat(32);
    expect(serverEnrollmentCodeFromAuthorization("Bearer " + code)).toBe(code);
    for (const header of [null, "", code, "bearer " + code, "Bearer  " + code, "Bearer " + code + " ", "Basic " + code,
      "Bearer " + code + ",Bearer " + code, "Bearer " + code.toUpperCase()]) {
      expect(serverEnrollmentCodeFromAuthorization(header)).toBeNull();
    }
  });
});
