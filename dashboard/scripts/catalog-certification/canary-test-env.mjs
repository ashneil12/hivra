#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createVercelGetter, readCanaryAlias } from "./vercel-rest.mjs";

function envError(message) {
  return new Error(`[canary-test-env] ${message}`);
}

export function selectProductionEnvValue(rows, key) {
  const matching = rows
    .filter((row) => row?.key === key && typeof row.value === "string" && row.value.length > 0)
    .filter((row) => Array.isArray(row.target) && row.target.includes("production") && !row.gitBranch)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  return matching[0]?.value ?? null;
}

export async function loadCanaryTestEnv({ get, projectId, deploymentId }) {
  if (await readCanaryAlias(get, projectId) !== deploymentId) {
    throw envError("Canary changed after revision verification; no browser started");
  }
  const { envs } = await get(`/v8/projects/${projectId}/env`, { decrypt: "true" }) ?? {};
  if (!Array.isArray(envs)) throw envError("Vercel API did not return env rows");
  const supabaseUrl = selectProductionEnvValue(envs, "SUPABASE_URL");
  const serviceRole = selectProductionEnvValue(envs, "SUPABASE_SERVICE_ROLE_KEY");
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co") || url.origin !== supabaseUrl) throw new Error();
  } catch {
    throw envError("invalid Canary Supabase URL");
  }
  if (!serviceRole || serviceRole.length < 20 || /[\r\n\0]/.test(serviceRole)) {
    throw envError("invalid Canary Supabase service role value");
  }
  return { LAUNCH_SWEEP_SUPABASE_URL: supabaseUrl, LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY: serviceRole };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const [mode, ...rest] = process.argv.slice(2);
    if (!["--verify-only", "--launch-sweep"].includes(mode) || rest.length) throw envError("expected one explicit mode");
    const { HIVRA_CANARY_VERCEL_PROJECT_ID: projectId, HIVRA_VERCEL_SCOPE: scope, CERT_VERCEL_DEPLOYMENT_ID: deploymentId } = process.env;
    const get = createVercelGetter(scope);
    const testEnv = await loadCanaryTestEnv({ get, projectId, deploymentId });
    if (mode === "--launch-sweep") {
      const env = { ...process.env, ...testEnv };
      delete env.HIVRA_VERCEL_TOKEN;
      const result = spawnSync("npm", ["run", "test:launch-sweep"], { env, stdio: "inherit" });
      process.exitCode = result.status === 0 ? 0 : 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 74;
  }
}
