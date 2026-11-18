import {
  AGE_IDENTITY_RE,
  AGE_RECIPIENT_RE,
  backupEncryptionEnvPrefix,
  buildAgeIdentityPrelude,
  isAgeEncryptedPath,
  resolveAgeIdentity,
  resolveBackupEncryption,
} from "../backup-encryption";
import { isValidColdArchiveUri, manifestPathFromArchiveUri, parseColdStorageManifest } from "../manifest";

// Obviously fake, shape-valid placeholders. Never real keys.
const FAKE_RECIPIENT = `age1${"q".repeat(58)}`;
const FAKE_IDENTITY = ["AGE-SECRET-KEY-1", "Q".repeat(58)].join("");
const ID = "00000000-0000-4000-8000-000000000216";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("resolveBackupEncryption", () => {
  it.each([[undefined], [""], ["off"], ["0"], ["false"], ["no"], ["  OFF "]])("is off for %p", (v) => {
    expect(resolveBackupEncryption({ HERMES_BACKUP_ENCRYPTION: v })).toEqual({ enabled: false });
  });

  it("is off when nothing is set, even if a recipient is", () => {
    expect(resolveBackupEncryption({ HERMES_BACKUP_AGE_RECIPIENT: FAKE_RECIPIENT })).toEqual({ enabled: false });
  });

  it("is on with a valid recipient", () => {
    expect(
      resolveBackupEncryption({ HERMES_BACKUP_ENCRYPTION: "on", HERMES_BACKUP_AGE_RECIPIENT: ` ${FAKE_RECIPIENT}\n` })
    ).toEqual({ enabled: true, ok: true, recipient: FAKE_RECIPIENT });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["wrong prefix", `age2${"q".repeat(58)}`],
    ["too short", `age1${"q".repeat(57)}`],
    ["too long", `age1${"q".repeat(59)}`],
    ["upper case", `age1${"Q".repeat(58)}`],
    ["secret key", FAKE_IDENTITY],
    ["shell metacharacters", `age1${"q".repeat(50)}; rm -rf /`],
    ["newline injection", `${FAKE_RECIPIENT}\nHERMES_X=1`],
  ])("refuses (never plaintext) when on and the recipient is %s", (_n, recipient) => {
    const r = resolveBackupEncryption({ HERMES_BACKUP_ENCRYPTION: "on", HERMES_BACKUP_AGE_RECIPIENT: recipient });
    expect(r.enabled).toBe(true);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("HERMES_BACKUP_AGE_RECIPIENT");
    expect(backupEncryptionEnvPrefix(r)).toBe("");
  });

  it("treats an unrecognised switch value as misconfigured, not as off", () => {
    const r = resolveBackupEncryption({ HERMES_BACKUP_ENCRYPTION: "onn", HERMES_BACKUP_AGE_RECIPIENT: FAKE_RECIPIENT });
    expect(r).toMatchObject({ enabled: true, ok: false });
  });
});

describe("backupEncryptionEnvPrefix", () => {
  it("is empty when off so commands stay byte-identical", () => {
    expect(backupEncryptionEnvPrefix({ enabled: false })).toBe("");
  });
  it("carries only the public recipient", () => {
    const prefix = backupEncryptionEnvPrefix({ enabled: true, ok: true, recipient: FAKE_RECIPIENT });
    expect(prefix).toBe(`HERMES_BACKUP_ENCRYPTION=on HERMES_BACKUP_AGE_RECIPIENT=${FAKE_RECIPIENT} `);
    expect(prefix).not.toContain("SECRET");
  });
});

describe("resolveAgeIdentity", () => {
  it("accepts a well-formed identity", () => {
    expect(resolveAgeIdentity({ HERMES_BACKUP_AGE_IDENTITY: `${FAKE_IDENTITY}\n` })).toEqual({
      present: true,
      identity: FAKE_IDENTITY,
    });
  });
  it("reports a clear reason when missing", () => {
    const r = resolveAgeIdentity({});
    expect(r.present).toBe(false);
    expect((r as { error: string }).error).toContain("HERMES_BACKUP_AGE_IDENTITY is not configured");
  });
  it.each([["garbage"], [FAKE_RECIPIENT], [`${FAKE_IDENTITY}\nextra`], [`${FAKE_IDENTITY}EOF`.toLowerCase()]])(
    "rejects a malformed identity (%#)",
    (v) => {
      expect(resolveAgeIdentity({ HERMES_BACKUP_AGE_IDENTITY: v }).present).toBe(false);
    }
  );
  it("never echoes the malformed value in its error", () => {
    const bad = "AGE-SECRET-KEY-1-not-valid";
    const r = resolveAgeIdentity({ HERMES_BACKUP_AGE_IDENTITY: bad });
    expect(JSON.stringify(r)).not.toContain(bad);
  });
  it("regexes match the shapes age-keygen emits", () => {
    expect(AGE_RECIPIENT_RE.test(FAKE_RECIPIENT)).toBe(true);
    expect(AGE_IDENTITY_RE.test(FAKE_IDENTITY)).toBe(true);
  });
});

describe("buildAgeIdentityPrelude", () => {
  it("puts the identity only inside a quoted heredoc, with a 0600 mktemp file and an EXIT trap", () => {
    const script = buildAgeIdentityPrelude(FAKE_IDENTITY);
    expect(script).toContain(`<<'HERMES_BACKUP_AGE_IDENTITY_EOF'\n${FAKE_IDENTITY}\nHERMES_BACKUP_AGE_IDENTITY_EOF`);
    expect(script).toContain("mktemp");
    expect(script).toContain('chmod 0600 "$__age_id_file"');
    expect(script).toContain(`trap 'rm -f -- "$__age_id_file"' EXIT`);
    expect(script).toContain('export HERMES_BACKUP_AGE_IDENTITY_FILE="$__age_id_file"');
    // the secret appears exactly once: never in an assignment, argv or export
    expect(script.split(FAKE_IDENTITY)).toHaveLength(2);
  });
  it("can leave removal to a detached job", () => {
    expect(buildAgeIdentityPrelude(FAKE_IDENTITY, { removeOnExit: false })).not.toContain("trap");
  });
  it("refuses a value that could break out of the heredoc", () => {
    expect(() => buildAgeIdentityPrelude(`${FAKE_IDENTITY}\nHERMES_BACKUP_AGE_IDENTITY_EOF\nrm -rf /`)).toThrow();
  });
});

describe("encrypted archive paths and manifests", () => {
  const plainUri = `free/${ID}/data-20260516T102940Z.tar.zst`;
  const ageUri = `${plainUri}.age`;

  it("isAgeEncryptedPath keys on the .age suffix", () => {
    expect(isAgeEncryptedPath(ageUri)).toBe(true);
    expect(isAgeEncryptedPath(plainUri)).toBe(false);
  });

  it("accepts the .age archive uri and derives the same manifest path", () => {
    expect(isValidColdArchiveUri(ageUri)).toBe(true);
    expect(manifestPathFromArchiveUri(ageUri)).toBe(`meta/${ID}/20260516T102940Z.json`);
    expect(manifestPathFromArchiveUri(plainUri)).toBe(`meta/${ID}/20260516T102940Z.json`);
  });

  it.each([`${ageUri}.age`, `${ageUri};id`, `${plainUri}.age.zst`, `${plainUri}.agex`])("still rejects %s", (u) => {
    expect(isValidColdArchiveUri(u)).toBe(false);
  });

  const base = {
    schema_version: 1,
    archived_at: "2026-05-16T10:29:40Z",
    vmid: 216,
    pve_host: "fixturenode2",
    instance_id: ID,
    archive_size_bytes: 10,
    archive_sha256: SHA_A,
    tier: "free",
  };

  it("parses a plain manifest exactly as before", () => {
    const m = parseColdStorageManifest(JSON.stringify({ ...base, archive_path: plainUri }), "m");
    expect(m.archiveUri).toBe(plainUri);
    expect(m).not.toHaveProperty("encryption");
    expect(m).not.toHaveProperty("plainSha256");
  });

  it("parses an encrypted manifest with plain_sha256", () => {
    const m = parseColdStorageManifest(
      JSON.stringify({ ...base, archive_path: ageUri, encryption: "age", plain_sha256: SHA_B }),
      "m"
    );
    expect(m).toMatchObject({ archiveUri: ageUri, archiveSha256: SHA_A, encryption: "age", plainSha256: SHA_B });
  });

  it.each([
    ["unknown encryption", { archive_path: ageUri, encryption: "gpg", plain_sha256: SHA_B }],
    ["missing plain_sha256", { archive_path: ageUri, encryption: "age" }],
    ["malformed plain_sha256", { archive_path: ageUri, encryption: "age", plain_sha256: "nope" }],
    ["plain_sha256 without encryption", { archive_path: plainUri, plain_sha256: SHA_B }],
    ["encryption but plain name", { archive_path: plainUri, encryption: "age", plain_sha256: SHA_B }],
    [".age name but no encryption", { archive_path: ageUri }],
  ])("rejects %s", (_n, extra) => {
    expect(() => parseColdStorageManifest(JSON.stringify({ ...base, ...extra }), "m")).toThrow(/Invalid cold-storage manifest/);
  });
});
