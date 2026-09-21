const TEST_CHAT_KEY = "b".repeat(64);
const LEGACY_CHAT_KEY = "c".repeat(64);
const SECRET_WRITE_KEY = "d".repeat(64);

describe("chat-crypto", () => {
  beforeEach(() => {
    process.env.CHAT_ENCRYPTION_KEY = TEST_CHAT_KEY;
    process.env.ENCRYPTION_KEY = SECRET_WRITE_KEY;
  });

  afterEach(() => {
    delete process.env.CHAT_ENCRYPTION_KEY;
    delete process.env.CHAT_ENCRYPTION_KEY_LEGACY;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_LEGACY;
  });

  it("encrypts and decrypts stored chat text", async () => {
    const { encryptStoredChatText, decryptStoredChatText, isEncryptedChatText } = await import(
      "@/lib/chat-crypto"
    );

    const encrypted = encryptStoredChatText("Sensitive chat content");

    expect(encrypted).not.toBe("Sensitive chat content");
    expect(isEncryptedChatText(encrypted)).toBe(true);
    expect(decryptStoredChatText(encrypted)).toBe("Sensitive chat content");
  });

  it.each(["z", "0", " ", "\n", "#comment", " 00"])(
    "rejects malformed chat keys ending in %j without truncating them",
    async (suffix) => {
      const { encryptStoredChatText } = await import("@/lib/chat-crypto");
      process.env.CHAT_ENCRYPTION_KEY = TEST_CHAT_KEY + suffix;
      expect(() => encryptStoredChatText("not-persisted")).toThrow(
        "CHAT_ENCRYPTION_KEY must be 32 bytes (64 hex chars)",
      );
    },
  );

  it("rejects malformed legacy chat keys", async () => {
    const { encryptStoredChatText, decryptStoredChatText } = await import("@/lib/chat-crypto");
    const encrypted = encryptStoredChatText("legacy chat");
    process.env.CHAT_ENCRYPTION_KEY = LEGACY_CHAT_KEY;
    process.env.CHAT_ENCRYPTION_KEY_LEGACY = TEST_CHAT_KEY + "z";
    expect(() => decryptStoredChatText(encrypted)).toThrow(
      "CHAT_ENCRYPTION_KEY_LEGACY must be 32 bytes (64 hex chars)",
    );
  });

  it("encrypts and decrypts stored chat json payloads", async () => {
    const { encryptStoredChatJson, decryptStoredChatJson, isEncryptedChatJson } = await import(
      "@/lib/chat-crypto"
    );

    const payload = {
      attachments: [{ name: "brief.md", textContent: "keep this private" }],
      hidden: true,
    };

    const encrypted = encryptStoredChatJson(payload);

    expect(isEncryptedChatJson(encrypted)).toBe(true);
    expect(decryptStoredChatJson<typeof payload>(encrypted)).toEqual(payload);
  });

  it("passes legacy plaintext values through unchanged when decrypting", async () => {
    const { decryptStoredChatText, decryptStoredChatJson } = await import("@/lib/chat-crypto");

    expect(decryptStoredChatText("Legacy plaintext")).toBe("Legacy plaintext");
    expect(decryptStoredChatJson({ usage: { total_tokens: 42 } })).toEqual({
      usage: { total_tokens: 42 },
    });
  });

  it("decrypts legacy chat ciphertext via the configured legacy chat key", async () => {
    delete process.env.CHAT_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = LEGACY_CHAT_KEY;
    const legacyModule = await import("@/lib/chat-crypto");
    const legacyCiphertext = legacyModule.encryptStoredChatText("Old chat row");

    process.env.CHAT_ENCRYPTION_KEY = TEST_CHAT_KEY;
    process.env.CHAT_ENCRYPTION_KEY_LEGACY = LEGACY_CHAT_KEY;
    process.env.ENCRYPTION_KEY = SECRET_WRITE_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = LEGACY_CHAT_KEY;

    const { decryptStoredChatText } = await import("@/lib/chat-crypto");
    expect(decryptStoredChatText(legacyCiphertext)).toBe("Old chat row");
  });

  it("writes new chat ciphertext with CHAT_ENCRYPTION_KEY instead of ENCRYPTION_KEY", async () => {
    const { encryptStoredChatText, decryptStoredChatText } = await import("@/lib/chat-crypto");
    const encrypted = encryptStoredChatText("Fresh chat row");

    delete process.env.CHAT_ENCRYPTION_KEY;
    delete process.env.CHAT_ENCRYPTION_KEY_LEGACY;
    process.env.ENCRYPTION_KEY = SECRET_WRITE_KEY;
    delete process.env.ENCRYPTION_KEY_LEGACY;

    expect(() => decryptStoredChatText(encrypted)).toThrow();
  });

  it("explicitly re-encrypts legacy text and plaintext chat values", async () => {
    delete process.env.CHAT_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = LEGACY_CHAT_KEY;
    const legacyModule = await import("@/lib/chat-crypto");
    const legacyCiphertext = legacyModule.encryptStoredChatText("Old chat row");

    process.env.CHAT_ENCRYPTION_KEY = TEST_CHAT_KEY;
    process.env.CHAT_ENCRYPTION_KEY_LEGACY = LEGACY_CHAT_KEY;
    process.env.ENCRYPTION_KEY = SECRET_WRITE_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = LEGACY_CHAT_KEY;

    const { reencryptStoredChatText, decryptStoredChatText } = await import("@/lib/chat-crypto");

    const rotatedLegacy = reencryptStoredChatText(legacyCiphertext);
    expect(rotatedLegacy.changed).toBe(true);
    expect(rotatedLegacy.keySource).toBe("chat-legacy");
    expect(rotatedLegacy.value).not.toBe(legacyCiphertext);
    expect(decryptStoredChatText(rotatedLegacy.value)).toBe("Old chat row");

    const rotatedPlaintext = reencryptStoredChatText("Legacy plaintext");
    expect(rotatedPlaintext.changed).toBe(true);
    expect(rotatedPlaintext.keySource).toBe("plaintext");
    expect(rotatedPlaintext.value).not.toBe("Legacy plaintext");
    expect(decryptStoredChatText(rotatedPlaintext.value)).toBe("Legacy plaintext");
  });

  it("explicitly re-encrypts legacy json envelopes and plaintext json payloads", async () => {
    delete process.env.CHAT_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = LEGACY_CHAT_KEY;
    const legacyModule = await import("@/lib/chat-crypto");
    const legacyCiphertext = legacyModule.encryptStoredChatJson({ hidden: true });

    process.env.CHAT_ENCRYPTION_KEY = TEST_CHAT_KEY;
    process.env.CHAT_ENCRYPTION_KEY_LEGACY = LEGACY_CHAT_KEY;
    process.env.ENCRYPTION_KEY = SECRET_WRITE_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = LEGACY_CHAT_KEY;

    const { reencryptStoredChatJson, decryptStoredChatJson, isEncryptedChatJson } = await import(
      "@/lib/chat-crypto"
    );

    const rotatedLegacy = reencryptStoredChatJson(legacyCiphertext);
    expect(rotatedLegacy.changed).toBe(true);
    expect(rotatedLegacy.keySource).toBe("chat-legacy");
    expect(isEncryptedChatJson(rotatedLegacy.value)).toBe(true);
    expect(decryptStoredChatJson(rotatedLegacy.value)).toEqual({ hidden: true });

    const rotatedPlaintext = reencryptStoredChatJson({ usage: { total_tokens: 42 } });
    expect(rotatedPlaintext.changed).toBe(true);
    expect(rotatedPlaintext.keySource).toBe("plaintext");
    expect(isEncryptedChatJson(rotatedPlaintext.value)).toBe(true);
    expect(decryptStoredChatJson(rotatedPlaintext.value)).toEqual({
      usage: { total_tokens: 42 },
    });
  });
});
