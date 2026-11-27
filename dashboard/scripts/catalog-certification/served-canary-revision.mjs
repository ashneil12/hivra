#!/usr/bin/env node
/**
 * Resolve the exact public Canary revision serving canary.hermesos.cloud.
 *
 * The certification runner must never certify "whatever origin/canary says" or
 * a stale checkout. Vercel's inspect output proves which deployment holds the
 * alias; the deployment API then proves that deployment came from the public
 * GitHub canary branch and names its exact merge commit.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{8,128}$/;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;

function revisionError(message) {
  return new Error(`[served-canary-revision] ${message}`);
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseJson(text, label) {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw revisionError(`malformed ${label} JSON`);
  }
}

function validHostname(value, label) {
  if (typeof value !== "string" || value !== value.toLowerCase() || !HOSTNAME.test(value)) {
    throw revisionError(`${label} must be one lowercase hostname`);
  }
  return value;
}

function validSlug(value, label) {
  if (typeof value !== "string" || !SLUG.test(value)) {
    throw revisionError(`${label} must be a lowercase GitHub/Vercel slug`);
  }
  return value;
}

function validSha(value, label) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw revisionError(`${label} must be one full lowercase 40-hex SHA`);
  }
  return value;
}

function validDeploymentId(value, label = "deployment id") {
  if (typeof value !== "string" || !DEPLOYMENT_ID.test(value)) {
    throw revisionError(`${label} is invalid`);
  }
  return value;
}

/** Validate the deployment that Vercel inspect says currently holds the alias. */
export function parseInspectDeployment(inspectJson, { host }) {
  const expectedHost = validHostname(host, "host");
  const inspect = parseJson(inspectJson, "Vercel inspect");
  if (!inspect) throw revisionError("Vercel inspect JSON must contain one object");
  if (inspect.readyState !== "READY") throw revisionError("the aliased deployment is not READY");
  if (inspect.target !== "production") throw revisionError("the aliased deployment is not a production deployment");
  if (!Array.isArray(inspect.aliases) || !inspect.aliases.includes(expectedHost)) {
    throw revisionError(`the inspected deployment does not alias ${expectedHost}`);
  }
  return {
    deploymentId: validDeploymentId(inspect.id, "inspect deployment id"),
    readyState: "READY",
    target: "production",
    host: expectedHost,
  };
}

/** Validate the Git provenance of that same deployment. */
export function parseDeploymentGitRevision(deploymentJson, { host, owner, repo, ref, deploymentId }) {
  const expectedHost = validHostname(host, "host");
  const expectedOwner = validSlug(owner, "owner");
  const expectedRepo = validSlug(repo, "repo");
  const expectedRef = validSlug(ref, "ref");
  const expectedDeploymentId = validDeploymentId(deploymentId);
  const deployment = parseJson(deploymentJson, "Vercel deployment");
  if (!deployment) throw revisionError("Vercel deployment JSON must contain one object");
  if (deployment.id !== expectedDeploymentId) throw revisionError("deployment API returned a different deployment than inspect");
  if (deployment.source !== "git") throw revisionError("the aliased deployment is not Git-sourced");
  if (deployment.readyState !== "READY") throw revisionError("deployment API readyState is not READY");
  if (deployment.target !== "production") throw revisionError("deployment API target is not production");
  if (!Array.isArray(deployment.alias) || !deployment.alias.includes(expectedHost)) {
    throw revisionError(`deployment API does not alias ${expectedHost}`);
  }

  const gitSource = asRecord(deployment.gitSource);
  if (!gitSource) throw revisionError("deployment has no gitSource");
  if (gitSource.type !== "github") throw revisionError("deployment gitSource is not GitHub");
  if (gitSource.ref !== expectedRef) throw revisionError(`deployment gitSource ref is not ${expectedRef}`);
  const gitSha = validSha(gitSource.sha, "gitSource SHA");

  const meta = asRecord(deployment.meta);
  if (!meta) throw revisionError("deployment has no Git metadata");
  if (meta.githubHost !== "github.com") throw revisionError("deployment did not come from github.com");
  if (meta.githubOrg !== expectedOwner || meta.githubRepo !== expectedRepo) {
    throw revisionError(`deployment did not come from ${expectedOwner}/${expectedRepo}`);
  }
  if (meta.githubCommitRef !== expectedRef) throw revisionError(`deployment commit ref is not ${expectedRef}`);
  const metaSha = validSha(meta.githubCommitSha, "GitHub commit SHA");
  if (metaSha !== gitSha) throw revisionError("gitSource SHA and GitHub commit SHA differ");

  const project = asRecord(deployment.project);
  return {
    deploymentId: expectedDeploymentId,
    host: expectedHost,
    owner: expectedOwner,
    repo: expectedRepo,
    ref: expectedRef,
    sha: gitSha,
    projectId: typeof project?.id === "string" ? project.id : null,
    projectName: typeof project?.name === "string" ? project.name : null,
  };
}

export function parseServedRevision({ inspectJson, deploymentJson, host, owner, repo, ref }) {
  const inspect = parseInspectDeployment(inspectJson, { host });
  return parseDeploymentGitRevision(deploymentJson, {
    host,
    owner,
    repo,
    ref,
    deploymentId: inspect.deploymentId,
  });
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw revisionError(`invalid option ${key ?? "<missing>"}`);
    }
    if (options.has(key)) throw revisionError(`${key} may be supplied only once`);
    options.set(key, value);
  }
  return options;
}

function vercel(args, scope) {
  const command = ["vercel", ...args, ...(scope ? ["--scope", scope] : [])];
  try {
    return execFileSync(command[0], command.slice(1), {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr ? ` ${String(error.stderr).split("\n")[0].slice(0, 240)}` : "";
    throw revisionError(`Vercel CLI query failed.${stderr}`);
  }
}

export function resolveServedRevision({ host, owner, repo, ref, scope }) {
  const inspectJson = vercel(["inspect", host, "--json"], scope);
  const inspect = parseInspectDeployment(inspectJson, { host });
  const deploymentJson = vercel(["api", `/v13/deployments/${inspect.deploymentId}`, "--raw"], scope);
  return parseDeploymentGitRevision(deploymentJson, {
    host,
    owner,
    repo,
    ref,
    deploymentId: inspect.deploymentId,
  });
}

function cli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const host = options.get("--host") ?? "canary.hermesos.cloud";
  const owner = options.get("--owner") ?? "ashneil12";
  const repo = options.get("--repo") ?? "hivra";
  const ref = options.get("--ref") ?? "canary";
  const scope = options.get("--scope") ?? process.env.HIVRA_VERCEL_SCOPE ?? process.env.VERCEL_SCOPE ?? "";
  return resolveServedRevision({ host, owner, repo, ref, scope });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(cli(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
