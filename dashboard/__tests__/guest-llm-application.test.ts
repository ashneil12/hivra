import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

type Receipt = { protocol: string; stateDigest: string; operationId: string | null; payloadDigest: string | null; provider: string | null; model: string | null };
const load = createRequire(__filename);
const { createLlmApplicationStore, PROTOCOL } = load("../provisioner/hivra-chat/llm-application.js") as {
  PROTOCOL: string;
  createLlmApplicationStore: (options: { directory: string; apiToken: string; runtime: string; io?: typeof fs }) => {
    inspect: () => Receipt; apply: (input: unknown) => Receipt; applyLegacy: (input: unknown) => Receipt;
  };
};
const token = "a".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const setting = { provider: "venice", baseUrl: "https://api.venice.ai/api/v1", apiKey: "fixture-private-model-key", model: "fixture-model" };
let root: string, directory: string, file: string;
let store: ReturnType<typeof createLlmApplicationStore>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hivra-llm-application-test-"));
  directory = path.join(root, ".hivra"); file = path.join(directory, "llm-provider.json");
  store = createLlmApplicationStore({ directory, apiToken: token, runtime: "codex" });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const request = (state: Receipt, payload: unknown = setting, operationId = id) => ({
  protocol: PROTOCOL, operationId, expectedStateDigest: state.stateDigest, payload,
});

it("durably applies a setting and recovers its key-free receipt in a new store instance", () => {
  const original = store.inspect();
  expect(original).toMatchObject({ operationId: null, provider: null, payloadDigest: null });
  const applied = store.apply(request(original));
  expect(applied).toMatchObject({ protocol: PROTOCOL, operationId: id, provider: "venice", model: "fixture-model" });
  expect(applied.stateDigest).not.toBe(original.stateDigest);
  expect(JSON.stringify(applied)).not.toContain(setting.apiKey);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject(setting);
  const restarted = createLlmApplicationStore({ directory, apiToken: token, runtime: "codex" });
  expect(restarted.inspect()).toEqual(applied);
  expect(fs.readdirSync(directory)).toEqual(["llm-provider.json"]);
});

it("replays the exact original request without another write and rejects altered reuse", () => {
  const input = request(store.inspect());
  const applied = store.apply(input), inode = fs.statSync(file).ino;
  expect(store.apply(input)).toEqual(applied);
  expect(fs.statSync(file).ino).toBe(inode);
  expect(() => store.apply({ ...input, payload: { ...setting, apiKey: "different-fixture-key" } })).toThrow("operation_conflict");
  expect(() => store.apply({ ...input, expectedStateDigest: applied.stateDigest })).toThrow("operation_conflict");
  expect(store.inspect()).toEqual(applied);
});

it("keeps a durable clear receipt and rejects an older operation after another change", () => {
  const first = request(store.inspect()), applied = store.apply(first);
  const clear = request(applied, null, nextId), cleared = store.apply(clear);
  expect(cleared).toMatchObject({ operationId: nextId, provider: null, model: null });
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ provider: null });
  expect(fs.readFileSync(file, "utf8")).not.toContain(setting.apiKey);
  expect(store.apply(clear)).toEqual(cleared);
  expect(() => store.apply(first)).toThrow("state_conflict");
  expect(store.inspect()).toEqual(cleared);
});

it("preserves existing legacy settings until an explicit, current-state-bound change", () => {
  fs.mkdirSync(directory, { mode: 0o700 });
  const legacy = JSON.stringify({ ...setting, model: "" }) + "\n";
  fs.writeFileSync(file, legacy, { mode: 0o600 });
  const observed = store.inspect();
  expect(observed).toMatchObject({ operationId: null, provider: "venice", model: null });
  expect(fs.readFileSync(file, "utf8")).toBe(legacy);
  store.apply(request(observed));
  expect(store.inspect()).toMatchObject({ operationId: id, model: "fixture-model" });
});

it.each([
  null, [], {}, "{", { provider: "venice" },
  { protocol: PROTOCOL, operationId: id, expectedStateDigest: "bad", payload: null },
])("rejects malformed request %j without touching the active file", input => {
  store.apply(request(store.inspect()));
  const before = fs.readFileSync(file, "utf8");
  expect(() => store.apply(input)).toThrow("invalid_request");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it.each([
  { ...setting, provider: ["venice"] }, { ...setting, apiKey: "short" },
  { ...setting, apiKey: "fixture\nsecret" }, { ...setting, baseUrl: "https://user:password@example.test" },
  { ...setting, baseUrl: "https://example.test/?apiKey=fixture" }, { ...setting, model: "bad model" },
  { ...setting, extra: "unrecognized" }, {}, [],
])("rejects invalid payload without exposing raw keys", value => {
  const before = store.inspect();
  expect(() => store.apply(request(before, value))).toThrow("invalid_request");
  expect(store.inspect()).toEqual(before);
  expect(fs.existsSync(file)).toBe(false);
});

it("does not overwrite configuration changed outside the recorded operation", () => {
  store.apply(request(store.inspect()));
  const data = JSON.parse(fs.readFileSync(file, "utf8")); data.apiKey = "external-fixture-key";
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  const changed = fs.readFileSync(file, "utf8");
  expect(() => store.inspect()).toThrow("storage_unavailable");
  expect(() => store.apply({ protocol: PROTOCOL, operationId: nextId, expectedStateDigest: "b".repeat(64), payload: null })).toThrow("storage_unavailable");
  expect(fs.readFileSync(file, "utf8")).toBe(changed);
});

it("retains the previous credential after a partial temporary write and cleans up owned bytes", () => {
  const applied = store.apply(request(store.inspect())), before = fs.readFileSync(file, "utf8");
  const broken = createLlmApplicationStore({ directory, apiToken: token, runtime: "codex", io: {
    ...fs, writeFileSync: (fd, bytes) => {
      if (typeof fd !== "number" || !Buffer.isBuffer(bytes)) throw new Error("Unexpected fixture write");
      fs.writeSync(fd, bytes.subarray(0, 10)); throw new Error(setting.apiKey);
    },
  } });
  expect(() => broken.apply(request(applied, null, nextId))).toThrow("storage_unavailable");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(fs.readdirSync(directory)).toEqual(["llm-provider.json"]);
  expect(store.inspect()).toEqual(applied);
});

it("reports uncertain acknowledgement after rename, then recovers the same durable operation", () => {
  const original = store.inspect(), input = request(original);
  let renamed = false;
  const broken = createLlmApplicationStore({ directory, apiToken: token, runtime: "codex", io: {
    ...fs, renameSync: (oldPath, newPath) => { fs.renameSync(oldPath, newPath); renamed = true; },
    fsyncSync: fd => { if (renamed && fs.fstatSync(fd).isDirectory()) throw new Error("fixture fsync failure"); fs.fsyncSync(fd); },
  } });
  expect(() => broken.apply(input)).toThrow("outcome_unknown");
  const observed = store.inspect();
  expect(observed.operationId).toBe(id);
  expect(store.apply(input)).toEqual(observed);
  expect(fs.readdirSync(directory)).toEqual(["llm-provider.json"]);
});

it.each(["symlink", "hardlink", "world-readable", "oversized", "invalid-json"])("fails closed on an unsafe %s settings file", kind => {
  fs.mkdirSync(directory, { mode: 0o700 });
  const other = path.join(root, "other.json");
  fs.writeFileSync(other, JSON.stringify(setting), { mode: 0o600 });
  if (kind === "symlink") fs.symlinkSync(other, file);
  else if (kind === "hardlink") fs.linkSync(other, file);
  else fs.writeFileSync(file, kind === "oversized" ? "x".repeat(16385) : kind === "invalid-json" ? "{" : JSON.stringify(setting), { mode: 0o600 });
  if (kind === "world-readable") fs.chmodSync(file, 0o644);
  expect(() => store.inspect()).toThrow("storage_unavailable");
  expect(fs.readFileSync(other, "utf8")).toBe(JSON.stringify(setting));
});

it("does not create storage for unsupported runtimes or reuse a different computer's MAC", () => {
  const unsupported = createLlmApplicationStore({ directory, apiToken: token, runtime: "openclaw" });
  expect(() => unsupported.inspect()).toThrow("unsupported_runtime");
  expect(fs.existsSync(directory)).toBe(false);
  store.apply(request(store.inspect()));
  const other = createLlmApplicationStore({ directory, apiToken: "b".repeat(64), runtime: "codex" });
  expect(() => other.inspect()).toThrow("storage_unavailable");
});

it("reads the complete bounded record even when filesystem reads are partial", () => {
  const applied = store.apply(request(store.inspect()));
  const partial = createLlmApplicationStore({ directory, apiToken: token, runtime: "codex", io: {
    ...fs, readSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      fs.readSync(fd, buffer, offset, Math.min(length, 3), position)) as typeof fs.readSync,
  } });
  expect(partial.inspect()).toEqual(applied);
  expect(() => partial.apply(request(applied, null, nextId))).not.toThrow();
});

it.each([false, true])("syncs the settings directory's parent, including interrupted creation recovery (%s)", exists => {
  if (exists) fs.mkdirSync(directory, { mode: 0o700 });
  let parentSynced = false;
  const parent = fs.statSync(root);
  const observed = createLlmApplicationStore({ directory, apiToken: token, runtime: "codex", io: {
    ...fs, fsyncSync: fd => {
      const info = fs.fstatSync(fd);
      if (info.dev === parent.dev && info.ino === parent.ino) parentSynced = true;
      fs.fsyncSync(fd);
    },
  } });
  observed.inspect();
  expect(parentSynced).toBe(true);
});

it("authenticates the operation's prior-state binding as well as its payload", () => {
  const input = request(store.inspect()); store.apply(input);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record._hivraApplication.previousStateDigest = "b".repeat(64);
  fs.writeFileSync(file, JSON.stringify(record));
  expect(() => store.inspect()).toThrow("storage_unavailable");
  expect(() => store.apply(input)).toThrow("storage_unavailable");
});

it("does not overwrite an intervening legacy edit observed before rename", () => {
  const before = store.inspect();
  const external = JSON.stringify({ ...setting, apiKey: "external-fixture-key" });
  const edited = createLlmApplicationStore({ directory, apiToken: token, runtime: "codex", io: {
    ...fs, writeFileSync: (fd, bytes) => {
      if (typeof fd !== "number" || !Buffer.isBuffer(bytes)) throw new Error("Unexpected fixture write");
      fs.writeFileSync(fd, bytes);
      fs.writeFileSync(file, external, { mode: 0o600 });
    },
  } });
  expect(() => edited.apply(request(before))).toThrow("state_conflict");
  expect(fs.readFileSync(file, "utf8")).toBe(external);
  expect(fs.readdirSync(directory)).toEqual(["llm-provider.json"]);
});

it("recovers an actual process interruption without leaving the pending key after clear", () => {
  const applied = store.apply(request(store.inspect()));
  const result = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs");
    const { createLlmApplicationStore } = require(${JSON.stringify(path.resolve(__dirname, "../provisioner/hivra-chat/llm-application.js"))});
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    createLlmApplicationStore({ ...input.options, io: { ...fs, renameSync() { process.exit(77); } } }).apply(input.request);
  `], { env: { NODE_ENV: "test" }, timeout: 5000, encoding: "utf8", input: JSON.stringify({
    options: { directory, apiToken: token, runtime: "codex" },
    request: request(applied, { ...setting, apiKey: "interrupted-fixture-key" }, nextId),
  }) });
  expect(result.status).toBe(77);
  expect(fs.readdirSync(directory).filter(name => name.startsWith(".llm-provider.json.pending-")).length).toBe(1);
  expect(store.inspect()).toEqual(applied);
  store.apply(request(applied, null, nextId));
  expect(fs.readdirSync(directory)).toEqual(["llm-provider.json"]);
  expect(fs.readFileSync(file, "utf8")).not.toContain("fixture-key");
});

it("does not report a receipt while interrupted credential cleanup fails", () => {
  const applied = store.apply(request(store.inspect()));
  const temporary = path.join(directory, ".llm-provider.json.pending-" + nextId);
  fs.writeFileSync(temporary, "interrupted-fixture-key", { mode: 0o600 });
  const stuck = createLlmApplicationStore({ directory, apiToken: token, runtime: "codex", io: {
    ...fs, unlinkSync: () => { throw new Error("private path and fixture key must not leak"); },
  } });
  expect(() => stuck.inspect()).toThrow("storage_unavailable");
  expect(() => stuck.apply(request(applied, null, nextId))).toThrow("storage_unavailable");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject(setting);
  expect(store.inspect()).toEqual(applied);
  expect(fs.existsSync(temporary)).toBe(false);
});

it("bounds interrupted-write cleanup and preserves unrelated or unsafe files", () => {
  store.inspect();
  const unrelated = path.join(directory, ".llm-provider.json.pending-not-a-uuid");
  fs.writeFileSync(unrelated, "owner data", { mode: 0o600 });
  const unsafe = path.join(directory, ".llm-provider.json.pending-" + id);
  fs.symlinkSync(unrelated, unsafe);
  expect(() => store.inspect()).toThrow("storage_unavailable");
  expect(fs.readFileSync(unrelated, "utf8")).toBe("owner data");
  fs.unlinkSync(unsafe);
  for (let i = 0; i < 1025; i++) fs.writeFileSync(path.join(directory, `unrelated-${i}`), "");
  expect(() => store.inspect()).toThrow("storage_unavailable");
  expect(fs.readFileSync(unrelated, "utf8")).toBe("owner data");
});

it("makes legacy writes atomic and refuses them after operation-protocol adoption", () => {
  store.applyLegacy(setting); store.applyLegacy(null); store.applyLegacy(setting);
  expect(store.inspect().operationId).toBe(null);
  const applied = store.apply(request(store.inspect()));
  expect(() => store.applyLegacy(null)).toThrow("application_protocol_required");
  expect(store.inspect()).toEqual(applied);
});
