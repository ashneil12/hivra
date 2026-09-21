import { encryptApiKey, decryptApiKey, formatKeyPreview } from "../crypto";

describe("Cryptography Module", () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = process.env;
        process.env = { ...originalEnv };
        // Generate a 32-byte mock key (64 hex characters)
        process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("encryptApiKey / decryptApiKey", () => {
        it("should encrypt and decrypt a string successfully", () => {
            const secret = "my-super-secret-api-key-123!";
            const ciphertext = encryptApiKey(secret);
            
            expect(ciphertext).toBeDefined();
            expect(ciphertext).not.toEqual(secret);
            
            const decrypted = decryptApiKey(ciphertext);
            expect(decrypted).toEqual(secret);
        });

        it("should throw an error if decrypting with a missing key", () => {
            const secret = "secret-data";
            const ciphertext = encryptApiKey(secret);
            
            delete process.env.ENCRYPTION_KEY;
            
            expect(() => decryptApiKey(ciphertext)).toThrow("ENCRYPTION_KEY env var not set");
        });

        it("should throw an error if the ENCRYPTION_KEY is the wrong size", () => {
            const secret = "secret-data";
            const ciphertext = encryptApiKey(secret);
            
            process.env.ENCRYPTION_KEY = "too-short";
            
            expect(() => decryptApiKey(ciphertext)).toThrow("ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
        });

        it("should throw an error if attempting to decrypt tampered cipher", () => {
            const secret = "secret-data";
            const ciphertext = encryptApiKey(secret);
            
            // Tamper with the ciphertext (assuming base64, modifying the last char)
            const tampered = ciphertext.slice(0, -1) + (ciphertext.endsWith("A") ? "B" : "A");

            expect(() => decryptApiKey(tampered)).toThrow();
        });
    });

    describe("formatKeyPreview", () => {
        it("formats long keys with prefix and suffix", () => {
            expect(formatKeyPreview("sk_live_1234567890abcdef")).toBe("sk_liv...cdef");
        });

        it("formats short keys safely", () => {
            expect(formatKeyPreview("123456")).toBe("1234...");
        });
    });
});
