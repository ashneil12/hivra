import { hashLocalOperatorPassword, verifyLocalOperatorPassword } from "../password";

describe("local operator password hashing", () => {
  it("round-trips a generated scrypt credential without storing plaintext", async () => {
    const password = "correct horse battery staple";
    const encoded = await hashLocalOperatorPassword(password);

    expect(encoded).toMatch(/^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain(password);
    await expect(verifyLocalOperatorPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyLocalOperatorPassword("incorrect password", encoded)).resolves.toBe(false);
  });

  it("rejects weak and malformed credentials", async () => {
    await expect(hashLocalOperatorPassword("too-short")).rejects.toThrow(/at least 12/i);
    await expect(verifyLocalOperatorPassword("anything", "plaintext-value")).resolves.toBe(false);
  });
});
