#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { CANARY_HOST, createVercelGetter, readCanaryAlias } from "./vercel-rest.mjs";

export async function resolveServedRevision({ projectId, get }) {
  const deploymentId = await readCanaryAlias(get, projectId);
  const deployment = await get(`/v13/deployments/${deploymentId}`, { withGitRepoInfo: "true" });
  if (deployment?.id !== deploymentId || deployment.projectId !== projectId
    || deployment.source !== "git" || deployment.readyState !== "READY"
    || deployment.target !== "production" || !Array.isArray(deployment.alias) || !deployment.alias.includes(CANARY_HOST)) {
    throw new Error("[served-canary-revision] deployment is not the configured READY Git Canary alias");
  }
  const { gitSource, meta } = deployment;
  if (gitSource?.type !== "github" || gitSource.ref !== "canary" || !/^[0-9a-f]{40}$/.test(gitSource.sha ?? "")
    || meta?.githubHost !== "github.com" || meta.githubOrg !== "ashneil12" || meta.githubRepo !== "hivra"
    || meta.githubCommitRef !== "canary" || meta.githubCommitSha !== gitSource.sha) {
    throw new Error("[served-canary-revision] deployment does not prove an exact ashneil12/hivra Canary Git revision");
  }
  return { deploymentId, host: CANARY_HOST, sha: gitSource.sha, projectId };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const projectId = process.env.HIVRA_CANARY_VERCEL_PROJECT_ID;
    const get = createVercelGetter(process.env.HIVRA_VERCEL_SCOPE);
    console.log(JSON.stringify(await resolveServedRevision({ projectId, get })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
