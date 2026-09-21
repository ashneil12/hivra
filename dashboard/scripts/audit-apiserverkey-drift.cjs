#!/usr/bin/env node
/**
 * Fleet audit: find instances whose stored apiServerKey has DRIFTED from the
 * VM's live API_SERVER_KEY — i.e. agents that 403 the signed workspace handoff
 * and render a blank white iframe (the regression covered by this audit).
 *
 * Detection mirrors the server-side self-heal shipped in
 *   dashboard/src/lib/webui-handoff-key-resync.ts (probeSignedHandoffSignature)
 * but runs READ-ONLY over HTTP (no SSH, no DB writes): for each running
 * instance we decrypt the dashboard's stored api_server_key_encrypted, mint a
 * throwaway signed `/_sidecar/webui-login` handoff with it, and GET the public
 * gateway with redirect:"manual". The sidecar verifies the HMAC before any
 * nonce/session step, so on a fresh/in-window/well-formed handoff:
 *   - 403            => signature REJECTED => stored key ≠ VM key => DRIFTED
 *   - 302 / status 0 => signature accepted => HEALTHY
 *   - other / throw  => INCONCLUSIVE / UNREACHABLE (not counted as drift)
 *
 * Crypto + signing are kept byte-identical to:
 *   dashboard/src/lib/crypto.ts        (AES-256-GCM, base64 = iv12+tag16+ct)
 *   dashboard/src/lib/webui-handoff.ts (HMAC-SHA256 over `exp.nonce.next`)
 *
 * The audit only FLAGS drift; it does not repair. A flagged instance self-heals
 * the next time its owner opens the workspace (the route now recovers + re-mints
 * with the live VM key). To force a fix without waiting, open the workspace or
 * run the dashboard's recoverAndPersistApiServerKeyFromManagedHost path.
 *
 * Required env: ENCRYPTION_KEY (64 hex), SUPABASE_URL (or
 * NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Optional env: ENCRYPTION_KEY_LEGACY (64 hex, second decrypt candidate).
 * Flags: --limit N  --concurrency N (default 10)  --instance <id>  --json
 *        --include-unreachable (list non-running/unreachable too)
 */

const crypto = require("node:crypto");

const ALG = "aes-256-gcm";
const HANDOFF_TTL_MS = 30_000;
const WEBFREE_BACKENDS = new Set(["webui", "gateway"]);
const PROBE_TIMEOUT_MS = 6000;

function parseArgs(argv) {
  const args = { concurrency: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--include-unreachable") args.includeUnreachable = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--instance") args.instance = String(argv[++i]);
  }
  return args;
}

function loadKeyCandidates() {
  const keys = [];
  for (const [name, raw] of [
    ["ENCRYPTION_KEY", process.env.ENCRYPTION_KEY],
    ["ENCRYPTION_KEY_LEGACY", process.env.ENCRYPTION_KEY_LEGACY],
  ]) {
    if (!raw) continue;
    const buf = Buffer.from(raw, "hex");
    if (buf.length !== 32) throw new Error(`${name} must be 32 bytes (64 hex chars)`);
    if (!keys.some((k) => k.equals(buf))) keys.push(buf);
  }
  if (keys.length === 0) throw new Error("ENCRYPTION_KEY env var not set");
  return keys;
}

function decryptApiKey(ciphertext, keyCandidates) {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  let lastErr;
  for (const key of keyCandidates) {
    try {
      const decipher = crypto.createDecipheriv(ALG, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("decrypt failed");
}

// Public WebUI origin: strip any gateway-port suffix + path the column carries
// (mirrors deriveWebUIBaseUrl's intent — the SPA + sidecar sit on the public
// 443 origin, not the gateway api port).
function deriveBaseUrl(gatewayUrl) {
  const u = new URL(gatewayUrl);
  return `${u.protocol}//${u.hostname}`;
}

function signHandoff(apiServerKey, exp, nonce, nextPath) {
  return crypto
    .createHmac("sha256", apiServerKey)
    .update(`${exp}.${nonce}.${nextPath}`)
    .digest("hex");
}

function buildSignedHandoffPath(apiServerKey, isWebfree) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const exp = Date.now() + HANDOFF_TTL_MS;
  const nextPath = "/";
  const sig = signHandoff(apiServerKey, exp, nonce, nextPath);
  const loginPath = isWebfree ? "/_sidecar/webui-login" : "/_sidecar/dashboard-login";
  const qs = new URLSearchParams({ exp: String(exp), nonce, next: nextPath, sig });
  return `${loginPath}?${qs.toString()}`;
}

async function fetchInstances(supabaseUrl, serviceKey, args) {
  const base = supabaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set(
    "select",
    "id,gateway_url,api_server_key_encrypted,backend,status,ipv4_address,user_id",
  );
  if (args.instance) {
    params.set("id", `eq.${args.instance}`);
  } else {
    params.set("status", "eq.running");
    params.set("gateway_url", "not.is.null");
    params.set("api_server_key_encrypted", "not.is.null");
  }
  params.set("order", "id.asc");
  if (args.limit) params.set("limit", String(args.limit));

  const res = await fetch(`${base}/rest/v1/hermes_instances?${params.toString()}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`PostgREST query failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function probeInstance(row, keyCandidates) {
  const result = { id: row.id, host: null, backend: row.backend ?? null, status: row.status };
  let apiServerKey;
  try {
    apiServerKey = decryptApiKey(row.api_server_key_encrypted, keyCandidates);
  } catch {
    result.verdict = "DECRYPT_FAILED";
    return result;
  }
  let baseUrl;
  try {
    baseUrl = deriveBaseUrl(row.gateway_url);
    result.host = new URL(baseUrl).host;
  } catch {
    result.verdict = "BAD_GATEWAY_URL";
    return result;
  }

  const isWebfree = WEBFREE_BACKENDS.has(String(row.backend ?? ""));
  const path = buildSignedHandoffPath(apiServerKey, isWebfree);

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Accept: "text/html" },
    });
    await res.body?.cancel?.().catch(() => {});
    result.httpStatus = res.status;
    if (res.status === 403) {
      result.verdict = "DRIFTED";
      // Flag a possible Cloudflare/WAF false-positive so it can be spot-checked.
      if (res.headers.get("cf-mitigated") || res.headers.get("cf-chl-bypass")) {
        result.note = "403 carried a Cloudflare challenge header — verify it is the sidecar, not the edge";
      }
    } else if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      result.verdict = "HEALTHY";
    } else {
      result.verdict = "INCONCLUSIVE";
    }
  } catch (err) {
    result.verdict = "UNREACHABLE";
    result.error = err instanceof Error ? err.name : String(err);
  }
  return result;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const keyCandidates = loadKeyCandidates();

  const rows = await fetchInstances(supabaseUrl, serviceKey, args);
  if (!args.json) {
    console.error(`Probing ${rows.length} instance(s) at concurrency ${args.concurrency}…`);
  }

  const results = await runPool(rows, args.concurrency, (row) => probeInstance(row, keyCandidates));

  const byVerdict = {};
  for (const r of results) (byVerdict[r.verdict] ||= []).push(r);

  if (args.json) {
    console.log(JSON.stringify({ total: results.length, byVerdict, results }, null, 2));
    return;
  }

  const order = ["DRIFTED", "DECRYPT_FAILED", "INCONCLUSIVE", "HEALTHY", "UNREACHABLE", "BAD_GATEWAY_URL"];
  console.log("\n=== apiServerKey drift audit ===");
  for (const v of order) {
    const list = byVerdict[v] || [];
    console.log(`${v.padEnd(16)} ${list.length}`);
  }

  const drifted = byVerdict.DRIFTED || [];
  if (drifted.length) {
    console.log(`\n--- DRIFTED (white-screened) — ${drifted.length} ---`);
    for (const r of drifted) {
      console.log(`  ${r.id}  ${r.host}  backend=${r.backend}${r.note ? `  [${r.note}]` : ""}`);
    }
  }
  const decryptFailed = byVerdict.DECRYPT_FAILED || [];
  if (decryptFailed.length) {
    console.log(`\n--- DECRYPT_FAILED (stored blob unreadable with provided keys) — ${decryptFailed.length} ---`);
    for (const r of decryptFailed) console.log(`  ${r.id}`);
  }
  const inconclusive = byVerdict.INCONCLUSIVE || [];
  if (inconclusive.length) {
    console.log(`\n--- INCONCLUSIVE (non-403 error status; sidecar likely not ready) — ${inconclusive.length} ---`);
    for (const r of inconclusive) console.log(`  ${r.id}  ${r.host}  http=${r.httpStatus}`);
  }
  if (args.includeUnreachable) {
    const unreachable = byVerdict.UNREACHABLE || [];
    console.log(`\n--- UNREACHABLE — ${unreachable.length} ---`);
    for (const r of unreachable) console.log(`  ${r.id}  ${r.host}  ${r.error}`);
  }

  if (drifted.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error("audit failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
