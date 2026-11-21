#!/usr/bin/env node
// Deterministic verifier for universal catalog candidates.
//
//   node verify-candidate.mjs <slug>           verify one registry manifest
//   node verify-candidate.mjs --spec <file>    verify a spec JSON file
//   node verify-candidate.mjs --all [--force]  verify every manifest; skips
//                                              evidence fresher than 7 days
//
// Spec shape: { id, license, sourceUrl, runtime, floor?: { ram } } — the same
// fields CatalogAppManifest carries, so a manifest dump or a hand-written
// candidate spec both work.
//
// Every check records pass/fail/skipped with raw evidence. Verdict is "pass"
// only when nothing failed. Evidence lands in
// dashboard/catalog-curation/evidence/<slug>.json and the process exits
// non-zero on failure so an unattended loop can gate on it.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = path.resolve(DASHBOARD_DIR, "..");
const EVIDENCE_DIR = path.join(DASHBOARD_DIR, "catalog-curation", "evidence");
const EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BOOT_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 2_000;

// Keep in sync with CATALOG_OSI_LICENSES in src/lib/hivra/catalog-manifests/schema.ts.
const OSI_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "ISC",
  "MIT OR Apache-2.0",
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "MPL-2.0",
]);

const DUMMY_MODEL_ENV = {
  apiKey: "sk-verify-dummy-key-0000000000000000",
  baseUrl: "http://127.0.0.1:9/v1",
  model: "verify-model",
};

const GATEWAY_SERVER = path.join(DASHBOARD_DIR, "provisioner", "hivra-chat", "server.js");
const GATEWAY_PUBLIC_HOST = "box-verify.example.test";
const GATEWAY_PUBLIC_ORIGIN = `https://${GATEWAY_PUBLIC_HOST}`;
const GATEWAY_TOKEN = "a".repeat(64);
const CATALOG_APP_RUNNER = path.join(DASHBOARD_DIR, "provisioner", "hivra-catalog-app.py");

// Deterministic stand-ins for the guest's generated secrets: the runner's
// --render-only mode uses the same `render-only-<name>` values, so boot and
// gateway checks see identical env either way. Never real secrets.
const FAKE_SECRET_PREFIX = "render-only-";

function fakeSecretValue(name) {
  return `${FAKE_SECRET_PREFIX}${name.toLowerCase()}`;
}

/** Mirror of the guest substitution: ${HIVRA_PUBLIC_ORIGIN},
 * ${HIVRA_PUBLIC_HOST} and ${NAME} for declared generatedSecrets. Throws on
 * any other placeholder, exactly like hivra-catalog-app.py. */
function substituteEnvValue(value, secretNames) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    if (name === "HIVRA_PUBLIC_ORIGIN") return GATEWAY_PUBLIC_ORIGIN;
    if (name === "HIVRA_PUBLIC_HOST") return GATEWAY_PUBLIC_HOST;
    if (secretNames.has(name)) return fakeSecretValue(name);
    throw new Error(`env placeholder \${${name}} is not declared`);
  });
}

function substituteEnvMap(env, secretNames) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) out[key] = substituteEnvValue(value, secretNames);
  return out;
}

function shOut(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 120_000,
    env: opts.env,
    cwd: opts.cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
    error: res.error ? String(res.error.message ?? res.error) : null,
  };
}

function gitSha() {
  const res = shOut("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
  return res.status === 0 ? res.stdout.trim() : "unknown";
}

function check(name, status, detail, evidence) {
  return { name, status, ...(detail ? { detail } : {}), ...(evidence !== undefined ? { evidence } : {}) };
}

function parseSourceRepo(sourceUrl) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(sourceUrl ?? "");
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, "") } : null;
}

// ── Check 1: licence ────────────────────────────────────────────────────────

function checkLicense(spec) {
  const repo = parseSourceRepo(spec.sourceUrl);
  if (!repo) return check("license", "fail", `unparseable sourceUrl ${spec.sourceUrl}`);
  const res = shOut("gh", ["api", `repos/${repo.owner}/${repo.repo}`, "--jq", "{spdx_id: .license.spdx_id, archived, full_name}"]);
  if (res.status !== 0) return check("license", "fail", `gh api failed: ${(res.stderr || res.error || res.stdout).slice(0, 300)}`);
  let meta;
  try {
    meta = JSON.parse(res.stdout);
  } catch {
    return check("license", "fail", `unexpected gh api output: ${res.stdout.slice(0, 200)}`);
  }
  const problems = [];
  if (!OSI_LICENSES.has(meta.spdx_id)) problems.push(`spdx_id ${meta.spdx_id} not in allowlist`);
  if (meta.archived) problems.push("repository is archived");
  if (problems.length) return check("license", "fail", problems.join("; "), meta);
  return check("license", "pass", `${meta.full_name} is ${meta.spdx_id}`, meta);
}

// ── Check 2: image / package exists with the needed platform ────────────────

function parseImagePlatforms(raw) {
  // Accepts an OCI index, a manifest list, or a single manifest.
  try {
    const doc = JSON.parse(raw);
    if (Array.isArray(doc.manifests)) {
      return doc.manifests
        .map((m) => m.platform && `${m.platform.os}/${m.platform.architecture}${m.platform.variant ? `/${m.platform.variant}` : ""}`)
        .filter(Boolean);
    }
    if (doc.os && doc.architecture) return [`${doc.os}/${doc.architecture}`];
  } catch {
    /* not json */
  }
  return [];
}

function imageDigest(repo, tag) {
  const res = shOut("docker", ["buildx", "imagetools", "inspect", `${repo}:${tag}`], { timeout: 60_000 });
  if (res.status !== 0) return { ok: false, stderr: (res.stderr || res.error || "inspect failed").slice(0, 400) };
  const digest = /Digest:\s+(sha256:[a-f0-9]{64})/.exec(res.stdout)?.[1] ?? null;
  return { ok: true, digest, inspect: res.stdout.slice(0, 800) };
}

async function inspectDockerImage(repo, tag) {
  const ref = `${repo}:${tag}`;
  const digestInfo = imageDigest(repo, tag);
  if (!digestInfo.ok) return { ok: false, detail: `${ref}: ${digestInfo.stderr}`, evidence: { ref } };

  let platforms = [];
  const raw = shOut("docker", ["buildx", "imagetools", "inspect", "--raw", ref], { timeout: 60_000 });
  if (raw.status === 0) platforms = parseImagePlatforms(raw.stdout);
  if (platforms.length === 0) {
    // Single-manifest images carry no platform list; imagetools resolves the
    // image config and reports os/architecture for the one variant it serves.
    const fmt = shOut("docker", ["buildx", "imagetools", "inspect", "--format", "{{json .}}", ref], { timeout: 60_000 });
    if (fmt.status === 0) {
      try {
        const doc = JSON.parse(fmt.stdout);
        if (doc.image?.os && doc.image?.architecture) platforms = [`${doc.image.os}/${doc.image.architecture}`];
      } catch {
        /* not json */
      }
    }
  }
  if (platforms.length === 0) {
    const man = shOut("docker", ["manifest", "inspect", ref], { timeout: 60_000 });
    if (man.status === 0) platforms = parseImagePlatforms(man.stdout);
  }
  const evidence = { ref, digest: digestInfo.digest, platforms: platforms.length ? platforms : ["unknown"] };
  if (platforms.length === 0) return { ok: false, detail: `${ref}: could not determine platforms`, evidence };
  if (!platforms.some((p) => p.startsWith("linux/amd64"))) {
    return { ok: false, detail: `${ref}: no linux/amd64 variant (platforms: ${platforms.join(", ")})`, evidence };
  }
  const hasArm64 = platforms.some((p) => p.startsWith("linux/arm64"));
  return { ok: true, detail: `${ref} linux/amd64${hasArm64 ? " + linux/arm64" : " only"}`, evidence };
}

async function checkImage(spec) {
  const rt = spec.runtime;
  if (rt.kind === "docker-stack") {
    const services = [];
    const failures = [];
    for (const svc of rt.services) {
      const res = await inspectDockerImage(svc.imageRepo, svc.imageTag);
      services.push({ name: svc.name, ...res.evidence });
      if (!res.ok) failures.push(`${svc.name}: ${res.detail}`);
    }
    const evidence = { services };
    if (failures.length) return check("image", "fail", failures.join("; "), evidence);
    return check("image", "pass", `${services.length} service images have linux/amd64`, evidence);
  }
  if (rt.kind !== "docker-web") {
    // cli-web: the package or release asset must exist upstream.
    const installer = rt.installer;
    if (installer.method === "uv-tool") {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(installer.packageName)}/json`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return check("package", "fail", `PyPI ${installer.packageName}: HTTP ${res.status}`);
      const data = await res.json();
      return check("package", "pass", `PyPI ${installer.packageName} ${data.info?.version}`, { version: data.info?.version });
    }
    if (installer.method === "npm-global") {
      const res = await fetch(`https://registry.npmjs.org/${installer.packageName}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return check("package", "fail", `npm ${installer.packageName}: HTTP ${res.status}`);
      const data = await res.json();
      const latest = data["dist-tags"]?.latest;
      return check("package", "pass", `npm ${installer.packageName} ${latest}`, { version: latest });
    }
    // github-release-tar: the declared assets must exist on the latest release.
    const [owner, repo] = installer.repo.split("/");
    const rel = shOut("gh", ["api", `repos/${owner}/${repo}/releases/latest`, "--jq", "{tag_name, assets: [.assets[].name]}"], { timeout: 60_000 });
    if (rel.status !== 0) return check("package", "fail", `gh release lookup failed: ${(rel.stderr || rel.stdout).slice(0, 300)}`);
    let info;
    try {
      info = JSON.parse(rel.stdout);
    } catch {
      return check("package", "fail", `unexpected release JSON: ${rel.stdout.slice(0, 200)}`);
    }
    const missing = [installer.assetX64, installer.assetArm64].filter(Boolean).filter((a) => !info.assets.includes(a));
    if (missing.length) return check("package", "fail", `release ${info.tag_name} missing assets: ${missing.join(", ")}`, info);
    return check("package", "pass", `release ${info.tag_name} has ${info.assets.length} assets`, info);
  }

  const res = await inspectDockerImage(rt.imageRepo, rt.imageTag);
  return check("image", res.ok ? "pass" : "fail", res.detail, res.evidence);
}

// ── Check 3: boot ───────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// The box gateway only proxies catalog apps whose hostPort sits in the
// catalog range (server.js readCatalogAppMeta), so the verify container must
// publish on the manifest's own hostPort — exactly what production binds.
async function freeCatalogPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 3200 + Math.floor(Math.random() * 800);
    const busy = await new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(true));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(false)));
    });
    if (!busy) return port;
  }
  throw new Error("no free catalog port in 3200-3999");
}

function mergedDockerEnv(runtime) {
  const secretNames = new Set(runtime.generatedSecrets ?? []);
  const env = substituteEnvMap(runtime.env, secretNames);
  const modelEnv = runtime.modelEnv;
  if (modelEnv) {
    for (const [k, v] of Object.entries(modelEnv.extraEnv ?? {})) env[k] = substituteEnvValue(v, secretNames);
    env[modelEnv.apiKeyVar] = DUMMY_MODEL_ENV.apiKey;
    env[modelEnv.baseUrlVar] = DUMMY_MODEL_ENV.baseUrl;
    if (modelEnv.modelVar) env[modelEnv.modelVar] = DUMMY_MODEL_ENV.model;
  }
  // The guest injects each declared secret as a raw env var last, so a secret
  // name wins over any static or model binding that happens to collide.
  for (const name of secretNames) env[name] = fakeSecretValue(name);
  return env;
}

async function pollHealth(port, healthPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastError = null;
  const start = Date.now();
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
        signal: AbortSignal.timeout(8_000),
        redirect: "follow",
      });
      lastStatus = res.status;
      if (res.status < 400) {
        return { ok: true, status: res.status, seconds: Math.round(((Date.now() - start) / 1000) * 10) / 10, attempts };
      }
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, status: lastStatus, seconds: Math.round(((Date.now() - start) / 1000) * 10) / 10, attempts, error: lastError };
}

function parseMemUsage(text) {
  // "123.4MiB / 7.769GiB" -> bytes of the first figure.
  const m = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB)?/.exec((text ?? "").trim());
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2] ?? "B";
  const mult = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, kB: 1000, MB: 1000 ** 2, GB: 1000 ** 3 }[unit] ?? 1;
  return Math.round(value * mult);
}

// ── Gateway check ───────────────────────────────────────────────────────────
// Boots the real provisioner/hivra-chat/server.js as AGENT_KIND=catalog-app
// against the running app container, then walks the user path a browser takes:
// /app/ -> 303 -> / -> app, all through catalogAppProxy with the standard
// forwarded-header contract. Catches apps that build absolute redirects from
// Host, enforce trusted domains, or do Origin-vs-Host CSRF checks.

function gwRequest(gwPort, { method = "GET", reqPath = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gwPort,
        method,
        path: reqPath,
        headers: {
          host: GATEWAY_PUBLIC_HOST,
          authorization: `Bearer ${GATEWAY_TOKEN}`,
          accept: "text/html,application/xhtml+xml,*/*",
          ...headers,
        },
        timeout: 20_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("gateway request timeout")));
    req.on("error", (err) => resolve({ status: 0, error: String(err?.message ?? err), headers: {}, body: "" }));
    if (body !== null) req.write(body);
    req.end();
  });
}

function gwCookies(jar, setCookies) {
  for (const sc of setCookies ?? []) {
    const pair = String(sc).split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}
function gwCookieHeader(jar) {
  const entries = Object.entries(jar);
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join("; ") : null;
}

/** Returns the path+query to request next, or { fail } when the redirect
 * leaves the public host or points at loopback. */
function gwRedirectTarget(location, currentPath) {
  if (!location) return null;
  const loc = String(location).trim();
  if (loc.startsWith("//")) {
    try {
      const u = new URL(`http:${loc}`);
      return u.hostname === GATEWAY_PUBLIC_HOST ? u.pathname + u.search : { fail: `protocol-relative redirect to ${u.host}` };
    } catch {
      return { fail: `unparseable redirect ${loc.slice(0, 120)}` };
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(loc)) {
    let u;
    try {
      u = new URL(loc);
    } catch {
      return { fail: `unparseable redirect ${loc.slice(0, 120)}` };
    }
    const host = u.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") {
      return { fail: `redirect to loopback ${u.host}${u.pathname}` };
    }
    if (host !== GATEWAY_PUBLIC_HOST) return { fail: `redirect to foreign host ${u.host}${u.pathname}` };
    return u.pathname + u.search;
  }
  // Relative reference: resolve against the current path.
  try {
    return new URL(loc, `http://${GATEWAY_PUBLIC_HOST}${currentPath}`).pathname +
      new URL(loc, `http://${GATEWAY_PUBLIC_HOST}${currentPath}`).search;
  } catch {
    return { fail: `unparseable redirect ${loc.slice(0, 120)}` };
  }
}

async function gatewayCheck(spec, hostPort, route = null) {
  const rt = spec.runtime;
  // docker-stack publishes through runtime.web; everything else uses the
  // top-level hostPort/healthPath/proxyMode like docker-web.
  const healthPath = route?.healthPath ?? rt.healthPath ?? rt.web?.healthPath ?? "/";
  const proxyMode = route?.proxyMode ?? rt.proxyMode ?? rt.web?.proxyMode ?? "standard";
  const kind = route?.kind ?? (rt.kind === "docker-stack" ? "docker-stack" : "docker-web");
  const work = mkdtempSync(path.join(tmpdir(), `hivra-gw-${spec.id}-`));
  const home = path.join(work, "home");
  const metaFile = path.join(work, "catalog-app.json");
  const evidence = { publicHost: GATEWAY_PUBLIC_HOST };
  let child = null;
  try {
    mkdirSync(path.join(home, ".hivra"), { recursive: true });
    writeFileSync(path.join(home, ".hivra", "api-token"), GATEWAY_TOKEN + "\n", { mode: 0o600 });
    writeFileSync(
      metaFile,
      JSON.stringify({
        appId: spec.id,
        name: spec.name ?? spec.id,
        kind,
        hostPort,
        healthPath,
        proxyMode,
      }),
    );
    const gwPort = await freePort();
    evidence.gatewayPort = gwPort;
    evidence.proxyMode = proxyMode;
    child = spawn(process.execPath, [GATEWAY_SERVER], {
      env: {
        ...process.env,
        HOME: home,
        HIVRA_CHAT_PORT: String(gwPort),
        HIVRA_AGENT_KIND: "catalog-app",
        HIVRA_CATALOG_APP_META: metaFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let gwErr = "";
    child.stderr.on("data", (c) => (gwErr += c));
    child.stdout.on("data", () => {});

    // Wait for the gateway to answer its own health route.
    const gwDeadline = Date.now() + 20_000;
    let gwUp = false;
    while (Date.now() < gwDeadline) {
      const probe = await gwRequest(gwPort, { reqPath: "/healthz", headers: { authorization: "" } });
      if (probe.status === 200) {
        gwUp = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!gwUp) {
      evidence.gatewayStderr = gwErr.slice(-800);
      return check("gateway", "fail", "hivra-chat gateway did not start", evidence);
    }

    // Walk /app/ -> app through the gateway, following redirects by hand.
    const jar = {};
    const hops = [];
    let reqPath = "/app/";
    let final = null;
    let redirectFail = null;
    for (let hop = 0; hop < 10; hop += 1) {
      const cookie = gwCookieHeader(jar);
      const res = await gwRequest(gwPort, {
        reqPath,
        headers: cookie ? { cookie } : {},
      });
      gwCookies(jar, res.headers["set-cookie"]);
      hops.push({ hop, path: reqPath, status: res.status, location: res.headers.location ?? null });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        const next = gwRedirectTarget(res.headers.location, reqPath);
        if (next && next.fail) {
          redirectFail = next.fail;
          break;
        }
        if (next) {
          reqPath = next;
          continue;
        }
      }
      final = res;
      break;
    }
    evidence.hops = hops;
    if (redirectFail) {
      evidence.finalStatus = final?.status ?? null;
      return check("gateway", "fail", redirectFail, evidence);
    }
    if (!final) {
      return check("gateway", "fail", "redirect chain exceeded 10 hops", evidence);
    }
    evidence.finalStatus = final.status;
    evidence.finalPath = reqPath;
    const body = final.body ?? "";
    evidence.bodyHead = body.slice(0, 400);
    if (final.status >= 400) {
      // API-only apps have no page at "/": their surface is the REST API the
      // gateway proxies verbatim. Accept a clean 4xx at "/" when the app's own
      // healthPath answers through the same gateway — redirect loops, loopback
      // references and CSRF rejections above still fail.
      const hp = healthPath && healthPath !== "/" ? healthPath : null;
      if (hp && final.status >= 400 && final.status < 500) {
        const cookie = gwCookieHeader(jar);
        const hpRes = await gwRequest(gwPort, { reqPath: hp, headers: cookie ? { cookie } : {} });
        evidence.healthPathProbe = { path: hp, status: hpRes.status };
        if (hpRes.status > 0 && hpRes.status < 400) {
          const hpBody = hpRes.body ?? "";
          if (/127\.0\.0\.1|localhost/.test(hpBody)) {
            return check("gateway", "fail", `healthPath ${hp} body references loopback`, evidence);
          }
          return check(
            "gateway",
            "pass",
            `API-only surface: / -> ${final.status}, ${hp} -> ${hpRes.status} through gateway`,
            evidence,
          );
        }
      }
      return check("gateway", "fail", `final status ${final.status} after ${hops.length} hop(s)`, evidence);
    }
    const loopbackRef = new RegExp(`(127\\.0\\.0\\.1|localhost):${hostPort}`).test(body);
    if (loopbackRef) {
      return check("gateway", "fail", `final HTML references loopback ${hostPort}`, evidence);
    }

    // Login/setup form probe: POST it empty through the same gateway origin.
    const formMatch = /<form[^>]*>/i.exec(body);
    const isPostForm = formMatch && /method\s*=\s*["']?post/i.test(formMatch[0]);
    if (isPostForm) {
      const actionMatch = /action\s*=\s*["']([^"']*)["']/i.exec(formMatch[0]);
      let postPath = reqPath;
      if (actionMatch && actionMatch[1]) {
        const resolved = gwRedirectTarget(actionMatch[1], reqPath);
        if (resolved && resolved.fail) {
          evidence.formPost = { action: actionMatch[1], fail: resolved.fail };
          return check("gateway", "fail", `login form action ${resolved.fail}`, evidence);
        }
        if (resolved) postPath = resolved;
      }
      const cookie = gwCookieHeader(jar);
      const post = await gwRequest(gwPort, {
        method: "POST",
        reqPath: postPath,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "0",
          origin: `https://${GATEWAY_PUBLIC_HOST}`,
          ...(cookie ? { cookie } : {}),
        },
        body: "",
      });
      gwCookies(jar, post.headers["set-cookie"]);
      evidence.formPost = {
        path: postPath,
        status: post.status,
        location: post.headers.location ?? null,
        bodyHead: (post.body ?? "").slice(0, 400),
      };
      // A rejection is a 4xx/5xx whose body names the mechanism, or Nextcloud's
      // dedicated untrusted-domain page at any status. A 200 re-render of the
      // login form (which legitimately mentions csrf tokens) is not a rejection.
      const postBody = post.body ?? "";
      const rejected =
        /untrusted domain/i.test(postBody) ||
        (post.status >= 400 && /origin|csrf|trusted|host|forbidden/i.test(postBody));
      if (rejected) {
        return check("gateway", "fail", `login form POST rejected as origin/host/CSRF issue (status ${post.status})`, evidence);
      }
    } else {
      evidence.formPost = { found: false };
    }

    // Reserved-path collision probe: the gateway owns POST /login for its
    // connect flow on every agent kind except catalog-app, whose apps post
    // their own login there. If the answer is the gateway's deny page the
    // app's login can never work (the Grafana live defect).
    const loginProbe = await gwRequest(gwPort, {
      method: "POST",
      reqPath: "/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "verify", password: "verify" }),
    });
    evidence.loginProbe = { status: loginProbe.status, bodyHead: (loginProbe.body ?? "").slice(0, 300) };
    if (/this box is private/i.test(loginProbe.body ?? "")) {
      return check("gateway", "fail", "POST /login answered by the gateway deny page (reserved-path collision)", evidence);
    }

    const hopDesc = hops.map((h) => `${h.status} ${h.path}`).join(" -> ");
    return check(
      "gateway",
      "pass",
      `through gateway: ${hopDesc}${isPostForm ? `; form POST -> ${evidence.formPost.status}` : ""}`,
      evidence,
    );
  } finally {
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 3000).unref();
    }
    rmSync(work, { recursive: true, force: true });
  }
}

async function bootDockerWeb(spec, platforms) {
  const rt = spec.runtime;
  const ref = `${rt.imageRepo}:${rt.imageTag}`;
  const slug = spec.id;
  const name = `hivra-verify-${slug}-${Math.random().toString(36).slice(2, 8)}`;
  const work = mkdtempSync(path.join(tmpdir(), `hivra-verify-${slug}-`));
  const envFile = path.join(work, "env");
  const env = mergedDockerEnv(rt);
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });

  const hostPort = Number.isInteger(rt.hostPort) ? rt.hostPort : await freeCatalogPort();
  const hasArm64 = platforms.some((p) => p.startsWith("linux/arm64"));
  const args = [
    "run", "-d",
    "--name", name,
    "--security-opt", "no-new-privileges",
    ...(rt.dropAllCaps ? ["--cap-drop", "ALL"] : []),
    ...(!hasArm64 ? ["--platform", "linux/amd64"] : []),
    "-p", `127.0.0.1:${hostPort}:${rt.containerPort}`,
    "--env-file", envFile,
    ...rt.volumes.flatMap((v) => ["-v", `${name}-${v.name}:${v.mountPath}`]),
    ref,
  ];

  const evidence = {
    container: name,
    hostPort,
    image: ref,
    runArgs: args.map((a) => (a === envFile ? "<env-file>" : a)),
  };
  let memBytes = null;
  try {
    const runRes = shOut("docker", args, { timeout: 300_000 });
    evidence.runStdout = runRes.stdout.trim().slice(0, 300);
    if (runRes.status !== 0) {
      evidence.runStderr = runRes.stderr.slice(0, 600);
      return { checks: [check("boot", "fail", `docker run failed: ${runRes.stderr.slice(0, 300)}`, evidence), check("gateway", "skipped", "container did not start")], memBytes };
    }

    const health = await pollHealth(hostPort, rt.healthPath, BOOT_TIMEOUT_MS);
    evidence.health = health;
    if (!health.ok) {
      const logs = shOut("docker", ["logs", "--tail", "40", name], { timeout: 30_000 });
      evidence.logsTail = logs.stdout.slice(-1500);
      return { checks: [check("boot", "fail", `health ${rt.healthPath} never returned <400 (last status ${health.status ?? "none"})`, evidence), check("gateway", "skipped", "health check failed")], memBytes };
    }

    const stats = shOut("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", name], { timeout: 30_000 });
    const memText = stats.stdout.trim();
    memBytes = parseMemUsage(memText);
    evidence.memUsage = memText;
    evidence.memBytes = memBytes;
    const bootCheck = check("boot", "pass", `health ${rt.healthPath} -> ${health.status} in ${health.seconds}s`, evidence);
    const gateway = await gatewayCheck(spec, hostPort);
    return { checks: [bootCheck, gateway], memBytes };
  } finally {
    shOut("docker", ["rm", "-f", name], { timeout: 60_000 });
    const vols = rt.volumes.map((v) => `${name}-${v.name}`);
    if (vols.length) shOut("docker", ["volume", "rm", ...vols], { timeout: 60_000 });
    rmSync(work, { recursive: true, force: true });
  }
}

// docker-stack: render through the guest runner's own --render-only mode so
// the verifier exercises exactly what install writes, then bring the compose
// project up and check the web service through the real gateway.
async function bootDockerStack(spec, imageEvidence) {
  const rt = spec.runtime;
  const web = rt.web;
  const slug = spec.id;
  const work = mkdtempSync(path.join(tmpdir(), `hivra-verify-stack-${slug}-`));
  const outDir = path.join(work, "rendered");
  const specFile = path.join(work, "spec.json");
  const project = `hivra-verify-${slug}-${Math.random().toString(36).slice(2, 8)}`;
  const composeFile = path.join(outDir, "compose.yaml");
  const evidence = { project, composeFile, renderedDir: outDir };
  let memBytes = null;

  // The runner validates the launch-spec envelope {appId,name,runtime}; the
  // publicOrigin rides alongside it exactly like the guest install payload.
  writeFileSync(
    specFile,
    JSON.stringify({
      spec: { appId: slug, name: spec.name ?? slug, runtime: rt },
      publicOrigin: GATEWAY_PUBLIC_ORIGIN,
    }),
  );
  const render = spawnSync("python3", ["-I", "-B", CATALOG_APP_RUNNER, "render-only", specFile, outDir], {
    encoding: "utf8",
    timeout: 60_000,
  });
  try {
    if (render.error || render.status !== 0) {
      evidence.renderStderr = (render.stderr || render.error?.message || "").slice(0, 600);
      return { checks: [check("boot", "fail", `runner --render-only failed: ${evidence.renderStderr}`, evidence), check("gateway", "skipped", "render failed")], memBytes };
    }
    evidence.renderStdout = (render.stdout || "").trim().slice(0, 300);

    // Match the guest's linux/amd64 target when any service lacks arm64.
    const services = imageEvidence?.services ?? [];
    const allArm64 = services.length > 0 && services.every((s) => (s.platforms ?? []).some((p) => p.startsWith("linux/arm64")));
    const composeEnv = { ...process.env, ...(allArm64 ? {} : { DOCKER_DEFAULT_PLATFORM: "linux/amd64" }) };
    evidence.defaultPlatform = allArm64 ? "host" : "linux/amd64";

    const up = shOut("docker", ["compose", "-p", project, "-f", composeFile, "up", "-d"], { timeout: 600_000, env: composeEnv });
    evidence.upStdout = up.stdout.slice(-800);
    if (up.status !== 0) {
      evidence.upStderr = up.stderr.slice(-1200);
      const logs = shOut("docker", ["compose", "-p", project, "-f", composeFile, "logs", "--tail", "60"], { timeout: 60_000, env: composeEnv });
      evidence.logsTail = (logs.stdout + logs.stderr).slice(-2000);
      return { checks: [check("boot", "fail", `docker compose up failed: ${up.stderr.slice(0, 300)}`, evidence), check("gateway", "skipped", "stack did not start")], memBytes };
    }

    const hostPort = web.hostPort;
    const health = await pollHealth(hostPort, web.healthPath, BOOT_TIMEOUT_MS);
    evidence.health = health;
    if (!health.ok) {
      const logs = shOut("docker", ["compose", "-p", project, "-f", composeFile, "logs", "--tail", "80"], { timeout: 60_000, env: composeEnv });
      evidence.logsTail = (logs.stdout + logs.stderr).slice(-2500);
      return { checks: [check("boot", "fail", `health ${web.healthPath} never returned <400 (last status ${health.status ?? "none"})`, evidence), check("gateway", "skipped", "health check failed")], memBytes };
    }

    // Whole-stack idle memory: sum docker stats across the project's containers.
    const ps = shOut("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`], { timeout: 30_000 });
    const ids = ps.stdout.split(/\s+/).filter(Boolean);
    evidence.containerCount = ids.length;
    let total = 0;
    let sawStats = false;
    const perContainer = [];
    for (const id of ids) {
      const stats = shOut("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", id], { timeout: 30_000 });
      const text = stats.stdout.trim();
      const bytes = parseMemUsage(text);
      perContainer.push({ id: id.slice(0, 12), memUsage: text, memBytes: bytes });
      if (bytes !== null) {
        total += bytes;
        sawStats = true;
      }
    }
    evidence.perContainerMem = perContainer;
    if (sawStats) memBytes = total;
    evidence.memBytes = memBytes;

    const bootCheck = check("boot", "pass", `stack up; health ${web.healthPath} -> ${health.status} in ${health.seconds}s across ${ids.length} container(s)`, evidence);
    const gateway = await gatewayCheck(spec, web.hostPort);
    return { checks: [bootCheck, gateway], memBytes };
  } finally {
    shOut("docker", ["compose", "-p", project, "-f", composeFile, "down", "-v", "--remove-orphans"], { timeout: 120_000 });
    const vols = shOut("docker", ["volume", "ls", "-q", "--filter", `name=hivra-app-${slug}-`], { timeout: 30_000 });
    const volNames = vols.stdout.split(/\s+/).filter(Boolean);
    if (volNames.length) shOut("docker", ["volume", "rm", ...volNames], { timeout: 60_000 });
    rmSync(work, { recursive: true, force: true });
  }
}

async function runCliProbe(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 120_000,
    env: opts.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
    error: res.error ? String(res.error.message ?? res.error) : null,
  };
}

function helpHead(text) {
  return (text ?? "").slice(0, 1500);
}

async function cliChatFlagsPresent(helpText, cliChat) {
  const flags = (cliChat?.args ?? []).filter((a) => a.startsWith("-"));
  const missing = flags.filter((f) => !(helpText ?? "").includes(f));
  return { flags, missing };
}

/** Leading positional words of cliChat.args (the subcommand path, e.g.
 * ["run"] for goose's ["run","--text"] or ["agent"] for zeroclaw's
 * ["agent","--agent","hivra","-m"]). Flags live on the subcommand's help, not
 * the top-level one. */
function cliChatCommandPath(cliChat) {
  const out = [];
  for (const arg of cliChat?.args ?? []) {
    if (arg.startsWith("-")) break;
    out.push(arg);
  }
  return out;
}

function findReleaseBinary(work, binName) {
  const exact = [];
  const other = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.isFile()) {
        if (ent.name === binName) exact.push(p);
        else if (!ent.name.includes(".") && statSync(p).size > 10_000) other.push(p);
      }
    }
  };
  walk(work, 0);
  return exact[0] ?? other[0] ?? null;
}

async function bootCliWeb(spec) {
  const rt = spec.runtime;
  const installer = rt.installer;
  const work = mkdtempSync(path.join(tmpdir(), `hivra-verify-${spec.id}-`));
  const evidence = { installer: installer.method };
  const checks = [];

  try {
    if (installer.method === "github-release-tar") {
      // The assets are linux binaries: fetch, extract, and run --help inside a
      // container, matching the guest runtime.
      const rel = shOut("gh", ["api", `repos/${installer.repo}/releases/latest`, "--jq", "{tag_name, assets: [.assets[] | {name, browser_download_url}]}"] , { timeout: 60_000 });
      if (rel.status !== 0) {
        checks.push(check("install", "fail", `gh release lookup failed: ${(rel.stderr || rel.stdout).slice(0, 300)}`));
        return finishCli(checks);
      }
      const info = JSON.parse(rel.stdout);
      const wantArm = process.arch === "arm64" && installer.assetArm64 && info.assets.some((a) => a.name === installer.assetArm64);
      const assetName = wantArm ? installer.assetArm64 : installer.assetX64;
      const asset = info.assets.find((a) => a.name === assetName);
      if (!asset) {
        checks.push(check("install", "fail", `release ${info.tag_name} missing asset ${assetName}`));
        return finishCli(checks);
      }
      const dl = path.join(work, assetName);
      const curl = shOut("curl", ["-fsSL", "-o", dl, asset.browser_download_url], { timeout: 300_000 });
      if (curl.status !== 0) {
        checks.push(check("install", "fail", `asset download failed: ${curl.stderr.slice(0, 300)}`));
        return finishCli(checks);
      }
      const untar = shOut("tar", ["-xf", dl, "-C", work], { timeout: 120_000 });
      if (untar.status !== 0) {
        checks.push(check("install", "fail", `asset extract failed: ${untar.stderr.slice(0, 300)}`));
        return finishCli(checks);
      }
      const bin = findReleaseBinary(work, installer.binName);
      if (!bin) {
        checks.push(check("install", "fail", "release asset contained no runnable binary"));
        return finishCli(checks);
      }
      const relBin = path.relative(work, bin);
      const platform = wantArm ? "linux/arm64" : "linux/amd64";
      const cmdPath = cliChatCommandPath(rt.cliChat).map((a) => `'${a}'`).join(" ");
      const run = await runCliProbe("docker", [
        "run", "--rm", "--platform", platform,
        "-v", `${work}:/w`, "-w", "/w",
        "debian:bookworm-slim",
        "sh", "-c", `chmod +x '/w/${relBin}' && '/w/${relBin}' ${cmdPath} --help 2>&1 | head -80`,
      ], { timeout: 300_000 });
      const helpText = `${run.stdout}\n${run.stderr}`;
      evidence.install = { tag: info.tag_name, asset: assetName, platform, helpHead: helpHead(helpText) };
      if (!helpText.trim()) {
        checks.push(check("install", "fail", `container probe produced no output: ${(run.error || run.stderr || "").slice(0, 300)}`, evidence));
        return finishCli(checks);
      }
      checks.push(check("install", "pass", `release ${info.tag_name} asset ${assetName} executed --help in ${platform}`));
      checks.push(check("boot", "pass", "release binary ran --help inside linux container", { exitStatus: run.status }));
      if (rt.cliChat) {
        const flagCheck = await cliChatFlagsPresent(helpText, rt.cliChat);
        evidence.flagsChecked = flagCheck.flags;
        if (flagCheck.missing.length) {
          checks.push(check("cli-flags", "fail", `help output missing flags: ${flagCheck.missing.join(", ")}`, { helpHead: helpHead(helpText) }));
        } else {
          checks.push(check("cli-flags", "pass", `help mentions ${flagCheck.flags.join(", ") || "no dash flags"}`));
        }
      }
      return finishCli(checks);
    }

    let binPath = null;
    let installNote = "";
    if (installer.method === "uv-tool") {
      const toolDir = path.join(work, "tools");
      const binDir = path.join(work, "bin");
      mkdirSync(toolDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const env = { ...process.env, UV_TOOL_DIR: toolDir, UV_TOOL_BIN_DIR: binDir, UV_PYTHON: "3.12" };
      const inst = await runCliProbe("uv", ["tool", "install", installer.packageName], { env, timeout: 300_000 });
      evidence.installStdout = inst.stdout.slice(0, 500);
      if (inst.status !== 0) {
        checks.push(check("install", "fail", `uv tool install failed: ${(inst.stderr || inst.error || "").slice(0, 300)}`, evidence));
        return finishCli(checks);
      }
      binPath = path.join(binDir, installer.binName);
      installNote = `uv tool install ${installer.packageName}`;
    } else {
      // npm-global
      const prefix = path.join(work, "npm");
      const inst = await runCliProbe("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", installer.packageName], { timeout: 300_000 });
      evidence.installStdout = inst.stdout.slice(0, 500);
      if (inst.status !== 0) {
        checks.push(check("install", "fail", `npm install failed: ${(inst.stderr || inst.error || "").slice(0, 300)}`, evidence));
        return finishCli(checks);
      }
      binPath = path.join(prefix, "node_modules", ".bin", installer.binName);
      installNote = `npm install --prefix ${installer.packageName}`;
    }
    checks.push(check("install", "pass", installNote));

    // Probe the binary: --version first, --help as fallback; keep the output.
    let probe = await runCliProbe(binPath, ["--version"], { timeout: 90_000 });
    let mode = "--version";
    if (probe.status !== 0 || (!probe.stdout.trim() && !probe.stderr.trim())) {
      probe = await runCliProbe(binPath, ["--help"], { timeout: 90_000 });
      mode = "--help";
    }
    const helpText = `${probe.stdout}\n${probe.stderr}`;
    evidence.probe = { mode, status: probe.status, head: helpHead(helpText) };
    if (!helpText.trim()) {
      checks.push(check("boot", "fail", `binary probe produced no output: ${(probe.error || "").slice(0, 300)}`, evidence));
      return finishCli(checks);
    }
    checks.push(check("boot", "pass", `binary ${mode} ran (exit ${probe.status})`, evidence.probe));

    if (rt.cliChat) {
      // cliChat flags belong to the configured subcommand: ask that
      // subcommand for its own help (e.g. `goose run --help`,
      // `zeroclaw agent --help`) so `run --text` style flags resolve. Always
      // run --help explicitly: the boot probe may have used --version, whose
      // output does not list flags.
      const cmdPath = cliChatCommandPath(rt.cliChat);
      const helpProbe = await runCliProbe(binPath, [...cmdPath, "--help"], { timeout: 90_000 });
      const subText = `${helpProbe.stdout}\n${helpProbe.stderr}`;
      const flagHelp = subText.trim() ? subText : helpText;
      if (subText.trim()) {
        evidence.subcommandHelp = { args: cmdPath, head: helpHead(subText) };
      }
      const flagCheck = await cliChatFlagsPresent(flagHelp, rt.cliChat);
      evidence.flagsChecked = flagCheck.flags;
      if (flagCheck.missing.length) {
        checks.push(check("cli-flags", "fail", `help output missing flags: ${flagCheck.missing.join(", ")}`, { helpHead: helpHead(helpText) }));
      } else {
        checks.push(check("cli-flags", "pass", `help mentions ${flagCheck.flags.join(", ") || "no dash flags"}`));
      }
    }
    return finishCli(checks);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function finishCli(checks) {
  // cli-web installs a CLI, not a resident service: there is no idle memory to
  // floor-check here. The launch sweep owns live footprint verification.
  checks.push(check("floor", "skipped", "cli-web installs a CLI; no resident service to measure"));
  const failed = checks.filter((c) => c.status === "fail");
  return { checks, verdict: failed.length ? "fail" : "pass", reasons: failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`) };
}

// ── Driver ──────────────────────────────────────────────────────────────────

function dumpManifest(slug) {
  // ts-node transpile-only, same pattern as the ops:* scripts but without
  // tsconfig-paths: the manifest registry has no "@/" imports.
  const res = spawnSync(
    process.execPath,
    [
      "-r", "ts-node/register/transpile-only",
      "scripts/catalog-curator/dump-manifest.ts",
      slug,
    ],
    {
      cwd: DASHBOARD_DIR,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: "true",
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs", moduleResolution: "node" }),
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (res.status !== 0) throw new Error(`dump-manifest failed for ${slug}: ${(res.stderr || res.stdout || "").slice(0, 300)}`);
  return JSON.parse(res.stdout);
}

function dumpAllManifests() {
  const res = spawnSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", "scripts/catalog-curator/dump-manifest.ts", "--all"],
    {
      cwd: DASHBOARD_DIR,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: "true",
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs", moduleResolution: "node" }),
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (res.status !== 0) throw new Error(`dump-manifest --all failed: ${(res.stderr || res.stdout || "").slice(0, 300)}`);
  return JSON.parse(res.stdout);
}

async function verifyOne(spec, { force = false } = {}) {
  const slug = spec.id;
  const evidencePath = path.join(EVIDENCE_DIR, `${slug}.json`);
  if (!force && existsSync(evidencePath)) {
    try {
      const prior = JSON.parse(readFileSync(evidencePath, "utf8"));
      const age = Date.now() - new Date(prior.checkedAt).getTime();
      if (prior.verdict === "pass" && age < EVIDENCE_MAX_AGE_MS) {
        return { slug, verdict: "pass", skipped: true, reasons: [] };
      }
    } catch {
      /* re-verify on unreadable evidence */
    }
  }

  const checks = [];
  checks.push(checkLicense(spec));
  const licenseFailed = checks[0].status === "fail";
  const imageCheck = await checkImage(spec);
  checks.push(imageCheck);

  if (licenseFailed || imageCheck.status === "fail") {
    for (const name of ["boot", "gateway", "floor"]) {
      checks.push(check(name, "skipped", "earlier gate failed"));
    }
  } else if (spec.runtime.kind === "docker-web" || spec.runtime.kind === "docker-stack") {
    const platforms = imageCheck.evidence?.platforms ?? imageCheck.evidence?.services?.flatMap((s) => s.platforms ?? []) ?? [];
    const bootResult = spec.runtime.kind === "docker-stack"
      ? await bootDockerStack(spec, imageCheck.evidence)
      : await bootDockerWeb(spec, platforms);
    checks.push(...bootResult.checks);

    // Floor check: measured idle memory must fit under 80% of the floor.
    const floorRamGb = spec.floor?.ram;
    if (typeof floorRamGb === "number" && bootResult.memBytes !== null) {
      const limit = floorRamGb * 0.8 * 1024 ** 3;
      const pass = bootResult.memBytes < limit;
      checks.push(
        check(
          "floor",
          pass ? "pass" : "fail",
          `idle memory ${(bootResult.memBytes / 1024 ** 2).toFixed(1)}MiB vs floor ${floorRamGb}GB*0.8=${(limit / 1024 ** 3).toFixed(1)}GiB`,
          { memBytes: bootResult.memBytes, floorRamGb },
        ),
      );
    } else {
      checks.push(check("floor", "skipped", "no floor.ram in spec or no memory reading"));
    }
  } else {
    const cli = await bootCliWeb(spec);
    checks.push(...cli.checks);
  }

  const failed = checks.filter((c) => c.status === "fail");
  const verdict = failed.length ? "fail" : "pass";
  const doc = {
    slug,
    checkedAt: new Date().toISOString(),
    gitSha: gitSha(),
    checks,
    verdict,
    reasons: failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`),
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  // Container/bridge addresses in raw tool output trip the public-tree hygiene
  // gate; loopback is the only address evidence needs to keep.
  const serialized = JSON.stringify(doc, null, 2).replace(/\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g, "<redacted-ip>");
  writeFileSync(evidencePath, serialized + "\n");
  return { slug, verdict, skipped: false, reasons: doc.reasons, evidencePath };
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const all = argv.includes("--all");
  const specIdx = argv.indexOf("--spec");
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(specIdx >= 0 && i === specIdx + 1));

  if (all) {
    const manifests = dumpAllManifests();
    const results = [];
    for (const manifest of manifests) {
      process.stderr.write(`[verify] ${manifest.id} ... `);
      try {
        const r = await verifyOne(manifest, { force });
        results.push(r);
        process.stderr.write(`${r.verdict}${r.skipped ? " (fresh evidence)" : ""}\n`);
      } catch (err) {
        results.push({ slug: manifest.id, verdict: "fail", reasons: [String(err?.message ?? err)] });
        process.stderr.write(`error: ${err?.message ?? err}\n`);
      }
    }
    const failed = results.filter((r) => r.verdict === "fail");
    process.stdout.write(
      JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.slug) }, null, 2) + "\n",
    );
    process.exit(failed.length ? 1 : 0);
  }

  let spec;
  if (specIdx >= 0) {
    const file = argv[specIdx + 1];
    if (!file) {
      console.error("--spec requires a file path");
      process.exit(2);
    }
    spec = JSON.parse(readFileSync(file, "utf8"));
  } else if (positional[0]) {
    spec = dumpManifest(positional[0]);
  } else {
    console.error("usage: verify-candidate.mjs <slug> | --spec <file.json> | --all [--force]");
    process.exit(2);
  }

  try {
    const result = await verifyOne(spec, { force });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.verdict === "pass" ? 0 : 1);
  } catch (err) {
    console.error(`verify failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}

await main();
