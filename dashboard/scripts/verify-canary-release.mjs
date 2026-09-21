#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{8,128}$/;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EARLIEST_VERCEL_TIMESTAMP_MS = Date.parse("2020-01-01T00:00:00.000Z");
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const PRIVATE_WORKSPACE_CONTENT =
  /data-testid=["']unified-workspace["']|Canary preview|Compatibility session|Capability matrix/i;

const FORBIDDEN_HANDOFF_SENTINELS = [
  { name: "secret key", pattern: /\bsk_(?:live|test)_[A-Za-z0-9_-]{8,}\b/i },
  { name: "bearer credential", pattern: /\bAuthorization\s*:\s*Bearer\s+\S+/i },
  { name: "JWT credential", pattern: /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  {
    name: "secret assignment",
    pattern:
      /\b(?:CLERK_SECRET_KEY|API[_-]?KEY|ACCESS[_-]?TOKEN|SERVICE[_-]?ROLE[_-]?KEY|PASSWORD)\s*[:=]\s*\S+/i,
  },
  { name: "token-bearing URL", pattern: /https?:\/\/\S+[?#]\S+/i },
  { name: "raw unified UID", pattern: /\b(?:uid\s*[:=]\s*)?(?:h|x)-[A-Za-z0-9][A-Za-z0-9._:-]{3,}\b/i },
  { name: "raw Clerk user ID", pattern: /\buser_[A-Za-z0-9]{6,}\b/ },
  { name: "transcript", pattern: /\btranscript\s*[:=]/i },
  { name: "raw error", pattern: /\braw\s+error\s*[:=]/i },
  { name: "placeholder", pattern: /\b(?:TODO|FIXME|placeholder|coming soon)\b/i },
];

function verificationError(message) {
  return new Error(`[verify-canary-release] ${message}`);
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function parseExpectedAlias(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !HOSTNAME.test(value)
  ) {
    throw verificationError("expected alias must be one lowercase hostname");
  }
  return value;
}

function parseExpectedUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw verificationError("expected URL must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/dashboard/workspace"
  ) {
    throw verificationError(
      "expected URL must be the exact HTTPS /dashboard/workspace URL",
    );
  }
  return parsed;
}

function parseCreatedAt(value, nowMs) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < EARLIEST_VERCEL_TIMESTAMP_MS ||
    value > nowMs + MAX_CLOCK_SKEW_MS
  ) {
    throw verificationError(
      "Vercel inspect JSON.createdAt must be a valid deployment timestamp in milliseconds",
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw verificationError("Vercel inspect JSON.createdAt is invalid");
  }
  return parsed.toISOString();
}

export function parseVercelInspect(
  inspectJson,
  { expectedAlias, nowMs = Date.now() },
) {
  const alias = parseExpectedAlias(expectedAlias);
  let parsed;
  try {
    parsed = JSON.parse(inspectJson);
  } catch {
    throw verificationError("malformed Vercel inspect JSON");
  }
  const inspect = asRecord(parsed);
  if (!inspect) {
    throw verificationError("Vercel inspect JSON must contain one object");
  }
  if (inspect.readyState !== "READY") {
    throw verificationError("Vercel inspect readyState must be READY");
  }
  if (inspect.target !== "production") {
    throw verificationError("Vercel inspect target must be production");
  }
  if (!Array.isArray(inspect.aliases)) {
    throw verificationError("Vercel inspect aliases must be an array");
  }
  if (!inspect.aliases.every((candidate) => typeof candidate === "string")) {
    throw verificationError("Vercel inspect aliases must contain only hostnames");
  }
  if (!inspect.aliases.includes(alias)) {
    throw verificationError(`Vercel inspect does not contain expected alias ${alias}`);
  }
  if (typeof inspect.id !== "string" || !DEPLOYMENT_ID.test(inspect.id)) {
    throw verificationError("Vercel inspect deployment ID is invalid");
  }

  return {
    readyState: "READY",
    target: "production",
    alias,
    deploymentId: inspect.id,
    deploymentCreatedAt: parseCreatedAt(inspect.createdAt, nowMs),
    deploymentCreatedAtSource: "Vercel inspect JSON.createdAt",
  };
}

function parseCurlHeaders(headers) {
  if (typeof headers !== "string") {
    throw verificationError("curl headers must be text");
  }
  let status = null;
  let fields = new Map();
  for (const line of headers.split(/\r?\n/)) {
    const statusMatch = line.match(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/i);
    if (statusMatch) {
      status = Number.parseInt(statusMatch[1], 10);
      fields = new Map();
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!fields.has(name)) fields.set(name, value);
  }
  if (!status) {
    throw verificationError("curl headers contain no HTTP status");
  }
  return { status, fields };
}

function assertNoPrivateWorkspaceContent(body) {
  if (typeof body !== "string") {
    throw verificationError("curl body must be text");
  }
  if (PRIVATE_WORKSPACE_CONTENT.test(body)) {
    throw verificationError(
      "unauthenticated response exposed private workspace content",
    );
  }
}

function parseRedirectBoundary(status, fields, expectedUrl) {
  const rawLocation = fields.get("location");
  if (!rawLocation) {
    throw verificationError("Clerk sign-in redirect is missing Location");
  }
  let location;
  try {
    location = new URL(rawLocation, expectedUrl.origin);
  } catch {
    throw verificationError("Clerk sign-in redirect Location is invalid");
  }
  if (location.origin !== expectedUrl.origin) {
    throw verificationError("Clerk sign-in redirect must remain same-origin");
  }
  if (location.pathname !== "/sign-in" && !location.pathname.startsWith("/sign-in/")) {
    throw verificationError("redirect did not enter the Clerk sign-in boundary");
  }
  const redirectUrl = location.searchParams.get("redirect_url");
  if (
    redirectUrl !== expectedUrl.pathname &&
    redirectUrl !== expectedUrl.href
  ) {
    throw verificationError(
      "Clerk sign-in boundary did not retain the exact workspace return URL",
    );
  }
  return {
    status,
    boundary: "clerk-sign-in-redirect",
    location: location.href,
  };
}

export function parseAuthResponse({ headers, body, expectedUrl }) {
  const exactUrl = parseExpectedUrl(expectedUrl);
  const { status, fields } = parseCurlHeaders(headers);
  assertNoPrivateWorkspaceContent(body);

  if ([301, 302, 303, 307, 308].includes(status)) {
    return parseRedirectBoundary(status, fields, exactUrl);
  }

  if (status !== 404) {
    throw verificationError(`unexpected unauthenticated status ${status}`);
  }
  if (fields.has("location")) {
    throw verificationError("Clerk protect-rewrite must not include Location");
  }
  if (fields.get("x-clerk-auth-status")?.toLowerCase() !== "signed-out") {
    throw verificationError("404 response is missing Clerk protect-rewrite status");
  }
  if (!fields.get("x-clerk-auth-reason")?.toLowerCase().includes("protect-rewrite")) {
    throw verificationError("404 response is missing Clerk protect-rewrite reason");
  }

  return {
    status,
    boundary: "clerk-protect-rewrite",
    location: null,
  };
}

function parseSha(label, value) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw verificationError(`${label} must be one full lowercase 40-hex SHA`);
  }
  return value;
}

export function parseRevisionEvidence({
  expectedSha,
  localSha,
  originSha,
  visibleSha,
}) {
  const expected = parseSha("expected SHA", expectedSha);
  const local = parseSha("local SHA", localSha);
  const origin = parseSha("origin SHA", originSha);
  const visible =
    visibleSha === undefined ? undefined : parseSha("visible SHA", visibleSha);

  for (const [label, candidate] of [
    ["local", local],
    ["origin/main", origin],
    ...(visible === undefined ? [] : [["visible", visible]]),
  ]) {
    if (candidate !== expected) {
      throw verificationError(`${label} revision does not equal expected SHA`);
    }
  }

  return {
    expectedSha: expected,
    localSha: local,
    originSha: origin,
    ...(visible === undefined ? {} : { visibleSha: visible }),
  };
}

export function assertSafeHandoffText(text) {
  if (typeof text !== "string") {
    throw verificationError("handoff evidence must be text");
  }
  for (const sentinel of FORBIDDEN_HANDOFF_SENTINELS) {
    if (sentinel.pattern.test(text)) {
      throw verificationError(
        `forbidden handoff sentinel detected: ${sentinel.name}`,
      );
    }
  }
}

export function verifyCanaryRelease({
  inspectJson,
  headers,
  body,
  expectedAlias,
  expectedUrl,
  expectedSha,
  localSha,
  originSha,
  visibleSha,
  handoffTexts = [],
  now = () => new Date(),
}) {
  const verifiedAtDate = now();
  if (!(verifiedAtDate instanceof Date) || !Number.isFinite(verifiedAtDate.getTime())) {
    throw verificationError("verifier clock returned an invalid date");
  }
  const inspect = parseVercelInspect(inspectJson, {
    expectedAlias,
    nowMs: verifiedAtDate.getTime(),
  });
  const auth = parseAuthResponse({ headers, body, expectedUrl });
  const revisions = parseRevisionEvidence({
    expectedSha,
    localSha,
    originSha,
    visibleSha,
  });
  for (const text of handoffTexts) assertSafeHandoffText(text);

  return {
    ...inspect,
    ...revisions,
    expectedUrl: parseExpectedUrl(expectedUrl).href,
    auth,
    verifiedAt: verifiedAtDate.toISOString(),
  };
}

function parseCliArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "live" && command !== "scan") {
    throw verificationError("usage: verify-canary-release.mjs <live|scan> [options]");
  }
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw verificationError(`invalid CLI option ${name ?? "<missing>"}`);
    }
    const key = name.slice(2);
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
  }
  return { command, options };
}

function requiredOption(options, name) {
  const values = options.get(name);
  if (!values || values.length !== 1 || !values[0]) {
    throw verificationError(`--${name} is required exactly once`);
  }
  return values[0];
}

function optionalOption(options, name) {
  const values = options.get(name);
  if (!values) return undefined;
  if (values.length !== 1) {
    throw verificationError(`--${name} may be supplied only once`);
  }
  return values[0];
}

function gitRevision(ref) {
  try {
    return execFileSync("git", ["rev-parse", ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw verificationError(`could not resolve Git revision ${ref}`);
  }
}

function readEvidenceFile(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw verificationError(`could not read ${label} file`);
  }
}

export function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseCliArguments(argv);
  if (command === "scan") {
    const files = options.get("file") ?? [];
    if (files.length === 0) {
      throw verificationError("scan requires at least one --file");
    }
    for (const file of files) {
      assertSafeHandoffText(readEvidenceFile(file, "handoff"));
    }
    return { ok: true, filesScanned: files.length };
  }

  const expectedSha = requiredOption(options, "expected-sha");
  const localSha = optionalOption(options, "local-sha") ?? gitRevision("HEAD");
  const originSha =
    optionalOption(options, "origin-sha") ?? gitRevision("origin/main");
  const handoffTexts = (options.get("handoff") ?? []).map((path) =>
    readEvidenceFile(path, "handoff"),
  );
  const evidence = verifyCanaryRelease({
    inspectJson: readEvidenceFile(requiredOption(options, "inspect"), "inspect"),
    headers: readEvidenceFile(requiredOption(options, "headers"), "headers"),
    body: readEvidenceFile(requiredOption(options, "body"), "body"),
    expectedAlias: requiredOption(options, "expected-alias"),
    expectedUrl: requiredOption(options, "expected-url"),
    expectedSha,
    localSha,
    originSha,
    visibleSha: optionalOption(options, "visible-sha"),
    handoffTexts,
  });
  return { ok: true, ...evidence };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown verifier failure";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
