import { decryptFolderRecovery, encryptFolderRecovery, FOLDER_RECOVERY_FORMAT,
  FOLDER_RECOVERY_MAX_BYTES, sha256FolderBytes, validateFolderRecoveryPayload, type FolderRecoveryPayload } from "../folder-recovery-artifact";

const secret = "correct horse battery folder";
function payload(bytes = Buffer.from([0, 255, 17, 128])): FolderRecoveryPayload {
  return { format: FOLDER_RECOVERY_FORMAT, scope: "/home/bux/Hivra",
    source: { agentId: "11111111-1111-4111-8111-111111111111", bindingHash: "a".repeat(64) },
    exportedAt: "2026-09-05T12:00:00Z", entries: [
      { path: "nested", kind: "directory" },
      { path: "nested/binary.bin", kind: "file", content: bytes.toString("base64"), sha256: sha256FolderBytes(bytes), executable: false },
    ] };
}

describe("encrypted Ubuntu Hivra-folder artifact", () => {
  it("roundtrips binary bytes, scope and source binding without plaintext in the artifact", async () => {
    const input = payload();
    const artifact = await encryptFolderRecovery(input, secret);
    expect(await decryptFolderRecovery(artifact, secret)).toEqual(input);
    expect(artifact.includes(Buffer.from("nested/binary.bin"))).toBe(false);
    expect(artifact.includes(Buffer.from(secret))).toBe(false);
    expect(await encryptFolderRecovery(input, secret)).not.toEqual(artifact);
  });
  it("authenticates the header and ciphertext, and rejects a wrong passphrase", async () => {
    const artifact = await encryptFolderRecovery(payload(), secret);
    await expect(decryptFolderRecovery(artifact, "wrong password entirely")).rejects.toThrow("incorrect");
    for (const offset of [16, 33, artifact.length - 1]) {
      const corrupt = Buffer.from(artifact); corrupt[offset] ^= 1;
      await expect(decryptFolderRecovery(corrupt, secret)).rejects.toThrow();
    }
  });
  it("handles the full 2 MiB binary limit and fails above it without truncation", async () => {
    const input = payload(Buffer.alloc(FOLDER_RECOVERY_MAX_BYTES, 128));
    const artifact = await encryptFolderRecovery(input, secret);
    expect(await decryptFolderRecovery(artifact, secret)).toEqual(input);
    expect(() => validateFolderRecoveryPayload(payload(Buffer.alloc(FOLDER_RECOVERY_MAX_BYTES + 1)))).toThrow();
  });
  it.each(["../secret", "/etc/passwd", "nested/../escape", "nested//file", "a\\b", "a\u0000b"])("rejects unsafe path %p", (path) => {
    const input = payload(); input.entries[1].path = path;
    expect(() => validateFolderRecoveryPayload(input)).toThrow();
  });
  it("rejects missing/file parents, duplicate paths, corrupted bytes and unsupported kinds", () => {
    const input = payload();
    expect(() => validateFolderRecoveryPayload({ ...input, entries: [input.entries[1]] })).toThrow();
    expect(() => validateFolderRecoveryPayload({ ...input, entries: [...input.entries, input.entries[1]] })).toThrow();
    expect(() => validateFolderRecoveryPayload({ ...input, entries: [{ ...input.entries[0], kind: "symlink" }] })).toThrow();
    const file = input.entries[1];
    expect(() => validateFolderRecoveryPayload({ ...input, entries: [input.entries[0], { ...file, content: "ZmFrZQ==" }] })).toThrow();
  });
  it("rejects a controller backup, excess entries and weak passphrases", async () => {
    const input = payload();
    expect(() => validateFolderRecoveryPayload({ ...input, format: "hivra-controller-v1" })).toThrow();
    expect(() => validateFolderRecoveryPayload({ ...input, entries: Array.from({ length: 513 }, (_, i) => ({ kind: "directory", path: String(i) })) })).toThrow();
    await expect(encryptFolderRecovery(input, "short")).rejects.toThrow("passphrase");
  });
});
