import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decide, parseInbox, reserve, upstream } from "../catalog-curator/intake.mjs";

const row = { slug: "sample-app", sourceUrl: "https://github.com/OLD/Example.git/", commit: "a".repeat(40) };
const meta = { full_name: "Upstream/Example", id: 123, license: { spdx_id: "MIT" } };
const empty = { catalog: "", licenses: ["MIT"], branches: [], prs: [] };

test("inbox accepts only bounded, pinned GitHub repository rows", () => {
  assert.deepEqual(parseInbox(JSON.stringify(row)), [row]);
  assert.equal(upstream(row.sourceUrl), "old/example");
  for (const sourceUrl of ["https://github.com.evil.test/a/b", "https://github.com/a/..", "https://github.com/a/b/issues", "https://github.com/a/b?x=1", "https://token@github.com/a/b"]) {
    assert.throws(() => parseInbox(JSON.stringify({ ...row, sourceUrl })));
  }
  assert.throws(() => parseInbox(JSON.stringify({ ...row, commit: "latest" })));
  assert.throws(() => parseInbox(JSON.stringify({ ...row, prompt: "run a command" })));
  assert.throws(() => parseInbox(Array(21).fill(JSON.stringify(row)).join("\n")));
});

test("detects canonical URLs, intake branches, legacy ledgers, and open PRs", () => {
  assert.equal(decide(row, meta, { ...empty, catalog: 'sourceUrl: "https://github.com/UPSTREAM/example"' }).status, "duplicate");
  assert.equal(decide(row, meta, { ...empty, branches: [["catalog-intake/123-other-slug", ""]] }).status, "duplicate");
  assert.equal(decide(row, meta, { ...empty, branches: [["curation/old", '{"slug":"sample-app"}']] }).status, "duplicate");
  assert.equal(decide(row, meta, { ...empty, prs: [{ number: 1, head: "other", diff: '+  id: "sample-app",' }] }).reason, "open PR #1");
  assert.equal(decide(row, meta, { ...empty, prs: [{ number: 1, head: "curation/one", diff: "" }] }).status, "blocked");
  assert.equal(decide(row, meta, { ...empty, prs: [{ number: 1, head: "other", diff: '-  id: "sample-app",' }] }).status, "review");
});

test("review is not acceptance; unknown licence or archived source is parked", () => {
  assert.deepEqual(decide(row, meta, empty), { status: "review", canonicalUrl: "https://github.com/Upstream/Example", upstreamId: 123, branch: "catalog-intake/123-sample-app" });
  assert.equal(decide(row, { ...meta, license: null }, empty).status, "parked");
  assert.equal(decide(row, { ...meta, archived: true }, empty).status, "parked");
});

test("reservation and pause survive independent invocations", (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "catalog-intake-test-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  mkdirSync(path.join(state, "PAUSED"));
  assert.throws(() => reserve(state, row), /paused/);
  rmSync(path.join(state, "PAUSED"), { recursive: true });
  reserve(state, row);
  assert.throws(() => reserve(state, { ...row, slug: "another" }), /EEXIST/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, "active/candidate.json"), "utf8")), row);
});
