#!/usr/bin/env node
// Refresh the static Venice catalog (src/lib/venice/pricing.ts) from Venice's
// public models list. The proxy prices from the live list at request time
// (src/lib/venice/live-pricing.ts); this catalog is only the fallback and the
// baseline the weekly drift check compares against, so keep it close.
//
//   node scripts/refresh-venice-catalog.mjs          # dry run: print the diff
//   node scripts/refresh-venice-catalog.mjs --write  # update pricing.ts in place
//   node scripts/refresh-venice-catalog.mjs --from file.json   # use a saved response
//
// Updates, for every model already in the catalog: input/output/cache-read
// price, context window and max output tokens. It never touches displayName,
// privacy or cacheWriteUsd, never deletes a model, and only PRINTS models that
// are new on Venice or gone from it (a person should pick the display name and
// check the privacy label). With --write it also sets the snapshot date.
// VENICE_API_KEY is optional; the list is public.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = resolve(here, "../src/lib/venice/pricing.ts");
const URL_ = "https://api.venice.ai/api/v1/models?type=text";

const args = process.argv.slice(2);
const write = args.includes("--write");
const fromIdx = args.indexOf("--from");
const fromFile = fromIdx >= 0 ? args[fromIdx + 1] : null;

async function loadLive() {
  if (fromFile) return JSON.parse(readFileSync(fromFile, "utf8"));
  const headers = process.env.VENICE_API_KEY
    ? { Authorization: `Bearer ${process.env.VENICE_API_KEY}` }
    : {};
  const res = await fetch(URL_, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Venice returned HTTP ${res.status}`);
  return res.json();
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const tok = (v) => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const fmtTok = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");

const json = await loadLive();
const live = new Map();
for (const item of json.data ?? []) {
  const spec = item?.model_spec ?? {};
  const p = spec.pricing ?? spec;
  const input = num(p.input?.usd);
  const output = num(p.output?.usd);
  if (typeof item?.id !== "string" || input == null || output == null) continue;
  live.set(item.id, {
    name: spec.name ?? item.id,
    input,
    output,
    cache: num(p.cache_input?.usd),
    context: tok(spec.availableContextTokens) ?? tok(spec.context_length),
    maxOut: tok(spec.maxCompletionTokens),
    privacy: spec.privacy,
  });
}
if (live.size === 0) throw new Error("Venice returned no priced models; refusing to touch the catalog");

let src = readFileSync(PRICING_PATH, "utf8");
const changes = [];
const seen = new Set();

src = src.replace(/(  model\(\{\n)([\s\S]*?)(\n  \}\),)/g, (whole, open, body, close) => {
  const id = /model: "([^"]+)"/.exec(body)?.[1];
  const l = id && live.get(id);
  if (!id) return whole;
  seen.add(id);
  if (!l) return whole;
  let out = body;
  const setLine = (key, value, fmt = String) => {
    const re = new RegExp(`^(    ${key}: )(.*?)(,)$`, "m");
    const m = re.exec(out);
    if (value == null) {
      if (m) {
        changes.push(`${id}: ${key} ${m[2]} -> (removed)`);
        out = out.replace(new RegExp(`^    ${key}: .*,\\n?`, "m"), "");
      }
      return;
    }
    const next = fmt(value);
    if (m) {
      if (m[2] !== next) {
        changes.push(`${id}: ${key} ${m[2]} -> ${next}`);
        out = out.replace(re, `$1${next}$3`);
      }
    } else {
      changes.push(`${id}: ${key} (none) -> ${next}`);
      out = out.replace(/^(    outputUsd: .*,\n)/m, `$1    ${key}: ${next},\n`);
    }
  };
  setLine("inputUsd", l.input);
  setLine("outputUsd", l.output);
  setLine("cacheReadUsd", l.cache);
  if (l.context != null) setLine("contextWindow", l.context, fmtTok);
  if (l.maxOut != null) setLine("maxOutputTokens", l.maxOut, fmtTok);
  const catPrivacy = /privacy: "([^"]+)"/.exec(out)?.[1];
  if (l.privacy && catPrivacy && l.privacy !== catPrivacy && !(l.privacy === "private" && catPrivacy === "e2ee_private")) {
    changes.push(`${id}: PRIVACY differs (catalog ${catPrivacy}, Venice ${l.privacy}); not changed, review by hand`);
  }
  return open + out + close;
});

const gone = [...seen].filter((id) => !live.has(id));
const added = [...live.keys()].filter((id) => !seen.has(id));

console.log(`Venice priced text models: ${live.size}. Catalog models: ${seen.size}.`);
console.log(changes.length ? `\nChanges (${changes.length}):\n  ${changes.join("\n  ")}` : "\nNo changes to existing models.");
if (gone.length) console.log(`\nIn the catalog but not on Venice (kept, check if delisted):\n  ${gone.join("\n  ")}`);
if (added.length) {
  console.log(`\nNew on Venice, not in the catalog (add by hand, check display name and privacy):`);
  for (const id of added) {
    const l = live.get(id);
    console.log(
      `  model({ model: "${id}", displayName: ${JSON.stringify(l.name)}, inputUsd: ${l.input}, outputUsd: ${l.output}` +
        `${l.cache != null ? `, cacheReadUsd: ${l.cache}` : ""}, contextWindow: ${fmtTok(l.context ?? 128000)}, ` +
        `maxOutputTokens: ${fmtTok(l.maxOut ?? 8192)}, privacy: "${l.privacy ?? "private"}" }),`,
    );
  }
}

if (write) {
  const today = new Date().toISOString().slice(0, 10);
  src = src.replace(
    /(VENICE_CHAT_PRICING_CATALOG_UPDATED_AT = ")[^"]+(")/,
    `$1${today}$2`,
  );
  writeFileSync(PRICING_PATH, src);
  console.log(`\nWrote ${PRICING_PATH} (snapshot date ${today}).`);
} else {
  console.log("\nDry run. Re-run with --write to apply.");
}
