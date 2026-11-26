#!/usr/bin/env node
/**
 * Export the Canary-only live-audit secrets for one certification process.
 *
 * The values are fetched straight from the Canary Vercel project into the
 * runner process environment. They are never written to a disk env file and
 * this script never prints them except as shell assignments consumed by eval
 * in the parent runner. It deliberately refuses live-shaped Clerk keys.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function envError(message) {
  return new Error(`[canary-test-env] ${message}`);
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseRows(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw envError("malformed Vercel env JSON");
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.envs ?? parsed?.env;
  if (!Array.isArray(rows)) throw envError("Vercel env JSON has no env rows");
  return rows.filter((row) => asRecord(row));
}

/** Pick the production-scoped value for key. Rows without a production target are not eligible. */
export function selectProductionEnvValue(rows, key) {
  const matching = rows
    .filter((row) => row.key === key && typeof row.value === "string" && row.value.length > 0)
    .filter((row) => Array.isArray(row.target) && row.target.includes("production"))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  return matching[0]?.value ?? null;
}

function validateSecretValue(name, value) {
  if (typeof value !== "string" || !value) throw envError(`${name} is missing in the Canary production env`);
  if (/[\r\n\0]/.test(value)) throw envError(`${name} contains a control character and is unsafe to export`);
  return value;
}

export function shellQuote(value) {
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw envError("cannot shell-quote a control-character value");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildTestEnvExports(rows) {
  const clerk = validateSecretValue("CLERK_SECRET_KEY", selectProductionEnvValue(rows, "CLERK_SECRET_KEY"));
  if (!clerk.startsWith("sk_test_")) throw envError("CLERK_SECRET_KEY is not the Canary Clerk test key");
  const supabaseUrl = validateSecretValue("SUPABASE_URL", selectProductionEnvValue(rows, "SUPABASE_URL"));
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co")) {
      throw new Error("wrong shape");
    }
  } catch {
    throw envError("SUPABASE_URL is not an https Supabase URL");
  }
  const serviceRole = validateSecretValue(
    "SUPABASE_SERVICE_ROLE_KEY",
    selectProductionEnvValue(rows, "SUPABASE_SERVICE_ROLE_KEY"),
  );
  if (serviceRole.length < 20) throw envError("SUPABASE_SERVICE_ROLE_KEY is too short to be plausible");

  return [
    `export CLERK_SECRET_KEY=${shellQuote(clerk)}`,
    `export LAUNCH_SWEEP_SUPABASE_URL=${shellQuote(supabaseUrl)}`,
    `export LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY=${shellQuote(serviceRole)}`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw envError(`invalid option ${key ?? "<missing>"}`);
    if (options.has(key)) throw envError(`${key} may be supplied only once`);
    options.set(key, value);
  }
  return options;
}

function vercelApiProjectEnv(projectId, scope) {
  const args = [
    "api",
    `/v8/projects/${encodeURIComponent(projectId)}/env?decrypt=true`,
    "--raw",
    ...(scope ? ["--scope", scope] : []),
  ];
  try {
    return execFileSync("vercel", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr ? ` ${String(error.stderr).split("\n")[0].slice(0, 200)}` : "";
    throw envError(`could not read the Canary env metadata.${stderr}`);
  }
}

function cli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const projectId = options.get("--project-id") ?? process.env.HIVRA_CANARY_VERCEL_PROJECT_ID;
  if (!projectId || !/^prj_[A-Za-z0-9]{8,128}$/.test(projectId)) {
    throw envError("--project-id or HIVRA_CANARY_VERCEL_PROJECT_ID is required");
  }
  const scope = options.get("--scope") ?? process.env.HIVRA_VERCEL_SCOPE ?? process.env.VERCEL_SCOPE ?? "";
  return buildTestEnvExports(parseRows(vercelApiProjectEnv(projectId, scope)));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${cli()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
