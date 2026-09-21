import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createBackupManifest,
  databaseRestorePreamble,
  databaseRestorePsqlArgs,
  decryptBackupArchive,
  encryptBackupArchive,
  inspectExtractedBackup,
  resolveNewBackupPath,
  rejectIncompleteLegacyStorage,
  sha256File,
  validateBackupManifest,
} from "./hivra-self-host-backup.mjs";

function privateTemporaryDirectory() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hivra-backup-test-")));
  chmodSync(directory, 0o700);
  return directory;
}

test("streams an authenticated encrypted archive without exposing plaintext", async () => {
  const directory = privateTemporaryDirectory();
  try {
    const archive = path.join(directory, "payload.tar");
    const encrypted = path.join(directory, "backup.hivra");
    const restored = path.join(directory, "restored.tar");
    const plaintext = Buffer.from("operator secret\nprovider secret\n");
    writeFileSync(archive, plaintext, { mode: 0o600 });
    await encryptBackupArchive({ archive, output: encrypted, passphrase: "correct horse battery staple" });
    assert.equal(readFileSync(encrypted).includes(plaintext), false);
    await decryptBackupArchive({ input: encrypted, output: restored, passphrase: "correct horse battery staple" });
    assert.deepEqual(readFileSync(restored), plaintext);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a wrong passphrase and removes unauthenticated output", async () => {
  const directory = privateTemporaryDirectory();
  try {
    const archive = path.join(directory, "payload.tar");
    const encrypted = path.join(directory, "backup.hivra");
    const restored = path.join(directory, "restored.tar");
    writeFileSync(archive, "private data", { mode: 0o600 });
    await encryptBackupArchive({ archive, output: encrypted, passphrase: "correct horse battery staple" });
    await assert.rejects(
      decryptBackupArchive({ input: encrypted, output: restored, passphrase: "incorrect horse battery staple" }),
      /authentication failed/i,
    );
    assert.equal(existsSync(restored), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds every restored payload file to its authenticated manifest", async () => {
  const directory = privateTemporaryDirectory();
  try {
    const files = {};
    for (const [name, contents] of [
      ["dashboard.env", "A=\"value\"\n"],
      ["database.sql", "COPY public.example FROM stdin;\n\\.\n"],
      ["receipt.json", "{}\n"],
      ["storage.ndjson", '{"format":"hivra-storage-files-v1"}\n{"type":"end","entries":0,"files":0,"bytes":0}\n'],
    ]) {
      const target = path.join(directory, name);
      writeFileSync(target, contents, { mode: 0o600 });
      files[name] = await sha256File(target);
    }
    const manifest = createBackupManifest({
      sourceRevision: "a".repeat(40),
      stateReceipt: { createdAt: "2026-08-29T12:00:00.000Z" },
      files,
      createdAt: "2026-08-29T13:00:00.000Z",
    });
    assert.deepEqual(validateBackupManifest(manifest), manifest);
    assert.equal(manifest.format, "hivra-self-host-backup-payload-v2");
    const withoutStorage = { ...files };
    delete withoutStorage["storage.ndjson"];
    assert.throws(() => validateBackupManifest({ ...manifest, files: withoutStorage }), /storage.ndjson/i);
    assert.throws(() => validateBackupManifest({ ...manifest, files: { ...files, "database.sql": { ...files["database.sql"], bytes: -1 } } }), /database.sql/i);
    assert.throws(() => validateBackupManifest({ ...manifest, installationCreatedAt: "not-a-date" }), /manifest/i);
    writeFileSync(path.join(directory, "backup.json"), JSON.stringify(manifest), { mode: 0o600 });
    assert.deepEqual(await inspectExtractedBackup(directory), manifest);
    writeFileSync(path.join(directory, "storage.ndjson"), "tampered bytes", { mode: 0o600 });
    await assert.rejects(inspectExtractedBackup(directory), /storage.ndjson/i);
    rmSync(path.join(directory, "storage.ndjson"));
    const legacy = createBackupManifest({ sourceRevision: "a".repeat(40), stateReceipt: { createdAt: manifest.installationCreatedAt },
      files: withoutStorage, createdAt: manifest.createdAt, format: "hivra-self-host-backup-payload-v1" });
    writeFileSync(path.join(directory, "backup.json"), JSON.stringify(legacy), { mode: 0o600 });
    assert.deepEqual(await inspectExtractedBackup(directory), legacy);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy backups remain readable only when they do not promise missing uploaded files", async () => {
  const directory = privateTemporaryDirectory();
  try {
    const sql = path.join(directory, "database.sql");
    const manifest = { format: "hivra-self-host-backup-payload-v1" };
    writeFileSync(sql, 'COPY "storage"."objects" ("id") FROM stdin;\n\\.\n');
    await rejectIncompleteLegacyStorage(manifest, sql);
    writeFileSync(sql, 'COPY "storage"."objects" ("id") FROM stdin;\nobject-1\n\\.\n');
    await assert.rejects(rejectIncompleteLegacyStorage(manifest, sql), /no file bytes/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("prepares a full replacement restore for exactly the dumped local schemas", async () => {
  const directory = privateTemporaryDirectory();
  try {
    const sql = path.join(directory, "database.sql");
    writeFileSync(sql, [
      'COPY "public"."proxmox_hosts" ("id") FROM stdin;',
      'COPY "auth"."users" ("id") FROM stdin;',
      'COPY "public"."proxmox_hosts" ("id") FROM stdin;',
      "",
    ].join("\n"), { mode: 0o600 });
    assert.equal(
      await databaseRestorePreamble(sql),
      'SET session_replication_role = replica;\nTRUNCATE TABLE "auth"."users", "public"."proxmox_hosts" RESTART IDENTITY CASCADE;\n',
    );
    writeFileSync(sql, 'COPY "private"."secrets" ("id") FROM stdin;\n', { mode: 0o600 });
    await assert.rejects(databaseRestorePreamble(sql), /unsupported COPY target/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restores through the local Supabase superuser instead of the restricted postgres role", () => {
  const args = databaseRestorePsqlArgs("hivra-0123456789");
  assert.deepEqual(args, [
    "exec", "-i", "supabase_db_hivra-0123456789",
    "psql", "--username", "supabase_admin", "--dbname", "postgres", "--set=ON_ERROR_STOP=on",
  ]);
  assert.equal(args.includes("postgres") && args[args.indexOf("--username") + 1] === "postgres", false);
  assert.throws(() => databaseRestorePsqlArgs("production"), /identity is invalid/i);
});

test("requires a new backup outside source and state in an owner-only directory", () => {
  const directory = privateTemporaryDirectory();
  const repositoryRoot = path.join(directory, "repo");
  const stateDirectory = path.join(directory, "state");
  const backupDirectory = path.join(directory, "backups");
  for (const target of [repositoryRoot, stateDirectory, backupDirectory]) {
    mkdirSync(target, { mode: 0o700 });
  }
  try {
    assert.equal(
      resolveNewBackupPath(path.join(backupDirectory, "operator.hivra"), { repositoryRoot, stateDirectory }),
      path.join(realpathSync(backupDirectory), "operator.hivra"),
    );
    assert.throws(
      () => resolveNewBackupPath(path.join(stateDirectory, "operator.hivra"), { repositoryRoot, stateDirectory }),
      /outside/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
