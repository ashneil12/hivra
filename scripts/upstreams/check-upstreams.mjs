#!/usr/bin/env node
// Weekly upstream check: for every repository in docs/upstreams/upstreams.json,
// report whether its default branch or its newest release tag moved since the
// last check, and whether Hivra's pin is behind. Uses `git ls-remote` only, so
// it needs no GitHub token and never runs upstream code.
//
//   node scripts/upstreams/check-upstreams.mjs            # print the report
//   node scripts/upstreams/check-upstreams.mjs --json     # machine-readable
//   node scripts/upstreams/check-upstreams.mjs --write    # also record today's state

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LIST_PATH = path.join(ROOT, "docs/upstreams/upstreams.json");

function lsRemote(args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["ls-remote", ...args], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

export async function gitRemote(repo) {
  const url = `https://github.com/${repo}.git`;
  const headOut = await lsRemote([url, "HEAD"]);
  const head = headOut.split(/\s+/)[0] || null;
  const tagsOut = await lsRemote(["--tags", "--refs", url]);
  const tags = tagsOut
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter(Boolean);
  return { head, tags };
}

/** Numeric-aware tag comparison; a pre-release suffix (-rc, -beta, -alpha) sorts below its release. */
export function compareTags(a, b) {
  const parts = (t) => {
    const [main, pre] = t.replace(/^[^\d]*/, "").split(/-(.*)/s);
    return { nums: main.split(/[.]/).map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true });
}

export function newestTag(tags, pattern) {
  const re = pattern ? new RegExp(pattern) : /\d/;
  const stable = tags.filter((t) => re.test(t) && !/(alpha|beta|rc|canary|nightly|dev)/i.test(t));
  return stable.sort(compareTags).at(-1) ?? null;
}

const sameRef = (a, b) => Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));

export function assess(entry, remote) {
  const latest = entry.watch === "tags" ? newestTag(remote.tags, entry.tagPattern) : null;
  const headMoved = entry.checked?.head ? !sameRef(remote.head, entry.checked.head) : remote.head !== null;
  const newRelease = latest !== null && latest !== (entry.checked?.latest ?? null);
  let pinBehind = null;
  if (entry.pin && latest && entry.watch === "tags" && /\d/.test(entry.pin) && !entry.pin.startsWith("sha256:")) {
    pinBehind = compareTags(entry.pin, latest) < 0;
  } else if (entry.pin && /^[0-9a-f]{7,40}$/.test(entry.pin) && remote.head) {
    pinBehind = !sameRef(remote.head, entry.pin);
  }
  return { id: entry.id, repo: entry.repo, role: entry.role, pin: entry.pin ?? "latest", head: remote.head, latest, headMoved, newRelease, pinBehind };
}

export async function run({ list, fetchRemote = gitRemote, today = new Date().toISOString().slice(0, 10) }) {
  const rows = [];
  for (const entry of list.repos) {
    try {
      rows.push(assess(entry, await fetchRemote(entry.repo)));
    } catch (err) {
      rows.push({ id: entry.id, repo: entry.repo, role: entry.role, error: String(err.message ?? err).split("\n")[0] });
    }
  }
  const updated = {
    ...list,
    lastFullCheck: today,
    repos: list.repos.map((entry) => {
      const row = rows.find((r) => r.id === entry.id);
      if (!row || row.error) return entry;
      return { ...entry, checked: { head: row.head, latest: row.latest ?? entry.checked?.latest ?? null } };
    }),
  };
  return { rows, updated };
}

export function format(rows) {
  const lines = [];
  const changed = rows.filter((r) => r.error || r.headMoved || r.newRelease || r.pinBehind);
  lines.push(`${changed.length} of ${rows.length} upstream repositories need a look.`, "");
  for (const r of changed) {
    if (r.error) {
      lines.push(`- ${r.repo}: could not reach it (${r.error})`);
      continue;
    }
    const notes = [];
    if (r.newRelease) notes.push(`new release ${r.latest}`);
    else if (r.headMoved) notes.push(`new commits on the default branch (now ${r.head.slice(0, 10)})`);
    if (r.pinBehind) notes.push(`Hivra pins ${r.pin}`);
    lines.push(`- ${r.repo} [${r.role}]: ${notes.join("; ")}`);
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const list = JSON.parse(await readFile(LIST_PATH, "utf8"));
  const { rows, updated } = await run({ list });
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else console.log(format(rows));
  if (process.argv.includes("--write")) await writeFile(LIST_PATH, `${JSON.stringify(updated, null, 2)}\n`);
}
