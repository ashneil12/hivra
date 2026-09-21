import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, linkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateStorageTarget, withQuiescedStorage } from "./hivra-self-host-storage.mjs";

const helper = fileURLToPath(new URL("./hivra-storage-snapshot.cjs", import.meta.url));
function run(mode, root, input) { return spawnSync(process.execPath, [helper, mode, root], { input, maxBuffer: 2 * 1024 * 1024 }); }
test("round-trips private nested files, empty files, Unicode and multiple streaming chunks", t => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hivra-storage-proof-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, "source"), target = path.join(base, "target");
  mkdirSync(source); mkdirSync(target); mkdirSync(path.join(source, "stub")); mkdirSync(path.join(source, "stub", "private"));
  const bytes = randomBytes(131_073);
  writeFileSync(path.join(source, "stub", "private", "你好.bin"), bytes);
  writeFileSync(path.join(source, "empty"), "");
  const packed = run("pack", source);
  assert.equal(packed.status, 0, packed.stderr.toString());
  const restored = run("unpack", target, packed.stdout);
  assert.equal(restored.status, 0, restored.stderr.toString());
  assert.deepEqual(readFileSync(path.join(target, "stub", "private", "你好.bin")), bytes);
  assert.equal(readFileSync(path.join(target, "empty")).length, 0);
  assert.notEqual(run("unpack", target, packed.stdout).status, 0, "Never overwrite a nonempty target");
});

test("accepts only the empty stub directory created by the pinned storage service", t => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hivra-storage-bootstrap-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, "source"), target = path.join(base, "target");
  mkdirSync(source); mkdirSync(target);
  mkdirSync(path.join(source, "stub")); mkdirSync(path.join(target, "stub"));
  writeFileSync(path.join(source, "stub", "proof"), "restored file");
  const packed = run("pack", source);
  assert.equal(packed.status, 0);
  assert.equal(run("unpack", target, packed.stdout).status, 0);
  assert.equal(readFileSync(path.join(target, "stub", "proof"), "utf8"), "restored file");
  assert.notEqual(run("unpack", target, packed.stdout).status, 0, "Existing uploaded data is never overwritten");
  for (const [index, kind] of ["file", "nested-directory", "symlink", "unexpected-directory"].entries()) {
    const root = path.join(base, `reject-${index}`); mkdirSync(root);
    if (kind === "symlink") symlinkSync(path.join(source, "stub"), path.join(root, "stub"));
    else if (kind === "file") writeFileSync(path.join(root, "stub"), "keep");
    else mkdirSync(path.join(root, kind === "unexpected-directory" ? "other" : "stub"));
    if (kind === "nested-directory") mkdirSync(path.join(root, "stub", "retained"));
    const rejected = run("unpack", root, packed.stdout);
    assert.notEqual(rejected.status, 0, kind);
    assert.match(rejected.stderr.toString(), /HIVRA_STORAGE_TARGET_NOT_EMPTY/);
  }
});

test("rejects traversal, malformed streams, forged digests and trailing records", t => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hivra-storage-negative-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const header = { format: "hivra-storage-files-v1" };
  const streams = [
    [header, { type: "directory", path: "../escape" }],
    [header, { type: "file", path: "/escape", bytes: 1 }],
    [header, { type: "file", path: "data", bytes: 1 }, { type: "chunk", data: "eA==" }, { type: "file-end", sha256: "0".repeat(64) }],
    [header, { type: "file", path: "data", bytes: 0 }, { type: "chunk", data: "eA==" }],
    [header, { type: "end", entries: 0, files: 0, bytes: 0 }, { type: "directory", path: "late" }],
    [header, { type: "directory", path: "stub" }, { type: "directory", path: "stub" }],
    [header],
  ];
  for (const [index, stream] of streams.entries()) {
    const target = path.join(base, String(index)); mkdirSync(target);
    assert.notEqual(run("unpack", target, stream.map(x => JSON.stringify(x)).join("\n") + "\n").status, 0);
  }
  assert.ok(!readdirSync(path.dirname(base)).includes("escape"));
});

test("does not read through symlinks or hardlinks in the source volume", t => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hivra-storage-links-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(path.join(base, "original"), "unlogged fixture");
  const symlinks = path.join(base, "symlinks"), hardlinks = path.join(base, "hardlinks");
  mkdirSync(symlinks); mkdirSync(hardlinks);
  symlinkSync(path.join(base, "original"), path.join(symlinks, "link"));
  linkSync(path.join(base, "original"), path.join(hardlinks, "link"));
  assert.notEqual(run("pack", symlinks).status, 0);
  assert.notEqual(run("pack", hardlinks).status, 0);
});

test("volume access requires the exact local project, image, file backend and mount", () => {
  const project = "hivra-0123456789";
  const valid = { id: "a".repeat(64), image: `sha256:${"b".repeat(64)}`, user: "", running: true, fileBackend: true, localTenant: true, mountedFilePath: true,
    labels: { "com.supabase.cli.project": project }, mounts: [{ Type: "volume", Name: `supabase_storage_${project}`, Destination: "/mnt" }] };
  assert.equal(validateStorageTarget(valid, project).volume, `supabase_storage_${project}`);
  for (const override of [{ labels: {} }, { fileBackend: false }, { image: "latest" }, { localTenant: false }, { mountedFilePath: false }, { mounts: [{ ...valid.mounts[0], Type: "bind" }] }, { mounts: [{ ...valid.mounts[0], Name: "other" }] }]) {
    assert.throws(() => validateStorageTarget({ ...valid, ...override }, project), /identity or backend/);
  }
});

test("a failed snapshot action restarts only its previously running storage service", async t => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hivra-storage-quiesce-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const docker = path.join(base, "docker"), journal = path.join(base, "commands.jsonl"), state = path.join(base, "running");
  const project = "hivra-0123456789", id = "a".repeat(64);
  const fixture = { id, image: `sha256:${"b".repeat(64)}`, user: "", running: true,
    fileBackend: true, localTenant: true, mountedFilePath: true, labels: { "com.supabase.cli.project": project },
    mounts: [{ Type: "volume", Name: `supabase_storage_${project}`, Destination: "/mnt" }] };
  writeFileSync(state, "true");
  writeFileSync(docker, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), state = ${JSON.stringify(state)};
fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(args) + "\\n");
if (args[0] === "stop") fs.writeFileSync(state, "false");
else if (args[0] === "start") fs.writeFileSync(state, "true");
else if (args[2] === "{{.State.Running}}") console.log(fs.readFileSync(state, "utf8"));
else if (args[2] === "{{.State.Health.Status}}") console.log("healthy");
else console.log(JSON.stringify(${JSON.stringify(fixture)}));
`, { mode: 0o700 });
  await assert.rejects(withQuiescedStorage(docker, project, async target => {
    assert.equal(target.id, id);
    assert.equal(readFileSync(state, "utf8"), "false");
    throw new Error("synthetic snapshot failure");
  }), /synthetic snapshot failure/);
  assert.equal(readFileSync(state, "utf8"), "true");
  const mutations = readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse).filter(args => ["stop", "start"].includes(args[0]));
  assert.deepEqual(mutations, [["stop", "--timeout", "30", id], ["start", id]]);
});

for (const scenario of ["applied-stop", "rejected-stop", "inspect-failed", "restart-failed", "initially-stopped"]) {
  test(`storage reconciles ${scenario} without replaying snapshot work`, async t => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hivra-storage-reconcile-")));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const docker = path.join(base, "docker"), state = path.join(base, "running"), journal = path.join(base, "commands");
    const project = "hivra-0123456789", id = "a".repeat(64);
    const fixture = { id, image: `sha256:${"b".repeat(64)}`, user: "", running: scenario !== "initially-stopped",
      fileBackend: true, localTenant: true, mountedFilePath: true, labels: { "com.supabase.cli.project": project },
      mounts: [{ Type: "volume", Name: `supabase_storage_${project}`, Destination: "/mnt" }] };
    writeFileSync(state, String(fixture.running));
    writeFileSync(docker, `#!${process.execPath}
const fs = require("node:fs"), args = process.argv.slice(2);
const state = ${JSON.stringify(state)}, scenario = ${JSON.stringify(scenario)};
fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(args) + "\\n");
if (args[0] === "stop") {
  if (scenario !== "rejected-stop") fs.writeFileSync(state, "false");
  console.error("private-daemon-detail-must-not-leak"); process.exit(1);
} else if (args[0] === "start") {
  if (scenario === "restart-failed") process.exit(1);
  fs.writeFileSync(state, "true");
} else if (args[2] === "{{.State.Running}}") {
  if (scenario === "inspect-failed") process.exit(1);
  console.log(fs.readFileSync(state, "utf8"));
} else if (args[2] === "{{.State.Health.Status}}") console.log("healthy");
else console.log(JSON.stringify(${JSON.stringify(fixture)}));
`, { mode: 0o700 });
    let calls = 0;
    const result = withQuiescedStorage(docker, project, async () => { calls += 1; return "captured"; });
    if (scenario === "initially-stopped") assert.equal(await result, "captured");
    else await assert.rejects(result, error => {
      assert.doesNotMatch(error.message, /private-daemon/);
      if (["inspect-failed", "restart-failed"].includes(scenario)) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2, "retain the operation and reconciliation errors");
      }
      return true;
    });
    assert.equal(calls, scenario === "initially-stopped" ? 1 : 0);
    assert.equal(readFileSync(state, "utf8"), ["applied-stop", "rejected-stop"].includes(scenario) ? "true" : "false");
    const commands = readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse);
    const starts = commands.filter(args => args[0] === "start");
    assert.deepEqual(starts, ["applied-stop", "restart-failed"].includes(scenario) ? [["start", id]] : []);
    if (scenario === "initially-stopped") assert.equal(commands.some(args => args[0] === "stop"), false);
  });
}
