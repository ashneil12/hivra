import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CANARY_HOST = "canary.hermesos.cloud";

function authToken(env) {
  if (env.HIVRA_VERCEL_TOKEN?.trim()) return env.HIVRA_VERCEL_TOKEN.trim();
  const paths = [
    "Library/Application Support/com.vercel.cli/auth.json",
    ".local/share/com.vercel.cli/auth.json",
    ".vercel/auth.json",
  ];
  for (const relative of paths) {
    const file = path.join(homedir(), relative);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) continue;
      const { token } = JSON.parse(readFileSync(file, "utf8"));
      if (typeof token === "string" && token.trim()) return token.trim();
    } catch {
      continue;
    }
  }
  throw new Error("[vercel-rest] no owner-only Vercel API credential is available");
}

export function createVercelGetter(scope, { fetchImpl = fetch, env = process.env } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(scope ?? "") && !/^team_[A-Za-z0-9]{8,128}$/.test(scope ?? "")) {
    throw new Error("[vercel-rest] an explicit Vercel team slug or ID is required");
  }
  const token = authToken(env);
  return async (pathname, query = {}) => {
    if (pathname !== `/v4/aliases/${CANARY_HOST}`
      && !/^\/v(?:13\/deployments\/dpl_[A-Za-z0-9]+|8\/projects\/prj_[A-Za-z0-9]+\/env)$/.test(pathname)) {
      throw new Error("[vercel-rest] unsupported API read");
    }
    const url = new URL(pathname, "https://api.vercel.com");
    url.search = new URLSearchParams(query);
    url.searchParams.set(scope.startsWith("team_") ? "teamId" : "slug", scope);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new Error("[vercel-rest] Vercel API request did not complete");
    });
    if (!response.ok) throw new Error(`[vercel-rest] Vercel API read failed (HTTP ${response.status})`);
    return response.json().catch(() => {
      throw new Error("[vercel-rest] invalid Vercel API response");
    });
  };
}

export async function readCanaryAlias(get, projectId) {
  if (!/^prj_[A-Za-z0-9]{8,128}$/.test(projectId ?? "")) {
    throw new Error("[vercel-rest] an explicit Canary project ID is required");
  }
  const alias = await get(`/v4/aliases/${CANARY_HOST}`);
  if (alias?.alias !== CANARY_HOST || alias.projectId !== projectId || !/^dpl_[A-Za-z0-9]{8,128}$/.test(alias.deploymentId ?? "")) {
    throw new Error("[vercel-rest] Canary alias does not match the configured project and deployment");
  }
  return alias.deploymentId;
}
