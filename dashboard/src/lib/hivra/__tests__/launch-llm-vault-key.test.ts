import { resolveLaunchLlmVaultKey, type VaultKeyReader } from "../launch-llm-vault-key";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/crypto", () => ({
  decryptApiKey: (value: string) => {
    if (!value.startsWith("enc:")) throw new Error("bad ciphertext");
    return value.slice(4);
  },
}));

const OWNER = "user_owner";
const KEY_ID = "44444444-4444-4444-8444-444444444444";
const reference = { provider: "venice", mode: "byok", vaultKeyId: KEY_ID, model: "deepseek-v4-pro" };

describe("a launch that names a saved Vault key", () => {
  it("swaps the reference for the owner's own saved key, and nothing else", async () => {
    const read = jest.fn<ReturnType<VaultKeyReader>, Parameters<VaultKeyReader>>(async () => ({ provider: "venice", encrypted_key: "enc:synthetic-venice-key" }));
    await expect(resolveLaunchLlmVaultKey(OWNER, reference, read)).resolves.toEqual({
      ok: true,
      llm: { provider: "venice", mode: "byok", model: "deepseek-v4-pro", apiKey: "synthetic-venice-key" },
    });
    // Read for the signed-in owner only.
    expect(read).toHaveBeenCalledWith(OWNER, KEY_ID);
  });

  it("leaves a launch without a reference to the normal validation", async () => {
    const read = jest.fn();
    for (const llm of [undefined, null, { provider: "venice", mode: "managed", walletType: "card" }, { provider: "venice", mode: "byok", apiKey: "synthetic-pasted-key" }]) {
      await expect(resolveLaunchLlmVaultKey(OWNER, llm, read)).resolves.toEqual({ ok: true, llm });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["with a pasted key too", { ...reference, apiKey: "synthetic-pasted-key" }],
    ["for Hivra credits", { ...reference, mode: "managed", walletType: "card" }],
    ["for another provider", { ...reference, provider: "openrouter" }],
    ["with a malformed id", { ...reference, vaultKeyId: "not-a-uuid" }],
  ])("refuses a reference %s before reading anything", async (_label, llm) => {
    const read = jest.fn();
    await expect(resolveLaunchLlmVaultKey(OWNER, llm, read)).resolves.toMatchObject({ ok: false, status: 400 });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["isn't the owner's", null],
    ["belongs to another provider", { provider: "openrouter", encrypted_key: "enc:sk-or-123" }],
    ["has no stored key", { provider: "venice", encrypted_key: null }],
  ])("says so, and launches nothing, when the saved key %s", async (_label, row) => {
    await expect(resolveLaunchLlmVaultKey(OWNER, reference, async () => row)).resolves.toEqual({
      ok: false,
      status: 404,
      error: "That saved Venice key is no longer in your Vault. Paste the key, or choose another option.",
    });
  });

  it("reports an unreadable Vault as a retry, never as a missing key", async () => {
    await expect(resolveLaunchLlmVaultKey(OWNER, reference, async () => { throw new Error("db down"); }))
      .resolves.toMatchObject({ ok: false, status: 503 });
    await expect(resolveLaunchLlmVaultKey(OWNER, reference, async () => ({ provider: "venice", encrypted_key: "garbled" })))
      .resolves.toMatchObject({ ok: false, status: 503 });
  });

  it("never puts the key in an error", async () => {
    const results = await Promise.all([
      resolveLaunchLlmVaultKey(OWNER, { ...reference, apiKey: "pasted-secret-1" }, async () => null),
      resolveLaunchLlmVaultKey(OWNER, reference, async () => ({ provider: "venice", encrypted_key: "garbled-secret" })),
    ]);
    expect(JSON.stringify(results)).not.toMatch(/secret/);
  });
});
