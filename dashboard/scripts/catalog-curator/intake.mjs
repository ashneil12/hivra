import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "ashneil12/hivra";
const LEDGER = "dashboard/catalog-curation/candidates.jsonl";
const LIB = "dashboard/src/lib/hivra";
const SCHEMA = LIB + "/catalog-manifests/schema.ts";
const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const SHA = /^[0-9a-f]{40}$/;
const LANE = /^(catalog-intake|curation)\//;
const DEADLINE = performance.now() + 120_000;

export function upstream(value) {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})\/?$/i.exec(value);
  if (!match) return null;
  const repo = match[2].replace(/\.git$/i, "");
  return repo && repo !== "." && repo !== ".." ? `${match[1]}/${repo}`.toLowerCase() : null;
}

function lines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export function parseInbox(text) {
  const rows = lines(text);
  if (rows.length > 20) throw new Error("Inbox is limited to 20 rows");
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join() !== "commit,slug,sourceUrl"
      || typeof row.slug !== "string" || !SLUG.test(row.slug) || !upstream(row.sourceUrl)
      || typeof row.commit !== "string" || !SHA.test(row.commit)) {
      throw new Error("Inbox rows need only slug, HTTPS GitHub repository sourceUrl, and full lowercase commit SHA");
    }
  }
  return rows;
}

function matches(row, sources, text) {
  const slugs = [...text.matchAll(/\b(?:id|slug)["']?\s*:\s*["']([a-z0-9-]+)["']/gi)].map((m) => m[1]);
  return slugs.includes(row.slug) || [...text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/gi)]
    .some(([url]) => sources.includes(upstream(url)));
}

export function decide(row, meta, snapshot) {
  const sources = [upstream(row.sourceUrl), upstream(`https://github.com/${meta.full_name}`)];
  const branch = `catalog-intake/${meta.id}-${row.slug}`;
  if (matches(row, sources, snapshot.catalog)) return { status: "duplicate", reason: "Canary catalog or curation ledger" };
  for (const [ref, text] of snapshot.branches) {
    const reserved = /^catalog-intake\/(\d+)-(.+)$/.exec(ref);
    if (reserved?.[1] === String(meta.id) || reserved?.[2] === row.slug || matches(row, sources, text)) {
      return { status: "duplicate", reason: `existing branch ${ref}` };
    }
  }
  for (const { number, diff } of snapshot.prs) {
    const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
    if (matches(row, sources, additions)) return { status: "duplicate", reason: `open PR #${number}` };
  }
  if (meta.private || meta.archived || !snapshot.licenses.includes(meta.license?.spdx_id)) {
    return { status: "parked", reason: "Upstream is private, archived, or outside the catalog SPDX allowlist" };
  }
  const active = snapshot.prs.find(({ head, diff }) => LANE.test(head)
    || /^\+.*\bid:\s*"[^"]+",\s*$/m.test(diff) && /^\+\+\+ b\/dashboard\/src\/lib\/hivra\/catalog-manifests\/manifests\//m.test(diff));
  if (active) return { status: "blocked", reason: `expansion lane has open PR #${active.number}` };
  return { status: "review", canonicalUrl: `https://github.com/${meta.full_name}`, upstreamId: meta.id, branch };
}

function cmd(program, args) {
  const remaining = Math.floor(DEADLINE - performance.now());
  if (remaining < 1) throw new Error("Intake exceeded its two-minute metadata budget");
  try {
    return execFileSync(program, args, { encoding: "utf8", timeout: Math.min(25_000, remaining), maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`${program} ${args[0]} failed; check authentication, connectivity or the Canary checkout`);
  }
}

function api(endpoint) {
  return JSON.parse(cmd("gh", ["api", "--hostname", "github.com", endpoint]));
}

function snapshot() {
  const remote = cmd("git", ["remote", "get-url", "origin"]).trim();
  if (!["https://github.com/ashneil12/hivra.git", "https://github.com/ashneil12/hivra", "git@github.com:ashneil12/hivra.git"].includes(remote)) {
    throw new Error("origin must be the public Hivra repository");
  }
  const refs = cmd("git", ["ls-remote", "--heads", "origin", "refs/heads/canary", "refs/heads/curation/*", "refs/heads/catalog-intake/*"])
    .trim().split("\n").map((line) => line.split("\t"));
  const sha = refs.find(([, ref]) => ref === "refs/heads/canary")?.[0];
  if (!SHA.test(sha ?? "")) throw new Error("Could not pin origin/canary");
  const catalog = cmd("git", ["grep", "-h", "-E", 'github\\.com|[[:space:]](id|slug):', sha, "--", LIB + "/catalog-manifests/manifests",
    LIB + "/agent-catalog.ts", LIB + "/computer-catalog.ts", LIB + "/preview-catalog.ts"]) + cmd("git", ["show", `${sha}:${LEDGER}`]);
  const schema = cmd("git", ["show", `${sha}:${SCHEMA}`]);
  const allowlist = /export const CATALOG_OSI_LICENSES = \[([\s\S]*?)\] as const/.exec(schema);
  if (!allowlist) throw new Error("Could not read catalog SPDX allowlist");
  const licenses = [...allowlist[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const prs = JSON.parse(cmd("gh", ["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${REPO}/pulls?state=open&base=canary&per_page=100`])).flat()
    .map((pr) => ({ number: pr.number, head: pr.head.ref, diff: cmd("gh", ["pr", "diff", "--repo", REPO, String(pr.number)]) }));
  const local = cmd("git", ["for-each-ref", "--format=%(objectname)%09%(refname)", "refs/heads/curation", "refs/heads/catalog-intake"])
    .trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
  const branches = new Map();
  for (const [source, entries] of [["local", local], ["remote", refs]]) {
    for (const [oid, fullRef] of entries) {
      const ref = fullRef.slice(11);
      const key = `${oid} ${ref}`;
      if (!LANE.test(ref) || branches.has(key)) continue;
      let text = "";
      if (ref.startsWith("curation/")) {
        text = source === "local" ? cmd("git", ["show", `${oid}:${LEDGER}`])
          : Buffer.from(api(`repos/${REPO}/contents/${LEDGER}?ref=${oid}`).content, "base64").toString();
      }
      branches.set(key, [ref, text]);
    }
  }
  return { sha, catalog, licenses, prs, branches: [...branches.values()] };
}

export function reserve(state, candidate) {
  if (existsSync(path.join(state, "PAUSED"))) throw new Error("Intake is paused");
  const lane = path.join(state, "active");
  mkdirSync(lane, { mode: 0o700 });
  if (existsSync(path.join(state, "PAUSED"))) throw new Error("Intake paused during reservation; inspect the lane before resuming");
  writeFileSync(path.join(lane, "candidate.json"), JSON.stringify(candidate, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (!["--dry-run", "--reserve"].includes(mode) || rest.length) {
    throw new Error("Choose --dry-run or --reserve explicitly; no autonomous integration or live work is started");
  }
  const state = process.env.CURATOR_STATE || path.join(homedir(), ".local/state/hivra-catalog-curator");
  if (!path.isAbsolute(state)) throw new Error("CURATOR_STATE must be absolute");
  const dir = lstatSync(state);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error("State must be an owner-only directory");
  if (existsSync(path.join(state, "PAUSED")) || existsSync(path.join(state, "active"))) {
    console.log(JSON.stringify({ status: "blocked", reason: "Persistent pause or active lane; inspect state" }));
    return;
  }
  const inbox = path.join(state, "inbox.jsonl");
  const input = lstatSync(inbox);
  if (!input.isFile() || input.uid !== process.getuid() || (input.mode & 0o077) || input.size > 16_384) {
    throw new Error("Inbox must be an owner-only regular file at most 16 KiB");
  }
  const rows = parseInbox(readFileSync(inbox, "utf8"));
  if (mode === "--reserve" && rows.length !== 1) throw new Error("Reserve requires exactly one approved inbox row");
  if (!rows.length) {
    console.log(JSON.stringify({ status: "idle" }));
    return;
  }
  const observed = snapshot();
  const seen = new Set();
  for (const row of rows) {
    const meta = api(`repos/${upstream(row.sourceUrl)}`);
    if (!Number.isSafeInteger(meta.id) || !upstream(`https://github.com/${meta.full_name}`)) throw new Error("GitHub did not resolve an upstream identity");
    let result = seen.has(meta.id) || seen.has(row.slug)
      ? { status: "duplicate", reason: "Earlier inbox row" }
      : decide(row, meta, observed);
    seen.add(meta.id);
    seen.add(row.slug);
    if (result.status === "review") {
      const endpoint = `repos/${meta.full_name}`;
      const commit = api(`${endpoint}/commits/${row.commit}`);
      if (commit.sha !== row.commit) throw new Error("GitHub did not resolve the pinned commit");
      const license = api(`${endpoint}/license`);
      const pinned = api(`${endpoint}/contents/${license.path.split("/").map(encodeURIComponent).join("/")}?ref=${row.commit}`);
      if (pinned.sha !== license.sha || license.license?.spdx_id !== meta.license.spdx_id) {
        result = { status: "parked", reason: "Pinned licence differs from the recognized upstream licence" };
      } else {
        result.spdx = meta.license.spdx_id;
        result.licenseBlob = pinned.sha;
      }
    }
    const decision = { ...row, ...result, canarySha: observed.sha };
    if (mode === "--reserve" && result.status === "review") reserve(state, decision);
    console.log(JSON.stringify(decision));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[catalog-intake] ${error instanceof SyntaxError ? "Malformed JSON" : error.message}`);
    process.exitCode = 2;
  }
}
