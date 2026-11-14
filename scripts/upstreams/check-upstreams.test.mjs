import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assess, compareTags, newestTag, run, format, LIST_PATH } from "./check-upstreams.mjs";

test("tags sort numerically and pre-releases sort below their release", () => {
  assert.ok(compareTags("v2.15", "v2.2") > 0);
  assert.ok(compareTags("rust-v0.167.2", "rust-v0.149.1") > 0);
  assert.ok(compareTags("v1.0.2-rc.3", "v1.0.2") < 0);
  assert.equal(newestTag(["v2.2", "v2.15", "v2.9", "v3.0-beta.1"], "^v\\d+\\.\\d+$"), "v2.15");
  assert.equal(newestTag(["rust-v0.149.1", "rust-v0.167.2", "rust-v.0.0.2504292006", "rust-v0.170.0-alpha.1"], "^rust-v\\d+\\.\\d+\\.\\d+$"), "rust-v0.167.2");
});

test("a pin behind the newest release is flagged, a current one is not", () => {
  const entry = { id: "x", repo: "o/x", role: "agent-runtime", pin: "2.1.292", watch: "tags", tagPattern: "^v\\d+\\.\\d+\\.\\d+$", checked: { head: "aaaa", latest: "v2.1.292" } };
  const behind = assess(entry, { head: "bbbbbbbb", tags: ["v2.1.292", "v2.1.322"] });
  assert.equal(behind.pinBehind, true);
  assert.equal(behind.newRelease, true);
  assert.equal(behind.headMoved, true);
  const current = assess({ ...entry, pin: "2.1.322", checked: { head: "bbbb", latest: "v2.1.322" } }, { head: "bbbbbbbb", tags: ["v2.1.322"] });
  assert.equal(current.pinBehind, false);
  assert.equal(current.newRelease, false);
  assert.equal(current.headMoved, false);
});

test("a commit pin is compared with the default branch", () => {
  const entry = { id: "bux", repo: "o/bux", role: "agent-runtime", pin: "f17c1b31d6688dd92e745ade650e00d46b4dc4da", watch: "head", checked: { head: "f17c1b31d6" } };
  assert.equal(assess(entry, { head: "f17c1b31d6688dd92e745ade650e00d46b4dc4da", tags: [] }).pinBehind, false);
  assert.equal(assess(entry, { head: "0000000000", tags: [] }).pinBehind, true);
});

test("run records today's state and reports unreachable repos without failing", async () => {
  const list = { repos: [
    { id: "a", repo: "o/a", role: "library", watch: "head", checked: { head: "old" } },
    { id: "b", repo: "o/b", role: "library", watch: "head", checked: { head: "same" } },
  ] };
  const { rows, updated } = await run({
    list,
    today: "2026-11-19",
    fetchRemote: async (repo) => {
      if (repo === "o/a") return { head: "new123", tags: [] };
      throw new Error("not found");
    },
  });
  assert.equal(updated.lastFullCheck, "2026-11-19");
  assert.equal(updated.repos[0].checked.head, "new123");
  assert.equal(updated.repos[1].checked.head, "same");
  const text = format(rows);
  assert.match(text, /2 of 2 upstream repositories need a look/);
  assert.match(text, /o\/b: could not reach it/);
});

test("the committed list is well formed", () => {
  const list = JSON.parse(readFileSync(LIST_PATH, "utf8"));
  const ids = new Set();
  for (const entry of list.repos) {
    assert.match(entry.repo, /^[\w.-]+\/[\w.-]+$/, entry.id);
    assert.ok(["ported-code", "library", "agent-runtime", "desktop-stack", "skills", "inspiration"].includes(entry.role), entry.id);
    assert.ok(entry.licence, `${entry.id} has a licence note`);
    assert.ok(!ids.has(entry.id), `${entry.id} is unique`);
    ids.add(entry.id);
    if (entry.tagPattern) new RegExp(entry.tagPattern);
  }
});
